import { sumCents, toCents } from "./money";
import type { ExtractedInvoice } from "./extract.functions";
import type { JournalLine } from "./accounting";

export type SourceValues = {
  source: "excel" | "pdf";
  subtotal: number; iva: number; impoconsumo: number; discount: number; surcharge: number; total: number;
  lines: { subtotal: number; iva: number; impoconsumo: number; iva_base: number | null; iva_rate: number | null }[];
};
export function captureSource(inv: ExtractedInvoice, source: SourceValues["source"]): SourceValues {
  return {
    source, subtotal: toCents(inv.subtotal), iva: toCents(inv.iva), impoconsumo: toCents(inv.impoconsumo),
    discount: toCents(inv.discount), surcharge: toCents(inv.surcharge), total: toCents(inv.total),
    lines: inv.lines.map(l => ({
      subtotal: toCents(l.subtotal ?? l.total), iva: toCents(l.iva), impoconsumo: toCents(l.impoconsumo),
      iva_base: l.iva_base === undefined ? null : toCents(l.iva_base), iva_rate: l.iva_rate ?? null,
    })),
  };
}
export function sourceFromRaw(raw: unknown): SourceValues | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { valores_origen?: SourceValues; ia?: ExtractedInvoice; fuente?: string };
  if (r.valores_origen) return r.valores_origen;
  if (!r.ia?.lines) return null;
  // Legacy RECIBIDOS stored line.total including taxes; its base is quantity × unit value.
  const inv = r.fuente === "excel_recibidos" ? { ...r.ia, lines: r.ia.lines.map(l => ({ ...l, subtotal: l.subtotal ?? l.quantity * l.unit_value })) } : r.ia;
  return captureSource(inv, r.fuente === "excel_recibidos" ? "excel" : "pdf");
}
export function sourceErrors(s: SourceValues): string[] {
  const errors: string[] = [];
  for (const field of ["subtotal", "iva", "impoconsumo"] as const) {
    if (s.lines.reduce((sum, l) => sum + l[field], 0) !== s[field]) errors.push(`Diferencia con la fuente: suma de ${field === "impoconsumo" ? "INC" : field} de las líneas.`);
  }
  if (Math.abs(s.subtotal + s.iva + s.impoconsumo - s.discount + s.surcharge - s.total) > 100)
    errors.push("Diferencia con la fuente: subtotal + impuestos − descuento + recargo no coincide con el total.");
  return errors;
}
export function compareSource(s: SourceValues, inv: { subtotal?: unknown; iva?: unknown; impoconsumo?: unknown; total?: unknown; discount?: unknown }): string[] {
  return (["subtotal", "iva", "impoconsumo", "total", "discount"] as const).flatMap(field =>
    inv[field] !== undefined && toCents(inv[field]) !== s[field] ? [`Diferencia con la fuente: ${field}, origen ${(s[field] / 100).toFixed(2)}, borrador ${(toCents(inv[field]) / 100).toFixed(2)}.`] : []);
}
/** Set obligation from the source, not by forcing debit totals to balance. */
export function alignJournalToSource(journal: JournalLine[], s: SourceValues, retained: number): JournalLine[] {
  const out = journal.filter(l => l.account_code !== "42958101").map(l => ({ ...l }));
  const payable = out.find(l => /^(22|23)/.test(l.account_code) && !/^236[578]/.test(l.account_code) && l.credit > 0);
  if (payable) payable.credit = (s.total - toCents(retained)) / 100;
  const diff = sumCents(out.map(l => l.debit)) - sumCents(out.map(l => l.credit));
  if (diff !== 0 && Math.abs(diff) <= 100) out.push({ account_code: "42958101", account_name: "Ajuste por redondeo del documento", debit: diff < 0 ? -diff / 100 : 0, credit: diff > 0 ? diff / 100 : 0 });
  return out;
}
export function validateStoredJournal(inv: { raw_extraction?: unknown; subtotal?: unknown; iva?: unknown; impoconsumo?: unknown; total?: unknown; discount?: unknown; retefuente?: unknown; reteiva?: unknown; reteica?: unknown }, journal: JournalLine[]): string[] {
  const source = sourceFromRaw(inv.raw_extraction);
  const errors = source ? [...sourceErrors(source), ...compareSource(source, inv)] : [];
  if (!journal.length) errors.push("No hay asiento aprobado para exportar.");
  const debit = sumCents(journal.map(l => l.debit)), credit = sumCents(journal.map(l => l.credit));
  if (debit !== credit) errors.push("Diferencia con la fuente: débitos y créditos no coinciden.");
  if (inv.total !== undefined) {
    const obligation = sumCents(journal.filter(l => /^(22|23|1330)/.test(l.account_code)).map(l => l.credit));
    if (obligation !== toCents(inv.total)) errors.push("Diferencia con la fuente: retenciones + anticipo + CxP no coincide con el total.");
  }
  if (source) {
    const baseDebits = sumCents(journal.filter(l => l.account_code !== "42958101").map(l => l.debit));
    if (baseDebits !== source.subtotal + source.iva + source.impoconsumo)
      errors.push("Diferencia con la fuente: los débitos no conservan los importes de la factura.");
  }
  return errors;
}