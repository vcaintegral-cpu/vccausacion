// Extractos bancarios en PDF (núcleo global). El texto se extrae en el navegador
// (extracto-pdf-navegador.ts, pdfjs) y aquí se interpreta de forma pura:
//   - lineasPdf: agrupa los fragmentos de texto por página y renglón;
//   - leerExtractoDaviviendaPdf: extracto de Davivienda (cuenta de ahorros/corriente):
//     «INFORME DEL MES: OCTUBRE /2026», saldo anterior / nuevo saldo y movimientos
//     «DD MM $ valor ± doc clase de movimiento oficina»;
//   - compararExtractos: el extracto oficial contra la relación que reporta la empresa
//     (movimientos que faltan o sobran en la relación) y pasa las referencias (RC/RP)
//     citadas en la relación al extracto oficial.
import { roundCOP } from "@/lib/money";
import type { MovBanco } from "@/lib/conciliacion";
import type { Extracto } from "@/lib/lectores-extracto";

export type ItemPdf = { pagina: number; x: number; y: number; texto: string };
export type LineaPdf = { pagina: number; y: number; celdas: Array<{ x: number; texto: string }> };

/** Fragmentos → renglones (misma página, altura a ±2 puntos), de arriba abajo e izquierda a derecha. */
export function lineasPdf(items: ItemPdf[]): LineaPdf[] {
  const orden = items
    .filter((i) => i.texto.trim())
    .sort((a, b) => a.pagina - b.pagina || b.y - a.y || a.x - b.x);
  const out: LineaPdf[] = [];
  for (const i of orden) {
    const ult = out[out.length - 1];
    if (ult && ult.pagina === i.pagina && Math.abs(ult.y - i.y) <= 2)
      ult.celdas.push({ x: i.x, texto: i.texto.trim() });
    else out.push({ pagina: i.pagina, y: i.y, celdas: [{ x: i.x, texto: i.texto.trim() }] });
  }
  for (const l of out) l.celdas.sort((a, b) => a.x - b.x);
  return out;
}

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
const montoUS = (t: string) => {
  const n = Number(t.replace(/[$\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * Extracto de Davivienda en PDF. Los movimientos traen día y mes; el año sale de «INFORME
 * DEL MES». Valida saldo anterior + movimientos = nuevo saldo (advertencia si no cuadra).
 */
export function leerExtractoDaviviendaPdf(items: ItemPdf[], prefijoId = "dv"): Extracto {
  const lineas = lineasPdf(items);
  const texto = (l: LineaPdf) =>
    l.celdas
      .map((c) => c.texto)
      .join(" ")
      .replace(/\s+/g, " ");
  let anio: number | null = null;
  let mesInforme: number | null = null;
  let saldoInicial: number | null = null;
  let saldoFinal: number | null = null;
  let cuentaNumero: string | null = null;
  const movimientos: MovBanco[] = [];
  const advertencias: string[] = [];
  for (const l of lineas) {
    const t = texto(l);
    const inf = /INFORME DEL MES:?\s*([A-ZÁÉÍÓÚ]+)\s*\/?\s*(\d{4})/i.exec(t);
    if (inf) {
      const m = MESES.indexOf(inf[1]!.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, ""));
      if (m >= 0) mesInforme = m + 1;
      anio = Number(inf[2]);
      continue;
    }
    if (!cuentaNumero && /^\d{4} \d{4} \d{4}$/.test(t.trim())) cuentaNumero = t.replace(/\s/g, "");
    const saldo = /^(Saldo Anterior|Nuevo Saldo)\s*\$\s*([\d,]+\.\d{2})/i.exec(t);
    if (saldo) {
      const v = montoUS(saldo[2]!);
      if (/anterior/i.test(saldo[1]!)) saldoInicial = v;
      else saldoFinal = v;
      continue;
    }
    // «01 10 $ 2,225,508.00 + 9781 Abono Transferencia … » (la oficina va al final, a la derecha).
    const mov = /^(\d{2})\s+(\d{2})\s+\$\s*([\d,]+\.\d{2})\s*([+-])\s+(\d+)\s+(.+)$/.exec(t);
    if (!mov || !anio) continue;
    const valor = montoUS(mov[3]!);
    if (valor == null) continue;
    const xDesc = l.celdas.find((c) => c.texto.startsWith(mov[6]!.slice(0, 8)))?.x ?? 0;
    // Descripción: las celdas entre la clase de movimiento y la columna de oficina.
    const desc = l.celdas
      .filter((c) => c.x >= xDesc && c.x < 440)
      .map((c) => c.texto)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const oficina = l.celdas
      .filter((c) => c.x >= 440 && !/^\d+$/.test(c.texto))
      .map((c) => c.texto)
      .join(" ")
      .trim();
    const mes = Number(mov[2]);
    // Movimientos de diciembre en un informe de enero son del año anterior.
    const a = mesInforme === 1 && mes === 12 ? anio - 1 : anio;
    movimientos.push({
      id: `${prefijoId}-${movimientos.length + 1}`,
      fecha: `${a}-${mov[2]}-${mov[1]}`,
      descripcion: [desc || mov[6]!.trim(), oficina ? `(${oficina})` : ""]
        .filter(Boolean)
        .join(" "),
      valor: roundCOP(mov[4] === "-" ? -valor : valor),
      refs: [],
      tercero: null,
    });
  }
  if (!anio) advertencias.push("No se encontró «INFORME DEL MES» (año del extracto).");
  if (saldoInicial != null && saldoFinal != null) {
    const suma = roundCOP(saldoInicial + movimientos.reduce((s, m) => s + m.valor, 0));
    if (Math.abs(suma - saldoFinal) >= 0.01)
      advertencias.push(
        `El extracto PDF no cuadra: saldo anterior + movimientos = ${suma.toLocaleString("es-CO")} y el nuevo saldo es ${saldoFinal.toLocaleString("es-CO")}. Revisa si faltan páginas.`,
      );
  }
  return { movimientos, saldoInicial, saldoFinal, cuentaNumero, advertencias };
}

/** Lee cualquier extracto PDF conocido (hoy: Davivienda). */
export function leerExtractoPdf(items: ItemPdf[], prefijoId = "pdf"): Extracto {
  const plano = items.map((i) => i.texto).join(" ");
  if (/DAVIVIENDA/i.test(plano)) return leerExtractoDaviviendaPdf(items, prefijoId);
  const ext = leerExtractoDaviviendaPdf(items, prefijoId);
  if (!ext.movimientos.length)
    ext.advertencias.push("Formato de extracto PDF no reconocido: cárgalo en Excel.");
  return ext;
}

export type ComparacionExtractos = {
  /** En el extracto oficial y no en la relación de la empresa (no reportados). */
  faltanEnRelacion: MovBanco[];
  /** En la relación y no en el extracto oficial (reportados de más o con otro valor/fecha). */
  sobranEnRelacion: MovBanco[];
  coinciden: number;
  /** Mismo valor pero con otra fecha en la relación (más de 3 días): [oficial, relación]. */
  fechaDistinta: Array<[MovBanco, MovBanco]>;
  /** Extracto oficial con las referencias (RC/RP) y el tercero citados en la relación. */
  oficialConRefs: MovBanco[];
};

const dias = (a: string, b: string) =>
  Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000;

/**
 * Extracto oficial (PDF del banco) vs relación de la empresa (hoja del reporte mensual):
 * mismo valor exacto, fecha igual o cercana (hasta 3 días; luego el mismo mes, informado
 * como fecha distinta). Movimientos en cero de la
 * relación (líneas informativas) no cuentan.
 */
export function compararExtractos(oficial: MovBanco[], relacion: MovBanco[]): ComparacionExtractos {
  const rel = relacion.filter((r) => Math.abs(r.valor) >= 0.01);
  const usados = new Set<string>();
  const faltan: MovBanco[] = [];
  const conRefs: MovBanco[] = [];
  const fechaDistinta: Array<[MovBanco, MovBanco]> = [];
  for (const tol of [0, 1, 2, 3, 31]) {
    for (const o of oficial) {
      if (conRefs.some((c) => c.id === o.id)) continue;
      const r = rel.find(
        (x) =>
          !usados.has(x.id) &&
          Math.abs(roundCOP(x.valor) - roundCOP(o.valor)) < 0.01 &&
          dias(x.fecha, o.fecha) <= tol,
      );
      if (!r) continue;
      usados.add(r.id);
      if (tol > 3) fechaDistinta.push([o, r]);
      conRefs.push({
        ...o,
        refs: [...new Set([...(o.refs ?? []), ...(r.refs ?? [])])],
        tercero: o.tercero ?? r.tercero ?? null,
      });
    }
  }
  const porId = new Map(conRefs.map((c) => [c.id, c]));
  const oficialConRefs = oficial.map((o) => porId.get(o.id) ?? o);
  for (const o of oficial) if (!porId.has(o.id)) faltan.push(o);
  return {
    faltanEnRelacion: faltan,
    sobranEnRelacion: rel.filter((r) => !usados.has(r.id)),
    coinciden: conRefs.length,
    fechaDistinta,
    oficialConRefs,
  };
}
