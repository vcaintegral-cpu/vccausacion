import { supabase } from "@/integrations/supabase/client";

/**
 * Referencia única al archivo original cargado por el usuario. No se generan
 * ni se duplican archivos: Historial y Documentos apuntan al mismo objeto en Storage.
 */
export type InvoiceFileRef = { file_path: string | null; file_name: string | null };

async function signedUrl(path: string, download?: string) {
  const { data, error } = await supabase.storage
    .from("facturas")
    .createSignedUrl(path, 300, download ? { download } : undefined);
  if (error || !data?.signedUrl) throw new Error(error?.message ?? "No fue posible abrir el documento.");
  return data.signedUrl;
}

export async function openInvoiceFile(ref: InvoiceFileRef) {
  if (!ref.file_path) throw new Error("PDF no disponible");
  window.open(await signedUrl(ref.file_path), "_blank", "noopener,noreferrer");
}

export async function downloadInvoiceFile(ref: InvoiceFileRef) {
  if (!ref.file_path) throw new Error("PDF no disponible");
  const url = await signedUrl(ref.file_path, ref.file_name ?? "factura.pdf");
  const a = document.createElement("a");
  a.href = url;
  a.download = ref.file_name ?? "factura.pdf";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
