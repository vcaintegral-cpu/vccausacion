import { useState } from "react";
import { AlertTriangle, CheckCircle2, Download, XCircle } from "lucide-react";

import type { ImportDetail } from "@/lib/import-system";
import { downloadSheet } from "@/lib/spreadsheet";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const fmt = (value: number) => value.toLocaleString("es-CO");

export function ImportDetailPanel({ detail }: { detail: ImportDetail | null }) {
  const [open, setOpen] = useState(false);
  if (!detail) return null;
  const complete = detail.status === "COMPLETADA";
  const warning = detail.status === "COMPLETADA CON ERRORES";
  const Icon = complete ? CheckCircle2 : warning ? AlertTriangle : XCircle;
  const statusClass = complete ? "text-emerald-600" : warning ? "text-amber-600" : "text-destructive";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
      <div>
        <p className={`flex items-center gap-2 text-sm font-semibold ${statusClass}`}><Icon className="size-4" /> {detail.status}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Encontrados: {fmt(detail.found)} · Procesados: {fmt(detail.processed)} · Verificados: {fmt(detail.saved)} · Faltantes: {fmt(detail.missing)}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Ver detalle</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>Detalle de importación · {detail.module}</DialogTitle></DialogHeader>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <p>Archivo: <strong>{detail.fileName}</strong></p>
            <p>Fecha y hora: <strong>{new Date(detail.importedAt).toLocaleString("es-CO")}</strong></p>
            <p>Usuario: <strong>{detail.user}</strong></p>
            <p>Estado final: <strong className={statusClass}>{detail.status}</strong></p>
            <p>Registros encontrados: <strong>{fmt(detail.found)}</strong></p>
            <p>Registros válidos: <strong>{fmt(detail.valid)}</strong></p>
            <p>Registros inválidos: <strong>{fmt(detail.invalid)}</strong></p>
            <p>Registros procesados: <strong>{fmt(detail.processed)}</strong></p>
            <p>Registros guardados y verificados: <strong>{fmt(detail.saved)}</strong></p>
            <p>Nuevos: <strong>{fmt(detail.newRows)}</strong></p>
            <p>Actualizados: <strong>{fmt(detail.updated)}</strong></p>
            <p>Sin cambios: <strong>{fmt(detail.unchanged)}</strong></p>
            <p>Duplicados: <strong>{fmt(detail.duplicates)}</strong></p>
            <p>Rechazados: <strong>{fmt(detail.rejected)}</strong></p>
            <p>Errores: <strong>{fmt(detail.errors)}</strong></p>
            <p>Lotes utilizados: <strong>{detail.batchesProcessed}/{detail.batches}</strong></p>
          </div>
          {detail.issues.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Registros con novedad</p>
              <div className="max-h-56 overflow-auto rounded-md border border-border">
                {detail.issues.map((issue, index) => (
                  <p key={`${issue.key}-${index}`} className="border-b border-border px-3 py-2 text-xs last:border-0">
                    {issue.row ? `Fila ${issue.row} · ` : ""}{issue.key || "Sin llave"}: {issue.message}
                  </p>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => downloadSheet(detail.issues.map((issue) => ({ Fila: issue.row ?? "", Lote: issue.batch ?? "", Llave: issue.key, Error: issue.message })), `detalle-${detail.module.toLowerCase().replace(/\s+/g, "-")}.xlsx`, "Errores")}
              >
                <Download className="size-4" /> Descargar detalle
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}