// Carga masiva de facturas desde un comprimido .zip, con persistencia total:
// el ZIP y cada PDF quedan en Storage, cada PDF es una tarea en base de datos
// y el proceso puede reanudarse aunque se cierre el navegador.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  Layers,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { cop, fechaHora } from "@/lib/format";
import { codigoTecnico, mensajeAmigable } from "@/lib/bulk-messages";
import { diagnoseItem, type BulkDiagnosis } from "@/lib/bulk-diagnostics";
import { readZipContents, type BulkConfig } from "@/lib/bulk-invoices";
import {
  retryBulkItems,
  startBackgroundUpload,
  useBulkProgress,
} from "@/lib/bulk-runner";
import type { CompanyKnowledge } from "@/lib/causacion-engine";
import {
  ACTIVE_STATUSES,
  createUpload,
  deleteUpload,
  existingFingerprints,
  insertItems,
  ITEM_LABEL,
  listItems,
  listUploads,
  sha256,
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
  const progress = useBulkProgress();
  const [forzar, setForzar] = useState(false);
  const [diag, setDiag] = useState<BulkDiagnosis | null>(null);
  const [detalle, setDetalle] = useState<null | "errores" | "duplicados" | "procesadas" | "revision">(null);
  const [tecnicos, setTecnicos] = useState<Record<string, boolean>>({});
  const [abierto, setAbierto] = useState(false);
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

  // El proceso corre en segundo plano; "running" refleja el motor global, no la pantalla.
  const running = progress.running && (!upload || progress.uploadId === upload.id || progress.queued > 0);

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
    const eta = null;
    return {
      total,
      done,
      failed,
      dup,
      active,
      pending,
      percent: total ? Math.round(((done + failed + dup + review) / total) * 100) : 0,
      eta: eta as number | null,
      review: review + items.filter((i) => i.status === "completed" && i.needs_review).length,
    };
  }, [items]);

  /** Estado en vivo desde base de datos: la pantalla solo muestra el avance. */
  useEffect(() => {
    if (!upload) return;
    let cancel = false;
    const tick = async () => {
      const rows = await listItems(upload.id);
      if (!cancel) setItems(rows);
    };
    void tick();
    if (!running) return;
    const timer = window.setInterval(() => void tick(), 2500);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, [upload, running, progress.done, progress.errors]);

  useEffect(() => {
    if (!running && upload) {
      void historial.refetch();
      onFinished?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  /** Sube el ZIP, lo descomprime, guarda cada PDF y crea las tareas. */
  async function iniciar() {
    if (!companyId || selected.length === 0) return;
    setBusy("Guardando el archivo…");
    try {
      const zip = selected[0]!;
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth.user?.id;
      if (!userId) throw new Error("Sesión no válida.");

      const row = await createUpload({ companyId, fileName: zip.name, size: zip.size });
      setUpload(row);
      setItems([]);

      // 1) El comprimido original se guarda antes de procesar y nunca se borra solo.
      const zipPath = `${userId}/${companyId}/zips/${row.id}-${zip.name.replace(/[^\w.-]/g, "_")}`;
      const up = await supabase.storage.from("facturas").upload(zipPath, zip, { upsert: true });
      if (up.error) throw new Error(up.error.message);
      await updateUpload(row.id, { storage_path: zipPath, status: "extracting" });

      // 2) Descompresión controlada: PDFs por un lado, archivos no compatibles por otro.
      setBusy("Descomprimiendo…");
      const { pdfs, skipped, filesFound } = await readZipContents(selected);
      if (pdfs.length === 0) {
        await updateUpload(row.id, {
          status: "failed",
          files_found: filesFound,
          skipped_files: skipped.length,
          error_message: "El comprimido no contiene facturas PDF.",
          finished_at: new Date().toISOString(),
        });
        toast.error("El comprimido no contiene facturas PDF.");
        setBusy("");
        return;
      }

      // 3) Control de duplicados por huella del archivo (dentro del ZIP y contra la empresa).
      setBusy(`Guardando ${pdfs.length} documentos…`);
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

      const created = await insertItems(rows);
      setItems(created);
      await updateUpload(row.id, {
        status: "processing",
        files_found: filesFound,
        pdf_found: pdfs.length,
        skipped_files: skipped.length,
      });
      setBusy("");
      setSelected([]);
      if (inputRef.current) inputRef.current.value = "";
      // 4) El procesamiento arranca en segundo plano: la pantalla ya no es necesaria.
      startBackgroundUpload({ uploadId: row.id, companyId, fileName: zip.name });
      toast.success("Procesamiento iniciado en segundo plano. Puedes salir de este módulo.");
      void historial.refetch();
    } catch (error) {
      setBusy("");
      const message = error instanceof Error ? error.message : "No fue posible iniciar el procesamiento.";
      if (upload) await updateUpload(upload.id, { status: "failed", error_message: message });
      toast.error(message);
    }
  }

  function continuar() {
    if (!upload) return;
    startBackgroundUpload({ uploadId: upload.id, companyId, fileName: upload.file_name });
  }

  /** Reintenta solo las tareas indicadas, sin reiniciar el ZIP completo. */
  async function reintentar(ids: string[]) {
    if (!upload || ids.length === 0) return;
    await retryBulkItems({ uploadId: upload.id, companyId, fileName: upload.file_name }, ids);
  }

  async function reintentarErrores() {
    if (!upload) return;
    const rows = await listItems(upload.id);
    setItems(rows);
    await reintentar(rows.filter((i) => i.status === "error" || i.status === "requires_review").map((i) => i.id));
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

  const errores = items.filter((i) => i.status === "error");
  const duplicados = items.filter((i) => i.status === "duplicate");
  const procesadas = items.filter((i) => i.status === "completed");
  const revision = items.filter((i) => i.status === "requires_review" || (i.status === "completed" && i.needs_review));
  const pendientes = items.filter((i) =>
    ["pending", "downloading", "reading", "ocr", "extracting_data", "validating_company", "ready_for_accounting", "processing"].includes(
      i.status,
    ),
  );

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
          {/* RESUMEN COMPACTO — el detalle no se despliega automáticamente. */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {running ? "Carga masiva en proceso" : "Carga finalizada"} · {upload.file_name}
              </p>
              <p className="text-xs text-muted-foreground">
                {UPLOAD_LABEL[upload.status]} · {fechaHora(upload.created_at)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => { setDetalle("procesadas"); setAbierto(true); }}>
                Ver detalles
              </Button>
              {stats.failed > 0 ? (
                <Button size="sm" variant="outline" onClick={() => { setDetalle("errores"); setAbierto(true); }}>
                  Ver errores
                </Button>
              ) : null}
              {stats.dup > 0 ? (
                <Button size="sm" variant="outline" onClick={() => { setDetalle("duplicados"); setAbierto(true); }}>
                  Ver duplicados
                </Button>
              ) : null}
              {!running && stats.pending > 0 ? (
                <Button size="sm" variant="outline" onClick={() => continuar()}>
                  <RefreshCw className="size-4" /> Continuar procesamiento
                </Button>
              ) : null}
              {!running && stats.failed + stats.review > 0 ? (
                <Button size="sm" variant="outline" onClick={() => void reintentarErrores()}>
                  <RefreshCw className="size-4" /> Reintentar pendientes ({stats.failed + stats.review})
                </Button>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary">{stats.total} archivos</Badge>
            <span className="inline-flex items-center gap-1 text-success">
              <CheckCircle2 className="size-3.5" /> {stats.done} procesadas
            </span>
            {stats.active > 0 ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> {stats.active} en proceso
              </span>
            ) : null}
            {stats.failed > 0 ? (
              <span className="inline-flex items-center gap-1 text-destructive">
                <XCircle className="size-3.5" /> {stats.failed} con error
              </span>
            ) : null}
            {stats.dup > 0 ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Copy className="size-3.5" /> {stats.dup} duplicadas
              </span>
            ) : null}
            {stats.review > 0 ? (
              <span className="inline-flex items-center gap-1 text-warning">
                <AlertTriangle className="size-3.5" /> {stats.review} requieren revisión
              </span>
            ) : null}
          </div>

          {running || stats.pending > 0 ? (
            <div>
              <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                <span>
                  Procesando facturas… {stats.done + stats.failed + stats.dup + stats.review} de {stats.total}
                </span>
                <span>{stats.percent}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${stats.percent}%` }} />
              </div>
            </div>
          ) : null}

          {stats.failed + stats.review > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
              <AlertTriangle className="size-3.5 text-warning" />
              <span>{stats.failed + stats.review} facturas requieren revisión</span>
              <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => { setDetalle("errores"); setAbierto(true); }}>
                Ver errores
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* DETALLE COMPLETO — modal amplio con secciones plegables. */}
      <Dialog open={!!upload && abierto} onOpenChange={setAbierto}>
        <DialogContent className="max-h-[85vh] max-w-5xl overflow-auto">
          <DialogHeader>
            <DialogTitle className="text-sm">Detalle de carga · {upload?.file_name}</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Total PDF", String(stats.total)],
              ["Procesadas", String(stats.done)],
              ["En proceso", String(stats.active)],
              ["Pendientes", String(stats.pending)],
              ["Con error", String(stats.failed)],
              ["Duplicadas", String(stats.dup)],
              ["No compatibles", String(upload?.skipped_files ?? 0)],
              ["Requieren revisión", String(stats.review)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border border-border p-2">
                <p className="text-[11px] text-muted-foreground">{label}</p>
                <p className="text-sm font-semibold">{value}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {stats.total > 0 ? (
              <Button size="sm" variant="outline" onClick={descargarReporte}>
                <Download className="size-4" /> Descargar reporte
              </Button>
            ) : null}
            {!running && stats.failed + stats.review > 0 ? (
              <Button size="sm" variant="outline" onClick={() => void reintentarErrores()}>
                <RefreshCw className="size-4" /> Reintentar pendientes
              </Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={running || !!busy} onClick={() => void diagnosticar()}>
              <RefreshCw className="size-4" /> Diagnóstico sin IA
            </Button>
            {upload ? (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                disabled={running || !!busy}
                onClick={() => void eliminarProceso(upload)}
              >
                <Trash2 className="size-4" /> Eliminar carga
              </Button>
            ) : null}
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

          <Accordion
            type="single"
            collapsible
            value={detalle ?? ""}
            onValueChange={(v) => setDetalle((v || null) as typeof detalle)}
          >
            <AccordionItem value="errores">
              <AccordionTrigger className="text-xs font-semibold">
                Archivos con error ({errores.length})
              </AccordionTrigger>
              <AccordionContent>
                <div className="max-h-72 space-y-2 overflow-auto pr-1">
                  {errores.length === 0 ? <p className="text-xs text-muted-foreground">Sin errores.</p> : null}
                  {errores.map((i) => (
                    <div key={i.id} className="rounded-md border border-border p-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{i.file_name}</p>
                          <p className="truncate text-muted-foreground">
                            {i.invoice_number ?? "Sin número"} · {i.provider_name ?? "Proveedor no identificado"}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="outline" onClick={() => void reintentar([i.id])} disabled={running}>
                            <RefreshCw className="size-3.5" /> Reintentar
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            onClick={() => setTecnicos((t) => ({ ...t, [i.id]: !t[i.id] }))}
                          >
                            <ChevronDown className="size-3.5" /> Ver detalles técnicos
                          </Button>
                        </div>
                      </div>
                      <p className="mt-1 text-destructive">{mensajeAmigable(i)}</p>
                      {tecnicos[i.id] ? (
                        <div className="mt-1 rounded-md bg-muted/40 p-2 text-[11px] leading-5 text-muted-foreground">
                          <p>Código técnico: {codigoTecnico(i)}</p>
                          <p>Etapa: {i.stage ?? "—"}</p>
                          <p>ID del proceso: {i.id}</p>
                          <p>Mensaje original: {i.error_message ?? i.user_message ?? "—"}</p>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="duplicados">
              <AccordionTrigger className="text-xs font-semibold">Duplicados ({duplicados.length})</AccordionTrigger>
              <AccordionContent>
                <div className="max-h-72 space-y-1 overflow-auto pr-1">
                  {duplicados.length === 0 ? <p className="text-xs text-muted-foreground">Sin duplicados.</p> : null}
                  {duplicados.map((i) => (
                    <div key={i.id} className="rounded-md border border-border p-2 text-xs">
                      <p className="truncate font-medium">{i.invoice_number ?? i.file_name}</p>
                      <p className="text-muted-foreground">→ Ya existe · Ya fue procesada · No se volverá a causar</p>
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="procesadas">
              <AccordionTrigger className="text-xs font-semibold">Procesadas ({procesadas.length})</AccordionTrigger>
              <AccordionContent>
                <div className="max-h-72 overflow-auto rounded-md border border-border">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-muted/50 text-left">
                      <tr>
                        {["Archivo", "Proveedor", "Comprador", "Factura", "Total", "Estado"].map((h) => (
                          <th key={h} className="px-2 py-1 font-medium">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {procesadas.map((i) => (
                        <tr key={i.id} className="border-t border-border">
                          <td className="max-w-44 truncate px-2 py-1">{i.file_name}</td>
                          <td className="max-w-32 truncate px-2 py-1">{i.provider_name ?? "—"}</td>
                          <td className="max-w-32 truncate px-2 py-1">{i.buyer_name ?? "—"}</td>
                          <td className="px-2 py-1">{i.invoice_number ?? "—"}</td>
                          <td className="px-2 py-1">{cop(Number(i.invoice_total ?? 0))}</td>
                          <td className="px-2 py-1">{i.read_status ?? ITEM_LABEL[i.status]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="revision">
              <AccordionTrigger className="text-xs font-semibold">
                Requieren revisión ({revision.length})
              </AccordionTrigger>
              <AccordionContent>
                <div className="max-h-72 space-y-1 overflow-auto pr-1">
                  {revision.length === 0 ? <p className="text-xs text-muted-foreground">Ninguna.</p> : null}
                  {revision.map((i) => (
                    <div key={i.id} className="rounded-md border border-border p-2 text-xs">
                      <p className="truncate font-medium">{i.file_name}</p>
                      <p className="text-muted-foreground">
                        {i.invoice_number ?? "—"} · confianza {Math.round(Number(i.score ?? 0) * 100)}%
                      </p>
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="pendientes">
              <AccordionTrigger className="text-xs font-semibold">
                Pendientes y en proceso ({pendientes.length})
              </AccordionTrigger>
              <AccordionContent>
                <div className="max-h-72 space-y-1 overflow-auto pr-1">
                  {pendientes.length === 0 ? <p className="text-xs text-muted-foreground">Ninguna.</p> : null}
                  {pendientes.map((i) => (
                    <div key={i.id} className="flex items-center gap-2 rounded-md border border-border p-2 text-xs">
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                      <span className="truncate font-medium">{i.file_name}</span>
                      <span className="text-muted-foreground">{ITEM_LABEL[i.status]}</span>
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </DialogContent>
      </Dialog>

      {(historial.data ?? []).length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-semibold">Historial de cargas</p>
          <div className="max-h-64 space-y-1 overflow-auto pr-1">
            {(historial.data ?? []).map((u) => (
              <div
                key={u.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs"
              >
                <span className="min-w-0 truncate text-muted-foreground">
                  {fechaHora(u.created_at)} · <span className="font-medium text-foreground">{u.file_name}</span> ·{" "}
                  {u.pdf_found} archivos · {u.processed_count} procesadas · {u.error_count} errores ·{" "}
                  {UPLOAD_LABEL[u.status]}
                </span>
                <span className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void abrirProceso(u)}>
                    Ver detalle
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-destructive"
                    disabled={running || !!busy}
                    onClick={() => void eliminarProceso(u)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
