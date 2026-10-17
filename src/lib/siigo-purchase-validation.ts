import { isValidExpenseAccount } from "./provider-rules";
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
    const base = roundCOP(roundCOP(item.quantity) * roundCOP(item.price) - roundCOP(item.discount));
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
export function purchaseLineErrors(lines: Array<{ account_code?: string | null }>): string[] {
  if (!lines.length) return ["No hay renglones de compra para enviar."];
  return lines.flatMap((line, i) => isValidExpenseAccount(line.account_code)
    ? [] : [`Renglón ${i + 1}: Pendiente de cuenta de gasto válida (grupos 5, 6, 7 o 15-17).`]);
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
}): ReadbackExpected {
  const taxes = (doc.items ?? []).flatMap(item => item.taxes ?? []);
  const returned = (sumCents((doc.retentions ?? []).map(r => r.value))
    + sumCents(taxes.filter(t => /^rete/i.test(t.type ?? "")).map(t => t.value))) / 100;
  const retentions = (toCents(inv.retefuente) + toCents(inv.reteiva) + toCents(inv.reteica)) / 100;
  return {
    total: inv.total, iva: inv.iva, impoconsumo: inv.impoconsumo, retentions,
    returnedRetentions: returned, payable: (toCents(inv.total) - toCents(retentions)) / 100,
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