// Lector del reporte mensual de pagos con hoja «Consolidado» (función por empresa:
// `lector_consolidado_pagos`, se enciende en el perfil de las empresas que lo usan).
//
// Formato: un libro por mes (p. ej. «OCTUBRE 2026») con una hoja por cuenta bancaria y
// efectivo, y una hoja «Consolidado» que las une con las columnas:
//   FECHA · DESCRIPCIÓN · … · TERCERO · VALOR · CUENTA · RELACIÓN · APLICACIÓN · OBSERVACIONES
// VALOR negativo = egreso (pago). CUENTA = origen del pago (CORRIENTE, AHORROS, EFECTIVO…).
// RELACIÓN = facturas pagadas o concepto; APLICACIÓN y OBSERVACIONES = instrucciones de
// cómo hacer el recibo (anticipo, abono, varias facturas con el valor de cada una).
// Solo lee: no interpreta (eso lo hace el motor de egresos).
import * as XLSX from "xlsx";

import { normalizar, type MovimientoPago } from "@/lib/egresos";
import { corregirRangoHoja } from "@/lib/spreadsheet";

const COLUMNAS: Record<keyof Omit<MovimientoPago, "clave" | "fila" | "terceroNit">, string[]> = {
  fecha: ["FECHA", "FECHA DE SISTEMA"],
  descripcion: ["DESCRIPCION", "DESCRIPCION MOTIVO"],
  tercero: ["TERCERO", "PROVEEDOR", "BENEFICIARIO"],
  valor: ["VALOR", "DOCUMENTO VALOR", "VALOR TOTAL"],
  cuenta: ["CUENTA", "LUGAR", "ORIGEN"],
  relacion: ["RELACION"],
  aplicacion: ["APLICACION"],
  observaciones: ["OBSERVACIONES"],
  referencia: ["REFERENCIA 1", "REFERENCIA"],
};

const MESES = [
  "ENERO",
  "FEBRERO",
  "MARZO",
  "ABRIL",
  "MAYO",
  "JUNIO",
  "JULIO",
  "AGOSTO",
  "SEPTIEMBRE",
  "OCTUBRE",
  "NOVIEMBRE",
  "DICIEMBRE",
];

/** «OCTUBRE 2026» → "2026-10". */
export function periodoDeNombre(nombre: string | null | undefined): string | null {
  const t = normalizar(nombre);
  const mes = MESES.findIndex(
    (m) => t.includes(m) || (m === "SEPTIEMBRE" && t.includes("SETIEMBRE")),
  );
  const anio = /\b(20\d{2})\b/.exec(t)?.[1];
  return mes >= 0 && anio ? `${anio}-${String(mes + 1).padStart(2, "0")}` : null;
}

const dos = (n: number) => String(n).padStart(2, "0");
function fechaCelda(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime()))
    return `${v.getFullYear()}-${dos(v.getMonth() + 1)}-${dos(v.getDate())}`;
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${dos(d.m)}-${dos(d.d)}` : null;
  }
  const t = String(v ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  return m ? `${m[3]}-${dos(Number(m[2]))}-${dos(Number(m[1]))}` : null;
}

function numeroCelda(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v ?? "").replace(/[$\s]/g, "");
  if (!t) return null;
  const n = Number(t.replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const texto = (v: unknown) => {
  const t = String(v ?? "").trim();
  return t ? t : null;
};

export type LecturaConsolidado = {
  periodo: string | null;
  hoja: string | null;
  egresos: MovimientoPago[];
  ingresos: number;
  advertencias: string[];
};

export function leerConsolidadoPagos(
  bytes: Uint8Array | ArrayBuffer,
  nombreArchivo?: string | null,
): LecturaConsolidado {
  const wb = XLSX.read(bytes, { type: "array", cellDates: true });
  const advertencias: string[] = [];
  const nombreHoja = wb.SheetNames.find((n) => /consolidado/i.test(n)) ?? null;
  if (!nombreHoja)
    return {
      periodo: periodoDeNombre(nombreArchivo),
      hoja: null,
      egresos: [],
      ingresos: 0,
      advertencias: ["El libro no tiene la hoja «Consolidado»."],
    };
  const hoja = corregirRangoHoja(wb.Sheets[nombreHoja]!);
  const filas = XLSX.utils.sheet_to_json<unknown[]>(hoja, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  });

  // Encabezado: la primera fila que tenga FECHA y VALOR.
  const iEnc = filas.findIndex((f) => {
    const n = (f ?? []).map((c) => normalizar(String(c ?? "")));
    return n.includes("FECHA") && n.some((c) => COLUMNAS.valor.includes(c));
  });
  if (iEnc < 0)
    return {
      periodo: periodoDeNombre(nombreArchivo),
      hoja: nombreHoja,
      egresos: [],
      ingresos: 0,
      advertencias: ["No se encontró el encabezado (FECHA, VALOR) en «Consolidado»."],
    };
  const enc = (filas[iEnc] ?? []).map((c) => normalizar(String(c ?? "")));
  const col = Object.fromEntries(
    Object.entries(COLUMNAS).map(([k, nombres]) => [k, enc.findIndex((c) => nombres.includes(c))]),
  ) as Record<keyof typeof COLUMNAS, number>;
  for (const k of ["fecha", "valor", "cuenta"] as const)
    if (col[k] < 0) advertencias.push(`Falta la columna ${COLUMNAS[k][0]} en «Consolidado».`);

  const egresos: MovimientoPago[] = [];
  const repetidas = new Map<string, number>();
  let ingresos = 0;
  const celda = (f: unknown[], k: keyof typeof COLUMNAS) => (col[k] >= 0 ? f[col[k]] : null);
  for (let i = iEnc + 1; i < filas.length; i++) {
    const f = filas[i] ?? [];
    const valor = numeroCelda(celda(f, "valor"));
    if (valor == null || valor === 0) continue;
    if (valor > 0) {
      ingresos += 1;
      continue;
    }
    const fecha = fechaCelda(celda(f, "fecha"));
    if (!fecha) {
      advertencias.push(`Fila ${i + 1}: pago sin fecha válida; no se leyó.`);
      continue;
    }
    const descripcion = texto(celda(f, "descripcion"));
    const cuenta = texto(celda(f, "cuenta"));
    const base = [
      fecha,
      Math.round(-valor * 100),
      normalizar(descripcion),
      normalizar(cuenta),
    ].join("|");
    const n = (repetidas.get(base) ?? 0) + 1;
    repetidas.set(base, n);
    egresos.push({
      clave: `consolidado|${base}|${n}`,
      fila: i + 1,
      fecha,
      descripcion,
      tercero: texto(celda(f, "tercero"))?.split(/\r?\n/)[0]?.trim() ?? null,
      terceroNit: null,
      valor: Math.round(-valor * 100) / 100,
      cuenta,
      relacion: texto(celda(f, "relacion")),
      aplicacion: texto(celda(f, "aplicacion")),
      observaciones: texto(celda(f, "observaciones")),
      referencia: texto(celda(f, "referencia")),
    });
  }
  // Periodo: el del nombre del archivo, o el mes más frecuente de las fechas.
  let periodo = periodoDeNombre(nombreArchivo);
  if (!periodo && egresos.length) {
    const cuenta = new Map<string, number>();
    for (const e of egresos)
      cuenta.set(e.fecha.slice(0, 7), (cuenta.get(e.fecha.slice(0, 7)) ?? 0) + 1);
    periodo = [...cuenta].sort((a, b) => b[1] - a[1])[0]![0];
  }
  return { periodo, hoja: nombreHoja, egresos, ingresos, advertencias };
}
