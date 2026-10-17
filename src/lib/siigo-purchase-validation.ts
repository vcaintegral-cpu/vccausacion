import { isValidExpenseAccount } from "./provider-rules";
import { sumCents, toCents } from "./money";

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

/** Compare actual remote amounts, never the submitted payload or a single default tax ID. */
export function purchaseReadbackErrors(doc: PurchaseReadback, expected: {
  total: number; iva: number; impoconsumo: number; retentions: number;
  returnedRetentions: number; payable: number; ivaIds: Array<string | number>;
}): string[] {
  const taxes = (doc.items ?? []).flatMap(item => item.taxes ?? []);
  const iva = sumCents(taxes.filter(t => expected.ivaIds.some(id => String(id) === String(t.id))).map(t => t.value));
  const inc = sumCents(taxes.filter(t => /consum/i.test(t.type ?? "")).map(t => t.value));
  const payable = doc.payments ? sumCents(doc.payments.map(p => p.value)) : null;
  const fields = [
    ["Total", toCents(expected.total), doc.total === undefined ? null : toCents(doc.total)],
    ["IVA", toCents(expected.iva), iva],
    ["INC", toCents(expected.impoconsumo), inc],
    ["Retenciones", toCents(expected.retentions), toCents(expected.returnedRetentions)],
    ["CxP", toCents(expected.payable), payable],
  ] as const;
  return fields.flatMap(([label, local, remote]) => local === remote ? []
    : [`${label}: origen ${local / 100}, Siigo ${remote === null ? "no informado" : remote / 100}`]);
}