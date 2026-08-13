// Worker de segundo plano: toma trabajos de la cola persistente y los procesa
// con EXACTAMENTE el mismo motor que la causación individual.
import { createClient } from "@supabase/supabase-js";
import { extractText, getDocumentProxy } from "unpdf";

import { setDbClient } from "@/lib/db-client";
import { fetchCompanyPuc } from "@/lib/puc-data";
import { fetchCompanyKnowledge } from "@/lib/causacion-engine";
import { BulkInvoiceStageError, processInvoiceFile, type BulkConfig } from "@/lib/bulk-invoices";
import { mensajeUsuario } from "@/lib/bulk-upload-store";
import type { ExtractedInvoice } from "@/lib/extract.functions";

/** Mínimo de caracteres para considerar que el PDF trae texto digital (sin OCR). */
const MIN_DIGITAL_TEXT = 350;

export type JobRow = {
  id: string;
  job_type: string;
  upload_id: string | null;
  item_id: string | null;
  invoice_id: string | null;
  company_id: string;
  file_name: string;
  storage_bucket: string;
  storage_path: string | null;
  status: string;
  attempt_count: number;
  max_attempts: number;
  ai_result: unknown;
};

type QueryResult = { data: unknown; error: { message: string } | null; count?: number | null };
type Builder = {
  select: (cols?: string, opts?: { count?: "exact"; head?: boolean }) => Builder;
  update: (patch: Record<string, unknown>) => Builder;
  upsert: (rows: unknown, opts?: Record<string, unknown>) => Builder;
  eq: (col: string, value: unknown) => Builder;
  order: (col: string, opts?: Record<string, unknown>) => Builder;
  range: (from: number, to: number) => Builder;
  limit: (n: number) => Builder;
} & PromiseLike<QueryResult>;
type Client = {
  from: (table: string) => Builder;
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<QueryResult>;
  storage: { from: (bucket: string) => { download: (path: string) => Promise<{ data: Blob | null; error: { message: string } | null }> } };
};

let service: Client | null = null;

function serviceClient(): Client {
  if (service) return service;
  const url = process.env["SUPABASE_URL"]!;
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"]!;
  service = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (key.startsWith("sb_") && headers.get("Authorization") === `Bearer ${key}`) headers.delete("Authorization");
        headers.set("apikey", key);
        return fetch(input, { ...init, headers });
      },
    },
  }) as unknown as Client;
  return service;
}

const configCache = new Map<string, BulkConfig>();

async function pagedAll<T>(run: (from: number, to: number) => PromiseLike<QueryResult>) {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await run(from, from + PAGE - 1);
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

async function loadConfig(companyId: string): Promise<BulkConfig> {
  const hit = configCache.get(companyId);
  if (hit) return hit;
  const db = serviceClient();
  const [accounts, rules, taxes, products, categories, knowledge] = await Promise.all([
    fetchCompanyPuc(companyId),
    db.from("accounting_rules").select("*").eq("company_id", companyId),
    db.from("tax_rates").select("*").eq("company_id", companyId),
    pagedAll((from, to) => db.from("products").select("*").eq("company_id", companyId).range(from, to)),
    pagedAll((from, to) => db.from("product_categories").select("*").eq("company_id", companyId).range(from, to)),
    fetchCompanyKnowledge(companyId),
  ]);
  const config = {
    accounts,
    rules: (rules.data ?? []) as never,
    taxes: (taxes.data ?? []) as never,
    products: products as never,
    categories: categories as never,
    knowledge,
  } as BulkConfig;
  configCache.set(companyId, config);
  return config;
}

/** Lee el texto digital del PDF en el servidor (sin renderizar, sin OCR). */
async function readPdfText(bytes: Uint8Array): Promise<string> {
  try {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return String(text ?? "").replace(/[ \t]+/g, " ").trim();
  } catch {
    return "";
  }
}

async function updateJob(id: string, patch: Record<string, unknown>) {
  await serviceClient().from("processing_jobs").update(patch).eq("id", id);
}

async function updateItem(id: string | null, patch: Record<string, unknown>) {
  if (!id) return;
  await serviceClient().from("bulk_upload_items").update(patch).eq("id", id);
}

async function refreshUpload(uploadId: string | null) {
  if (!uploadId) return;
  const db = serviceClient();
  const { data: upRow } = await db.from("bulk_uploads").select("status").eq("id", uploadId).limit(1);
  const actual = ((upRow ?? []) as Array<{ status: string }>)[0]?.status;
  // Una carga cancelada por el usuario no vuelve a activarse sola.
  if (actual === "cancelled") return;
  const { data } = await db.from("bulk_upload_items").select("status").eq("upload_id", uploadId);
  const rows = (data ?? []) as Array<{ status: string }>;
  const processed = rows.filter((r) => r.status === "completed").length;
  const errors = rows.filter((r) => r.status === "error" || r.status === "requires_review").length;
  const pending = rows.length - processed - errors - rows.filter((r) => r.status === "duplicate").length;
  await db
    .from("bulk_uploads")
    .update({
      processed_count: processed,
      error_count: errors,
      status: pending > 0 ? "processing" : errors > 0 ? "completed_with_errors" : "completed",
      finished_at: pending > 0 ? null : new Date().toISOString(),
      ...(pending > 0 ? { error_code: null, error_message: null, error_stage: null } : {}),
    })
    .eq("id", uploadId);
}

async function extractWithAi(input: Record<string, unknown>): Promise<ExtractedInvoice> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) throw new Error("Falta la configuración de IA (LOVABLE_API_KEY)");
  const { extractInvoiceWithAi } = await import("@/lib/extract.server");
  return (await extractInvoiceWithAi(input as never, apiKey)) as ExtractedInvoice;
}

/** Procesa un trabajo de lectura + causación de un documento. */
async function runDocumentJob(job: JobRow) {
  const db = serviceClient();
  await updateJob(job.id, { status: "reading", processing_stage: "recuperando_pdf" });
  await updateItem(job.item_id, { status: "downloading", stage: "recuperando_pdf", attempts: job.attempt_count });

  if (!job.storage_path) throw new BulkInvoiceStageError("ERROR_ARCHIVO_NO_ENCONTRADO: la tarea no tiene ruta.", "reading");
  const { data: blob, error } = await db.storage.from(job.storage_bucket || "facturas").download(job.storage_path);
  if (error || !blob) throw new BulkInvoiceStageError(`ERROR_STORAGE: ${error?.message ?? "sin archivo"}`, "reading");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length === 0) throw new BulkInvoiceStageError("ERROR_ARCHIVO_VACIO: el PDF guardado no tiene datos.", "reading");

  await updateJob(job.id, { status: "reading", processing_stage: "leyendo_pdf" });
  await updateItem(job.item_id, {
    status: "reading",
    stage: "leyendo_pdf",
    download_status: "OK",
    stored_size_bytes: bytes.length,
    mime_type: "application/pdf",
    content_status: "OK",
  });

  const guardado = job.ai_result as ExtractedInvoice | null;
  const texto = await readPdfText(bytes);
  if (!guardado && texto.length < MIN_DIGITAL_TEXT) {
    // PDF escaneado: el servidor no puede renderizar imágenes. Queda pendiente de OCR
    // en el navegador y NO bloquea el resto del lote.
    await updateJob(job.id, {
      status: "needs_ocr",
      processing_stage: "requiere_ocr",
      locked_at: null,
      locked_by: null,
      lease_until: null,
      user_message: "El PDF no tiene texto digital: se leerá con OCR al abrir el módulo de causación.",
    });
    await updateItem(job.item_id, {
      status: "pending",
      stage: "requiere_ocr",
      user_message: "PDF escaneado: pendiente de lectura con OCR desde el módulo de causación.",
    });
    return;
  }

  await updateJob(job.id, { status: "extracting_data", processing_stage: guardado ? "reusando_lectura_ia" : "extrayendo_datos" });
  await updateItem(job.item_id, { status: "extracting_data", stage: "extrayendo_datos", extracted_text: texto.slice(0, 20000) });

  const config = await loadConfig(job.company_id);
  const file = new File([new Uint8Array(bytes)], job.file_name, { type: "application/pdf" });

  const result = await processInvoiceFile({
    file,
    companyId: job.company_id,
    config,
    storagePath: job.storage_path,
    prepared: { text: texto },
    cachedExtraction: guardado ?? undefined,
    extract: (async (args: { data: Record<string, unknown> }) => extractWithAi(args.data)) as never,
    onExtracted: async (data) => {
      // Se guarda la lectura de IA: un reintento no vuelve a gastar créditos.
      await updateJob(job.id, { ai_result: data });
    },
    onStage: async (stage, trace) => {
      await updateJob(job.id, { processing_stage: stage });
      await updateItem(job.item_id, {
        status: stage === "ready_for_accounting" ? "processing" : stage,
        stage,
        ...(trace
          ? {
              provider_name: trace.providerName,
              provider_nit: trace.providerNit,
              buyer_name: trace.buyerName,
              buyer_nit: trace.buyerNit,
              invoice_number: trace.invoiceNumber,
              issue_date: trace.issueDate,
              extracted_text: trace.text,
              read_status: trace.readMode === "texto" ? "Leída (texto)" : "Leída (imagen)",
            }
          : {}),
      });
    },
  });

  await updateItem(job.item_id, {
    status: "completed",
    stage: "guardado",
    invoice_id: result.invoiceId,
    invoice_number: result.numero,
    invoice_total: result.total,
    score: result.score,
    needs_review: result.needsReview,
    error_message: null,
    user_message: null,
    company_validation: "OK",
  });
  await updateJob(job.id, {
    status: result.needsReview ? "ready_for_review" : "ready_for_review",
    processing_stage: "guardado",
    invoice_id: result.invoiceId,
    completed_at: new Date().toISOString(),
    locked_at: null,
    locked_by: null,
    lease_until: null,
  });
}

async function failJob(job: JobRow, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const duplicado = /duplicad|ya fue causada|ya existe/i.test(message);
  const agotado = job.attempt_count >= job.max_attempts;
  const stage = error instanceof BulkInvoiceStageError ? error.stage : "processing";
  const requiereRevision = error instanceof BulkInvoiceStageError && error.requiresReview;

  await updateItem(job.item_id, {
    status: duplicado ? "duplicate" : requiereRevision ? "requires_review" : "error",
    stage,
    error_message: message.slice(0, 1000),
    user_message: mensajeUsuario(job.file_name, message),
    ...(error instanceof BulkInvoiceStageError && error.trace
      ? {
          provider_name: error.trace.providerName,
          provider_nit: error.trace.providerNit,
          buyer_name: error.trace.buyerName,
          buyer_nit: error.trace.buyerNit,
          invoice_number: error.trace.invoiceNumber,
          extracted_text: error.trace.text,
          company_validation: stage === "validating_company" ? message.slice(0, 500) : null,
        }
      : {}),
  });
  await updateJob(job.id, {
    // Un duplicado o un rechazo de negocio no se reintenta.
    status: duplicado ? "duplicate" : agotado || duplicado || stage === "validating_company" ? "error" : "pending",
    processing_stage: stage,
    error_code: duplicado ? "DUPLICATE" : stage.toUpperCase(),
    error_message: message.slice(0, 1000),
    user_message: mensajeUsuario(job.file_name, message),
    locked_at: null,
    locked_by: null,
    lease_until: null,
    completed_at: new Date().toISOString(),
  });
}

/** Toma trabajos de la cola y los procesa con concurrencia controlada. */
export async function runQueue(params: { limit?: number; workerId?: string; maxJobs?: number } = {}) {
  setDbClient(serviceClient());
  const db = serviceClient();
  const limit = Math.min(Math.max(params.limit ?? 3, 1), 5);
  const workerId = params.workerId ?? `worker-${crypto.randomUUID().slice(0, 8)}`;
  const maxJobs = params.maxJobs ?? 12;
  const deadline = Date.now() + 45_000;

  await db.rpc("release_stale_jobs", { _minutes: 5 });

  let procesados = 0;
  while (procesados < maxJobs && Date.now() < deadline) {
    const { data, error } = await db.rpc("claim_jobs", {
      _worker_id: workerId,
      _limit: Math.min(limit, maxJobs - procesados),
      _job_type: "document_processing",
    });
    if (error) throw new Error(error.message);
    const jobs = (data ?? []) as unknown as JobRow[];
    if (jobs.length === 0) break;

    await Promise.all(
      jobs.map(async (job) => {
        try {
          await runDocumentJob(job);
        } catch (err) {
          await failJob(job, err);
        }
        await refreshUpload(job.upload_id);
      }),
    );
    procesados += jobs.length;
  }

  const { count } = await db
    .from("processing_jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  return { processed: procesados, pending: count ?? 0, workerId };
}
