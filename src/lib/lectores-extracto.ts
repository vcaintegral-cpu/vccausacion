// Lectores de extractos y de la conciliación anterior (puros, sin red).
//   - Extracto Bancolombia exportado a Excel (cuenta corriente y de ahorros).
//   - Hojas del reporte mensual de pagos (Davivienda, Efectivo) para las empresas que
//     llevan ese reporte (función lector_consolidado_pagos).
//   - Extracto genérico: cualquier hoja con FECHA y VALOR (o DÉBITO/CRÉDITO, ENTRADA/SALIDA).
//   - Conciliación anterior: la que exporta la herramienta, o hojas «Falta en
//     contabilidad» / «Sobra en contabilidad».
import * as XLSX from "xlsx";

import { comprobantesEnTexto, type MovBanco, type PartidaConciliatoria } from "@/lib/conciliacion";
import { corregirRangoHoja } from "@/lib/spreadsheet";

export type Extracto = {
  movimientos: MovBanco[];
  saldoInicial: number | null;
  saldoFinal: number | null;
  cuentaNumero?: string | null;
  advertencias: string[];
};

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const N = (v: unknown) =>
  sinTildes(String(v ?? ""))
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const dos = (n: number) => String(n).padStart(2, "0");

/** Número escrito con coma de miles y punto decimal («1,007,400.00», «-$ 1,234.00», «.00»). */
export function numeroUS(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v ?? "").replace(/[$\s]/g, "");
  if (!t || !/\d/.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function fecha(v: unknown, anio?: number): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime()))
    return `${v.getFullYear()}-${dos(v.getMonth() + 1)}-${dos(v.getDate())}`;
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${dos(d.m)}-${dos(d.d)}` : null;
  }
  const t = String(v ?? "").trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${dos(Number(m[2]))}-${dos(Number(m[3]))}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) return `${m[3]}-${dos(Number(m[2]))}-${dos(Number(m[1]))}`;
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(t);
  if (m && anio) return `${anio}-${dos(Number(m[2]))}-${dos(Number(m[1]))}`;
  return null;
}

function filasDe(ws: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(corregirRangoHoja(ws), {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  });
}

export function libro(bytes: Uint8Array | ArrayBuffer) {
  return XLSX.read(bytes, { type: "array", cellDates: true });
}

/** Extracto Bancolombia exportado a Excel (encabezado, resumen y «Movimientos:»). */
export function leerExtractoBancolombia(
  bytes: Uint8Array | ArrayBuffer,
  prefijoId = "b",
): Extracto {
  const wb = libro(bytes);
  const filas = filasDe(wb.Sheets[wb.SheetNames[0]!]!);
  const advertencias: string[] = [];
  let anio: number | undefined;
  let cuentaNumero: string | null = null;
  let saldoInicial: number | null = null;
  let saldoFinal: number | null = null;
  let iMov = -1;
  for (let i = 0; i < filas.length; i++) {
    const f = (filas[i] ?? []).map(N);
    if (f[0] === "DESDE" && f[1] === "HASTA") {
      const sig = filas[i + 1] ?? [];
      const hasta = fecha(sig[1]);
      anio = hasta ? Number(hasta.slice(0, 4)) : undefined;
      const iNro = f.indexOf("NRO CUENTA");
      cuentaNumero = iNro >= 0 ? String(sig[iNro] ?? "").trim() || null : null;
    }
    if (f[0] === "SALDO ANTERIOR") {
      const sig = filas[i + 1] ?? [];
      saldoInicial = numeroUS(sig[0]);
      const iAct = f.indexOf("SALDO ACTUAL");
      saldoFinal = iAct >= 0 ? numeroUS(sig[iAct]) : null;
    }
    if (f[0] === "FECHA" && f.includes("VALOR")) {
      iMov = i;
      break;
    }
  }
  if (iMov < 0)
    return {
      movimientos: [],
      saldoInicial,
      saldoFinal,
      cuentaNumero,
      advertencias: ["No se encontró la tabla «Movimientos» del extracto."],
    };
  const enc = (filas[iMov] ?? []).map(N);
  const cFecha = enc.indexOf("FECHA");
  const cDesc = enc.findIndex((c) => c.startsWith("DESCRIPCION"));
  const cValor = enc.indexOf("VALOR");
  const cDoc = enc.findIndex((c) => c.startsWith("DCTO") || c.startsWith("DOCUMENTO"));
  const movimientos: MovBanco[] = [];
  for (let i = iMov + 1; i < filas.length; i++) {
    const f = filas[i] ?? [];
    if (N(f[cDesc]).startsWith("FIN ESTADO")) break;
    const valor = numeroUS(f[cValor]);
    const fch = fecha(f[cFecha], anio);
    if (valor == null || !fch) continue;
    movimientos.push({
      id: `${prefijoId}-${i}`,
      fecha: fch,
      descripcion: String(f[cDesc] ?? "").trim(),
      valor,
      refs: cDoc >= 0 ? comprobantesEnTexto(String(f[cDoc] ?? "")) : [],
    });
  }
  return { movimientos, saldoInicial, saldoFinal, cuentaNumero, advertencias };
}

/**
 * Hoja de un banco dentro del reporte mensual de pagos (p. ej. «Davivienda (B)»): FECHA,
 * DESCRIPCIÓN, VALOR y, si la trae, RELACIÓN con los comprobantes.
 */
export function leerHojaBanco(
  wb: XLSX.WorkBook,
  patronHoja: RegExp,
  prefijoId = "h",
): Extracto | null {
  const nombre = wb.SheetNames.find((n) => patronHoja.test(n));
  if (!nombre) return null;
  const filas = filasDe(wb.Sheets[nombre]!);
  const iEnc = filas.findIndex((f) => {
    const n = (f ?? []).map(N);
    return n.includes("FECHA") && n.includes("VALOR");
  });
  if (iEnc < 0)
    return {
      movimientos: [],
      saldoInicial: null,
      saldoFinal: null,
      advertencias: [`La hoja «${nombre}» no tiene FECHA y VALOR.`],
    };
  const enc = (filas[iEnc] ?? []).map(N);
  const c = {
    fecha: enc.indexOf("FECHA"),
    desc: enc.findIndex((x) => x.startsWith("DESCRIPCION")),
    valor: enc.indexOf("VALOR"),
    rel: enc.findIndex((x) => x.startsWith("RELACION")),
    apl: enc.findIndex((x) => x.startsWith("APLICACION")),
  };
  const movimientos: MovBanco[] = [];
  for (let i = iEnc + 1; i < filas.length; i++) {
    const f = filas[i] ?? [];
    if (/FIN DE REGISTROS/.test(N(f[0]))) break;
    const valor = typeof f[c.valor] === "number" ? (f[c.valor] as number) : numeroUS(f[c.valor]);
    const fch = fecha(f[c.fecha]);
    if (valor == null || !fch || valor === 0) continue;
    const rel = c.rel >= 0 ? String(f[c.rel] ?? "") : "";
    movimientos.push({
      id: `${prefijoId}-${i}`,
      fecha: fch,
      descripcion: String(f[c.desc] ?? "").trim(),
      valor,
      refs: comprobantesEnTexto(rel),
    });
  }
  return { movimientos, saldoInicial: null, saldoFinal: null, advertencias: [] };
}

/** Hoja «Efectivo» del reporte mensual: Fecha, Descripción, Entrada (± ), Saldo; saldo inicial en el encabezado. */
export function leerHojaEfectivo(wb: XLSX.WorkBook, prefijoId = "caja"): Extracto | null {
  const nombre = wb.SheetNames.find((n) => /efectivo|caja/i.test(n));
  if (!nombre) return null;
  const filas = filasDe(wb.Sheets[nombre]!);
  const iEnc = filas.findIndex((f) => {
    const n = (f ?? []).map(N);
    return n.includes("FECHA") && (n.includes("ENTRADA") || n.includes("VALOR"));
  });
  if (iEnc < 0)
    return {
      movimientos: [],
      saldoInicial: null,
      saldoFinal: null,
      advertencias: [`La hoja «${nombre}» no tiene Fecha y Entrada.`],
    };
  const encRaw = filas[iEnc] ?? [];
  const enc = encRaw.map(N);
  const cFecha = enc.indexOf("FECHA");
  const cDesc = enc.findIndex((x) => x.startsWith("DESCRIPCION"));
  const cValor = enc.includes("ENTRADA") ? enc.indexOf("ENTRADA") : enc.indexOf("VALOR");
  const cSaldo = enc.indexOf("SALDO");
  // Saldo inicial: el número escrito en el encabezado (p. ej. a la derecha de «Saldo»).
  const saldoInicial =
    encRaw.map((x) => (typeof x === "number" ? x : null)).find((x) => x != null) ?? null;
  const movimientos: MovBanco[] = [];
  let saldoFinal: number | null = null;
  for (let i = iEnc + 1; i < filas.length; i++) {
    const f = filas[i] ?? [];
    const valor = typeof f[cValor] === "number" ? (f[cValor] as number) : numeroUS(f[cValor]);
    const fch = fecha(f[cFecha]);
    if (cSaldo >= 0 && typeof f[cSaldo] === "number") saldoFinal = f[cSaldo] as number;
    if (valor == null || !fch || valor === 0) continue;
    movimientos.push({
      id: `${prefijoId}-${i}`,
      fecha: fch,
      descripcion: String(f[cDesc] ?? "").trim(),
      valor,
    });
  }
  return { movimientos, saldoInicial, saldoFinal, advertencias: [] };
}

/** Extracto genérico: FECHA + (VALOR | DÉBITO y CRÉDITO | ENTRADA y SALIDA). */
export function leerExtractoGenerico(bytes: Uint8Array | ArrayBuffer, prefijoId = "g"): Extracto {
  const wb = libro(bytes);
  for (const nombre of wb.SheetNames) {
    const filas = filasDe(wb.Sheets[nombre]!);
    const iEnc = filas.findIndex((f) => {
      const n = (f ?? []).map(N);
      return (
        n.includes("FECHA") &&
        (n.includes("VALOR") ||
          (n.includes("DEBITO") && n.includes("CREDITO")) ||
          n.includes("ENTRADA"))
      );
    });
    if (iEnc < 0) continue;
    const enc = (filas[iEnc] ?? []).map(N);
    const c = {
      fecha: enc.indexOf("FECHA"),
      desc: enc.findIndex(
        (x) => x.startsWith("DESCRIPCION") || x.startsWith("CONCEPTO") || x.startsWith("DETALLE"),
      ),
      valor: enc.indexOf("VALOR") >= 0 ? enc.indexOf("VALOR") : enc.indexOf("ENTRADA"),
      deb: enc.indexOf("DEBITO"),
      cred: enc.indexOf("CREDITO"),
      sal: enc.indexOf("SALIDA"),
    };
    const movimientos: MovBanco[] = [];
    for (let i = iEnc + 1; i < filas.length; i++) {
      const f = filas[i] ?? [];
      const fch = fecha(f[c.fecha]);
      if (!fch) continue;
      const num = (k: number) =>
        k < 0 ? null : typeof f[k] === "number" ? (f[k] as number) : numeroUS(f[k]);
      // En un extracto, CRÉDITO es lo que entra a la cuenta y DÉBITO lo que sale.
      const valor =
        c.valor >= 0 && c.sal < 0
          ? num(c.valor)
          : (num(c.cred) ?? num(c.valor) ?? 0) - (num(c.deb) ?? num(c.sal) ?? 0);
      if (valor == null || valor === 0) continue;
      movimientos.push({
        id: `${prefijoId}-${i}`,
        fecha: fch,
        descripcion: String(f[c.desc] ?? "").trim(),
        valor,
      });
    }
    return { movimientos, saldoInicial: null, saldoFinal: null, advertencias: [] };
  }
  return {
    movimientos: [],
    saldoInicial: null,
    saldoFinal: null,
    advertencias: ["No se encontró una hoja con FECHA y VALOR."],
  };
}

/**
 * Relación de cada movimiento en la hoja «Consolidado» del reporte mensual: cuenta, fecha,
 * valor y comprobantes (RC-1-…, RP-…) para citarlos en el extracto.
 */
export function relacionesConsolidado(
  wb: XLSX.WorkBook,
): Array<{ cuenta: string; fecha: string; valor: number; refs: string[]; tercero: string | null }> {
  const nombre = wb.SheetNames.find((n) => /consolidado/i.test(n));
  if (!nombre) return [];
  const filas = filasDe(wb.Sheets[nombre]!);
  const iEnc = filas.findIndex((f) => (f ?? []).map(N).includes("FECHA"));
  if (iEnc < 0) return [];
  const enc = (filas[iEnc] ?? []).map(N);
  const c = {
    fecha: enc.indexOf("FECHA"),
    valor: enc.indexOf("VALOR"),
    cuenta: enc.indexOf("CUENTA"),
    rel: enc.findIndex((x) => x.startsWith("RELACION")),
    ter: enc.indexOf("TERCERO"),
  };
  const out: Array<{
    cuenta: string;
    fecha: string;
    valor: number;
    refs: string[];
    tercero: string | null;
  }> = [];
  for (let i = iEnc + 1; i < filas.length; i++) {
    const f = filas[i] ?? [];
    const fch = fecha(f[c.fecha]);
    const valor = typeof f[c.valor] === "number" ? (f[c.valor] as number) : numeroUS(f[c.valor]);
    if (!fch || valor == null) continue;
    const refs = comprobantesEnTexto(String(f[c.rel] ?? ""));
    const tercero =
      c.ter >= 0
        ? String(f[c.ter] ?? "")
            .split(/\r?\n/)[0]!
            .trim() || null
        : null;
    if (refs.length || tercero)
      out.push({ cuenta: N(f[c.cuenta]), fecha: fch, valor, refs, tercero });
  }
  return out;
}

/** Cita en el extracto los comprobantes y terceros de la relación (misma cuenta, fecha y valor). */
export function citarRelaciones(
  movimientos: MovBanco[],
  relaciones: Array<{
    cuenta: string;
    fecha: string;
    valor: number;
    refs: string[];
    tercero: string | null;
  }>,
  cuenta: string,
): MovBanco[] {
  const k = N(cuenta);
  const pool = relaciones.filter((r) => r.cuenta === k);
  const usadas = new Set<number>();
  return movimientos.map((m) => {
    const i = pool.findIndex(
      (r, j) => !usadas.has(j) && r.fecha === m.fecha && Math.abs(r.valor - m.valor) < 0.01,
    );
    if (i < 0) return m;
    usadas.add(i);
    return {
      ...m,
      refs: [...new Set([...(m.refs ?? []), ...pool[i]!.refs])],
      tercero: m.tercero ?? pool[i]!.tercero,
    };
  });
}

/** Conciliación anterior: partidas por cuenta. Sin columna de cuenta, todas van a `cuentaPorDefecto`. */
export function leerConciliacionAnterior(
  bytes: Uint8Array | ArrayBuffer,
  cuentaPorDefecto: string,
): { porCuenta: Map<string, PartidaConciliatoria[]>; advertencias: string[] } {
  const wb = libro(bytes);
  const porCuenta = new Map<string, PartidaConciliatoria[]>();
  const advertencias: string[] = [];
  const agregar = (cuenta: string, p: PartidaConciliatoria) => {
    const k = N(cuenta) || N(cuentaPorDefecto);
    porCuenta.set(k, [...(porCuenta.get(k) ?? []), p]);
  };
  for (const nombre of wb.SheetNames) {
    const hoja = N(nombre);
    const filas = filasDe(wb.Sheets[nombre]!);
    const iEnc = filas.findIndex((f) => (f ?? []).map(N).includes("FECHA"));
    if (iEnc < 0) continue;
    const enc = (filas[iEnc] ?? []).map(N);
    const col = (...ns: string[]) =>
      enc.findIndex((x) => ns.some((n) => x === n || x.startsWith(n)));
    const c = {
      cuenta: col("CUENTA", "BANCO"),
      tipo: col("TIPO"),
      fecha: col("FECHA"),
      desc: col("DESCRIPCION", "CONCEPTO"),
      comp: col("COMPROBANTE"),
      ter: col("TERCERO"),
      valor: col("VALOR"),
      ingreso: col("INGRESO"),
      salida: col("SALIDA"),
      deb: col("DEBITO"),
      cred: col("CREDITO"),
    };
    // Formato de la hoja: tipo por columna, o por el nombre de la hoja.
    const tipoHoja: PartidaConciliatoria["tipo"] | null = /FALTA EN CONTAB|BANCO SIN LIBRO/.test(
      hoja,
    )
      ? "banco_sin_libros"
      : /SOBRA EN CONTAB|LIBROS SIN BANCO/.test(hoja)
        ? "libros_sin_banco"
        : null;
    if (c.tipo < 0 && !tipoHoja) continue;
    for (let i = iEnc + 1; i < filas.length; i++) {
      const f = filas[i] ?? [];
      const fch = fecha(f[c.fecha]);
      if (!fch) continue;
      const num = (k: number) =>
        k < 0 ? null : typeof f[k] === "number" ? (f[k] as number) : numeroUS(f[k]);
      let tipo: PartidaConciliatoria["tipo"] | null = tipoHoja;
      if (c.tipo >= 0) {
        const t = N(f[c.tipo]);
        tipo = /LIBRO.*SIN.*BANCO|SOBRA/.test(t)
          ? "libros_sin_banco"
          : /BANCO.*SIN.*LIBRO|FALTA/.test(t)
            ? "banco_sin_libros"
            : /DIFERENCIA/.test(t)
              ? "diferencia"
              : tipo;
      }
      if (!tipo) continue;
      const valor =
        num(c.valor) ??
        (tipo === "libros_sin_banco"
          ? (num(c.deb) ?? 0) - (num(c.cred) ?? 0)
          : (num(c.ingreso) ?? 0) - (num(c.salida) ?? 0));
      if (!valor) continue;
      agregar(c.cuenta >= 0 ? String(f[c.cuenta] ?? "") : "", {
        tipo,
        fecha: fch,
        descripcion: String(f[c.desc] ?? "").trim(),
        comprobante: c.comp >= 0 ? String(f[c.comp] ?? "").trim() || null : null,
        tercero: c.ter >= 0 ? String(f[c.ter] ?? "").trim() || null : null,
        valor,
      });
    }
  }
  if (!porCuenta.size)
    advertencias.push("No se encontraron partidas conciliatorias en el archivo.");
  return { porCuenta, advertencias };
}
