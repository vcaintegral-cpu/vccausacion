// Persistencia del procesamiento masivo de facturas (ZIP).
// El comprimido y cada PDF quedan guardados en Storage, y cada PDF es una tarea
// independiente en base de datos: el proceso sobrevive a recargas y cierres del navegador.
import { supabase } from "@/integrations/supabase/client";

export type UploadStatus =
  | "uploaded"
  | "extracting"
  | "processing"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelled";

export type ItemStatus =
  | "pending"
  | "downloading"
  | "reading"
  | "ocr"
  | "extracting_data"
  | "validating_company"
  | "ready_for_accounting"
  | "processing"
  | "requires_review"
  | "completed"
  | "error"
  | "duplicate";

export type BulkUpload = {
  id: string;
  company_id: string;
  file_name: string;
  storage_path: string | null;
  size_bytes: number;
  status: UploadStatus;
  files_found: number;
  pdf_found: number;
  skipped_files: number;
  processed_count: number;
  error_count: number;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

export type BulkItem = {
  id: string;
  upload_id: string;
  company_id: string;
  file_name: string;
  storage_path: string | null;
  size_bytes: number;
  fingerprint: string | null;
  status: ItemStatus;
  attempts: number;
  stage: string | null;
  error_message: string | null;
  user_message: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  invoice_total: number | null;
  score: number | null;
  needs_review: boolean;
  position: number;
  provider_name?: string | null;
  provider_nit?: string | null;
  buyer_name?: string | null;
  buyer_nit?: string | null;
  issue_date?: string | null;
  read_status?: string | null;
  storage_bucket?: string;
  download_status?: string | null;
  stored_size_bytes?: number | null;
  mime_type?: string | null;
  content_status?: string | null;
  extracted_text?: string | null;
  company_validation?: string | null;
};

export const ACTIVE_STATUSES: UploadStatus[] = ["uploaded", "extracting", "processing", "completed_with_errors"];

export const UPLOAD_LABEL: Record<UploadStatus, string> = {
  uploaded: "Cargado",
  extracting: "Descomprimiendo",
  processing: "Procesando",
  completed: "Completado",
  completed_with_errors: "Con errores",
  failed: "Fallido",
  cancelled: "Cancelado",
};

export const ITEM_LABEL: Record<ItemStatus, string> = {
  pending: "Pendiente",
  downloading: "Recuperando PDF",
  reading: "Leyendo",
  ocr: "Leyendo imagen",
  extracting_data: "Extrayendo datos",
  validating_company: "Validando empresa",
  ready_for_accounting: "Lista para causar",
  processing: "Procesando",
  requires_review: "Requiere revisión",
  completed: "Procesada",
  error: "Error",
  duplicate: "Duplicada",
};

export async function createUpload(params: {
  companyId: string;
  fileName: string;
  size: number;
}): Promise<BulkUpload> {
  const { data, error } = await supabase
    .from("bulk_uploads")
    .insert({
      company_id: params.companyId,
      file_name: params.fileName,
      size_bytes: params.size,
      status: "uploaded",
      started_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as unknown as BulkUpload;
}

export async function updateUpload(id: string, patch: Partial<BulkUpload>) {
  const { error } = await supabase.from("bulk_uploads").update(patch as never).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function updateItem(id: string, patch: Partial<BulkItem>) {
  const { error } = await supabase.from("bulk_upload_items").update(patch as never).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function insertItems(rows: Array<Partial<BulkItem>>): Promise<BulkItem[]> {
  if (rows.length === 0) return [];
  const out: BulkItem[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const { data, error } = await supabase
      .from("bulk_upload_items")
      .insert(rows.slice(i, i + 200) as never)
      .select();
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as unknown as BulkItem[]));
  }
  return out.sort((a, b) => a.position - b.position);
}

export async function listItems(uploadId: string): Promise<BulkItem[]> {
  const out: BulkItem[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("bulk_upload_items")
      .select("*")
      .eq("upload_id", uploadId)
      .order("position")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as BulkItem[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

export async function listUploads(companyId: string, limit = 30): Promise<BulkUpload[]> {
  const { data, error } = await supabase
    .from("bulk_uploads")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as BulkUpload[];
}

/**
 * Huellas de archivos que terminaron correctamente en la empresa.
 * Las tareas pendientes, fallidas o abandonadas no bloquean una nueva carga del PDF.
 */
export async function existingFingerprints(companyId: string, hashes: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < hashes.length; i += 200) {
    const chunk = hashes.slice(i, i + 200);
    const { data } = await supabase
      .from("bulk_upload_items")
      .select("fingerprint")
      .eq("company_id", companyId)
      .eq("status", "completed")
      .in("fingerprint", chunk);
    for (const row of data ?? []) {
      const f = (row as { fingerprint: string | null }).fingerprint;
      if (f) found.add(f);
    }
  }
  return found;
}

/** Recalcula contadores del proceso a partir del estado real de sus tareas. */
export async function refreshUploadCounters(uploadId: string, items: BulkItem[]) {
  const processed = items.filter((i) => i.status === "completed").length;
  const errors = items.filter((i) => i.status === "error" || i.status === "requires_review").length;
  const pending = items.filter((i) =>
    ["pending", "downloading", "reading", "ocr", "extracting_data", "validating_company", "ready_for_accounting", "processing"].includes(i.status),
  ).length;
  const status: UploadStatus = pending > 0 ? "processing" : errors > 0 ? "completed_with_errors" : "completed";
  await updateUpload(uploadId, {
    processed_count: processed,
    error_count: errors,
    status,
    ...(pending === 0 ? { finished_at: new Date().toISOString() } : { finished_at: null }),
  });
  return status;
}

export type StoredPdf = {
  file: File;
  bucket: string;
  path: string;
  size: number;
  mimeType: string;
};

export async function fileFromStorage(path: string, name: string, bucket = "facturas"): Promise<StoredPdf> {
  if (!path) throw new Error("ERROR_ARCHIVO_NO_ENCONTRADO: la tarea no tiene una ruta de almacenamiento.");
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`ERROR_STORAGE: ${error?.message ?? "no fue posible recuperar el PDF"}`);
  if (data.size === 0) throw new Error("ERROR_ARCHIVO_VACIO: el PDF guardado no contiene datos.");
  const bytes = new Uint8Array(await data.slice(0, 5).arrayBuffer());
  const validPdf = new TextDecoder().decode(bytes) === "%PDF-";
  if (!validPdf) throw new Error("ERROR_PDF_INVALIDO: el archivo recuperado no contiene un PDF válido.");
  const mimeType = data.type || "application/pdf";
  return { file: new File([data], name, { type: "application/pdf" }), bucket, path, size: data.size, mimeType };
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const hash = await crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `len:${bytes.length}`;
}

/** Mensaje sencillo para el usuario final; el detalle técnico queda en error_message. */
export async function deleteUpload(uploadId: string) {
  const items = await listItems(uploadId);
  const { data: up } = await supabase.from("bulk_uploads").select("storage_path").eq("id", uploadId).maybeSingle();
  const paths = [
    ...items.map((i) => i.storage_path).filter((p): p is string => !!p),
    ...((up as { storage_path: string | null } | null)?.storage_path ? [(up as { storage_path: string }).storage_path] : []),
  ];
  for (let i = 0; i < paths.length; i += 100) {
    await supabase.storage.from("facturas").remove(paths.slice(i, i + 100));
  }
  const del = await supabase.from("bulk_upload_items").delete().eq("upload_id", uploadId);
  if (del.error) throw new Error(del.error.message);
  const delUp = await supabase.from("bulk_uploads").delete().eq("id", uploadId);
  if (delUp.error) throw new Error(delUp.error.message);
}

export function mensajeUsuario(fileName: string, error: string): string {
  if (/duplicad|ya fue causada|ya existe/i.test(error)) return `${fileName}: este documento ya fue procesado.`;
  if (/identificar el comprador/i.test(error)) return "No fue posible identificar el comprador de la factura.";
  if (/no pertenece|no coincide/i.test(error)) return "Comprador diferente a la empresa activa.";
  if (/ERROR_STORAGE|ERROR_ARCHIVO_NO_ENCONTRADO/i.test(error)) return "Error al recuperar PDF.";
  if (/ERROR_ARCHIVO_VACIO|ERROR_PDF_INVALIDO/i.test(error)) return "El contenido recuperado no es un PDF válido.";
  if (/pdf|ilegible|dañad|contraseñ/i.test(error)) return `${fileName} no pudo ser leída. Puede reintentarse.`;
  return `${fileName} no pudo ser procesada. Puede reintentarse.`;
}
