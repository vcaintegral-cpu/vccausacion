// Diagnóstico del flujo ZIP SIN llamar a la IA.
// Usa exactamente el mismo lector que la carga individual (prepareInvoiceFile).
import { supabase } from "@/integrations/supabase/client";
import { prepareInvoiceFile } from "@/lib/invoice-file";
import { fileFromStorage, type BulkItem } from "@/lib/bulk-upload-store";

export type BulkDiagnosis = {
  fileName: string;
  bucket: string;
  storagePath: string | null;
  exists: boolean;
  sizeBytes: number | null;
  mimeType: string | null;
  downloadOk: boolean;
  pdfValid: boolean;
  textChars: number;
  readMode: "texto" | "imagen" | "—";
  stage: string;
  code: string;
  message: string;
};

/** Etapa + código legible para cualquier error del flujo masivo. */
export function errorCode(stage: string, message: string): string {
  if (/ERROR_ARCHIVO_NO_ENCONTRADO|not found|Object not found/i.test(message)) return "STORAGE_NOT_FOUND";
  if (/ERROR_STORAGE/i.test(message)) return "STORAGE_DOWNLOAD_ERROR";
  if (/ERROR_SUBIDA_PDF/i.test(message)) return "STORAGE_UPLOAD_ERROR";
  if (/ERROR_ARCHIVO_VACIO/i.test(message)) return "EMPTY_FILE";
  if (/ERROR_PDF_INVALIDO|no contiene un PDF válido/i.test(message)) return "PDF_INVALID";
  if (/contraseñ|password/i.test(message)) return "PDF_PASSWORD";
  if (/ERROR_NO_SE_PUDO_LEER_PDF|texto/i.test(message) && stage === "reading") return "PDF_READ_ERROR";
  if (/duplicad|ya fue causada|ya existe|repetido/i.test(message)) return "DUPLICATE";
  if (/comprador/i.test(message)) return "BUYER_MISMATCH";
  if (stage === "extracting_data") return "AI_EXTRACT_ERROR";
  return "UNKNOWN_ERROR";
}

/** Recupera el PDF desde Storage y lo lee (texto/imagen). No consume créditos de IA. */
export async function diagnoseItem(item: BulkItem): Promise<BulkDiagnosis> {
  const bucket = item.storage_bucket ?? "facturas";
  const base: BulkDiagnosis = {
    fileName: item.file_name,
    bucket,
    storagePath: item.storage_path,
    exists: false,
    sizeBytes: null,
    mimeType: null,
    downloadOk: false,
    pdfValid: false,
    textChars: 0,
    readMode: "—",
    stage: "download_pdf",
    code: "OK",
    message: "OK",
  };
  if (!item.storage_path) {
    return { ...base, code: "STORAGE_NOT_FOUND", message: "La tarea no tiene ruta de almacenamiento (el PDF nunca se guardó)." };
  }
  // Existencia real del objeto en el bucket.
  const folder = item.storage_path.split("/").slice(0, -1).join("/");
  const name = item.storage_path.split("/").pop()!;
  const { data: listed } = await supabase.storage.from(bucket).list(folder, { search: name, limit: 100 });
  base.exists = (listed ?? []).some((o) => o.name === name);

  let stored;
  try {
    stored = await fileFromStorage(item.storage_path, item.file_name, bucket);
  } catch (error) {
    const message = error instanceof Error ? error.message : "No fue posible recuperar el PDF.";
    return { ...base, code: errorCode("download_pdf", message), message };
  }
  base.downloadOk = true;
  base.sizeBytes = stored.size;
  base.mimeType = stored.mimeType;
  base.pdfValid = true;

  base.stage = "extract_text";
  try {
    const content = await prepareInvoiceFile(stored.file);
    base.textChars = content.text?.length ?? 0;
    base.readMode = content.text ? "texto" : "imagen";
    if (!content.text && !content.images?.length && !content.dataUrl) {
      return { ...base, code: "PDF_READ_ERROR", message: "No se obtuvo texto ni imagen legible del PDF." };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "No fue posible leer el PDF.";
    return { ...base, code: errorCode("extract_text", message), message };
  }
  return { ...base, stage: "ready_for_ai", code: "OK", message: "PDF recuperado y leído correctamente." };
}
