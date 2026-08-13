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

/** Crea un trabajo independiente por cada PDF del comprimido. */
export async function createJobs(rows: JobRowInsert[]) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase
      .from("processing_jobs")
      .upsert(rows.slice(i, i + 200).map((r) => ({ job_type: "document_processing", ...r })) as never, {
        onConflict: "item_id,job_type",
        ignoreDuplicates: true,
      });
    if (error) throw new Error(error.message);
  }
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
