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
import { estadoFacturaAfectada, facturaReferidaEnExcel, mensajeNotaCredito } from "@/lib/nota-credito";
import { fetchIvaConfig } from "@/lib/iva-treatment";
import { fetchCompanyKnowledge, type CompanyKnowledge } from "@/lib/causacion-engine";
import { cargarPrecedentes, cargarTablasBases, invalidarPrecedentes, invalidarTablasBases } from "@/lib/precedente-tributario.data";
import type { ImpuestoConfigurado } from "@/lib/precedente-tributario";
import type { Rule, TaxRate } from "@/lib/accounting";
import {
  cancelPendingItems,
  fileFromStorage,
  listItemStatuses,
  listActiveUploads,
  listItems,
  mensajeUsuario,
  refreshUploadCounters,
  updateItem,
  updateItems,
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
      fetchAll((from,to) => supabase.from("providers").select("nit,default_expense_account,default_payable_account,default_iva_account,purchase_tax_profile").eq("company_id",companyId).range(from,to)),
      fetchProviderRules(companyId),
      supabase.auth.getUser(),
    ]);
    if (company.error || !company.data || !auth.data.user) throw new Error("No se pudieron cargar los parámetros de la empresa.");
    // Precedente tributario (IVA y retenciones sincronizados con Siigo) y bases
    // mínimas: se precargan para el lote y quedan en una caché de 5 minutos, de
    // modo que lo sincronizado después con Siigo se aprende sin recargar la app.
    const [precedentes, tablasBases] = await Promise.all([
      cargarPrecedentes(companyId, (taxes.data ?? []) as unknown as ImpuestoConfigurado[]),
      cargarTablasBases(),
      fetchIvaConfig(companyId),
    ]);
    const config: BulkConfig = {
      batch: { company: company.data, providers: Object.fromEntries(providers.map((p) => [p.nit,p])), providerRules, userId: auth.data.user.id },
      accounts,
      rules: (rules.data ?? []) as unknown as Rule[],
      taxes: (taxes.data ?? []) as unknown as TaxRate[],
      products: products as BulkConfig["products"],
      categories: categories as BulkConfig["categories"],
      knowledge,
      // Fijos para todo el lote: un lote de más de 5 minutos ya no vuelve a descargar
      // el precedente tributario completo a mitad de camino.
      precedentes,
      tablasBases,
    };
    return { config, knowledge };
  })();
  depsCache.set(companyId, promise);
  promise.catch(() => depsCache.delete(companyId));
  return promise;
}

/** Fuerza recarga de catálogos (tras importar PUC, productos, impuestos, etc.). */
export function invalidateBulkDeps(companyId?: string) {
  invalidarPrecedentes(companyId);
  invalidarTablasBases();
  if (companyId) depsCache.delete(companyId);
  else depsCache.clear();
}

// ----------------------------------------------------------------------------
// Cola de procesos
// ----------------------------------------------------------------------------
type QueuedUpload = { uploadId: string; companyId: string; fileName: string };

const queue: QueuedUpload[] = [];
let loop: Promise<void> | null = null;

/** Cargas que el usuario pidió detener: no se toma ninguna factura nueva de ellas. */
const detenciones = new Map<string, "pausar" | "cancelar">();

function counters(items: Array<Pick<BulkItem, "status" | "needs_review">>) {
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
    // Las notas crédito de compra se registran manualmente en Siigo sobre la factura causada.
    const referida = facturaReferidaEnExcel(doc.rawHeader);
    const estado = await estadoFacturaAfectada(supabase, companyId, doc.header.provider_nit, referida);
    throw new BulkInvoiceStageError(
      mensajeNotaCredito({
        numero: [doc.header.prefix, doc.header.number].join("") || null,
        proveedor: doc.header.provider_name,
        nit: doc.header.provider_nit,
        total: doc.header.total,
        estado,
      }),
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
    // Los datos de la descarga viajan con la siguiente actualización (una escritura menos).
    let descarga: Partial<BulkItem> | null = {
      download_status: "OK",
      stored_size_bytes: stored.size,
      mime_type: stored.mimeType,
      content_status: "OK",
    };
    let textoGuardado = false;
    const saveTrace = async (stage: string, trace?: InvoiceReadTrace) => {
      // "Lista para causar" va seguida de inmediato por "Procesada": no se escribe aparte.
      if (stage === "ready_for_accounting") return;
      const patch: Partial<BulkItem> = {
        ...(descarga ?? {}),
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
              read_status: trace.readMode === "texto" ? "Leída (texto)" : "Leída (imagen)",
              // El texto leído (hasta 20.000 caracteres) se guarda una sola vez.
              ...(textoGuardado ? {} : { extracted_text: trace.text }),
            }
          : {}),
      };
      descarga = null;
      if (trace) textoGuardado = true;
      await updateItem(item.id, patch);
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
      ...(descarga ?? {}),
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
  if (detenciones.has(job.uploadId)) return;
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
    if (pendientes.length === 0 || detenciones.has(job.uploadId)) break;

    // Varias facturas en paralelo: la espera de la IA de una no bloquea a las demás.
    let cursor = 0;
    let activos = 0;
    // Contadores de avance con una consulta liviana (solo estados), a lo sumo cada 2 s
    // y sin que la siguiente factura tenga que esperarla.
    let ultimoConteo = 0;
    let conteoEnCurso = false;
    const refrescarConteo = () => {
      if (conteoEnCurso || Date.now() - ultimoConteo < 2000) return;
      conteoEnCurso = true;
      ultimoConteo = Date.now();
      void listItemStatuses(job.uploadId)
        .then((estados) => emit({ ...counters(estados) }))
        .catch(() => undefined)
        .finally(() => {
          conteoEnCurso = false;
        });
    };
    const worker = async () => {
      for (;;) {
        // Pausar/Cancelar: las facturas en curso terminan, no se toma ninguna más.
        if (detenciones.has(job.uploadId)) return;
        const item = pendientes[cursor++];
        if (!item) return;
        activos += 1;
        emit({ active: activos, pending: Math.max(pendientes.length - cursor, 0) });
        try {
          await processItem(item, job.companyId, deps);
        } finally {
          activos -= 1;
          emit({ active: activos });
          refrescarConteo();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, pendientes.length) }, worker));
  }

  const modo = detenciones.get(job.uploadId);
  if (modo === "cancelar") await cancelPendingItems(job.uploadId);
  const items = await listItems(job.uploadId);
  await refreshUploadCounters(
    job.uploadId,
    items,
    modo === "pausar" ? "paused" : modo === "cancelar" ? "cancelled" : undefined,
  );
  emit({ active: 0, ...counters(items) });
}

/**
 * Detiene una carga masiva a pedido del usuario.
 * - "pausar": las facturas que se están leyendo terminan; las demás quedan pendientes
 *   y no se retoman solas al abrir la aplicación, solo con "Reanudar".
 * - "cancelar": igual, pero las pendientes quedan canceladas (se pueden reintentar una a una).
 */
export async function detenerCarga(uploadId: string, modo: "pausar" | "cancelar") {
  detenciones.set(uploadId, modo);
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.uploadId === uploadId) queue.splice(i, 1);
  if (modo === "cancelar") await cancelPendingItems(uploadId);
  const items = await listItems(uploadId);
  await refreshUploadCounters(uploadId, items, modo === "pausar" ? "paused" : "cancelled");
  emit({ queued: queue.length, ...(snapshot.uploadId === uploadId ? counters(items) : {}) });
}

/** true mientras el motor sigue terminando las facturas en curso de una carga detenida. */
export function cargaDeteniendose(uploadId: string | null | undefined) {
  return !!uploadId && detenciones.has(uploadId) && snapshot.running && snapshot.uploadId === uploadId;
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
  // Reanudar (o reintentar) una carga detenida la vuelve a habilitar.
  if (detenciones.has(job.uploadId)) {
    if (snapshot.running && snapshot.uploadId === job.uploadId) return; // aún termina las facturas en curso
    detenciones.delete(job.uploadId);
  }
  if (snapshot.uploadId === job.uploadId && snapshot.running) return;
  if (queue.some((q) => q.uploadId === job.uploadId)) return;
  queue.push(job);
  emit({ running: true, queued: queue.length, fileName: snapshot.fileName ?? job.fileName });
  kick();
}

/** Reintenta tareas puntuales sin reiniciar todo el ZIP. */
export async function retryBulkItems(job: QueuedUpload, itemIds: string[]) {
  await updateItems(itemIds, { status: "pending", stage: null, error_message: null, user_message: null });
  startBackgroundUpload(job);
}

/**
 * Retoma las cargas masivas con facturas pendientes: al abrir la aplicación, después de
 * cada tanda de "Revisar ahora" y cada minuto mientras la aplicación está abierta. Así
 * las cargas que crea la revisión de carpetas (Drive / OneDrive), también la programada,
 * se procesan solas sin entrar a "Ver detalle → Continuar procesamiento".
 * Las cargas pausadas o canceladas por la usuaria no se tocan.
 */
let revisandoPendientes: Promise<void> | null = null;
export function resumeBackgroundUploads(companyId: string): Promise<void> {
  if (!companyId) return Promise.resolve();
  // Una sola revisión a la vez (el aviso periódico y el de "Revisar ahora" pueden coincidir).
  revisandoPendientes ??= (async () => {
    try {
      const uploads: BulkUpload[] = await listActiveUploads(companyId);
      for (const up of uploads) {
        if (queue.some((q) => q.uploadId === up.id) || (snapshot.running && snapshot.uploadId === up.id)) continue;
        const estados = await listItemStatuses(up.id);
        if (estados.some((i) => PENDING_STATUSES.includes(i.status))) {
          startBackgroundUpload({ uploadId: up.id, companyId, fileName: up.file_name });
        }
      }
    } finally {
      revisandoPendientes = null;
    }
  })();
  return revisandoPendientes;
}
