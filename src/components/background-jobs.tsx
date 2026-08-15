// Indicador global de procesamiento en segundo plano: visible en cualquier módulo,
// no bloquea la navegación y lee su estado del motor desacoplado de la pantalla.
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";

import { useBulkProgress } from "@/lib/bulk-runner";

export function BackgroundJobsPanel() {
  const p = useBulkProgress();
  if (!p.running || p.total === 0) return null;
  const percent = p.total ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <Link
      to="/causar"
      search={{ id: undefined }}
      title="Ver el detalle de la carga masiva"
      className="pointer-events-auto fixed top-3 right-4 z-50 flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs shadow-md transition-colors hover:bg-accent"
    >
      <Loader2 className="size-3.5 animate-spin text-primary" />
      <span className="font-medium">
        Procesando {p.total} facturas · {p.done}/{p.total}
      </span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <span className="block h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
      </span>
      {p.errors > 0 ? <span className="text-destructive">{p.errors} err.</span> : null}
    </Link>
  );
}
