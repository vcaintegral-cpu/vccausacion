import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Ban, CheckCheck, FileSearch, Loader2, RefreshCw, Send, Undo2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { siigoSyncInvoice } from "@/lib/siigo.functions";
import {
  siigoCheckInterrupted,
  siigoMarkReconciled,
  siigoMarkVoided,
  siigoRecheckInvoice,
} from "@/lib/siigo-recovery.functions";
import { siigoErrorKind, type SiigoErrorKind } from "@/lib/siigo-purchase-validation";
import { cop } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type SiigoErrorInvoice = {
  id: string;
  prefix: string | null;
  number: string | null;
  status: string;
  siigo_status: string | null;
  siigo_id: string | null;
  siigo_number: string | null;
  siigo_error?: string | null;
  siigo_error_kind?: string | null;
  siigo_trace?: unknown;
  siigo_attempts?: number | null;
  siigo_last_attempt_at?: string | null;
};

export const SIIGO_KIND_LABEL: Record<SiigoErrorKind, string> = {
  sin_crear: "Sin crear en Siigo",
  creado_diferencia: "Creado con diferencia",
  interrumpido: "Envío interrumpido",
};

const etiqueta = (i: SiigoErrorInvoice) => [i.prefix, i.number].filter(Boolean).join("-") || "Sin número";

type Res = { id: string; etiqueta: string; ok: boolean; message: string };

/** Acciones de recuperación compartidas entre la fila y el lote. */
export function useSiigoRecovery() {
  const sync = useServerFn(siigoSyncInvoice);
  const recheckFn = useServerFn(siigoRecheckInvoice);
  const checkFn = useServerFn(siigoCheckInterrupted);

  async function reintentar(inv: SiigoErrorInvoice): Promise<Res> {
    const e = etiqueta(inv);
    const kind = siigoErrorKind(inv);
    if (kind === "creado_diferencia") return { id: inv.id, etiqueta: e, ok: false, message: "Existe en Siigo: no se reenvía. Use Consultar Siigo de nuevo." };
    if (kind === "interrumpido") {
      const c = await checkFn({ data: { invoiceId: inv.id } });
      if (c.found || !c.ok) return { id: inv.id, etiqueta: e, ok: c.ok && c.status === "sincronizada", message: c.message };
    }
    const r = await sync({ data: { invoiceId: inv.id } });
    return { id: inv.id, etiqueta: e, ok: r.ok, message: r.ok ? `Siigo N° ${r.siigoNumber ?? r.siigoId ?? "creado"}.` : (r.error ?? "Siigo rechazó el comprobante.") };
  }

  async function consultar(inv: SiigoErrorInvoice): Promise<Res> {
    const r = await recheckFn({ data: { invoiceId: inv.id } });
    return { id: inv.id, etiqueta: etiqueta(inv), ok: r.ok, message: r.message };
  }

  async function volverABorrador(inv: SiigoErrorInvoice): Promise<Res> {
    const e = etiqueta(inv);
    const call = async (fn: string) => {
      const { data, error } = await (supabase.rpc as unknown as (n: string, p: Record<string, unknown>) => Promise<{ data: { ok: boolean; message?: string } | null; error: { message: string } | null }>)(fn, { _invoice_id: inv.id });
      if (error) return { ok: false, message: error.message };
      return data ?? { ok: false, message: "Sin respuesta." };
    };
    if (inv.status === "causada") {
      const r = await call("revert_invoice_posting");
      if (!r.ok) return { id: inv.id, etiqueta: e, ok: false, message: r.message ?? "No fue posible revertir la causación." };
    }
    const r = await call("return_invoice_to_draft");
    return { id: inv.id, etiqueta: e, ok: r.ok, message: r.ok ? "Devuelta a borrador para corregir cuentas." : (r.message ?? "No fue posible devolverla a borrador.") };
  }

  return { reintentar, consultar, volverABorrador };
}

/** Botones por fila según el tipo de error y el diálogo con el detalle completo. */
export function SiigoErrorActions({ invoice, onDone }: { invoice: SiigoErrorInvoice; onDone: () => void | Promise<void> }) {
  const kind = siigoErrorKind(invoice);
  const { reintentar, consultar, volverABorrador } = useSiigoRecovery();
  const reconcile = useServerFn(siigoMarkReconciled);
  const voided = useServerFn(siigoMarkVoided);
  const [busy, setBusy] = useState<string | null>(null);
  const [detalle, setDetalle] = useState(false);
  const [dialogo, setDialogo] = useState<null | "correcto" | "anulado">(null);
  const [comentario, setComentario] = useState("");

  if (!kind) return null;

  async function run(key: string, fn: () => Promise<{ ok: boolean; message: string }>) {
    if (busy) return;
    setBusy(key);
    try {
      const r = await fn();
      if (r.ok) toast.success(r.message); else toast.error(r.message);
      setDialogo(null);
      setComentario("");
      await onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error inesperado.");
    } finally {
      setBusy(null);
    }
  }

  const spin = (k: string, Icon: typeof Send) => (busy === k ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />);
  const consecutivo = invoice.siigo_number ?? invoice.siigo_id ?? "";

  return (
    <>
      <div className="flex flex-wrap justify-end gap-1">
        {(kind === "sin_crear" || kind === "interrumpido") && (
          <>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={!!busy} onClick={() => void run("retry", () => reintentar(invoice))}>
              {spin("retry", Send)} {kind === "interrumpido" ? "Verificar y reintentar" : "Reintentar envío"}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={!!busy} onClick={() => void run("draft", () => volverABorrador(invoice))}>
              {spin("draft", Undo2)} Volver a borrador
            </Button>
          </>
        )}
        {kind === "creado_diferencia" && (
          <>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={!!busy} onClick={() => void run("check", () => consultar(invoice))}>
              {spin("check", RefreshCw)} Consultar Siigo de nuevo
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={!!busy} onClick={() => setDialogo("correcto")}>
              <CheckCheck className="size-3.5" /> Marcar como correcto
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={!!busy} onClick={() => setDialogo("anulado")}>
              <Ban className="size-3.5" /> Marcado como anulado en Siigo
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setDetalle(true)}>
          <FileSearch className="size-3.5" /> Ver detalle
        </Button>
      </div>

      <Dialog open={dialogo === "correcto"} onOpenChange={(o) => !o && !busy && setDialogo(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Marcar {consecutivo} como correcto</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Confirma que en Siigo el documento está bien. La factura pasará a "Sincronizada – conciliada manualmente".</p>
          <Textarea value={comentario} onChange={(e) => setComentario(e.target.value)} placeholder="Comentario obligatorio: por qué el documento en Siigo es correcto" rows={3} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogo(null)} disabled={!!busy}>Cancelar</Button>
            <Button disabled={!!busy || comentario.trim().length < 5} onClick={() => void run("ok", () => reconcile({ data: { invoiceId: invoice.id, comment: comentario } }))}>
              {spin("ok", CheckCheck)} Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogo === "anulado"} onOpenChange={(o) => !o && !busy && setDialogo(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>¿Anuló {consecutivo} en Siigo?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            Confirme solo si ya anuló {consecutivo} dentro de Siigo. El consecutivo quedará en el historial y la factura volverá a "Sin crear en Siigo" para reenviarla con la lógica corregida.
          </p>
          <Textarea value={comentario} onChange={(e) => setComentario(e.target.value)} placeholder="Comentario (opcional)" rows={2} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogo(null)} disabled={!!busy}>Cancelar</Button>
            <Button variant="destructive" disabled={!!busy} onClick={() => void run("void", () => voided({ data: { invoiceId: invoice.id, comment: comentario } }))}>
              {spin("void", Ban)} Sí, lo anulé en Siigo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SiigoErrorDetail invoice={invoice} open={detalle} onOpenChange={setDetalle} />
    </>
  );
}

type Comparacion = { campo: string; origen: number; siigo: number | null; ok: boolean };

export function SiigoErrorDetail({ invoice, open, onOpenChange }: { invoice: SiigoErrorInvoice; open: boolean; onOpenChange: (o: boolean) => void }) {
  const trace = (invoice.siigo_trace && typeof invoice.siigo_trace === "object" ? invoice.siigo_trace : {}) as Record<string, unknown>;
  const comparacion = Array.isArray(trace["comparacion"]) ? (trace["comparacion"] as Comparacion[]) : [];
  const enviado = trace["siigo_request"];
  const respuesta = trace["siigo_verificacion"] ?? trace["siigo_respuesta"] ?? trace["response"] ?? trace["error_raw"];
  const kind = siigoErrorKind(invoice);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader><DialogTitle>Detalle Siigo · {etiqueta(invoice)}</DialogTitle></DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Dato k="Tipo de error" v={kind ? SIIGO_KIND_LABEL[kind] : "—"} />
            <Dato k="Consecutivo Siigo" v={invoice.siigo_number ?? "Pendiente"} />
            <Dato k="Intentos" v={String(invoice.siigo_attempts ?? 0)} />
            <Dato k="Último intento" v={invoice.siigo_last_attempt_at ? new Date(invoice.siigo_last_attempt_at).toLocaleString("es-CO") : "—"} />
          </div>
          <section>
            <h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Mensaje completo</h3>
            <p className="whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{invoice.siigo_error ?? "—"}</p>
          </section>
          {comparacion.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Comparación origen vs. Siigo</h3>
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-left text-muted-foreground">
                  <tr><th className="px-2 py-1">Campo</th><th className="px-2 py-1 text-right">Origen</th><th className="px-2 py-1 text-right">Siigo</th><th className="px-2 py-1">Resultado</th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {comparacion.map((c) => (
                    <tr key={c.campo}>
                      <td className="px-2 py-1">{c.campo}</td>
                      <td className="px-2 py-1 text-right font-mono">{cop(c.origen)}</td>
                      <td className="px-2 py-1 text-right font-mono">{c.siigo === null ? "No informado" : cop(c.siigo)}</td>
                      <td className={`px-2 py-1 ${c.ok ? "text-primary" : "text-destructive"}`}>{c.ok ? "Coincide" : "Diferencia"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          <Json titulo="JSON enviado a Siigo" valor={enviado} />
          <Json titulo="Respuesta de Siigo" valor={respuesta} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Dato({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="text-muted-foreground">{k}</div>
      <div className="font-medium">{v}</div>
    </div>
  );
}

function Json({ titulo, valor }: { titulo: string; valor: unknown }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">{titulo}</h3>
      {valor == null ? (
        <p className="text-xs text-muted-foreground">No registrado para este intento.</p>
      ) : (
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-[11px]">{typeof valor === "string" ? valor : JSON.stringify(valor, null, 2)}</pre>
      )}
    </section>
  );
}
