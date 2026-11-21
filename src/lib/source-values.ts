import { sumCents, toCents } from "./money";
import type { ExtractedInvoice } from "./extract.functions";
import type { JournalLine } from "./accounting";

export type SourceValues = {
  source: "excel" | "pdf";
  subtotal: number; iva: number; impoconsumo: number; discount: number; surcharge: number; total: number;
  lines: { subtotal: number; iva: number; impoconsumo: number; iva_base: number | null; iva_rate: number | null }[];
};
export function effectiveSource(raw: unknown, override?: unknown): SourceValues | null {
  if (override && typeof override === "object" && "lines" in override && Array.isArray(override.lines)) return override as SourceValues;
  return sourceFromRaw(raw);
}
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

/** Tolerancia (centavos) por redondeo de renglones: ~medio centavo por renglón, tope $1. */
const toleranciaRenglones = (s: SourceValues) => Math.min(100, Math.max(0, Math.ceil(s.lines.length / 2)));
/**
 * Subtotal con el que se concilian los renglones. Si el subtotal impreso no cuadra con los renglones pero los
 * renglones + impuestos sí dan el total del documento (descuento ya aplicado en los renglones, subtotal bruto
 * leído del PDF), los renglones son la base real: el subtotal impreso es solo de presentación.
 */
export function subtotalEfectivo(s: SourceValues): number {
  const lineas = s.lines.reduce((sum, l) => sum + l.subtotal, 0);
  const tol = toleranciaRenglones(s);
  if (Math.abs(lineas - s.subtotal) <= tol) return s.subtotal;
  if (s.lines.length > 0 && Math.abs(lineas + s.iva + s.impoconsumo + (s.surcharge ?? 0) - s.total) <= tol + 1) return lineas;
  return s.subtotal;
}
export function sourceErrors(s: SourceValues): string[] {
  const errors: string[] = [];
  for (const field of ["subtotal", "iva", "impoconsumo"] as const) {
    const lineas = s.lines.reduce((sum, l) => sum + l[field], 0);
    const objetivo = field === "subtotal" ? subtotalEfectivo(s) : s[field];
    // El INC puede venir solo en el total del documento (sin discriminar por renglón).
    if (field === "impoconsumo" && lineas === 0) continue;
    // Cantidad × valor unitario con 3 decimales hace que cada renglón se redondee a centavos: la suma puede
    // diferir del total del documento por ~medio centavo por renglón (tope $1). Se concilia con el ajuste al peso.
    // El IVA (e INC) además se redondea a pesos enteros en el documento del proveedor: hasta medio peso por renglón
    // (tope $2): 5.042 × 19 % = 957,98 y la factura dice 958.
    const tolerancia = field === "subtotal"
      ? Math.min(100, Math.max(0, Math.ceil(s.lines.length / 2)))
      : Math.min(200, Math.max(1, s.lines.length * 50));
    // Renglones ya netos del descuento: PDF que imprime el subtotal bruto y el descuento aparte, con los renglones
    // ya descontados. Si la suma coincide con subtotal − descuento, el documento es consistente.
    if (field === "subtotal" && s.discount > 0 && Math.abs(lineas - (s.subtotal - s.discount)) <= tolerancia) continue;
    if (Math.abs(lineas - objetivo) > tolerancia) errors.push(`Diferencia con la fuente: suma de ${field === "impoconsumo" ? "INC" : field} de las líneas (renglones ${(lineas / 100).toFixed(2)}, documento ${(s[field] / 100).toFixed(2)}, ${s.lines.length} renglones).`);
  }
  const descuento = subtotalEfectivo(s) === s.subtotal ? s.discount : 0;
  const base = subtotalEfectivo(s) + s.iva + s.impoconsumo + s.surcharge;
  // El subtotal puede venir ya neto del descuento (Excel de recibidos: el descuento es informativo):
  // el total manda, y cuadra con o sin restar el descuento.
  if (Math.abs(base - descuento - s.total) > 100 && Math.abs(base - s.total) > 100)
    errors.push(`Diferencia con la fuente: subtotal + impuestos − descuento + recargo no coincide con el total (subtotal ${(s.subtotal / 100).toFixed(2)}, IVA ${(s.iva / 100).toFixed(2)}, INC ${(s.impoconsumo / 100).toFixed(2)}, descuento ${(s.discount / 100).toFixed(2)}, recargo ${(s.surcharge / 100).toFixed(2)}, total ${(s.total / 100).toFixed(2)}, suma de renglones ${(s.lines.reduce((a, l) => a + l.subtotal, 0) / 100).toFixed(2)}).`);
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
  const advance = sumCents(out.filter(l => /^1330/.test(l.account_code)).map(l => l.credit));
  if (payable) payable.credit = (s.total - toCents(retained) - advance) / 100;
  const diff = sumCents(out.map(l => l.debit)) - sumCents(out.map(l => l.credit));
  if (diff !== 0 && Math.abs(diff) <= 100) out.push({ account_code: "42958101", account_name: "Ajuste por redondeo del documento", debit: diff < 0 ? -diff / 100 : 0, credit: diff > 0 ? diff / 100 : 0 });
  return out;
}
export function validateStoredJournal(inv: { source_override?: unknown; raw_extraction?: unknown; subtotal?: unknown; iva?: unknown; impoconsumo?: unknown; total?: unknown; discount?: unknown; retefuente?: unknown; reteiva?: unknown; reteica?: unknown }, journal: JournalLine[]): string[] {
  const source = effectiveSource(inv.raw_extraction, inv.source_override);
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
    // El recargo global del documento también es un débito (se suma a la cuenta del ítem principal).
    // (un recargo de $1 o menos puede ir, en cambio, al ajuste al peso 42958101).
    const sinRecargo = subtotalEfectivo(source) + source.iva + source.impoconsumo;
    const conRecargo = sinRecargo + (source.surcharge ?? 0);
    // Con ajuste al peso (42958101) en el asiento, los débitos pueden diferir del subtotal + IVA hasta $1.
    const hayAjuste = journal.some(l => l.account_code === "42958101");
    if (baseDebits !== conRecargo && !(baseDebits === sinRecargo && Math.abs(source.surcharge ?? 0) <= 100) && !(hayAjuste && Math.abs(baseDebits - conRecargo) <= 100))
      errors.push("Diferencia con la fuente: los débitos no conservan los importes de la factura.");
  }
  return errors;
}