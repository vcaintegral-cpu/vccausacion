// Lectura del estado real de la cola de trabajos (fuente de verdad = base de datos).
import { supabase } from "@/integrations/supabase/client";

export type JobStatus =
  | "pending"
  | "processing"
  | "reading"
  | "extracting_data"
  | "accounting"
  | "needs_ocr"
  | "ready_for_review"
  | "approved"
  | "syncing_siigo"
  | "synchronized"
  | "error"
  | "duplicate"
  | "cancelled";

export type ProcessingJob = {
  id: string;
  job_type: string;
  upload_id: string | null;
  item_id: string | null;
  invoice_id: string | null;
  company_id: string;
  file_name: string;
  storage_bucket: string;
  storage_path: string | null;
  status: JobStatus;
  processing_stage: string | null;
  attempt_count: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  user_message: string | null;
  error_stage: string | null;
  error_stack: string | null;
  http_status: number | null;
  retryable: boolean;
  created_at: string;
  updated_at: string;
};

export const JOB_LABEL: Record<string, string> = {
  pending: "Pendiente",
  processing: "Procesando",
  reading: "Leyendo",
  extracting_data: "Extrayendo datos",
  accounting: "Causando",
  needs_ocr: "Pendiente de OCR",
  ready_for_review: "Lista para revisar",
  approved: "Aprobada",
  syncing_siigo: "Enviando a Siigo",
  synchronized: "Sincronizada",
  error: "Error",
  duplicate: "Duplicada",
  cancelled: "Cancelada",
};

const ACTIVAS: JobStatus[] = ["processing", "reading", "extracting_data", "accounting", "syncing_siigo"];

export type JobRowInsert = {
  company_id: string;
  upload_id: string;
  item_id: string;
  file_name: string;
  storage_bucket: string;
  storage_path: string | null;
  job_type?: string;
  priority?: number;
};

/** Prioridad de la cola: menor número = se atiende antes. */
export const JOB_PRIORITY = { high: 1, normal: 5, low: 9 } as const;

/**
 * Crea un trabajo independiente por cada documento, sin duplicar los que ya existen.
 * Se evita ON CONFLICT: la comprobación previa por item_id hace la operación idempotente
 * y un fallo puntual de un lote nunca detiene a las demás cargas.
 */
export async function createJobs(rows: JobRowInsert[]) {
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.item_id);
  const existentes = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase
      .from("processing_jobs")
      .select("item_id")
      .in("item_id", ids.slice(i, i + 200));
    for (const row of data ?? []) {
      const id = (row as { item_id: string | null }).item_id;
      if (id) existentes.add(id);
    }
  }
  const nuevos = rows
    .filter((r) => !existentes.has(r.item_id))
    .map((r) => ({ job_type: "document_processing", priority: JOB_PRIORITY.normal, ...r }));
  let creados = 0;
  for (let i = 0; i < nuevos.length; i += 200) {
    const lote = nuevos.slice(i, i + 200);
    const { error } = await supabase.from("processing_jobs").insert(lote as never);
    if (error) {
      // Un choque con un trabajo creado en paralelo no es un fallo de la carga.
      if (!/duplicate key|already exists/i.test(error.message)) throw new Error(error.message);
      continue;
    }
    creados += lote.length;
  }
  return creados;
}

/**
 * Reanuda una carga sin volver a subir el ZIP: crea los trabajos que falten para
 * los documentos pendientes y reencola los que quedaron abandonados o con error.
 * Solo afecta al upload indicado; las demás cargas siguen su curso.
 */
export async function ensureUploadJobs(uploadId: string, incluirErrores = true) {
  const { data: items, error } = await supabase
    .from("bulk_upload_items")
    .select("id, company_id, file_name, storage_bucket, storage_path, status")
    .eq("upload_id", uploadId);
  if (error) throw new Error(error.message);

  const rows = (items ?? []) as unknown as Array<{
    id: string;
    company_id: string;
    file_name: string;
    storage_bucket: string | null;
    storage_path: string | null;
    status: string;
  }>;
  const recuperables = rows.filter(
    (i) =>
      i.storage_path &&
      (["pending", "downloading", "reading", "ocr", "extracting_data", "validating_company", "ready_for_accounting", "processing"].includes(
        i.status,
      ) ||
        (incluirErrores && i.status === "error")),
  );

  const creados = await createJobs(
    recuperables.map((i) => ({
      company_id: i.company_id,
      upload_id: uploadId,
      item_id: i.id,
      file_name: i.file_name,
      storage_bucket: i.storage_bucket ?? "facturas",
      storage_path: i.storage_path,
    })),
  );

  // Reencola los trabajos ya existentes de ESTA carga que quedaron detenidos.
  await resumeUpload(uploadId, incluirErrores);
  return { creados, recuperables: recuperables.length };
}

/** Despierta al worker del backend (no mantiene vivo el proceso: solo lo arranca). */
export async function kickWorker() {
  try {
    await fetch("/api/public/jobs/run", {
      method: "POST",
      keepalive: true,
      headers: {
        "content-type": "application/json",
        apikey: import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] as string,
      },
      body: JSON.stringify({ limit: 3 }),
    });
  } catch {
    // Si falla el arranque inmediato, pg_cron retoma la cola en el próximo minuto.
  }
}

export async function listJobs(companyId: string, limit = 500): Promise<ProcessingJob[]> {
  const { data, error } = await supabase
    .from("processing_jobs")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ProcessingJob[];
}

export type QueueSummary = {
  total: number;
  pendientes: number;
  procesando: number;
  errores: number;
  listas: number;
  sincronizadas: number;
  procesosActivos: number;
};

export function summarize(jobs: ProcessingJob[]): QueueSummary {
  const pendientes = jobs.filter((j) => j.status === "pending" || j.status === "needs_ocr").length;
  const procesando = jobs.filter((j) => ACTIVAS.includes(j.status)).length;
  return {
    total: jobs.length,
    pendientes,
    procesando,
    errores: jobs.filter((j) => j.status === "error").length,
    listas: jobs.filter((j) => j.status === "ready_for_review" || j.status === "approved").length,
    sincronizadas: jobs.filter((j) => j.status === "synchronized").length,
    procesosActivos: new Set(
      jobs.filter((j) => j.status === "pending" || ACTIVAS.includes(j.status)).map((j) => j.upload_id ?? j.id),
    ).size,
  };
}

export async function cancelUpload(uploadId: string) {
  const { error } = await supabase.rpc("cancel_upload_jobs", { _upload_id: uploadId } as never);
  if (error) throw new Error(error.message);
}

export async function resumeUpload(uploadId: string, incluirErrores = false) {
  const { error } = await supabase.rpc("resume_upload_jobs", {
    _upload_id: uploadId,
    _include_errors: incluirErrores,
  } as never);
  if (error) throw new Error(error.message);
  await kickWorker();
}

/** Reencola únicamente errores reintentables existentes, sin crear documentos ni jobs. */
export async function retryUploadErrors(uploadId: string) {
  const { data: jobs, error: readError } = await supabase
    .from("processing_jobs")
    .select("id, item_id")
    .eq("upload_id", uploadId)
    .eq("status", "error")
    .eq("retryable", true);
  if (readError) throw new Error(readError.message);

  const rows = (jobs ?? []) as Array<{ id: string; item_id: string | null }>;
  if (rows.length === 0) return 0;
  const jobIds = rows.map((job) => job.id);
  const itemIds = rows.map((job) => job.item_id).filter((id): id is string => Boolean(id));

  const { error: jobError } = await supabase
    .from("processing_jobs")
    .update({
      status: "pending",
      attempt_count: 0,
      processing_stage: "reencolado",
      error_code: null,
      error_message: null,
      error_stage: null,
      error_stack: null,
      http_status: null,
      retryable: false,
      locked_at: null,
      locked_by: null,
      lease_until: null,
      completed_at: null,
    } as never)
    .in("id", jobIds);
  if (jobError) throw new Error(jobError.message);

  if (itemIds.length > 0) {
    const { error: itemError } = await supabase
      .from("bulk_upload_items")
      .update({
        status: "pending",
        stage: "reencolado",
        error_message: null,
        user_message: null,
        retryable: false,
      } as never)
      .in("id", itemIds);
    if (itemError) throw new Error(itemError.message);
  }

  await kickWorker();
  return rows.length;
}

/** Reintento manual de un trabajo con error (no hay reintentos automáticos infinitos). */
export async function retryJob(jobId: string, reprocesarIa = false) {
  const patch: Record<string, unknown> = {
    status: "pending",
    attempt_count: 0,
    error_code: null,
    error_message: null,
    locked_at: null,
    locked_by: null,
    processing_stage: "reencolado",
  };
  // Solo se vuelve a llamar a la IA si el usuario lo pide explícitamente.
  if (reprocesarIa) patch["ai_result"] = null;
  const { error } = await supabase.from("processing_jobs").update(patch as never).eq("id", jobId);
  if (error) throw new Error(error.message);
  await kickWorker();
}
