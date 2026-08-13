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

export type ItemStatus = "pending" | "reading" | "processing" | "completed" | "error" | "duplicate";

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
  reading: "Leyendo",
  processing: "Procesando",
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

/** Huellas de archivos ya procesados correctamente en la empresa (control de duplicados). */
export async function existingFingerprints(companyId: string, hashes: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < hashes.length; i += 200) {
    const chunk = hashes.slice(i, i + 200);
    const { data } = await supabase
      .from("bulk_upload_items")
      .select("fingerprint")
      .eq("company_id", companyId)
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
  const errors = items.filter((i) => i.status === "error").length;
  const pending = items.filter((i) => i.status === "pending" || i.status === "reading" || i.status === "processing").length;
  const status: UploadStatus = pending > 0 ? "processing" : errors > 0 ? "completed_with_errors" : "completed";
  await updateUpload(uploadId, {
    processed_count: processed,
    error_count: errors,
    status,
    ...(pending === 0 ? { finished_at: new Date().toISOString() } : { finished_at: null }),
  });
  return status;
}

export async function fileFromStorage(path: string, name: string): Promise<File> {
  const { data, error } = await supabase.storage.from("facturas").download(path);
  if (error || !data) throw new Error(error?.message ?? "No fue posible recuperar el archivo guardado.");
  return new File([data], name, { type: "application/pdf" });
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
export function mensajeUsuario(fileName: string, error: string): string {
  if (/duplicad|ya fue causada|ya existe/i.test(error)) return `${fileName}: este documento ya fue procesado.`;
  if (/empresa/i.test(error)) return `${fileName}: la factura no pertenece a la empresa activa.`;
  if (/pdf|ilegible|dañad|contraseñ/i.test(error)) return `${fileName} no pudo ser leída. Puede reintentarse.`;
  return `${fileName} no pudo ser procesada. Puede reintentarse.`;
}
