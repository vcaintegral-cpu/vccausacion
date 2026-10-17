// Motor de carga masiva desacoplado de la pantalla.
//
// Vive como singleton de módulo (fuera de React): mientras la aplicación esté
// abierta, el procesamiento continúa aunque el usuario salga de "Causar factura"
// y navegue a Historial, Documentos, Empresas, etc.
// El estado real siempre vive en base de datos (bulk_uploads / bulk_upload_items);
// la interfaz solo lo muestra.
//
// IMPORTANTE: no reimplementa la lectura de PDF, la IA ni la causación: reutiliza
// exactamente processInvoiceFile(), el mismo procesador del flujo individual.
import { useSyncExternalStore } from "react";

import { supabase } from "@/integrations/supabase/client";
import { extractInvoice } from "@/lib/extract.functions";
import { fetchCompanyPuc } from "@/lib/puc-data";
import { errorCode } from "@/lib/bulk-diagnostics";
import { BulkInvoiceStageError, processInvoiceFile, resetBulkBatch, saveExtractedInvoice, type BulkConfig, type InvoiceReadTrace } from "@/lib/bulk-invoices";
import { parsePurchaseWorkbook, type PurchaseDocument } from "@/lib/purchase-excel";
import { excelDocKey, excelDocToExtracted } from "@/lib/excel-invoice-adapter";
import { fetchProviderRules } from "@/lib/provider-rules";
import { fetchIvaConfig } from "@/lib/iva-treatment";
import { fetchCompanyKnowledge, type CompanyKnowledge } from "@/lib/causacion-engine";
import type { Rule, TaxRate } from "@/lib/accounting";
import {
  ACTIVE_STATUSES,
  fileFromStorage,
  listItems,
  listUploads,
  mensajeUsuario,
  refreshUploadCounters,
  updateItem,
  updateUpload,
  type BulkItem,
  type BulkUpload,
} from "@/lib/bulk-upload-store";

const PENDING_STATUSES: BulkItem["status"][] = [
  "pending",
  "downloading",
  "reading",
  "ocr",
  "extracting_data",
  "validating_company",
  "ready_for_accounting",
  "processing",
];

export type BulkProgress = {
  running: boolean;
  uploadId: string | null;
  companyId: string | null;
  fileName: string | null;
  total: number;
  done: number;
  active: number;
  pending: number;
  errors: number;
  review: number;
  duplicates: number;
  queued: number;
};

const EMPTY: BulkProgress = {
  running: false,
  uploadId: null,
  companyId: null,
  fileName: null,
  total: 0,
  done: 0,
  active: 0,
  pending: 0,
  errors: 0,
  review: 0,
  duplicates: 0,
  queued: 0,
};

let snapshot: BulkProgress = EMPTY;
const listeners = new Set<() => void>();
// Se avisa a la interfaz como máximo 4 veces por segundo: el avance sigue siendo
// inmediato en memoria, pero la pantalla no se vuelve a dibujar en cada paso.
let avisoPendiente = false;

function notificar() {
  avisoPendiente = false;
  for (const l of listeners) l();
}

function emit(patch: Partial<BulkProgress>) {
  snapshot = { ...snapshot, ...patch };
  if (avisoPendiente) return;
  avisoPendiente = true;
  setTimeout(notificar, 250);
}


function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Estado del procesamiento en segundo plano (se puede leer desde cualquier módulo). */
export function useBulkProgress(): BulkProgress {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY,
  );
}

export function getBulkProgress() {
  return snapshot;
}

// ----------------------------------------------------------------------------
// Parámetros contables (se leen una vez por empresa y se reutilizan en el lote)
// ----------------------------------------------------------------------------
export type Deps = { config: BulkConfig; knowledge: CompanyKnowledge };
const depsCache = new Map<string, Promise<Deps>>();

async function fetchAll<T>(
  run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await run(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

export async function loadDeps(companyId: string): Promise<Deps> {
  const cached = depsCache.get(companyId);
  if (cached) return cached;
  const promise = (async (): Promise<Deps> => {
    const [rules, taxes, accounts, products, categories, knowledge, company, providers, providerRules, auth] = await Promise.all([
      supabase.from("accounting_rules").select("*").eq("company_id", companyId),
      supabase.from("tax_rates").select("*").eq("company_id", companyId),
      fetchCompanyPuc(companyId),
      fetchAll((from, to) =>
        supabase
          .from("products")
          .select("code, name, kind, category, category_id, account_code, account_name")
          .eq("company_id", companyId)
          .eq("active", true)
          .order("code")
          .range(from, to),
      ),
      fetchAll((from, to) =>
        supabase
          .from("product_categories")
          .select("id, name, kind, account_code, account_name")
          .eq("company_id", companyId)
          .eq("active", true)
          .range(from, to),
      ),
      fetchCompanyKnowledge(companyId),
      supabase.from("companies").select("id,name,nit,uses_cost_centers,default_payable_account").eq("id",companyId).single(),
      fetchAll((from,to) => supabase.from("providers").select("nit,default_expense_account,default_payable_account,default_iva_account").eq("company_id",companyId).range(from,to)),
      fetchProviderRules(companyId),
      supabase.auth.getUser(),
    ]);
    if (company.error || !company.data || !auth.data.user) throw new Error("No se pudieron cargar los parámetros de la empresa.");
    await fetchIvaConfig(companyId);
    const config: BulkConfig = {
      batch: { company: company.data, providers: Object.fromEntries(providers.map((p) => [p.nit,p])), providerRules, userId: auth.data.user.id },
      accounts,
      rules: (rules.data ?? []) as unknown as Rule[],
      taxes: (taxes.data ?? []) as unknown as TaxRate[],
      products: products as BulkConfig["products"],
      categories: categories as BulkConfig["categories"],
      knowledge,
    };
    return { config, knowledge };
  })();
  depsCache.set(companyId, promise);
  promise.catch(() => depsCache.delete(companyId));
  return promise;
}

/** Fuerza recarga de catálogos (tras importar PUC, productos, impuestos, etc.). */
export function invalidateBulkDeps(companyId?: string) {
  if (companyId) depsCache.delete(companyId);
  else depsCache.clear();
}

// ----------------------------------------------------------------------------
// Cola de procesos
// ----------------------------------------------------------------------------
type QueuedUpload = { uploadId: string; companyId: string; fileName: string };

const queue: QueuedUpload[] = [];
let loop: Promise<void> | null = null;

function counters(items: BulkItem[]) {
  const done = items.filter((i) => i.status === "completed").length;
  const errors = items.filter((i) => i.status === "error").length;
  const review = items.filter((i) => i.status === "requires_review" || (i.status === "completed" && i.needs_review)).length;
  const duplicates = items.filter((i) => i.status === "duplicate").length;
  const pending = items.filter((i) => PENDING_STATUSES.includes(i.status)).length;
  return { total: items.length, done, errors, review, duplicates, pending };
}

/** Caché del libro Excel ya descargado y leído (una sola vez por carga). */
const excelCache = new Map<string, Promise<PurchaseDocument[]>>();

function parseExcelCached(storagePath: string, fileName: string, companyNit: string): Promise<PurchaseDocument[]> {
  const key = `${storagePath}|${companyNit}`;
  let cached = excelCache.get(key);
  if (!cached) {
    cached = (async () => {
      const stored = await fileFromStorage(storagePath, fileName, "facturas", false);
      return parsePurchaseWorkbook(await stored.file.arrayBuffer(), companyNit);
    })();
    excelCache.set(key, cached);
    cached.catch(() => excelCache.delete(key));
  }
  return cached;
}

/** Procesa un documento del Excel RECIBIDOS por la MISMA función de causación del PDF. */
async function processExcelItem(item: BulkItem, companyId: string, deps: Deps) {
  const key = item.fingerprint?.startsWith("excel:") ? item.fingerprint.slice(6) : "";
  if (!item.storage_path || !key) throw new Error("ERROR_ARCHIVO_NO_ENCONTRADO: la tarea no tiene el documento del Excel.");
  const docs = await parseExcelCached(item.storage_path, item.file_name, deps.config.batch?.company.nit ?? "");
  const doc = docs.find((d) => excelDocKey(d) === key);
  if (!doc) throw new Error("El documento ya no está en el archivo Excel cargado.");
  const trace: InvoiceReadTrace = {
    providerName: doc.header.provider_name || null,
    providerNit: doc.header.provider_nit || null,
    buyerName: doc.header.buyer_name || null,
    buyerNit: doc.header.buyer_nit || null,
    invoiceNumber: [doc.header.prefix, doc.header.number].filter(Boolean).join("-") || null,
    issueDate: doc.header.issue_date || null,
    text: null,
    readMode: "texto",
  };
  await updateItem(item.id, {
    status: "validating_company",
    stage: "validating_company",
    provider_name: trace.providerName,
    provider_nit: trace.providerNit,
    buyer_name: trace.buyerName,
    buyer_nit: trace.buyerNit,
    invoice_number: trace.invoiceNumber,
    issue_date: trace.issueDate,
    read_status: "Leída (Excel)",
  });
  if (doc.kind === "credit_note") {
    throw new BulkInvoiceStageError(
      "Nota de crédito electrónica: requiere revisión manual; no se causa automáticamente.",
      "validating_company",
      trace,
      true,
    );
  }
  const result = await saveExtractedInvoice({
    data: excelDocToExtracted(doc),
    fileName: item.file_name,
    companyId,
    config: deps.config,
    knowledge: deps.knowledge,
    readMode: "texto",
    rawExtraction: { fuente: "excel_recibidos", fila_excel: doc.rowNumber, tipo_documento: doc.type },
  });
  await updateItem(item.id, {
    status: "completed",
    stage: "guardado",
    invoice_id: result.invoiceId,
    invoice_number: result.numero,
    invoice_total: result.total,
    score: result.score,
    needs_review: result.needsReview,
    error_message: null,
    user_message: null,
    provider_name: result.providerName,
    provider_nit: result.providerNit,
    buyer_name: result.buyerName,
    buyer_nit: result.buyerNit,
    issue_date: result.issueDate,
    read_status: "Leída (Excel)",
  });
}

/** Procesa una tarea reutilizando el procesador individual (sin cambios de lógica). */
async function processItem(item: BulkItem, companyId: string, deps: Deps) {
  await updateItem(item.id, { status: "downloading", attempts: item.attempts + 1, stage: "recuperando_pdf" });
  try {
    if (item.fingerprint?.startsWith("excel:")) {
      await processExcelItem(item, companyId, deps);
      return;
    }
    if (!item.storage_path) throw new Error("ERROR_ARCHIVO_NO_ENCONTRADO: la tarea no tiene storage_path.");
    const stored = await fileFromStorage(item.storage_path, item.file_name, item.storage_bucket ?? "facturas");
    await updateItem(item.id, {
      download_status: "OK",
      stored_size_bytes: stored.size,
      mime_type: stored.mimeType,
      content_status: "OK",
    });
    const saveTrace = async (stage: string, trace?: InvoiceReadTrace) => {
      await updateItem(item.id, {
        status: stage as BulkItem["status"],
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
    };
    const result = await processInvoiceFile({
      file: stored.file,
      companyId,
      config: deps.config,
      extract: extractInvoice as never,
      storagePath: item.storage_path,
      onStage: saveTrace,
      knowledge: deps.knowledge,
    });
    await updateItem(item.id, {
      status: "completed",
      stage: "guardado",
      invoice_id: result.invoiceId,
      invoice_number: result.numero,
      invoice_total: result.total,
      score: result.score,
      needs_review: result.needsReview,
      error_message: null,
      user_message: null,
      provider_name: result.providerName,
      provider_nit: result.providerNit,
      buyer_name: result.buyerName,
      buyer_nit: result.buyerNit,
      issue_date: result.issueDate,
      read_status: result.readMode === "texto" ? "Leída (texto)" : "Leída (imagen)",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error al procesar";
    const duplicado = /duplicad|ya fue causada|ya existe|repetido/i.test(message);
    const staged = error instanceof BulkInvoiceStageError ? error : null;
    const trace = staged?.trace;
    const storageError = /ERROR_STORAGE|ERROR_ARCHIVO|ERROR_PDF_INVALIDO/.test(message);
    const stage = staged?.stage ?? (storageError ? "download_pdf" : "process_invoice");
    const code = errorCode(stage, message);
    await updateItem(item.id, {
      status: staged?.requiresReview ? "requires_review" : duplicado ? "duplicate" : "error",
      stage,
      error_message: message,
      user_message: `Etapa: ${stage} · Código: ${code} · ${mensajeUsuario(item.file_name, message)} · ${message}`,
      ...(storageError ? { download_status: "ERROR", content_status: "ERROR" } : {}),
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
            company_validation: staged?.requiresReview ? "REQUIERE_REVISION" : "ERROR",
          }
        : {}),
    });
  }
}

/** Facturas que se leen y causan al mismo tiempo dentro de un lote. */
export const CONCURRENCIA = 5;

async function runUpload(job: QueuedUpload) {
  resetBulkBatch();
  invalidateBulkDeps(job.companyId);
  const deps = await loadDeps(job.companyId);
  await updateUpload(job.uploadId, { status: "processing", finished_at: null });

  for (;;) {
    const items = await listItems(job.uploadId);
    const c = counters(items);
    emit({
      running: true,
      uploadId: job.uploadId,
      companyId: job.companyId,
      fileName: job.fileName,
      queued: queue.length,
      ...c,
      active: 0,
    });
    // Una factura con error nunca detiene el lote: solo se toman las pendientes.
    const pendientes = items.filter((i) => PENDING_STATUSES.includes(i.status));
    if (pendientes.length === 0) break;

    // Varias facturas en paralelo: la espera de la IA de una no bloquea a las demás.
    let cursor = 0;
    let activos = 0;
    const worker = async () => {
      for (;;) {
        const item = pendientes[cursor++];
        if (!item) return;
        activos += 1;
        emit({ active: activos, pending: Math.max(pendientes.length - cursor, 0) });
        try {
          await processItem(item, job.companyId, deps);
        } finally {
          activos -= 1;
          emit({ active: activos, done: snapshot.done + 1 });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, pendientes.length) }, worker));
  }

  const items = await listItems(job.uploadId);
  await refreshUploadCounters(job.uploadId, items);
  emit({ active: 0, ...counters(items) });
}


async function drain() {
  try {
    for (;;) {
      const job = queue.shift();
      if (!job) break;
      try {
        await runUpload(job);
      } catch (error) {
        await updateUpload(job.uploadId, {
          status: "failed",
          error_message: error instanceof Error ? error.message : "Error en el procesamiento en segundo plano.",
        }).catch(() => undefined);
      }
    }
  } finally {
    loop = null;
    emit({ running: false, active: 0, queued: 0 });
  }
}

function kick() {
  if (!loop) loop = drain();
}

/** Encola una carga para que se procese en segundo plano (no requiere pantalla abierta). */
export function startBackgroundUpload(job: QueuedUpload) {
  if (snapshot.uploadId === job.uploadId && snapshot.running) return;
  if (queue.some((q) => q.uploadId === job.uploadId)) return;
  queue.push(job);
  emit({ running: true, queued: queue.length, fileName: snapshot.fileName ?? job.fileName });
  kick();
}

/** Reintenta tareas puntuales sin reiniciar todo el ZIP. */
export async function retryBulkItems(job: QueuedUpload, itemIds: string[]) {
  for (const id of itemIds) {
    await updateItem(id, { status: "pending", stage: null, error_message: null, user_message: null });
  }
  startBackgroundUpload(job);
}

/** Al abrir la aplicación retoma automáticamente las cargas que quedaron a medias. */
export async function resumeBackgroundUploads(companyId: string) {
  if (!companyId) return;
  const uploads: BulkUpload[] = await listUploads(companyId, 10);
  for (const up of uploads.filter((u) => ACTIVE_STATUSES.includes(u.status))) {
    const items = await listItems(up.id);
    if (items.some((i) => PENDING_STATUSES.includes(i.status))) {
      startBackgroundUpload({ uploadId: up.id, companyId, fileName: up.file_name });
    }
  }
}
