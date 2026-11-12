// Papel de trabajo de la conciliación en el formato de la firma (función de perfil
// «reporte_conciliacion_firma»): un libro por cuenta con dos hojas.
//   «Reporte Conciliación»: resumen (libros + columna D − columna E = extracto), movimiento
//     del mes extracto vs libros, partidas del extracto que no están en el auxiliar, partidas
//     del auxiliar que no figuran en el extracto, resumen por tipo, gastos bancarios del mes,
//     observaciones y firmas. Las cifras del resumen se alimentan por fórmula de la hoja de
//     trabajo.
//   «CONCILIACION <MES>»: hoja de trabajo (FECHA, DESCRIPCION, # REF, VALOR AUXILIAR, VALOR
//     EXTRACTO, OBSERVACION): saldo final, arrastre de meses anteriores, columna D (en el
//     extracto y faltan en el auxiliar), columna E (en el auxiliar y no en el extracto) y
//     total con la diferencia (debe ser cero).
// El mismo archivo se vuelve a leer el mes siguiente como conciliación anterior.
import * as XLSX from "xlsx";

import {
  esGastoBancario,
  type MovBanco,
  type MovLibro,
  type PartidaConciliatoria,
} from "@/lib/conciliacion";
import { roundCOP } from "@/lib/money";

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

export type DatosReporte = {
  empresa: { nombre: string; nit: string | null };
  etiqueta: string;
  cuentaContable: string | null;
  /** Número de la cuenta bancaria (del extracto), si se conoce. */
  cuentaNumero: string | null;
  /** Caja: planilla de efectivo en lugar de extracto bancario. */
  esCaja: boolean;
  periodo: string; // yyyy-MM
  saldoLibrosInicial: number | null;
  saldoLibrosFinal: number | null;
  saldoExtractoInicial: number | null;
  saldoExtractoFinal: number | null;
  /** Movimientos del extracto del mes (sin partidas del corte anterior). */
  extracto: MovBanco[];
  /** Movimientos de libros del mes (sin partidas del corte anterior). */
  libros: MovLibro[];
  /** Partidas al corte (con nota de la usuaria). */
  partidas: PartidaConciliatoria[];
  /** Verificaciones del arrastre (saldos iniciales vs conciliación anterior). */
  verificaciones?: Array<{ nivel: string; texto: string }>;
};

const fin = (periodo: string) => {
  const [a, m] = periodo.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(a, m, 0));
};
const ddmmyyyy = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
const fechaCelda = (iso: string) => {
  const [a, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(a, m - 1, d, 12));
};
const pesos = (n: number) =>
  n.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Columna de la hoja de trabajo: D (ajusta los libros) o E (ajusta el extracto). */
export const columnaDe = (p: PartidaConciliatoria): "D" | "E" =>
  p.tipo === "libros_sin_banco" ? "E" : "D";

function estadoYAccion(p: PartidaConciliatoria, anterior: boolean, esCaja: boolean) {
  const fuente = esCaja ? "la planilla" : "el extracto";
  if (p.tipo === "diferencia")
    return { estado: "AJUSTAR EN LIBROS", accion: "Ajustar la diferencia en Siigo." };
  if (p.tipo === "libros_sin_banco")
    return p.valor > 0
      ? {
          estado: anterior ? "PENDIENTE" : "EN TRÁNSITO",
          accion: `Verificar el abono en ${fuente} del mes siguiente.`,
        }
      : {
          estado: anterior ? "PENDIENTE" : "EN TRÁNSITO",
          accion: `Verificar el cargo en ${fuente} del mes siguiente (pago en tránsito).`,
        };
  return p.valor < 0
    ? {
        estado: anterior ? "PENDIENTE" : "POR REGISTRAR",
        accion: "Elaborar el recibo de pago (RP) en Siigo.",
      }
    : {
        estado: anterior ? "PENDIENTE" : "POR IDENTIFICAR",
        accion: "Identificar el tercero y elaborar el recibo de caja (RC).",
      };
}

function tipoResumen(p: PartidaConciliatoria, anterior: boolean, esCaja: boolean) {
  if (anterior)
    return {
      tipo: "Arrastre de meses anteriores",
      accion: "Depurar: registrar o definir su tratamiento.",
    };
  if (p.tipo === "diferencia")
    return { tipo: "Diferencias de valor (RC/RP vs banco)", accion: "Ajustar en Siigo." };
  if (p.tipo === "libros_sin_banco")
    return {
      tipo: `Registros del auxiliar sin movimiento en ${esCaja ? "la planilla" : "el extracto"}`,
      accion: "Verificar en el mes siguiente.",
    };
  return p.valor < 0
    ? {
        tipo: "Egresos del mes sin registrar en libros",
        accion: "Elaborar los recibos de pago (RP).",
      }
    : {
        tipo: "Ingresos del mes sin recibo de caja",
        accion: "Identificar y elaborar los recibos de caja (RC).",
      };
}

const conceptoGasto = (d: string) =>
  d
    .toUpperCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b\d[\d.,/-]*\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Nombre de la hoja de trabajo («CONCILIACION OCTUBRE»). */
export const hojaTrabajo = (periodo: string) =>
  `CONCILIACION ${MESES[Number(periodo.slice(5, 7)) - 1] ?? ""}`.trim();

/** Nombre del archivo («CONCILIACION_CORRIENTE_9677_al_31_DE_OCTUBRE_2026.xlsx»). */
export function nombreArchivo(
  d: Pick<DatosReporte, "etiqueta" | "cuentaNumero" | "periodo" | "esCaja">,
) {
  const f = fin(d.periodo);
  const num = (d.cuentaNumero ?? "").replace(/\D/g, "").slice(-4);
  const base = `${d.esCaja ? "EFECTIVO_" : ""}${d.etiqueta}${num ? `_${num}` : ""}`
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9]+/g, "_");
  return `CONCILIACION_${base}_al_${f.getUTCDate()}_DE_${MESES[f.getUTCMonth()]}_${f.getUTCFullYear()}.xlsx`;
}

type Celda = string | number | Date | null | { f?: string; v?: number | string; z?: string };

function hoja(filas: Celda[][], anchos: number[], merges: XLSX.Range[] = []): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  let maxC = 0;
  filas.forEach((fila, r) => {
    fila.forEach((v, c) => {
      if (v == null || v === "") return;
      const ref = XLSX.utils.encode_cell({ r, c });
      if (v instanceof Date) ws[ref] = { t: "d", v, z: "dd/mm/yyyy" };
      else if (typeof v === "number") ws[ref] = { t: "n", v, z: "#,##0.00" };
      else if (typeof v === "object")
        ws[ref] = {
          t: typeof v.v === "string" ? "s" : "n",
          ...(v.f ? { f: v.f } : {}),
          ...(v.v != null ? { v: v.v } : {}),
          z: v.z ?? "#,##0.00",
        };
      else ws[ref] = { t: "s", v };
      maxC = Math.max(maxC, c);
    });
  });
  ws["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: Math.max(filas.length - 1, 0), c: maxC },
  });
  ws["!cols"] = anchos.map((wch) => ({ wch }));
  if (merges.length) ws["!merges"] = merges;
  return ws;
}

/** Libro de la conciliación de una cuenta en el formato de la firma. */
export function libroConciliacionFirma(d: DatosReporte): XLSX.WorkBook {
  const corte = fin(d.periodo);
  const inicioMes = `${d.periodo}-01`;
  const anteriorFin = new Date(Date.UTC(corte.getUTCFullYear(), corte.getUTCMonth(), 0));
  const mes = MESES[corte.getUTCMonth()]!;
  const anio = corte.getUTCFullYear();
  const lado = d.esCaja ? "planilla" : "extracto";
  const LADO = d.esCaja ? "PLANILLA" : "EXTRACTO";
  const nombreHoja = hojaTrabajo(d.periodo);
  const ref = (c: string) => `'${nombreHoja}'!${c}`;
  const esAnterior = (p: PartidaConciliatoria) => !!p.fecha && p.fecha < inicioMes;
  const partidas = d.partidas.filter((p) => Math.abs(p.valor) >= 0.01);
  const anteriores = partidas.filter(esAnterior);
  const delMesD = partidas.filter((p) => !esAnterior(p) && columnaDe(p) === "D");
  const delMesE = partidas.filter((p) => !esAnterior(p) && columnaDe(p) === "E");
  const libros = roundCOP(d.saldoLibrosFinal ?? 0);
  const extracto = roundCOP(d.saldoExtractoFinal ?? 0);

  // ---------------- Hoja de trabajo ----------------
  const t: Celda[][] = [];
  t.push([
    `CONCILIACION ${d.esCaja ? "EFECTIVO " : ""}${d.etiqueta.toUpperCase()}${d.cuentaNumero ? ` N° ${d.cuentaNumero}` : ""}  —  ${mes} ${anio}`,
    null,
    null,
    null,
    null,
    null,
    "OBSERVACION",
  ]);
  t.push([]);
  t.push([
    "FECHA",
    "DESCRIPCION",
    "# REF",
    "VALOR AUXILIAR",
    `VALOR ${d.esCaja ? "EFECTIVO" : "EXTRACTO"}`,
    null,
    "OBSERVACION",
  ]);
  t.push([
    null,
    `SALDO FINAL ${ddmmyyyy(corte)}`,
    null,
    libros,
    extracto,
    null,
    `Auxiliar ${d.cuentaContable ?? ""}: saldo final ${pesos(libros)}.  |  ${d.esCaja ? "Planilla" : "Extracto"}: saldo final ${pesos(extracto)}.`,
  ]);
  const filaDesde = t.length + 1; // primera fila de partidas (1-based)
  const filaPartida = (p: PartidaConciliatoria) => {
    const col = columnaDe(p);
    return [
      p.fecha ? fechaCelda(p.fecha) : null,
      p.descripcion,
      p.comprobante ?? null,
      col === "D" ? roundCOP(p.valor) : null,
      col === "E" ? roundCOP(p.valor) : null,
      null,
      p.nota ?? estadoYAccion(p, esAnterior(p), d.esCaja).accion,
    ] as Celda[];
  };
  t.push([
    null,
    `PARTIDAS PENDIENTES DE MESES ANTERIORES  (arrastre de la conciliación al ${ddmmyyyy(anteriorFin)})`,
  ]);
  if (anteriores.length) for (const p of anteriores) t.push(filaPartida(p));
  else t.push([null, "NINGUNA"]);
  t.push([
    null,
    `${mes} ${anio} — COLUMNA D: ${d.esCaja ? "MOVIMIENTOS DE LA PLANILLA QUE FALTAN EN EL AUXILIAR" : "EN EL EXTRACTO Y FALTAN EN EL AUXILIAR"}`,
  ]);
  for (const p of delMesD) t.push(filaPartida(p));
  t.push([
    null,
    `${mes} ${anio} — COLUMNA E: MOVIMIENTOS DEL AUXILIAR QUE NO CRUZAN CON ${d.esCaja ? "LA PLANILLA" : "EL EXTRACTO"}`,
  ]);
  for (const p of delMesE) t.push(filaPartida(p));
  const filaHasta = t.length; // última fila de partidas (1-based)
  t.push([]);
  const sumaD = roundCOP(
    partidas.filter((p) => columnaDe(p) === "D").reduce((s, p) => s + p.valor, 0),
  );
  const sumaE = roundCOP(
    partidas.filter((p) => columnaDe(p) === "E").reduce((s, p) => s + p.valor, 0),
  );
  const totD = roundCOP(libros + sumaD);
  const totE = roundCOP(extracto + sumaE);
  const filaTotal = t.length + 1;
  t.push([
    null,
    "TOTAL",
    null,
    { f: `D4+SUM(D${filaDesde}:D${filaHasta})`, v: totD },
    { f: `E4+SUM(E${filaDesde}:E${filaHasta})`, v: totE },
    "DIFERENCIA →",
    { f: `D${filaTotal}-E${filaTotal}`, v: roundCOP(totD - totE) },
  ]);
  t.push([
    null,
    null,
    null,
    null,
    null,
    null,
    {
      f: `IF(ABS(G${filaTotal})<1,"✔  CONCILIADO - LA DIFERENCIA ES CERO","✖  REVISAR - QUEDA DIFERENCIA")`,
      v:
        Math.abs(totD - totE) < 1
          ? "✔  CONCILIADO - LA DIFERENCIA ES CERO"
          : "✖  REVISAR - QUEDA DIFERENCIA",
    },
  ]);
  t.push([]);
  t.push(["NOTAS DEL CIERRE"]);
  t.push([
    `1) Libros ${pesos(libros)} + columna D ${pesos(sumaD)} − columna E ${pesos(sumaE)} = ${pesos(roundCOP(libros + sumaD - sumaE))}; ${lado} ${pesos(extracto)}.`,
  ]);
  const wsTrabajo = hoja(t, [12, 60, 22, 18, 18, 14, 70]);

  // ---------------- Reporte ----------------
  const r: Celda[][] = [];
  const fila = (...celdas: Celda[]) => r.push([null, ...celdas]);
  const enJ = (texto: string, valor: Celda) =>
    r.push([null, texto, null, null, null, null, null, null, null, valor]);
  r.push([]);
  fila(d.empresa.nombre);
  fila(d.empresa.nit ? `NIT ${d.empresa.nit}` : "");
  fila(d.esCaja ? "CONCILIACIÓN DE EFECTIVO" : "CONCILIACIÓN BANCARIA");
  fila(
    `${d.etiqueta}${d.cuentaNumero ? ` N° ${d.cuentaNumero}` : ""}   |   Cuenta contable ${d.cuentaContable ?? "—"}${d.esCaja ? "   |   Planilla de efectivo vs auxiliar contable" : ""}`,
  );
  fila(
    `Fecha de corte: ${corte.getUTCDate()} de ${mes.toLowerCase()} de ${anio}   |   Cifras en pesos colombianos (COP)`,
  );
  r.push([]);
  fila("1.  RESUMEN DE LA CONCILIACIÓN");
  enJ(
    `Saldo según libros contables al ${ddmmyyyy(corte)} — auxiliar cuenta ${d.cuentaContable ?? ""}`,
    { f: ref("D4"), v: libros },
  );
  enJ(
    `(+/−) Partidas ${d.esCaja ? "de la planilla" : "del extracto"} que no están en el auxiliar (columna D)`,
    { f: `SUM(${ref(`D${filaDesde}:D${filaHasta}`)})`, v: sumaD },
  );
  enJ(
    `(−) Partidas del auxiliar que no figuran en ${d.esCaja ? "la planilla" : "el extracto"} (columna E)`,
    { f: `SUM(${ref(`E${filaDesde}:E${filaHasta}`)})`, v: sumaE },
  );
  enJ("Saldo en libros ajustado", { f: "J9+J10-J11", v: roundCOP(libros + sumaD - sumaE) });
  enJ(
    `Saldo según ${d.esCaja ? "planilla de efectivo" : "extracto bancario"} al ${ddmmyyyy(corte)}`,
    { f: ref("E4"), v: extracto },
  );
  enJ("Diferencia por conciliar", { f: "J12-J13", v: roundCOP(libros + sumaD - sumaE - extracto) });
  enJ("Estado de la conciliación", {
    f: 'IF(ABS(J14)<1,"✔  CONCILIADO","✖  REVISAR")',
    v: Math.abs(libros + sumaD - sumaE - extracto) < 1 ? "✔  CONCILIADO" : "✖  REVISAR",
  });
  r.push([]);

  // 2. Movimiento del mes.
  const abonos = roundCOP(d.extracto.filter((m) => m.valor > 0).reduce((s, m) => s + m.valor, 0));
  const cargos = roundCOP(d.extracto.filter((m) => m.valor < 0).reduce((s, m) => s + m.valor, 0));
  const debitos = roundCOP(d.libros.filter((m) => m.valor > 0).reduce((s, m) => s + m.valor, 0));
  const creditos = roundCOP(d.libros.filter((m) => m.valor < 0).reduce((s, m) => s + m.valor, 0));
  fila(`2.  MOVIMIENTO DEL MES  —  ${LADO} vs LIBROS`);
  const fMov = r.length + 1;
  r.push([
    null,
    "Concepto",
    null,
    null,
    null,
    null,
    `Según ${lado}`,
    "Según libros",
    null,
    "Diferencia",
  ]);
  const movFila = (concepto: string, a: number | null, b: number | null) => {
    const n = r.length + 1;
    r.push([
      null,
      concepto,
      null,
      null,
      null,
      null,
      a,
      b,
      null,
      { f: `H${n}-G${n}`, v: roundCOP((b ?? 0) - (a ?? 0)) },
    ]);
  };
  movFila(
    `Saldo anterior al ${ddmmyyyy(anteriorFin)}`,
    d.saldoExtractoInicial,
    d.saldoLibrosInicial,
  );
  movFila("(+) Total abonos / débitos", abonos, debitos);
  movFila("(−) Total cargos / créditos", cargos, creditos);
  movFila(`(=) Saldo al ${ddmmyyyy(corte)}`, d.saldoExtractoFinal, d.saldoLibrosFinal);
  void fMov;
  r.push([]);

  // 3 y 4. Partidas de cada lado.
  const seccion = (
    titulo: string,
    tituloDesc: string,
    lista: PartidaConciliatoria[],
    totalTitulo: string,
  ) => {
    fila(titulo);
    r.push([
      null,
      "N°",
      "Fecha",
      tituloDesc,
      "# Ref.",
      null,
      "Valor",
      "Período",
      "Estado",
      "Observación / acción requerida",
    ]);
    const desde = r.length + 1;
    lista.forEach((p, i) => {
      const anterior = esAnterior(p);
      const ea = estadoYAccion(p, anterior, d.esCaja);
      r.push([
        null,
        { v: i + 1, z: "0" },
        p.fecha ? fechaCelda(p.fecha) : null,
        p.descripcion,
        p.comprobante ?? null,
        null,
        roundCOP(p.valor),
        p.fecha ? (MESES[Number(p.fecha.slice(5, 7)) - 1] ?? "") : "",
        ea.estado,
        p.nota ?? ea.accion,
      ]);
    });
    const hasta = r.length;
    const total = roundCOP(lista.reduce((s, p) => s + p.valor, 0));
    r.push([
      null,
      totalTitulo,
      null,
      null,
      null,
      null,
      lista.length ? { f: `SUM(G${desde}:G${hasta})`, v: total } : 0,
      `${lista.length} partidas`,
    ]);
    r.push([]);
  };
  seccion(
    d.esCaja
      ? "3.  MOVIMIENTOS DE LA PLANILLA QUE NO ESTÁN EN EL AUXILIAR   (se suman o restan al saldo en libros)"
      : "3.  PARTIDAS DEL EXTRACTO QUE NO ESTÁN EN EL AUXILIAR   (se suman o restan al saldo en libros)",
    d.esCaja ? "Descripción en la planilla" : "Descripción del movimiento bancario",
    partidas.filter((p) => columnaDe(p) === "D"),
    d.esCaja
      ? "TOTAL PARTIDAS DE LA PLANILLA NO REGISTRADAS EN LIBROS"
      : "TOTAL PARTIDAS DEL EXTRACTO NO REGISTRADAS EN LIBROS",
  );
  seccion(
    d.esCaja
      ? "4.  MOVIMIENTOS DEL AUXILIAR QUE NO FIGURAN EN LA PLANILLA   (se restan del saldo en libros)"
      : "4.  PARTIDAS DEL AUXILIAR QUE NO FIGURAN EN EL EXTRACTO   (se restan del saldo en libros)",
    "Concepto registrado en el auxiliar",
    partidas.filter((p) => columnaDe(p) === "E"),
    d.esCaja
      ? "TOTAL PARTIDAS DEL AUXILIAR NO REFLEJADAS EN LA PLANILLA"
      : "TOTAL PARTIDAS DEL AUXILIAR NO REFLEJADAS EN EL EXTRACTO",
  );

  // 5. Resumen por tipo.
  fila("5.  RESUMEN POR TIPO DE PARTIDA");
  r.push([
    null,
    "Tipo de partida",
    null,
    null,
    null,
    "Cant.",
    "Valor",
    "% Partic.",
    "Acción requerida",
  ]);
  const grupos = new Map<string, { cant: number; valor: number; accion: string }>();
  for (const p of partidas) {
    const g = tipoResumen(p, esAnterior(p), d.esCaja);
    const x = grupos.get(g.tipo) ?? { cant: 0, valor: 0, accion: g.accion };
    x.cant += 1;
    x.valor = roundCOP(x.valor + p.valor);
    grupos.set(g.tipo, x);
  }
  const totalAbs = [...grupos.values()].reduce((s, g) => s + Math.abs(g.valor), 0) || 1;
  const dRes = r.length + 1;
  for (const [tipo, g] of grupos)
    r.push([
      null,
      tipo,
      null,
      null,
      null,
      g.cant,
      g.valor,
      {
        f: `ABS(G${r.length + 1})/${pesosNum(totalAbs)}`,
        v: Math.abs(g.valor) / totalAbs,
        z: "0.0%",
      },
      g.accion,
    ]);
  const hRes = r.length;
  r.push([
    null,
    "TOTAL",
    null,
    null,
    null,
    partidas.length,
    grupos.size
      ? { f: `SUM(G${dRes}:G${hRes})`, v: roundCOP(partidas.reduce((s, p) => s + p.valor, 0)) }
      : 0,
    { v: 1, z: "0.0%" },
    partidas.length ? "✔  Cuadra con el detalle" : "Sin partidas conciliatorias",
  ]);
  r.push([]);

  // 6. Gastos bancarios del mes (según extracto).
  let n = 6;
  if (!d.esCaja) {
    const gastos = new Map<string, { valor: number; cant: number }>();
    for (const m of d.extracto)
      if (esGastoBancario(m.descripcion) || /RENDIMIENTO|ABONO INTERES/i.test(m.descripcion)) {
        const k = conceptoGasto(m.descripcion);
        const x = gastos.get(k) ?? { valor: 0, cant: 0 };
        x.valor = roundCOP(x.valor + m.valor);
        x.cant += 1;
        gastos.set(k, x);
      }
    fila("6.  COMPOSICIÓN DE LOS GASTOS BANCARIOS DEL MES (según extracto)");
    r.push([null, "N°", "Concepto", null, null, null, "Valor", "Cant."]);
    const dg = r.length + 1;
    [...gastos].forEach(([k, g], i) =>
      r.push([null, { v: i + 1, z: "0" }, k, null, null, null, g.valor, { v: g.cant, z: "0" }]),
    );
    const hg = r.length;
    r.push([
      null,
      null,
      "TOTAL NETO DEL MES",
      null,
      null,
      null,
      gastos.size
        ? {
            f: `SUM(G${dg}:G${hg})`,
            v: roundCOP([...gastos.values()].reduce((s, g) => s + g.valor, 0)),
          }
        : 0,
      { v: [...gastos.values()].reduce((s, g) => s + g.cant, 0), z: "0" },
    ]);
    r.push([]);
    n = 7;
  }

  // 7. Observaciones.
  fila(`${n}.  OBSERVACIONES Y CONCLUSIÓN`);
  const dif = roundCOP(libros + sumaD - sumaE - extracto);
  fila(
    Math.abs(dif) < 1
      ? `•  La conciliación cierra en $0,00. El saldo en libros ajustado coincide con el saldo ${d.esCaja ? "de la planilla de efectivo" : "del extracto"} al ${ddmmyyyy(corte)}.`
      : `•  Queda una diferencia sin explicar de ${pesos(dif)}: revisar antes de cerrar el mes.`,
  );
  if (d.saldoExtractoInicial != null && d.saldoLibrosInicial != null)
    fila(
      `•  Saldo anterior: ${lado} ${pesos(d.saldoExtractoInicial)} y libros ${pesos(d.saldoLibrosInicial)} (diferencia ${pesos(roundCOP(d.saldoExtractoInicial - d.saldoLibrosInicial))}, explicada por las partidas del corte anterior).`,
    );
  for (const [tipo, g] of grupos)
    fila(`•  ${tipo}: ${g.cant} partida(s) por ${pesos(g.valor)}. ${g.accion}`);
  for (const v of d.verificaciones ?? [])
    fila(`•  ${v.nivel === "error" ? "REVISAR" : "Atención"}: ${v.texto}`);
  r.push([]);
  r.push([]);
  r.push([
    null,
    null,
    "_______________________________",
    null,
    null,
    "_______________________________",
    null,
    null,
    "_______________________________",
  ]);
  r.push([null, null, "Elaboró", null, null, "Revisó", null, null, "Aprobó"]);
  r.push([]);
  fila(
    `Documento generado por la herramienta a partir de la hoja «${nombreHoja}». Fuentes: ${d.esCaja ? "planilla de efectivo" : "extracto bancario"} del mes, movimiento de Siigo de la cuenta ${d.cuentaContable ?? ""} y conciliación del mes anterior.`,
  );
  const wsReporte = hoja(r, [3, 6, 12, 48, 20, 8, 18, 18, 18, 60]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsReporte, "Reporte Conciliación");
  XLSX.utils.book_append_sheet(wb, wsTrabajo, nombreHoja.slice(0, 31));
  return wb;
}

const pesosNum = (n: number) => String(roundCOP(n));
