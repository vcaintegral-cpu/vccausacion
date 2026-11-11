// Cuenta contable de cada impuesto de Siigo (núcleo global: todas las empresas).
//
// La API de impuestos de Siigo (/v1/taxes) no devuelve la cuenta contable del impuesto.
// Se determina así, sin adivinar:
//   1. La cuenta que la empresa usó con ese impuesto en Siigo: en el auxiliar histórico,
//      cada movimiento de impuesto trae como descripción el nombre del impuesto de Siigo
//      ("Compras 2.5%" → 23654001; "IVA compras 19%" → 24081001). Se toma la más usada.
//   2. Si no está en el historial: la cuenta del PUC del grupo del impuesto (2408 IVA,
//      2365 Retefuente, 2367 ReteIVA, 2368 ReteICA) cuyo nombre tiene la MISMA tarifa y
//      comparte el concepto (compras, servicios, arrendamientos, gastos…).
//   3. Sin coincidencia clara: sin cuenta (la usuaria la elige). Nunca una cuenta de otra
//      tarifa ni la 621008 (IVA del costo) por defecto.

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
export const normalizarNombreImpuesto = (s: string | null | undefined) =>
  sinTildes(String(s ?? "")).toLowerCase().replace(/(\d),(\d)/g, "$1.$2").replace(/\s+/g, " ").trim();

export type TipoImpuesto = "iva" | "retefuente" | "reteiva" | "reteica" | "autorretencion" | "impoconsumo" | string;

/** Prefijos PUC donde puede estar la cuenta de cada tipo de impuesto de compras. */
export function prefijosDeImpuesto(tipo: TipoImpuesto): string[] {
  const t = String(tipo).toLowerCase();
  if (t === "iva") return ["2408"];
  if (t === "reteiva") return ["2367"];
  if (t === "reteica") return ["2368"];
  if (t === "retefuente") return ["2365"];
  if (t.startsWith("autor") || t.startsWith("auto")) return ["2365", "2369", "1355"];
  if (t === "impoconsumo") return ["5", "6", "7", "2408"];
  return [];
}

/** Tarifa escrita en un nombre ("Compras 2.5%", "Retención por compras 2,5%", "19%"). */
function tarifaEnNombre(nombre: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(normalizarNombreImpuesto(nombre));
  return m ? Number(m[1]) : null;
}

const GENERICAS = new Set(["iva", "retencion", "retenciones", "rete", "retefuente", "reteiva", "reteica", "por", "de", "del", "la", "el", "en", "y", "descontable", "impuesto", "sobre", "las", "los", "a"]);
const conceptos = (nombre: string) =>
  normalizarNombreImpuesto(nombre)
    .replace(/\d+(?:\.\d+)?\s*%?/g, " ")
    .split(/[^a-z]+/)
    .filter((p) => p.length >= 3 && !GENERICAS.has(p))
    .map((p) => p.replace(/(es|s)$/, ""));

export type UsoHistorico = Map<string, Map<string, number>>;

/** Uso histórico: nombre del impuesto (descripción del movimiento) → cuenta → veces. */
export function usoHistoricoDeImpuestos(
  movimientos: Array<{ account_code: string | null; description: string | null; detail?: string | null }>,
): UsoHistorico {
  const out: UsoHistorico = new Map();
  for (const m of movimientos) {
    const cuenta = String(m.account_code ?? "").trim();
    if (!/^(2408|2365|2367|2368|2369)/.test(cuenta)) continue;
    for (const texto of [m.description, String(m.detail ?? "").replace(/\s*base\s*:.*$/i, "")]) {
      const k = normalizarNombreImpuesto(texto);
      if (!k) continue;
      const porCuenta = out.get(k) ?? new Map<string, number>();
      porCuenta.set(cuenta, (porCuenta.get(cuenta) ?? 0) + 1);
      out.set(k, porCuenta);
    }
  }
  return out;
}

export function cuentaParaImpuesto(
  tax: { type?: string | null; name?: string | null; percentage?: number | null },
  puc: Array<{ code: string; name: string }>,
  historico: UsoHistorico,
): { code: string | null; name: string | null; origen: "historial" | "puc" | null } {
  const tipo = String(tax.type ?? "").toLowerCase();
  const prefijos = prefijosDeImpuesto(tipo);
  const enGrupo = (c: string) => prefijos.some((p) => c.startsWith(p));
  // 1. Historial de la empresa en Siigo.
  const usos = historico.get(normalizarNombreImpuesto(tax.name));
  if (usos) {
    const mejor = [...usos].filter(([c]) => !prefijos.length || enGrupo(c)).sort((a, b) => b[1] - a[1])[0];
    if (mejor) return { code: mejor[0], name: puc.find((a) => a.code === mejor[0])?.name ?? null, origen: "historial" };
  }
  // 2. PUC: misma tarifa y concepto en común (solo cuentas auxiliares del grupo).
  if (!prefijos.length) return { code: null, name: null, origen: null };
  const tarifa = tax.percentage != null ? Number(tax.percentage) : tarifaEnNombre(String(tax.name ?? ""));
  const conceptosTax = conceptos(String(tax.name ?? ""));
  const codigos = new Set(puc.map((a) => a.code));
  const hojas = puc.filter((a) => enGrupo(a.code) && a.code.length >= 8 && ![...codigos].some((c) => c !== a.code && c.startsWith(a.code)));
  let mejor: { a: { code: string; name: string }; p: number } | null = null;
  for (const a of hojas) {
    const t = tarifaEnNombre(a.name);
    // Con tarifa en el nombre de la cuenta, debe ser la misma (ReteICA puede estar por mil).
    if (t != null && tarifa != null && Math.abs(t - tarifa) > 0.001) continue;
    const comunes = conceptos(a.name).filter((w) => conceptosTax.includes(w)).length;
    const p = comunes * 2 + (t != null && tarifa != null ? 1 : 0);
    if (p > 0 && (!mejor || p > mejor.p)) mejor = { a, p };
  }
  // Coincidencia clara: concepto en común, o la tarifa cuando es la única cuenta con ella.
  if (mejor && (mejor.p >= 2 || hojas.filter((a) => tarifaEnNombre(a.name) === tarifa).length === 1))
    return { code: mejor.a.code, name: mejor.a.name, origen: "puc" };
  return { code: null, name: null, origen: null };
}
