// Indicador global de procesamiento en segundo plano: visible en cualquier módulo,
// no bloquea la navegación y lee su estado del motor desacoplado de la pantalla.
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";

import { useBulkProgress } from "@/lib/bulk-runner";

export function BackgroundJobsPanel() {
  const p = useBulkProgress();
  if (!p.running || p.total === 0) return null;
  const listas = p.done;
  return (
    <div className="pointer-events-auto fixed bottom-4 right-4 z-50 w-64 rounded-lg border border-border bg-card p-3 shadow-lg">
      <div className="flex items-center gap-2">
        <Loader2 className="size-4 animate-spin text-primary" />
        <p className="text-xs font-semibold">Procesando facturas en segundo plano</p>
      </div>
      {p.fileName ? <p className="mt-1 truncate text-[11px] text-muted-foreground">{p.fileName}</p> : null}
      <p className="mt-1 text-xs">
        {listas} de {p.total}
      </p>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${p.total ? Math.round((listas / p.total) * 100) : 0}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Pendientes: {p.pending} · Errores: {p.errors}
      </p>
      <Link to="/causar" search={{}} className="mt-2 inline-block text-[11px] font-medium text-primary underline">
        Ver detalle
      </Link>
    </div>
  );
}
