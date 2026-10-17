// Adaptador "Excel RECIBIDOS → estructura del PDF".
//
// Convierte cada documento del reporte RECIBIDOS (Procesador XML FE) en la
// MISMA estructura ExtractedInvoice que hoy llena la IA al leer un PDF, para
// que el documento pase por exactamente la misma función de causación
// (saveExtractedInvoice en bulk-invoices.ts) con los mismos parámetros,
// reglas y resultados. No duplica lógica de causación ni usa IA.
import type { ExtractedInvoice } from "@/lib/extract.functions";
import type { PurchaseDocument } from "@/lib/purchase-excel";

/** Llave con la que el parser une encabezado y detalle: NUMERO FACTURA COMPLETO + CUFE. */
export function excelDocKey(doc: PurchaseDocument): string {
  return `${String(doc.rawHeader["NUMERO FACTURA COMPLETO"] ?? "").trim()}|${String(doc.rawHeader["CUFE"] ?? "")
    .trim()
    .toLowerCase()}`;
}

/** Nombre visible de la tarea en el historial de cargas. */
export function excelDocLabel(doc: PurchaseDocument): string {
  const numero = [doc.header.prefix, doc.header.number].filter(Boolean).join("-") || `fila ${doc.rowNumber}`;
  return `${numero} · ${doc.header.provider_name || doc.header.provider_nit}`;
}

/**
 * Convierte un documento del Excel en la estructura que produce la lectura del PDF.
 * Las notas de crédito no se causan por este flujo: quedan en "Requiere revisión manual".
 */
export function excelDocToExtracted(doc: PurchaseDocument): ExtractedInvoice {
  if (doc.kind === "credit_note") {
    throw new Error("NOTA_CREDITO_REVISION_MANUAL");
  }
  const h = doc.header;
  return {
    prefix: h.prefix || null,
    number: h.number || null,
    issue_date: h.issue_date || null,
    due_date: h.due_date || null,
    provider_nit: h.provider_nit || null,
    provider_name: h.provider_name || null,
    provider_address: h.provider_address || null,
    provider_city: h.provider_city || null,
    provider_phone: h.provider_phone || null,
    provider_email: h.provider_email || null,
    buyer_nit: h.buyer_nit || null,
    buyer_name: h.buyer_name || null,
    cufe: h.cufe || null,
    payment_form: h.payment_form || null,
    payment_method: h.payment_method || null,
    currency: h.currency || "COP",
    cost_center: null,
    notes: h.notes || null,
    subtotal: h.subtotal,
    discount: h.discount,
    iva: h.iva,
    impoconsumo: h.impoconsumo,
    retefuente: h.retefuente,
    reteiva: h.reteiva,
    reteica: h.reteica,
    total: h.total,
    lines: doc.lines.map((l) => ({
      code: l.code || null,
      description: l.description,
      quantity: l.quantity,
      unit_value: l.unit_value,
      discount: l.discount,
      iva: l.iva,
      retention: 0,
      impoconsumo: l.impoconsumo,
      total: l.total,
    })),
  };
}
