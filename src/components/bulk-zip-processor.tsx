// Carga masiva de facturas desde un comprimido .zip, con persistencia total:
// el ZIP y cada PDF quedan en Storage, cada PDF es una tarea en base de datos
// y el proceso puede reanudarse aunque se cierre el navegador.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Download, Layers, Loader2, RefreshCw, Sparkles, XCircle } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cop, fechaHora } from "@/lib/format";
import { isTransient } from "@/lib/bulk-queue";
import { processInvoiceFile, readZipContents, resetBulkBatch, type BulkConfig } from "@/lib/bulk-invoices";
import type { CompanyKnowledge } from "@/lib/causacion-engine";
import {
  ACTIVE_STATUSES,
  createUpload,
  existingFingerprints,
  fileFromStorage,
  insertItems,
  ITEM_LABEL,
  listItems,
  listUploads,
  mensajeUsuario,
  refreshUploadCounters,
  sha256,
  updateItem,
  updateUpload,
  UPLOAD_LABEL,
  type BulkItem,
  type BulkUpload,
} from "@/lib/bulk-upload-store";

const CONCURRENCY = 6;
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const started = useRef<number>(0);
  // Archivos en memoria de esta sesión (evita descargar de nuevo desde Storage).
  const cache = useRef(new Map<string, File>());
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

  const stats = useMemo(() => {
    const total = items.length;
    const done = items.filter((i) => i.status === "completed").length;
    const failed = items.filter((i) => i.status === "error").length;
    const dup = items.filter((i) => i.status === "duplicate").length;
    const active = items.filter((i) => i.status === "reading" || i.status === "processing").length;
    const pending = total - done - failed - dup - active;
    const terminados = done + failed + dup;
    const elapsed = started.current ? Date.now() - started.current : 0;
    const eta = running && terminados > 0 ? Math.round((elapsed / terminados) * (total - terminados)) : null;
    return {
      total,
      done,
      failed,
      dup,
      active,
      pending,
      percent: total ? Math.round(((done + failed + dup) / total) * 100) : 0,
      eta,
      review: items.filter((i) => i.status === "completed" && i.needs_review).length,
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
            patchItem(item.id, { status: "reading", attempts: attempt, stage: "lectura" });
            await updateItem(item.id, { status: "reading", attempts: attempt, stage: "lectura" });
            try {
              const file =
                cache.current.get(item.id) ??
                (item.storage_path ? await fileFromStorage(item.storage_path, item.file_name) : null);
              if (!file) throw new Error("El archivo del documento no está disponible.");
              cache.current.set(item.id, file);
              patchItem(item.id, { status: "processing", stage: "ia" });
              const result = await processInvoiceFile({
                file,
                companyId,
                config,
                extract: extract as never,
                storagePath: item.storage_path,
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
              };
              patchItem(item.id, patch);
              await updateItem(item.id, patch);
              break;
            } catch (error) {
              const message = error instanceof Error ? error.message : "Error al procesar";
              if (attempt < MAX_ATTEMPTS && isTransient(error)) {
                patchItem(item.id, { stage: `reintento ${attempt}`, error_message: message });
                await sleep(800 * attempt);
                continue;
              }
              const duplicado = /duplicad|ya fue causada|ya existe|repetido/i.test(message);
              const patch: Partial<BulkItem> = {
                status: duplicado ? "duplicate" : "error",
                stage: "error",
                error_message: message,
                user_message: mensajeUsuario(item.file_name, message),
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
      setUpload({ ...uploadRow, status });
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
      const previos = await existingFingerprints(companyId, prepared.map((p) => p.hash));
      const vistos = new Set<string>();

      const rows: Array<Partial<BulkItem>> = [];
      const files: File[] = [];
      let position = 0;
      for (const { file, hash } of prepared) {
        const repetido = previos.has(hash) || vistos.has(hash);
        vistos.add(hash);
        let path: string | null = null;
        if (!repetido) {
          const safe = file.name.replace(/[^\w.-]/g, "_");
          const target = `${userId}/${companyId}/bulk/${row.id}/${position}-${safe}`;
          const res = await supabase.storage.from("facturas").upload(target, file, { upsert: true });
          if (!res.error) path = target;
        }
        rows.push({
          upload_id: row.id,
          company_id: companyId,
          file_name: file.name,
          storage_path: path,
          size_bytes: file.size,
          fingerprint: repetido ? null : hash,
          status: repetido ? "duplicate" : "pending",
          user_message: repetido ? `${file.name}: este documento ya fue procesado.` : null,
          position,
        });
        files.push(file);
        position += 1;
      }

      const created = await insertItems(rows);
      created.forEach((item, i) => {
        const f = files[i];
        if (f) cache.current.set(item.id, f);
      });
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
      await runItems(row, created.filter((i) => i.status === "pending"));
    } catch (error) {
      setBusy("");
      const message = error instanceof Error ? error.message : "No fue posible iniciar el procesamiento.";
      if (upload) await updateUpload(upload.id, { status: "failed", error_message: message });
      toast.error(message);
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
    // Solo los documentos con error: los completados nunca se vuelven a causar.
    await runItems(upload, rows.filter((i) => i.status === "error"));
  }

  async function abrirProceso(u: BulkUpload) {
    setUpload(u);
    setItems(await listItems(u.id));
  }

  function descargarReporte() {
    if (!upload) return;
    const head = "Archivo;Estado;Intentos;Factura;Total;Confianza;Detalle";
    const body = items
      .map((i) =>
        [
          i.file_name,
          ITEM_LABEL[i.status],
          i.attempts,
          i.invoice_number ?? "",
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
              {!running && stats.failed > 0 ? (
                <Button size="sm" variant="outline" onClick={() => void reintentarErrores()}>
                  <RefreshCw className="size-4" /> Reintentar errores ({stats.failed})
                </Button>
              ) : null}
              {stats.total > 0 ? (
                <Button size="sm" variant="outline" onClick={descargarReporte}>
                  <Download className="size-4" /> Descargar reporte
                </Button>
              ) : null}
            </div>
          </div>

          <div>
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>
                {stats.done + stats.failed + stats.dup} de {stats.total}
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
                    : (i.user_message ?? "")}
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
