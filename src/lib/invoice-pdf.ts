import { supabase } from "@/integrations/supabase/client";

/**
 * Referencia única al archivo original cargado por el usuario. No se generan
 * ni se duplican archivos: Historial, Documentos y el visor interno apuntan al
 * mismo objeto en Storage (bucket privado `facturas`).
 */
export type InvoiceFileRef = {
  file_path: string | null;
  file_name: string | null;
  prefix?: string | null;
  number?: string | null;
};

export const PDF_NO_DISPONIBLE =
  "El PDF asociado a esta factura no se encuentra disponible en el almacenamiento.";

function limpio(valor: string | null | undefined) {
  return (valor ?? "").toString().trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** FACTURA_FECR_24474.pdf · FACTURA_24474.pdf cuando no hay prefijo. */
export function invoicePdfFileName(ref: InvoiceFileRef) {
  const partes = [limpio(ref.prefix), limpio(ref.number)].filter(Boolean);
  if (partes.length === 0) return limpio(ref.file_name) || "FACTURA.pdf";
  return `FACTURA_${partes.join("_")}.pdf`;
}

/** Descarga el binario desde Storage respetando RLS. No se persiste ninguna URL firmada. */
export async function fetchInvoicePdfBytes(ref: InvoiceFileRef): Promise<Uint8Array> {
  if (!ref.file_path) throw new Error(PDF_NO_DISPONIBLE);
  const { data, error } = await supabase.storage.from("facturas").download(ref.file_path);
  if (error || !data) throw new Error(error?.message ?? "No fue posible visualizar el PDF.");
  return new Uint8Array(await data.arrayBuffer());
}

/** URL firmada temporal (5 min), sólo para "Abrir en nueva pestaña". */
export async function invoiceSignedUrl(ref: InvoiceFileRef) {
  if (!ref.file_path) throw new Error(PDF_NO_DISPONIBLE);
  const { data, error } = await supabase.storage.from("facturas").createSignedUrl(ref.file_path, 300);
  if (error || !data?.signedUrl) throw new Error(error?.message ?? "No fue posible abrir el documento.");
  return data.signedUrl;
}

export async function openInvoiceFile(ref: InvoiceFileRef) {
  window.open(await invoiceSignedUrl(ref), "_blank", "noopener,noreferrer");
}

/** Descarga dentro de la aplicación (blob), sin navegar a Storage. */
export async function downloadInvoiceFile(ref: InvoiceFileRef, bytes?: Uint8Array) {
  const datos = bytes ?? (await fetchInvoicePdfBytes(ref));
  const url = URL.createObjectURL(new Blob([datos as BlobPart], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = invoicePdfFileName(ref);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
