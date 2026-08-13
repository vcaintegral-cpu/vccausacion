import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, PlayCircle, RefreshCw, StopCircle } from "lucide-react";

import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany, useCompanies } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { fechaHora } from "@/lib/format";
import {
  cancelUpload,
  ensureUploadJobs,
  JOB_LABEL,
  kickWorker,
  listJobs,
  retryJob,
  summarize,
  type ProcessingJob,
} from "@/lib/jobs-store";

export const Route = createFileRoute("/_authenticated/procesos")({
  head: () => ({
    meta: [
      { title: "Procesos en segundo plano | Causación" },
      { name: "description", content: "Seguimiento en tiempo real de los lotes de facturas que se procesan en el servidor." },
      { property: "og:title", content: "Procesos en segundo plano" },
      { property: "og:description", content: "Estado real de la cola de lectura, causación y sincronización de facturas." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Procesos,
});

const ACTIVOS = ["pending", "processing", "reading", "extracting_data", "accounting", "syncing_siigo"];

function Procesos() {
  const companyId = useActiveCompany();
  const { data: companies, isLoading } = useCompanies();

  const jobs = useQuery({
    queryKey: ["processing-jobs", companyId],
    enabled: !!companyId,
    refetchInterval: 5000,
    queryFn: () => listJobs(companyId!),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Cargando…</p>;
  if (!companies || companies.length === 0 || !companyId) return <EmptyCompany />;

  const rows: ProcessingJob[] = jobs.data ?? [];
  const resumen = summarize(rows);
  const lotes = new Map<string, ProcessingJob[]>();
  for (const job of rows) {
    const key = job.upload_id ?? "sueltos";
    lotes.set(key, [...(lotes.get(key) ?? []), job]);
  }

  async function accion(fn: () => Promise<void>, ok: string) {
    try {
      await fn();
      toast.success(ok);
      await jobs.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible completar la acción.");
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Procesos en segundo plano</h1>
          <p className="text-sm text-muted-foreground">
            El procesamiento ocurre en el servidor: puedes cerrar esta pestaña y el avance continúa.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void jobs.refetch()}>
            <RefreshCw className="size-4" /> Actualizar
          </Button>
          <Button onClick={() => void accion(kickWorker, "Procesamiento reactivado.")}>
            <PlayCircle className="size-4" /> Reactivar cola
          </Button>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Procesos activos", resumen.procesosActivos],
          ["Pendientes", resumen.pendientes],
          ["Procesando", resumen.procesando],
          ["Listas para revisar", resumen.listas],
          ["Sincronizadas", resumen.sincronizadas],
          ["Errores", resumen.errores],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border bg-card p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-xl font-semibold">{value}</p>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No hay trabajos en cola para esta empresa.
        </p>
      ) : (
        [...lotes.entries()].map(([uploadId, lote]) => {
          const activos = lote.filter((j) => ACTIVOS.includes(j.status)).length;
          const pendientes = lote.filter((j) => j.status === "pending" || j.status === "needs_ocr").length;
          const errores = lote.filter((j) => j.status === "error").length;
          const hechos = lote.length - activos - pendientes;
          const nombre = lote[0]?.file_name ?? "";
          return (
            <section key={uploadId} className="space-y-3 rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">
                    {uploadId === "sueltos" ? "Documentos sueltos" : `Lote ${uploadId.slice(0, 8)}`}
                    {nombre ? ` · ${nombre}` : ""} · {hechos}/{lote.length} terminados · {pendientes} pendientes · {errores} con error
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {activos > 0 ? (
                      <span className="inline-flex items-center gap-1">
                        <Loader2 className="size-3 animate-spin" /> {activos} en proceso
                      </span>
                    ) : (
                      pendientes > 0
                        ? "En espera de un worker: puedes reanudar este lote sin afectar a los demás."
                        : "Sin trabajos activos"
                    )}
                  </p>
                </div>
                {uploadId !== "sueltos" && (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => void accion(() => cancelUpload(uploadId), "Lote cancelado.")}>
                      <StopCircle className="size-4" /> Cancelar
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        void accion(async () => {
                          await ensureUploadJobs(uploadId, true);
                        }, "Lote reanudado.")
                      }
                    >
                      <PlayCircle className="size-4" /> Reanudar
                    </Button>
                  </div>
                )}
              </div>
              <div className="h-2 overflow-hidden rounded bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${Math.round((hechos / lote.length) * 100)}%` }} />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3">Archivo</th>
                      <th className="py-1 pr-3">Estado</th>
                      <th className="py-1 pr-3">Etapa</th>
                      <th className="py-1 pr-3">Intentos</th>
                      <th className="py-1 pr-3">Detalle</th>
                      <th className="py-1 pr-3">Actualizado</th>
                      <th className="py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {lote.map((job) => (
                      <tr key={job.id} className="border-t">
                        <td className="py-1 pr-3">{job.file_name}</td>
                        <td className="py-1 pr-3">{JOB_LABEL[job.status] ?? job.status}</td>
                        <td className="py-1 pr-3">{job.processing_stage ?? "—"}</td>
                        <td className="py-1 pr-3">
                          {job.attempt_count}/{job.max_attempts}
                        </td>
                        <td className="py-1 pr-3 text-muted-foreground">{job.user_message ?? job.error_message ?? "—"}</td>
                        <td className="py-1 pr-3 text-muted-foreground">{fechaHora(job.updated_at)}</td>
                        <td className="py-1">
                          {job.status === "error" && (
                            <Button variant="ghost" size="sm" onClick={() => void accion(() => retryJob(job.id), "Trabajo reencolado.")}>
                              Reintentar
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
