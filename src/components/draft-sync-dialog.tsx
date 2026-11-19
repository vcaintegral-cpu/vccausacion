import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import {
  aplicarSincronizacion,
  aprenderDeSincronizacion,
  deshacerSincronizacion,
  type BorradorRelacionado,
  type SyncResultado,
  type SyncChange,
} from "@/lib/draft-sync";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Solicitud de sincronización originada al guardar un borrador. */
export type DraftSyncRequest = {
  companyId: string;
  invoiceId: string;
  invoiceLabel: string;
  providerNit: string | null;
  providerName: string | null;
  changes: SyncChange[];
  drafts: BorradorRelacionado[];
};

type Resultado = {
  eventId: string | null;
  updated: number;
  conflicts: { label: string; message: string }[];
};

/**
 * Confirmación del cambio contable detectado. Nunca modifica otros borradores
 * sin que el usuario elija explícitamente "Aplicar a todos".
 */
export function DraftSyncDialog({
  request,
  onClose,
  onApplied,
}: {
  request: DraftSyncRequest | null;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [deshaciendo, setDeshaciendo] = useState(false);

  useEffect(() => {
    if (request) { setResultado(null); setBusy(false); setDeshaciendo(false); }
  }, [request]);

  if (!request) return null;
  const total = request.drafts.length;

  async function aplicarATodos() {
    if (!request || busy) return;
    setBusy(true);
    try {
      // Identificador único: si el mismo evento llega dos veces no se repite nada.
      const eventKey = `${request.invoiceId}:${request.drafts.map((d) => d.id).sort().join(",")}:${request.changes
        .map((c) => `${c.kind}=${c.old}>${c.new}`)
        .join("|")}`;
      // El servidor solo cambia cuentas que coinciden con la anterior; la clasificación (producto) y los borradores
      // que estaban SIN cuenta se completan aquí, con el mismo motor de «Asignar cuenta» de Borradores.
      const soloTipo = request.changes.every((c) => c.kind === "tipo");
      const res = soloTipo
        ? ({ ok: true, updated: 0, conflicts: [] } as SyncResultado)
        : await aplicarSincronizacion({
            sourceInvoiceId: request.invoiceId,
            changes: request.changes,
            known: request.drafts,
            eventKey,
          });
      if (!res.ok) { toast.error(res.message ?? "No fue posible sincronizar los borradores."); return; }
      const conflictos = (res.conflicts ?? []).map((c) => ({ label: c.label, message: c.message }));
      const extra = await completarCuentaYClasificacion(
        request,
        new Set((res.conflicts ?? []).map((c) => c.invoice_id)),
      );
      setResultado({
        eventId: res.event_id ?? null,
        updated: Math.min(total, (res.updated ?? 0) + extra),
        conflicts: conflictos,
      });
      // Aprendizaje contable: la decisión confirmada queda como regla del proveedor.
      try {
        const { data: auth } = await supabase.auth.getUser();
        await aprenderDeSincronizacion({
          companyId: request.companyId,
          providerNit: request.providerNit,
          providerName: request.providerName,
          invoiceId: request.invoiceId,
          userId: auth.user?.id ?? null,
          changes: request.changes,
        });
      } catch (e) {
        console.warn("[sincronizacion] no se pudo actualizar la regla del proveedor", e);
      }
      onApplied?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No fue posible sincronizar los borradores.");
    } finally {
      setBusy(false);
    }
  }

  async function deshacer() {
    if (!resultado?.eventId || deshaciendo) return;
    setDeshaciendo(true);
    try {
      const res = await deshacerSincronizacion(resultado.eventId);
      if (!res.ok) { toast.error(res.message ?? "No fue posible deshacer la sincronización."); return; }
      toast.success(res.message ?? "Sincronización deshecha.");
      onApplied?.();
      onClose();
    } finally {
      setDeshaciendo(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{resultado ? "Sincronización aplicada" : "Cambio contable detectado"}</DialogTitle>
        </DialogHeader>

        {!resultado && (
          <div className="space-y-3 text-sm">
            <dl className="space-y-1">
              <Fila k="Proveedor" v={`${request.providerName ?? "—"}${request.providerNit ? ` · NIT ${request.providerNit}` : ""}`} />
              <Fila k="Factura modificada" v={request.invoiceLabel} />
            </dl>
            <p className="text-muted-foreground">
              Se detectaron {total} borrador(es) adicional(es) de este proveedor.
            </p>
            <div className="rounded-md border border-border">
              {request.changes.map((c, i) => (
                <div key={`${c.kind}-${i}`} className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0">
                  <span className="text-xs text-muted-foreground">{c.label}</span>
                  <span className="font-mono text-xs">
                    {c.old || "—"} <span className="text-muted-foreground">→</span> <strong>{c.new}</strong>
                  </span>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Solo se cambian estas cuentas y la clasificación (producto o gasto). Los borradores que estaban sin cuenta la reciben; no se modifican valores, fechas, números, retenciones calculadas ni el total de ninguna factura.
            </p>
          </div>
        )}

        {resultado && (
          <div className="space-y-3 text-sm">
            <p>{resultado.updated} de {total} borrador(es) actualizados correctamente.</p>
            {resultado.conflicts.length > 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                <p className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="size-4" /> {resultado.conflicts.length} borrador(es) no se modificaron
                </p>
                <ul className="mt-1 space-y-1 text-muted-foreground">
                  {resultado.conflicts.map((c) => (
                    <li key={c.label}><span className="font-mono">{c.label}</span> · {c.message}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {!resultado && (
            <>
              <Button variant="ghost" onClick={onClose} disabled={busy}>Cancelar</Button>
              <Button variant="outline" onClick={onClose} disabled={busy}>Aplicar solo a esta factura</Button>
              <Button onClick={() => void aplicarATodos()} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {busy ? "Aplicando cambios…" : `Aplicar a los ${total} borradores`}
              </Button>
            </>
          )}
          {resultado && (
            <>
              {resultado.eventId && resultado.updated > 0 && (
                <Button variant="outline" onClick={() => void deshacer()} disabled={deshaciendo}>
                  {deshaciendo ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} Deshacer sincronización
                </Button>
              )}
              <Button onClick={onClose}>Cerrar</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Complemento de la sincronización: pone la cuenta (y la clasificación «producto» con su producto del catálogo) en los
 * renglones SIN cuenta de los demás borradores del proveedor y el tipo en los que ya la tienen. Devuelve cuántos
 * borradores se completaron.
 */
async function completarCuentaYClasificacion(
  request: DraftSyncRequest,
  omitir: Set<string>,
): Promise<number> {
  try {
    const cambioCuenta = request.changes.find((c) => c.kind === "gasto");
    const { data: lin } = await supabase
      .from("invoice_lines")
      .select("position, description, account_code, account_name, item_type, code")
      .eq("invoice_id", request.invoiceId)
      .order("position");
    const origen = (lin ?? []) as Array<{
      description: string | null;
      account_code: string | null;
      account_name: string | null;
      item_type: string | null;
      code: string | null;
    }>;
    const cuenta = cambioCuenta?.new || String(origen.find((l) => l.item_type === "producto")?.account_code ?? "").trim();
    if (!cuenta) return 0;
    const linea = origen.find((l) => String(l.account_code ?? "").trim() === cuenta);
    const nombre = cambioCuenta?.name ?? linea?.account_name ?? null;
    const esProducto = linea?.item_type === "producto";
    const { loadDeps } = await import("@/lib/bulk-runner");
    const { asignarCuentaGasto } = await import("@/lib/asignar-cuenta-gasto");
    const { config } = await loadDeps(request.companyId);
    let completados = 0;
    for (const d of request.drafts) {
      if (omitir.has(d.id)) continue;
      const r = await asignarCuentaGasto(
        d.id,
        { code: cuenta, name: nombre },
        config,
        {
          inventario: /^14/.test(cuenta),
          ...(esProducto
            ? { tipo: "producto" as const, producto: linea?.code ? { code: linea.code, name: linea.description } : null }
            : {}),
        },
      );
      if (r.ok && r.renglones > 0) completados += 1;
    }
    return completados;
  } catch (e) {
    console.warn("[sincronizacion] no se pudo completar la cuenta en los demás borradores", e);
    return 0;
  }
}

function Fila({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
}
