import { isValidExpenseAccount, isValidPurchaseAccount } from "./provider-rules";
import { roundCOP, sumCents, toCents } from "./money";

export type PurchaseTax = { id?: string | number; type?: string; name?: string; percentage?: number; active?: boolean };
export function resolvePurchaseInc(taxes: PurchaseTax[], base: number, amount: number): string | number | null {
  if (toCents(amount) === 0) return null;
  const matches = taxes.filter(t => t.id != null && t.active !== false && /consum/i.test(`${t.type ?? ""} ${t.name ?? ""}`)
    && Number(t.percentage) > 0 && toCents(base * Number(t.percentage) / 100) === toCents(amount));
  return matches.length === 1 ? matches[0]?.id ?? null : null;
}

/** Forecast from the exact two-decimal payload, never from the invoice header. */
export function purchasePayloadErrors(items: Array<{ quantity: number; price: number; discount?: number; tax_ids?: Array<string | number> }>, taxes: PurchaseTax[], expected: { subtotal: number; iva: number; impoconsumo: number }): string[] {
  let subtotal = 0, iva = 0, inc = 0;
  const errors: string[] = [];
  for (const [index, item] of items.entries()) {
    const base = baseOf(item);
    subtotal += toCents(base);
    for (const id of item.tax_ids ?? []) {
      const tax = taxes.find(t => String(t.id) === String(id) && t.active !== false);
      if (!tax) { errors.push(`Renglón ${index + 1}: el impuesto ${id} no está activo en Siigo.`); continue; }
      const kind = `${tax.type ?? ""} ${tax.name ?? ""}`;
      const amount = toCents(base * Number(tax.percentage ?? 0) / 100);
      if (/consum/i.test(kind)) inc += amount;
      else if (/iva/i.test(kind) && !/rete|withhold/i.test(kind)) iva += amount;
    }
  }
  for (const [label, local, sent] of [["Subtotal", toCents(expected.subtotal), subtotal], ["IVA", toCents(expected.iva), iva], ["INC", toCents(expected.impoconsumo), inc]] as const)
    if (local !== sent) errors.push(`Diferencia con la fuente: ${label}, origen ${local / 100}, Siigo calcularía ${sent / 100}. No se envió la factura.`);
  return errors;
}

/** Same purchase safety gate for PDF and RECIBIDOS; origin never grants an exemption. */
export function purchaseLineErrors(
  lines: Array<{ account_code?: string | null; item_type?: string | null }>,
  inventario = false,
): string[] {
  if (!lines.length) return ["No hay renglones de compra para enviar."];
  // Con la función "productos_inventario", los renglones de producto/servicio pueden ir a la 14.
  return lines.flatMap((line, i) => {
    const deInventario = inventario && (line.item_type === "producto" || line.item_type === "servicio");
    return isValidPurchaseAccount(line.account_code, deInventario)
      ? []
      : [`Renglón ${i + 1}: Pendiente de cuenta de gasto válida (grupos 5, 6, 7 o 15-17${inventario ? "; inventario 14 solo en renglones de producto" : ""}).`];
  });
}

export type PurchaseReadback = {
  total?: number;
  payments?: Array<{ value?: number }>;
  items?: Array<{ taxes?: Array<{ id?: string | number; type?: string; value?: number }> }>;
};

export type ReadbackExpected = {
  total: number; iva: number; impoconsumo: number; retentions: number;
  returnedRetentions: number; payable: number; ivaIds: Array<string | number>;
};
export type ReadbackRow = { campo: string; origen: number; siigo: number | null; ok: boolean };

/** Field-by-field comparison: gross vs gross (Siigo net + retentions) and net vs net (CxP). */
export function purchaseReadbackComparison(doc: PurchaseReadback, expected: ReadbackExpected): ReadbackRow[] {
  const taxes = (doc.items ?? []).flatMap(item => item.taxes ?? []);
  const iva = sumCents(taxes.filter(t => expected.ivaIds.some(id => String(id) === String(t.id))).map(t => t.value));
  const inc = sumCents(taxes.filter(t => /consum/i.test(t.type ?? "")).map(t => t.value));
  const payable = doc.payments ? sumCents(doc.payments.map(p => p.value)) : null;
  const fields = [
    // Siigo purchase total is net of applied retentions; reconstruct the gross source total.
    ["Total bruto", toCents(expected.total), doc.total === undefined ? null : toCents(doc.total) + toCents(expected.returnedRetentions)],
    ["IVA", toCents(expected.iva), iva],
    ["INC", toCents(expected.impoconsumo), inc],
    ["Retenciones", toCents(expected.retentions), toCents(expected.returnedRetentions)],
    ["CxP (neto)", toCents(expected.payable), payable],
  ] as const;
  return fields.map(([campo, local, remote]) => ({ campo, origen: local / 100, siigo: remote === null ? null : remote / 100, ok: local === remote }));
}

/** Compare actual remote amounts, never the submitted payload or a single default tax ID. */
export function purchaseReadbackErrors(doc: PurchaseReadback, expected: ReadbackExpected): string[] {
  return purchaseReadbackComparison(doc, expected).filter(r => !r.ok).map(r =>
    `${r.campo}: origen ${r.origen}, Siigo ${r.siigo === null ? "no informado" : r.siigo}`);
}

/** Expected values for re-reading an existing Siigo purchase, derived only from that remote document. */
export function readbackExpectedFromDoc(doc: PurchaseReadback & { retentions?: Array<{ value?: number }> }, inv: {
  total: number; iva: number; impoconsumo: number; retefuente: number; reteiva: number; reteica: number;
}, incAsCost = 0, extra: { ivaAsCost?: number; providerRounding?: number } = {}): ReadbackExpected {
  const ivaAsCost = toCents(extra.ivaAsCost ?? 0);
  // Diferencia de redondeo registrada: Siigo tiene el total calculado de las líneas.
  const total = (toCents(inv.total) - toCents(extra.providerRounding ?? 0)) / 100;
  const taxes = (doc.items ?? []).flatMap(item => item.taxes ?? []);
  const returned = (sumCents((doc.retentions ?? []).map(r => r.value))
    + sumCents(taxes.filter(t => /^rete/i.test(t.type ?? "")).map(t => t.value))) / 100;
  const retentions = (toCents(inv.retefuente) + toCents(inv.reteiva) + toCents(inv.reteica)) / 100;
  return {
    total, iva: (toCents(inv.iva) - ivaAsCost) / 100, impoconsumo: (toCents(inv.impoconsumo) - toCents(incAsCost)) / 100, retentions,
    returnedRetentions: returned, payable: (toCents(total) - toCents(retentions)) / 100,
    ivaIds: taxes.filter(t => /^iva$/i.test((t.type ?? "").trim())).map(t => t.id ?? ""),
  };
}

export type SiigoErrorKind = "sin_crear" | "creado_diferencia" | "interrumpido";
/** Error type is persisted; a remote identity always means the document exists in Siigo. */
export function siigoErrorKind(inv: { siigo_status?: string | null; siigo_id?: string | null; siigo_number?: string | null; siigo_error_kind?: string | null }): SiigoErrorKind | null {
  if (inv.siigo_status !== "error") return null;
  if (inv.siigo_id || inv.siigo_number) return "creado_diferencia";
  return inv.siigo_error_kind === "interrumpido" ? "interrumpido" : "sin_crear";
}

/** A "sincronizando" send older than five minutes was interrupted (app closed mid-send). */
export const INTERRUPTED_AFTER_MS = 5 * 60 * 1000;
export function isInterruptedSend(inv: { siigo_status?: string | null; siigo_last_attempt_at?: string | null }, now = Date.now()): boolean {
  if (inv.siigo_status !== "sincronizando") return false;
  const t = inv.siigo_last_attempt_at ? Date.parse(inv.siigo_last_attempt_at) : NaN;
  return !Number.isFinite(t) || now - t > INTERRUPTED_AFTER_MS;
}
// ---------------------------------------------------------------------------
// Representación en Siigo de casos especiales, SIN cambiar importes de la fuente.
// ---------------------------------------------------------------------------
export type AdaptableItem = {
  type: "Product" | "Account"; code: string; account_code: string; description: string;
  quantity: number; price: number; discount: number; tax_ids: Array<string | number>; item_type: string;
};
const kindOf = (t: PurchaseTax) => `${t.type ?? ""} ${t.name ?? ""}`;
const isIva = (t: PurchaseTax) => /iva/i.test(kindOf(t)) && !/rete|withhold|consum/i.test(kindOf(t));
const isInc = (t: PurchaseTax) => /consum/i.test(kindOf(t));
// Igual que Siigo: cantidad (2 decimales) × precio (hasta 6 decimales) − descuento, a 2 decimales.
const baseOf = (it: { quantity: number; price: number; discount?: number }) =>
  roundCOP(roundCOP(it.quantity) * (Math.round(Number(it.price) * 1e6) / 1e6) - roundCOP(it.discount));

export type AdaptResult<T> = { items: T[]; incAsCost: number; adjustment: number; providerRounding: number; notes: string[] };

/**
 * - IVA sobre base parcial (AIU, 1,9 %): divide el renglón en parte gravada + no gravada.
 * - INC sin impuesto equivalente en Siigo: se envía como mayor costo del mismo renglón.
 * - Ajuste al peso del documento (≤ $1): renglón de ajuste (+) o menor valor de un renglón no gravado (−).
 * El total, el IVA y el neto siguen siendo exactamente los de la fuente.
 */
export function adaptPurchaseItems<T extends AdaptableItem>(
  items: T[],
  lines: Array<{ iva: number; impoconsumo: number }>,
  taxes: PurchaseTax[],
  header: { subtotal: number; iva: number; impoconsumo: number; total: number },
  adjustmentAccount: string | null,
): AdaptResult<T> {
  const active = taxes.filter(t => t.id != null && t.active !== false);
  const out: T[] = [];
  const notes: string[] = [];
  let incAsCost = 0;
  items.forEach((item, i) => {
    const line = lines[i];
    if (!line) { out.push(item); return; }
    const base = baseOf(item);
    let parts: T[] = [item];
    const ivaTax = active.find(t => isIva(t) && item.tax_ids.some(id => String(id) === String(t.id)));
    if (toCents(line.iva) > 0 && ivaTax && toCents(base * Number(ivaTax.percentage) / 100) !== toCents(line.iva)) {
      const candidates = [ivaTax, ...active.filter(t => isIva(t) && t !== ivaTax && Number(t.percentage) > 0)];
      for (const tax of candidates) {
        const pct = Number(tax.percentage);
        const taxed = roundCOP(line.iva * 100 / pct);
        if (toCents(taxed * pct / 100) !== toCents(line.iva) || !(taxed > 0) || toCents(taxed) >= toCents(base)) continue;
        const otros = item.tax_ids.filter(id => String(id) !== String(ivaTax.id));
        parts = [
          { ...item, quantity: 1, price: taxed, discount: 0, tax_ids: [tax.id!, ...otros], description: `${item.description} (base gravada)` },
          { ...item, quantity: 1, price: roundCOP(base - taxed), discount: 0, tax_ids: otros, description: `${item.description} (no gravado)` },
        ];
        notes.push(`Renglón ${i + 1}: IVA ${line.iva} sobre base ${taxed} (${pct} %).`);
        break;
      }
    }
    out.push(...parts);
    if (toCents(line.impoconsumo) > 0 && !item.tax_ids.some(id => active.some(t => isInc(t) && String(t.id) === String(id)))) {
      out.push({ ...item, type: "Account", code: item.account_code, quantity: 1, price: roundCOP(line.impoconsumo), discount: 0, tax_ids: [], description: `Impoconsumo no descontable · ${item.description}` });
      incAsCost += toCents(line.impoconsumo);
      notes.push(`Renglón ${i + 1}: INC ${line.impoconsumo} enviado como mayor costo.`);
    }
  });
  const diff = toCents(header.total) - toCents(header.subtotal) - toCents(header.iva) - toCents(header.impoconsumo);
  if (diff !== 0 && Math.abs(diff) <= 100) {
    if (diff > 0) {
      if (!adjustmentAccount) throw new Error(`Ajuste al peso de ${diff / 100}: falta la cuenta de ajuste. No se envió la factura.`);
      const ref = out[0]!;
      out.push({ ...ref, type: "Account", code: adjustmentAccount, account_code: adjustmentAccount, quantity: 1, price: diff / 100, discount: 0, tax_ids: [], description: "Ajuste al peso del documento" });
    } else {
      // Siigo no descuenta items[].discount del total de la compra: el ajuste se resta del
      // valor de un renglón sin impuestos (mismo total, IVA y neto de la fuente).
      const idx = out.findIndex(it => it.tax_ids.length === 0 && toCents(baseOf(it)) > -diff);
      if (idx < 0) {
        // Diferencia de redondeo del proveedor: se envían los valores calculados de las
        // líneas (sin tocar IVA, base ni retenciones) y la diferencia queda pendiente al pago.
        notes.push(`Diferencia de redondeo del proveedor: ${diff / 100} (pendiente al pago).`);
        return { items: out, incAsCost: incAsCost / 100, adjustment: 0, providerRounding: diff / 100, notes };
      }
      const t = out[idx]!;
      out[idx] = { ...t, quantity: 1, discount: 0, price: roundCOP(baseOf(t) + diff / 100), description: `${t.description} (incluye ajuste al peso ${diff / 100})` };
    }
    notes.push(`Ajuste al peso del documento: ${diff / 100}.`);
  }
  return { items: out, incAsCost: incAsCost / 100, adjustment: Math.abs(diff) <= 100 ? diff / 100 : 0, providerRounding: 0, notes };
}

const AIU = /\b(administraci[oó]n|utilidad(es)?|imprevistos?|a\.?\s?i\.?\s?u\.?)\b/i;

/**
 * Retefuente goes only on the rows whose bases reproduce the source value exactly:
 * all rows, a single row, the AIU rows (administración, imprevistos, utilidad) or,
 * with few rows, the smallest exact combination. Otherwise all rows (the caller
 * then detects the difference and does not send).
 */
export function retefuenteRows(bases: number[], pct: number, target: number, descriptions: string[] = []): number[] {
  const all = bases.map((_, i) => i);
  const per = bases.map(b => toCents(b * pct / 100));
  const goal = toCents(target);
  const sum = (rows: number[]) => rows.reduce((a, i) => a + per[i]!, 0);
  if (sum(all) === goal) return all;
  const single = per.findIndex(c => c === goal);
  if (single >= 0) return [single];
  const aiu = all.filter(i => per[i]! > 0 && AIU.test(descriptions[i] ?? ""));
  if (aiu.length && sum(aiu) === goal) return aiu;
  const candidates = all.filter(i => per[i]! > 0);
  if (candidates.length <= 12) {
    let best: number[] | null = null;
    for (let mask = 1; mask < 1 << candidates.length; mask++) {
      const rows = candidates.filter((_, k) => mask & (1 << k));
      if (sum(rows) === goal && (!best || rows.length < best.length)) best = rows;
    }
    if (best) return best;
  }
  return all;
}

/** IVA capitalizado: un renglón adicional sin impuestos en la cuenta del activo; nunca lleva retención. */
export function capitalizedIvaRow<T extends AdaptableItem>(ref: T, account: string, amount: number): T {
  return { ...ref, type: "Account", code: account, account_code: account, quantity: 1, price: roundCOP(amount), discount: 0, tax_ids: [], item_type: "activo", description: "IVA 19% sobre utilidad (mayor valor del activo)" };
}

/** Rows that receive a line retention, excluding rows that must never carry one. */
export function retentionRowsExcluding(bases: number[], pct: number, target: number, excluded: Set<number>, descriptions: string[] = []): number[] {
  const masked = bases.map((b, i) => (excluded.has(i) ? 0 : b));
  return retefuenteRows(masked, pct, target, descriptions).filter(i => !excluded.has(i));
}

/**
 * Siigo calcula cada renglón con 2 decimales (cantidad × precio unitario y el IVA
 * renglón por renglón). La factura del proveedor calcula con más decimales o sobre
 * el total, y pueden quedar centavos de diferencia que bloquean el envío. Sin
 * cambiar ningún valor de la fuente:
 * 1. Renglones de cuenta con cantidad ≠ 1 cuyo producto no da su base exacta → se
 *    envían como cantidad 1 por su base exacta (la cantidad queda en la descripción).
 *    Un producto de inventario con varias unidades se reparte en (n − 1) + 1 unidades.
 * 2. Si el IVA aún no cuadra y se permite, se agrupan los renglones de cuenta con la
 *    misma cuenta e impuestos (mismo asiento contable, IVA calculado sobre el total) o
 *    se divide un renglón para reproducir el IVA redondeado del proveedor.
 * Los productos de inventario conservan siempre sus unidades y su valor total.
 */
export function ajustarPrecisionRenglones<T extends AdaptableItem>(
  items: T[],
  taxes: PurchaseTax[],
  expected: { subtotal: number; iva: number; impoconsumo: number },
  options: { permitirFusion: boolean },
): { items: T[]; notas: string[] } {
  if (!purchasePayloadErrors(items, taxes, expected).length) return { items, notas: [] };
  const notas: string[] = [];
  const exacto = items.flatMap((it, i): T[] => {
    if (Number(it.quantity) === 1) return [it];
    const base = roundCOP(Number(it.quantity) * Number(it.price) - Number(it.discount || 0));
    if (toCents(baseOf(it)) === toCents(base)) return [it];
    if (it.type === "Account") {
      notas.push(`Renglón ${i + 1}: cantidad ${it.quantity} enviada como 1 por su valor exacto ${base}.`);
      return [{ ...it, quantity: 1, price: base, discount: 0, description: `${it.description} (cant. ${it.quantity})` }];
    }
    // Producto de inventario: se conservan las unidades, repartidas en (n − 1) + 1. Agrega
    // un renglón (cambia las posiciones), así que solo cuando no hay retención por renglón.
    if (!options.permitirFusion) return [it];
    const q = Number(it.quantity);
    const p1 = toCents(it.price);
    const p2 = toCents(base) - (q - 1) * p1;
    if (!Number.isInteger(q) || q < 2 || !(p2 > 0)) return [it];
    notas.push(`Renglón ${i + 1}: producto de ${q} unidades enviado como ${q - 1} + 1 para conservar su valor exacto ${base}.`);
    return [
      { ...it, quantity: q - 1, price: p1 / 100, discount: 0 },
      { ...it, quantity: 1, price: p2 / 100, discount: 0 },
    ];
  });
  if (!purchasePayloadErrors(exacto, taxes, expected).length || !options.permitirFusion) return { items: exacto, notas };
  const conDivision = (base: T[], previas: string[]) => {
    const dividido = dividirParaRedondeoIva(base, taxes, expected);
    return dividido ? { items: dividido.items, notas: [...previas, ...dividido.notas] } : null;
  };

  const clave = (it: T) => `${it.account_code}|${[...it.tax_ids].map(String).sort().join(",")}`;
  const grupos = new Map<string, T[]>();
  for (const it of exacto) if (it.type === "Account") grupos.set(clave(it), [...(grupos.get(clave(it)) ?? []), it]);
  if (![...grupos.values()].some((g) => g.length > 1)) return conDivision(exacto, notas) ?? { items: exacto, notas };
  const fusionados: T[] = [];
  const notasFusion: string[] = [];
  const hechos = new Set<string>();
  for (const it of exacto) {
    if (it.type !== "Account") { fusionados.push(it); continue; }
    const k = clave(it);
    if (hechos.has(k)) continue;
    hechos.add(k);
    const grupo = grupos.get(k)!;
    if (grupo.length === 1) { fusionados.push(it); continue; }
    const base = roundCOP(grupo.reduce((s, g) => s + baseOf(g), 0));
    fusionados.push({ ...it, quantity: 1, price: base, discount: 0, description: `${it.description} y ${grupo.length - 1} renglón(es) más de la misma cuenta` });
    notasFusion.push(`${grupo.length} renglones de la cuenta ${it.account_code} agrupados (IVA sobre su total).`);
  }
  if (!purchasePayloadErrors(fusionados, taxes, expected).length) return { items: fusionados, notas: [...notas, ...notasFusion] };
  return conDivision(fusionados, [...notas, ...notasFusion]) ?? conDivision(exacto, notas) ?? { items: exacto, notas };
}

/** IVA en centavos que Siigo calcularía: renglón por renglón, redondeado a 2 decimales. */
function ivaSiigoCentavos(items: AdaptableItem[], taxes: PurchaseTax[]): number {
  let iva = 0;
  for (const it of items) {
    for (const id of it.tax_ids) {
      const tax = taxes.find((t) => String(t.id) === String(id) && t.active !== false);
      if (tax && isIva(tax)) iva += toCents((baseOf(it) * Number(tax.percentage ?? 0)) / 100);
    }
  }
  return iva;
}

/**
 * El proveedor redondeó el IVA distinto a como lo hace Siigo (p. ej. $282.413,45
 * contra 19 % × $1.486.386,55 = $282.413,4445). Siigo redondea renglón por renglón,
 * así que un renglón de cuenta se divide en dos de la MISMA cuenta e impuestos,
 * con el corte que hace que sus dos redondeos sumen el IVA de la fuente. La base,
 * el IVA, el total y el asiento quedan idénticos. Solo para hasta 3 centavos.
 */
export function dividirParaRedondeoIva<T extends AdaptableItem>(
  items: T[],
  taxes: PurchaseTax[],
  expected: { subtotal: number; iva: number; impoconsumo: number },
): { items: T[]; notas: string[] } | null {
  const subtotal = items.reduce((a, it) => a + toCents(baseOf(it)), 0);
  if (subtotal !== toCents(expected.subtotal)) return null;
  let diff = toCents(expected.iva) - ivaSiigoCentavos(items, taxes);
  if (diff === 0 || Math.abs(diff) > 3) return null;
  let out = [...items];
  const notas: string[] = [];
  while (diff !== 0) {
    const paso = Math.sign(diff);
    // Renglón de cuenta con un solo IVA, el de mayor base.
    const candidatos = out
      .map((it, i) => ({ it, i, ivas: it.tax_ids.map((id) => taxes.find((t) => String(t.id) === String(id) && t.active !== false)).filter((t): t is PurchaseTax => !!t && isIva(t)) }))
      .filter((c) => c.ivas.length === 1 && (c.it.type === "Account" || (Number.isInteger(Number(c.it.quantity)) && Number(c.it.quantity) >= 2)))
      // Primero renglones de cuenta; luego productos (se dividen por unidades).
      .sort((a, b) => (a.it.type === "Account" ? 0 : 1) - (b.it.type === "Account" ? 0 : 1) || baseOf(b.it) - baseOf(a.it));
    let hecho = false;
    for (const { it, i, ivas } of candidatos) {
      const pct = Number(ivas[0]!.percentage ?? 0);
      const base = toCents(baseOf(it));
      const ivaRenglon = toCents((base / 100) * pct / 100);
      const ivaDe = (cents: number) => toCents(((cents / 100) * pct) / 100);
      if (it.type === "Account") {
        for (let k = 1; k < Math.min(base, 100000); k++) {
          if (ivaDe(k) + ivaDe(base - k) - ivaRenglon !== paso) continue;
          const parte = (cents: number, n: number) => ({ ...it, quantity: 1, price: cents / 100, discount: 0, description: `${it.description} (parte ${n}/2, redondeo IVA)` });
          out = [...out.slice(0, i), parte(base - k, 1), parte(k, 2), ...out.slice(i + 1)];
          notas.push(`Renglón de la cuenta ${it.account_code} dividido en dos para reproducir el IVA redondeado del proveedor (${paso > 0 ? "+" : "−"}0,01).`);
          hecho = true;
          break;
        }
      } else {
        // Producto: (q − 1) unidades a P1 + 1 unidad a P2; mismas unidades y mismo valor total.
        const q = Number(it.quantity);
        const centro = Math.round(base / q);
        for (let d = 0; d < 5000 && !hecho; d++) {
          for (const p1 of d === 0 ? [centro] : [centro + d, centro - d]) {
            const p2 = base - (q - 1) * p1;
            if (!(p1 > 0) || !(p2 > 0) || ivaDe((q - 1) * p1) + ivaDe(p2) - ivaRenglon !== paso) continue;
            out = [
              ...out.slice(0, i),
              { ...it, quantity: q - 1, price: p1 / 100, discount: 0 },
              { ...it, quantity: 1, price: p2 / 100, discount: 0 },
              ...out.slice(i + 1),
            ];
            notas.push(`Producto ${it.code} (${q} unidades) enviado como ${q - 1} + 1 para reproducir el IVA redondeado del proveedor (${paso > 0 ? "+" : "−"}0,01).`);
            hecho = true;
            break;
          }
        }
      }
      if (hecho) break;
    }
    if (!hecho) return null;
    diff -= paso;
  }
  return purchasePayloadErrors(out, taxes, expected).length ? null : { items: out, notas };
}

/** Por qué no se pudo ajustar la precisión (se agrega al mensaje de error para no adivinar). */
export function motivoSinAjuste(
  items: AdaptableItem[],
  taxes: PurchaseTax[],
  expected: { subtotal: number; iva: number; impoconsumo: number },
  permitirAjuste: boolean,
): string | null {
  if (!purchasePayloadErrors(items, taxes, expected).length) return null;
  if (!permitirAjuste)
    return "No se dividen ni agrupan renglones porque la factura tiene Retefuente o renglones excluidos de retención (la retención se ubica por renglón).";
  const conIva = items.filter((it) => it.tax_ids.some((id) => taxes.some((t) => String(t.id) === String(id) && isIva(t))));
  const diff = Math.abs(toCents(expected.iva) - ivaSiigoCentavos(items, taxes));
  if (diff > 3) return `La diferencia de IVA es de ${diff / 100}: supera el ajuste automático de 3 centavos; revise la lectura de la factura.`;
  if (conIva.length && conIva.every((it) => it.type !== "Account" && !(Number.isInteger(Number(it.quantity)) && Number(it.quantity) >= 2)))
    return "El IVA está en productos de inventario de 1 unidad: no se pueden dividir sin cambiar el inventario. Cambie el renglón a cuenta de gasto/costo o ajuste el centavo en Siigo.";
  return null;
}

/**
 * Diferencia de redondeo del proveedor de hasta $1 entre los valores de la factura y lo
 * que Siigo calcula renglón por renglón (subtotal con 2 decimales por precio, IVA por
 * renglón): se reproduce como la firma lo hace en Siigo, con un renglón de "Ajuste al
 * peso" sin impuestos por la diferencia del total (o restándola de un renglón sin IVA).
 * El total de la compra y el pago quedan iguales a la factura; el IVA queda el que Siigo
 * calcula (diferencia de centavos, informada en la nota). Más de $1 no se ajusta.
 */
export function ajusteAlPesoSiigo<T extends AdaptableItem>(
  items: T[],
  taxes: PurchaseTax[],
  expected: { subtotal: number; iva: number; impoconsumo: number },
  cuentaAjuste: string | null,
): { items: T[]; subtotalSiigo: number; ivaSiigo: number; nota: string } | null {
  if (!items.length) return null;
  const sub = items.reduce((a, it) => a + toCents(baseOf(it)), 0);
  const ivaS = ivaSiigoCentavos(items, taxes);
  const dSub = toCents(expected.subtotal) - sub;
  const dIva = toCents(expected.iva) - ivaS;
  const total = dSub + dIva;
  if ((dSub === 0 && dIva === 0) || Math.abs(dSub) > 100 || Math.abs(dIva) > 100 || Math.abs(total) > 100) return null;
  let out = [...items];
  if (total > 0) {
    if (!cuentaAjuste) return null;
    const ref = items[0]!;
    out.push({ ...ref, type: "Account", code: cuentaAjuste, account_code: cuentaAjuste, quantity: 1, price: total / 100, discount: 0, tax_ids: [], description: "Ajuste al peso del documento" });
  } else if (total < 0) {
    const idx = out.findIndex((it) => it.tax_ids.length === 0 && toCents(baseOf(it)) > -total);
    if (idx < 0) return null;
    const t = out[idx]!;
    out = out.map((it, i) => (i === idx ? { ...t, quantity: 1, discount: 0, price: roundCOP(baseOf(t) + total / 100), description: `${t.description} (incluye ajuste al peso ${total / 100})` } : it));
  }
  const subtotalSiigo = out.reduce((a, it) => a + toCents(baseOf(it)), 0) / 100;
  return {
    items: out,
    subtotalSiigo,
    ivaSiigo: ivaS / 100,
    nota: `Ajuste al peso ${total / 100} en Siigo: el proveedor redondeó distinto (subtotal ${dSub / 100}, IVA ${dIva / 100}).`,
  };
}
