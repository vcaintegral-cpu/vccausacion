// Carga masiva de facturas desde un comprimido .zip, con persistencia total:
// el ZIP y cada PDF quedan en Storage, cada PDF es una tarea en base de datos
// y el proceso puede reanudarse aunque se cierre el navegador.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Download, Layers, Loader2, RefreshCw, Sparkles, Trash2, XCircle } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cop, fechaHora } from "@/lib/format";
import { diagnoseItem, errorCode, type BulkDiagnosis } from "@/lib/bulk-diagnostics";
import {
  BulkInvoiceStageError,
  processInvoiceFile,
  readZipContents,
  resetBulkBatch,
  type BulkConfig,
  type InvoiceReadTrace,
} from "@/lib/bulk-invoices";
import type { CompanyKnowledge } from "@/lib/causacion-engine";
import { createJobs, ensureUploadJobs, kickWorker } from "@/lib/jobs-store";
import {
  ACTIVE_STATUSES,
  createUpload,
  deleteUpload,
  existingFingerprints,
  fileFromStorage,
  insertItems,
  ITEM_LABEL,
  listItems,
  listUploads,
  mensajeUsuario,
  refreshUploadCounters,
  RESUMABLE_STATUSES,
  sha256,
  updateItem,
  updateUpload,
  UPLOAD_LABEL,
  type BulkItem,
  type BulkUpload,
} from "@/lib/bulk-upload-store";

// Secuencial y sin reintentos automáticos: un error detiene la tarea y el usuario
// decide si reintenta manualmente (no se gastan créditos de IA en bucles).
const CONCURRENCY = 1;
const MAX_ATTEMPTS = 1;

type Props = {
  companyId: string;
  config: BulkConfig | undefined;
  knowledge?: CompanyKnowledge | undefined;
  extract: (args: { data: { fileName: string; mimeType: string } & Record<string, unknown> }) => Promise<unknown>;
  loadingConfig: boolean;
  onFinished?: () => void;
};

export function BulkZipProcessor({ companyId, config, knowledge, extract, loadingConfig, onFinished }: Props) {
  const [selected, setSelected] = useState<File[]>([]);
  const [busy, setBusy] = useState<string>("");
  const [upload, setUpload] = useState<BulkUpload | null>(null);
  const [items, setItems] = useState<BulkItem[]>([]);
  const [running, setRunning] = useState(false);
  const [forzar, setForzar] = useState(false);
  const [diag, setDiag] = useState<BulkDiagnosis | null>(null);
  const started = useRef<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const historial = useQuery({
    queryKey: ["bulk-uploads", companyId],
    enabled: !!companyId,
    queryFn: () => listUploads(companyId),
  });

  /** Al abrir el módulo se recuperan los procesos que quedaron sin terminar. */
  useEffect(() => {
    if (!companyId) return;
    let cancel = false;
    void (async () => {
      const uploads = await listUploads(companyId, 10);
      const pendiente = uploads.find((u) => ACTIVE_STATUSES.includes(u.status));
      if (!pendiente || cancel) return;
      const rows = await listItems(pendiente.id);
      if (cancel) return;
      setUpload(pendiente);
      setItems(rows);
    })();
    return () => {
      cancel = true;
    };
  }, [companyId]);

  /** El progreso real se lee de la base de datos: el trabajo ocurre en el backend. */
  useEffect(() => {
    if (!upload || running) return;
    const activo = ["pending", "extracting", "processing"].includes(upload.status);
    if (!activo) return;
    const timer = setInterval(() => {
      void (async () => {
        const rows = await listItems(upload.id);
        setItems(rows);
        const [fresco] = await listUploads(companyId, 20).then((us) => us.filter((u) => u.id === upload.id));
        if (fresco) setUpload(fresco);
      })();
    }, 5000);
    return () => clearInterval(timer);
  }, [companyId, running, upload]);

  const stats = useMemo(() => {
    const total = items.length;
    const done = items.filter((i) => i.status === "completed").length;
    const failed = items.filter((i) => i.status === "error").length;
    const dup = items.filter((i) => i.status === "duplicate").length;
    const active = items.filter((i) =>
      ["downloading", "reading", "ocr", "extracting_data", "validating_company", "ready_for_accounting", "processing"].includes(i.status),
    ).length;
    const review = items.filter((i) => i.status === "requires_review").length;
    const pending = total - done - failed - dup - review - active;
    const terminados = done + failed + dup + review;
    const elapsed = started.current ? Date.now() - started.current : 0;
    const eta = running && terminados > 0 ? Math.round((elapsed / terminados) * (total - terminados)) : null;
    return {
      total,
      done,
      failed,
      dup,
      active,
      pending,
      percent: total ? Math.round(((done + failed + dup + review) / total) * 100) : 0,
      eta,
      review: review + items.filter((i) => i.status === "completed" && i.needs_review).length,
    };
  }, [items, running]);

  const patchItem = useCallback((id: string, patch: Partial<BulkItem>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }, []);

  /** Procesa una lista de tareas, una por una y guardando el resultado inmediatamente. */
  const runItems = useCallback(
    async (uploadRow: BulkUpload, targets: BulkItem[]) => {
      if (targets.length === 0) return;
      if (!config) {
        toast.error("Los parámetros contables aún se están cargando.");
        return;
      }
      setRunning(true);
      started.current = Date.now();
      resetBulkBatch();
      await updateUpload(uploadRow.id, { status: "processing", finished_at: null });

      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const index = cursor++;
          if (index >= targets.length) return;
          const item = targets[index]!;
          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            patchItem(item.id, { status: "downloading", attempts: attempt, stage: "recuperando_pdf" });
            await updateItem(item.id, { status: "downloading", attempts: attempt, stage: "recuperando_pdf" });
            try {
              if (!item.storage_path) throw new Error("ERROR_ARCHIVO_NO_ENCONTRADO: la tarea no tiene storage_path.");
              const stored = await fileFromStorage(item.storage_path, item.file_name, item.storage_bucket ?? "facturas");
              const storagePatch: Partial<BulkItem> = {
                download_status: "OK",
                stored_size_bytes: stored.size,
                mime_type: stored.mimeType,
                content_status: "OK",
              };
              patchItem(item.id, storagePatch);
              await updateItem(item.id, storagePatch);
              const saveTrace = async (stage: string, trace?: InvoiceReadTrace) => {
                const status = stage as BulkItem["status"];
                const tracePatch: Partial<BulkItem> = {
                  status,
                  stage,
                  ...(trace ? {
                    provider_name: trace.providerName,
                    provider_nit: trace.providerNit,
                    buyer_name: trace.buyerName,
                    buyer_nit: trace.buyerNit,
                    invoice_number: trace.invoiceNumber,
                    issue_date: trace.issueDate,
                    extracted_text: trace.text,
                    read_status: trace.readMode === "texto" ? "Leída (texto)" : "Leída (imagen)",
                  } : {}),
                };
                patchItem(item.id, tracePatch);
                await updateItem(item.id, tracePatch);
              };
              const result = await processInvoiceFile({
                file: stored.file,
                companyId,
                config,
                extract: extract as never,
                storagePath: item.storage_path,
                onStage: saveTrace,
                ...(knowledge ? { knowledge } : {}),
              });
              const patch: Partial<BulkItem> = {
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
              };
              patchItem(item.id, patch);
              await updateItem(item.id, patch);
              break;
            } catch (error) {
              const message = error instanceof Error ? error.message : "Error al procesar";
              const duplicado = /duplicad|ya fue causada|ya existe|repetido/i.test(message);
              const staged = error instanceof BulkInvoiceStageError ? error : null;
              const trace = staged?.trace;
              const storageError = /ERROR_STORAGE|ERROR_ARCHIVO|ERROR_PDF_INVALIDO/.test(message);
              const stage = staged?.stage ?? (storageError ? "download_pdf" : "process_invoice");
              const code = errorCode(stage, message);
              const patch: Partial<BulkItem> = {
                status: staged?.requiresReview ? "requires_review" : duplicado ? "duplicate" : "error",
                stage,
                error_message: message,
                user_message: `Etapa: ${stage} · Código: ${code} · ${mensajeUsuario(item.file_name, message)} · ${message}`,
                ...(storageError ? { download_status: "ERROR", content_status: "ERROR" } : {}),
                ...(trace ? {
                  provider_name: trace.providerName,
                  provider_nit: trace.providerNit,
                  buyer_name: trace.buyerName,
                  buyer_nit: trace.buyerNit,
                  invoice_number: trace.invoiceNumber,
                  issue_date: trace.issueDate,
                  extracted_text: trace.text,
                  read_status: trace.readMode === "texto" ? "Leída (texto)" : "Leída (imagen)",
                  company_validation: staged?.requiresReview ? "REQUIERE_REVISION" : "ERROR",
                } : {}),
              };
              patchItem(item.id, patch);
              await updateItem(item.id, patch);
              break;
            }
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

      const rows = await listItems(uploadRow.id);
      setItems(rows);
      const status = await refreshUploadCounters(uploadRow.id, rows);
      setUpload({
        ...uploadRow,
        status,
        files_found: Math.max(uploadRow.files_found, rows.length),
        pdf_found: Math.max(uploadRow.pdf_found, rows.length),
        processed_count: rows.filter((r) => r.status === "completed").length,
        error_count: rows.filter((r) => r.status === "error").length,
      });
      setRunning(false);
      void historial.refetch();
      onFinished?.();
      const ok = rows.filter((r) => r.status === "completed").length;
      toast.success(`${ok} de ${rows.length} facturas causadas como borrador.`);
    },
    [companyId, config, extract, historial, knowledge, onFinished, patchItem],
  );

  /** Sube el ZIP, lo descomprime, guarda cada PDF y crea las tareas. */
  async function iniciar() {
    if (!companyId || selected.length === 0) return;
    setBusy("Guardando el archivo…");
    // Cada carga tiene su propio identificador y su propio estado: nunca se toca
    // el registro de otra carga que esté en curso.
    let actual: BulkUpload | null = null;
    let etapa = "crear_carga";
    let conTareas = false;
    try {
      const zip = selected[0]!;
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth.user?.id;
      if (!userId) throw new Error("Sesión no válida.");

      const row = await createUpload({ companyId, fileName: zip.name, size: zip.size });
      actual = row;
      setUpload(row);
      setItems([]);

      // 1) El comprimido original se guarda antes de procesar y nunca se borra solo.
      etapa = "guardar_zip";
      const zipPath = `${userId}/${companyId}/zips/${row.id}-${zip.name.replace(/[^\w.-]/g, "_")}`;
      const up = await supabase.storage.from("facturas").upload(zipPath, zip, { upsert: true });
      if (up.error) throw new Error(up.error.message);
      await updateUpload(row.id, { storage_path: zipPath, status: "extracting" });

      // 2) Descompresión controlada: PDFs por un lado, archivos no compatibles por otro.
      setBusy("Descomprimiendo…");
      etapa = "descomprimir";
      const { pdfs, skipped, filesFound } = await readZipContents(selected);
      if (pdfs.length === 0) {
        await updateUpload(row.id, {
          status: "failed",
          files_found: filesFound,
          skipped_files: skipped.length,
          error_code: "ZIP_SIN_PDF",
          error_stage: "descomprimir",
          error_message: "El comprimido no contiene facturas PDF.",
          finished_at: new Date().toISOString(),
        });
        toast.error("El comprimido no contiene facturas PDF.");
        setBusy("");
        return;
      }

      // 3) Control de duplicados por huella del archivo (dentro del ZIP y contra la empresa).
      setBusy(`Guardando ${pdfs.length} documentos…`);
      etapa = "guardar_pdf";
      const prepared: Array<{ file: File; hash: string }> = [];
      for (const file of pdfs) {
        prepared.push({ file, hash: await sha256(new Uint8Array(await file.arrayBuffer())) });
      }
      const previos = forzar
        ? new Set<string>()
        : await existingFingerprints(companyId, prepared.map((p) => p.hash));
      const vistos = new Set<string>();

      const rows: Array<Partial<BulkItem>> = [];
      const files: File[] = [];
      let position = 0;
      for (const { file, hash } of prepared) {
        const repetido = previos.has(hash) || vistos.has(hash);
        vistos.add(hash);
        let path: string | null = null;
        let uploadError: string | null = null;
        if (!repetido) {
          const safe = file.name.replace(/[^\w.-]/g, "_");
          const target = `${userId}/${companyId}/bulk/${row.id}/${position}-${safe}`;
          // El PDF extraído se guarda siempre como application/pdf: el worker lo
          // recupera después desde bucket + storage_path (nunca desde el File del navegador).
          const res = await supabase.storage
            .from("facturas")
            .upload(target, file, { upsert: true, contentType: "application/pdf" });
          if (res.error) uploadError = `ERROR_SUBIDA_PDF: ${res.error.message}`;
          else path = target;
        }
        rows.push({
          upload_id: row.id,
          company_id: companyId,
          file_name: file.name,
          storage_path: path,
          size_bytes: file.size,
          fingerprint: repetido ? null : hash,
          status: repetido ? "duplicate" : uploadError ? "error" : "pending",
          ...(uploadError
            ? {
                stage: "upload_pdf",
                error_message: uploadError,
                user_message: `Etapa: upload_pdf · Código: STORAGE_UPLOAD_ERROR · ${uploadError}`,
                download_status: "ERROR",
              }
            : {}),
          ...(repetido ? { user_message: `${file.name}: este documento ya fue procesado.` } : {}),
          position,
        });
        files.push(file);
        position += 1;
      }

      etapa = "crear_documentos";
      const created = await insertItems(rows);
      conTareas = created.length > 0;
      setItems(created);
      await updateUpload(row.id, {
        status: "processing",
        files_found: filesFound,
        pdf_found: pdfs.length,
        skipped_files: skipped.length,
        error_code: null,
        error_message: null,
        error_stage: null,
      });
      setBusy("");
      setSelected([]);
      if (inputRef.current) inputRef.current.value = "";
      const pending = created.filter((i) => i.status === "pending");
      // 4) Cada PDF queda como un trabajo independiente en la cola persistente:
      // a partir de aquí el procesamiento vive en el backend, no en esta pestaña.
      etapa = "crear_tareas";
      await createJobs(
        pending.map((i) => ({
          company_id: companyId,
          upload_id: row.id,
          item_id: i.id,
          file_name: i.file_name,
          storage_bucket: i.storage_bucket ?? "facturas",
          storage_path: i.storage_path,
        })),
      );
      setUpload({ ...row, files_found: filesFound, pdf_found: pdfs.length, skipped_files: skipped.length, status: "processing" });
      await kickWorker();
      void historial.refetch();
      toast.success(
        `${pending.length} facturas enviadas a procesamiento en segundo plano. Puedes salir de esta pantalla.`,
      );
    } catch (error) {
      setBusy("");
      const message = error instanceof Error ? error.message : "No fue posible iniciar el procesamiento.";
      if (actual) {
        // Si los documentos ya existen, la carga NO se pierde: queda pausada y
        // puede reanudarse sin volver a subir el ZIP.
        await updateUpload(actual.id, {
          status: conTareas ? "processing_paused" : "failed",
          error_code: conTareas ? "WORKER_INTERRUMPIDO" : "UPLOAD_ERROR",
          error_stage: etapa,
          error_message: message,
          ...(conTareas ? { finished_at: null } : { finished_at: new Date().toISOString() }),
        });
        const [fresco] = (await listUploads(companyId, 20)).filter((u) => u.id === actual!.id);
        if (fresco) setUpload(fresco);
      }
      void historial.refetch();
      toast.error(
        conTareas
          ? `La carga quedó pausada en la etapa "${etapa}". Pulsa "Reanudar" para continuar sin volver a subir el ZIP. Detalle: ${message}`
          : message,
      );
    }
  }

  /** Reanuda una carga concreta: recrea las tareas que falten y despierta al worker. */
  async function reanudar(u: BulkUpload) {
    setBusy("Reanudando carga…");
    try {
      const { recuperables } = await ensureUploadJobs(u.id, true);
      await updateUpload(u.id, { status: "processing", finished_at: null, error_code: null, error_message: null, error_stage: null });
      await kickWorker();
      const rows = await listItems(u.id);
      setItems(rows);
      const [fresco] = (await listUploads(companyId, 20)).filter((x) => x.id === u.id);
      setUpload(fresco ?? { ...u, status: "processing" });
      void historial.refetch();
      toast.success(`${recuperables} documentos pendientes reenviados a la cola en segundo plano.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible reanudar la carga.");
    } finally {
      setBusy("");
    }
  }

  async function continuar() {
    if (!upload) return;
    const rows = await listItems(upload.id);
    setItems(rows);
    await runItems(upload, rows.filter((i) => i.status !== "completed" && i.status !== "duplicate" && i.status !== "error"));
  }

  async function reintentarErrores() {
    if (!upload) return;
    const rows = await listItems(upload.id);
    setItems(rows);
    const failed = rows.filter((i) => i.status !== "completed" && i.status !== "duplicate");
    const first = failed[0];
    if (!first) return;
    await runItems(upload, [first]);
    const tested = (await listItems(upload.id)).find((i) => i.id === first.id);
    if (!tested || tested.status !== "completed") {
      toast.error(`La prueba del primer PDF falló en: ${tested?.stage ?? "lectura"}. No se procesaron los demás documentos.`);
      return;
    }
    await runItems(upload, failed.slice(1));
  }

  async function abrirProceso(u: BulkUpload) {
    setUpload(u);
    setItems(await listItems(u.id));
  }

  /** Prueba SIN IA: recupera el primer PDF desde Storage y lo lee con el mismo lector individual. */
  async function diagnosticar() {
    if (!upload) return;
    const rows = await listItems(upload.id);
    setItems(rows);
    const target = rows.find((i) => i.status !== "completed") ?? rows[0];
    if (!target) return;
    setBusy("Diagnóstico sin IA…");
    try {
      const resultado = await diagnoseItem(target);
      setDiag(resultado);
      if (resultado.code === "OK") toast.success("PDF recuperado y leído correctamente (sin IA).");
      else toast.error(`Etapa: ${resultado.stage} · Código: ${resultado.code}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible ejecutar el diagnóstico.");
    } finally {
      setBusy("");
    }
  }

  /** Elimina una carga masiva completa: tareas, archivos guardados y el registro. */
  async function eliminarProceso(u: BulkUpload) {
    if (running) return;
    if (!window.confirm(`¿Eliminar la carga "${u.file_name}"? Se borran sus tareas y archivos guardados.`)) return;
    setBusy("Eliminando carga…");
    try {
      await deleteUpload(u.id);
      if (upload?.id === u.id) {
        setUpload(null);
        setItems([]);
      }
      await historial.refetch();
      toast.success("Carga masiva eliminada.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible eliminar la carga.");
    } finally {
      setBusy("");
    }
  }

  function descargarReporte() {
    if (!upload) return;
    const head = "Archivo;Proveedor;NIT proveedor;Comprador;NIT comprador;Factura;Fecha;Estado;Intentos;Total;Confianza;Detalle";
    const body = items
      .map((i) =>
        [
          i.file_name,
          i.provider_name ?? "",
          i.provider_nit ?? "",
          i.buyer_name ?? "",
          i.buyer_nit ?? "",
          i.invoice_number ?? "",
          i.issue_date ?? "",
          ITEM_LABEL[i.status],
          i.attempts,
          i.invoice_total ?? "",
          i.score !== null ? `${Math.round(Number(i.score) * 100)}%` : "",
          (i.user_message ?? i.error_message ?? "").replace(/[\r\n;]+/g, " "),
        ].join(";"),
      )
      .join("\n");
    const blob = new Blob([`\uFEFF${head}\n${body}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reporte-${upload.file_name.replace(/\.zip$/i, "")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const terminado = upload && !running && stats.total > 0 && stats.pending === 0 && stats.active === 0;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
          <Layers className="size-4" />
        </div>
        <div>
          <h2 className="text-sm font-semibold">Carga masiva</h2>
          <p className="text-xs text-muted-foreground">
            Sube un .zip con las facturas PDF. El comprimido se guarda primero, cada factura se convierte en una tarea
            independiente y el avance queda registrado: puedes salir del módulo y retomar el proceso.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1 space-y-1.5">
          <Label htmlFor="masivo">Archivos o comprimido (.zip)</Label>
          <Input
            id="masivo"
            ref={inputRef}
            type="file"
            multiple
            onChange={(e) => setSelected(Array.from(e.target.files ?? []))}
          />
          <label className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={forzar} onChange={(e) => setForzar(e.target.checked)} />
            Reprocesar aunque el documento ya se haya cargado antes
          </label>
        </div>
        <Button
          onClick={() => void iniciar()}
          disabled={running || !!busy || selected.length === 0 || !companyId || loadingConfig || !config}
        >
          {running || busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          {busy || (running ? "Procesando…" : loadingConfig ? "Cargando parámetros contables…" : "Procesar comprimido")}
        </Button>
      </div>

      {upload ? (
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">{upload.file_name}</p>
              <p className="text-xs text-muted-foreground">
                {UPLOAD_LABEL[upload.status]} · {fechaHora(upload.created_at)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {!running && stats.pending > 0 ? (
                <Button size="sm" variant="outline" onClick={() => void continuar()}>
                  <RefreshCw className="size-4" /> Continuar procesamiento
                </Button>
              ) : null}
              {!running && stats.failed + stats.review + stats.active > 0 ? (
                <Button size="sm" variant="outline" onClick={() => void reintentarErrores()}>
                  <RefreshCw className="size-4" /> Reintentar pendientes ({stats.failed + stats.review + stats.active})
                </Button>
              ) : null}
              {stats.total > 0 ? (
                <Button size="sm" variant="outline" onClick={descargarReporte}>
                  <Download className="size-4" /> Descargar reporte
                </Button>
              ) : null}
              <Button size="sm" variant="outline" disabled={running || !!busy} onClick={() => void eliminarProceso(upload)}>
                <Trash2 className="size-4" /> Eliminar carga
              </Button>
              <Button size="sm" variant="outline" disabled={running || !!busy} onClick={() => void diagnosticar()}>
                <RefreshCw className="size-4" /> Diagnóstico sin IA
              </Button>
            </div>
          </div>

          {diag ? (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-[11px] leading-5">
              <p className="mb-1 text-xs font-semibold">Diagnóstico del PDF (sin IA) · {diag.fileName}</p>
              <p>Bucket: {diag.bucket}</p>
              <p>Storage path: {diag.storagePath ?? "—"}</p>
              <p>Existe: {diag.exists ? "SI" : "NO"}</p>
              <p>Descarga: {diag.downloadOk ? "OK" : "ERROR"}</p>
              <p>Tamaño: {diag.sizeBytes ?? 0} bytes</p>
              <p>MIME: {diag.mimeType ?? "—"}</p>
              <p>PDF válido: {diag.pdfValid ? "OK" : "NO"}</p>
              <p>Texto extraído: {diag.textChars} caracteres ({diag.readMode})</p>
              <p>Etapa: {diag.stage} · Código: {diag.code}</p>
              <p>Mensaje: {diag.message}</p>
            </div>
          ) : null}

          <div>
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>
                {stats.done + stats.failed + stats.dup + stats.review} de {stats.total}
              </span>
              <span>
                {stats.percent}%
                {stats.eta !== null ? ` · faltan ~${Math.round(stats.eta / 1000)}s` : ""}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${stats.percent}%` }} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Total PDF", String(stats.total)],
              ["Procesadas", String(stats.done)],
              ["En proceso", String(stats.active)],
              ["Pendientes", String(stats.pending)],
              ["Con error", String(stats.failed)],
              ["Duplicadas", String(stats.dup)],
              ["No compatibles", String(upload.skipped_files)],
              ["Requieren revisión", String(stats.review)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border border-border p-2">
                <p className="text-[11px] text-muted-foreground">{label}</p>
                <p className="text-sm font-semibold">{value}</p>
              </div>
            ))}
          </div>

          <ul className="max-h-64 space-y-1 overflow-auto rounded-md border border-border p-2">
            {items.map((i) => (
              <li key={i.id} className="flex items-start gap-2 text-xs">
                {i.status === "completed" ? (
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                ) : i.status === "error" ? (
                  <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                ) : i.status === "reading" || i.status === "processing" ? (
                  <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Layers className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="w-52 truncate font-medium">{i.file_name}</span>
                <span className="text-muted-foreground">{ITEM_LABEL[i.status]}</span>
                <span className="flex-1 truncate text-muted-foreground">
                  {i.status === "completed"
                    ? `${i.invoice_number ?? ""} · ${cop(Number(i.invoice_total ?? 0))}`
                    : `${ITEM_LABEL[i.status]}${i.stage ? ` · ${i.stage.replaceAll("_", " ")}` : ""}${i.user_message ? ` · ${i.user_message}` : ""}`}
                </span>
                {i.status === "completed" ? (
                  <span className={i.needs_review ? "text-warning" : "text-success"}>
                    {i.needs_review ? "Revisar" : "Automática"} · {Math.round(Number(i.score ?? 0) * 100)}%
                  </span>
                ) : null}
              </li>
            ))}
          </ul>

          {terminado ? (
            <div className="space-y-1">
              <p className="text-xs font-semibold">Verificación de lectura por documento</p>
              <div className="max-h-72 overflow-auto rounded-md border border-border">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      {["Archivo", "Proveedor", "Comprador", "NIT comprador", "Factura", "Estado"].map((h) => (
                        <th key={h} className="px-2 py-1 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.id} className="border-t border-border">
                        <td className="max-w-44 truncate px-2 py-1">{i.file_name}</td>
                        <td className="max-w-32 truncate px-2 py-1">{i.provider_name ?? "—"}</td>
                        <td className="max-w-32 truncate px-2 py-1">{i.buyer_name ?? "—"}</td>
                        <td className="px-2 py-1">{i.buyer_nit ?? "—"}</td>
                        <td className="px-2 py-1">{i.invoice_number ?? "—"}</td>
                        <td className="px-2 py-1">
                           {i.status === "completed" ? (i.read_status ?? "Leída") : `${ITEM_LABEL[i.status]} · ${(i.stage ?? "sin etapa").replaceAll("_", " ")}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {terminado ? (
            <p className="text-xs text-muted-foreground">
              Procesamiento terminado · Archivos en el comprimido: {upload.files_found} · PDF encontrados:{" "}
              {upload.pdf_found} · Procesados: {stats.done} · Con error: {stats.failed} · No compatibles:{" "}
              {upload.skipped_files}
            </p>
          ) : null}
        </div>
      ) : null}

      {(historial.data ?? []).length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-semibold">Historial de cargas</p>
          <div className="overflow-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-left">
                <tr>
                  {["Fecha", "Archivo", "Total", "Procesados", "Errores", "Estado", ""].map((h) => (
                    <th key={h} className="px-2 py-1 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(historial.data ?? []).map((u) => (
                  <tr key={u.id} className="border-t border-border">
                    <td className="px-2 py-1">{fechaHora(u.created_at)}</td>
                    <td className="max-w-40 truncate px-2 py-1">{u.file_name}</td>
                    <td className="px-2 py-1">{u.pdf_found}</td>
                    <td className="px-2 py-1">{u.processed_count}</td>
                    <td className="px-2 py-1">{u.error_count}</td>
                    <td className="px-2 py-1">{UPLOAD_LABEL[u.status]}</td>
                    <td className="px-2 py-1">
                      <Button size="sm" variant="ghost" onClick={() => void abrirProceso(u)}>
                        Ver detalle
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={running || !!busy}
                        onClick={() => void eliminarProceso(u)}
                      >
                        <Trash2 className="size-4" /> Eliminar
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
