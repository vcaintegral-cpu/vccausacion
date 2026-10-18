import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { AlertTriangle, CheckCircle2, Download, Eye, FileSpreadsheet, Loader2, Pencil, Send, Upload } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany } from "@/components/app-shell";
import { cop, fecha, fechaHora } from "@/lib/format";
import { DS_TEMPLATE_COLUMNS, FILLED_LABEL, VENDOR_ID_LABEL, missingIdentity, dianLabel, diasParaDian, resolutionExpiry, type FilledField, type RowError, type VendorIdType } from "@/lib/support-docs";
import { processSupportUpload, type SupportProgress } from "@/lib/support-processing";
import { siigoListDsTypes, siigoSyncSupportDocument } from "@/lib/siigo-support.functions";
import { siigoReleaseInterrupted } from "@/lib/siigo-recovery.functions";
import { SiigoErrorActions } from "@/components/siigo-error-actions";
import { siigoErrorKind } from "@/lib/siigo-purchase-validation";
import { aprenderReglaProveedor, isValidExpenseAccount } from "@/lib/provider-rules";
import { exportXlsx } from "@/lib/export";
import type { JournalLine } from "@/lib/accounting";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export const Route = createFileRoute("/_authenticated/documentos-soporte")({
  head: () => ({
    meta: [
      { title: "Documentos soporte · Creación masiva en Siigo" },
      { name: "description", content: "Carga cuentas de cobro en PDF o Excel y crea documentos soporte en Siigo de forma masiva." },
      { property: "og:title", content: "Documentos soporte en Siigo" },
      { property: "og:description", content: "Creación masiva de documentos soporte en Siigo desde PDF o Excel." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DocumentosSoporte,
});

type Decision = { code?: string; origin?: string; reason?: string };
type Ds = {
  id: string; prefix: string | null; number: string | null; issue_date: string | null; provider_nit: string | null; provider_name: string | null;
  provider_address: string | null; provider_city: string | null; provider_phone: string | null; provider_email: string | null;
  subtotal: number; iva: number; retefuente: number; reteiva: number; reteica: number; total: number; cost_center: string | null; notes: string | null;
  status: string; siigo_status: string | null; siigo_id: string | null; siigo_number: string | null; siigo_error: string | null; siigo_error_kind: string | null;
  siigo_trace: unknown; siigo_attempts: number | null; siigo_last_attempt_at: string | null; ds_dian_status: string | null; ds_sent_date: string | null;
  vendor_id_type: string | null; vendor_is_natural: boolean | null; vendor_declarant: boolean | null; vendor_filled: FilledField[] | null; iva_confirmed: boolean;
  raw_extraction: { account_decisions?: Record<string, Decision> } | null; source_override: unknown; doc_kind: string;
  invoice_lines: Array<{ account_code: string | null; account_name: string | null; description: string | null }>;
};

const ORIGIN: Record<string, string> = { REGLA: "Regla", APRENDIZAJE: "Historial", HISTORIAL: "Historial", HISTORIAL_DESCRIPCION: "Historial descripción", IA: "IA", NINGUNA: "Pendiente" };
const label = (d: Ds) => (String(d.number ?? "").trim() ? [d.prefix, d.number].filter(Boolean).join("-") : (d.provider_name ?? "Sin número"));

function estado(d: Ds): string {
  if (d.status === "incompleto") return "Incompleto";
  if (d.siigo_status === "sincronizando") return "Sincronizando";
  if (d.siigo_status === "sincronizada") return "Sincronizada";
  const k = siigoErrorKind(d);
  if (k === "creado_diferencia") return "Creado con diferencia";
  if (k === "interrumpido") return "Error – Envío interrumpido";
  if (k === "sin_crear") return "Error sin crear";
  if (k === "fecha_invalida") return "Error – fecha no aceptada";
  if (d.status === "aprobado") return "Aprobada";
  return "Borrador";
}

function DocumentosSoporte() {
  const companyId = useActiveCompany();
  const qc = useQueryClient();
  const release = useServerFn(siigoReleaseInterrupted);

  const docs = useQuery({
    queryKey: ["ds", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase.from("invoices")
        .select("id, prefix, number, issue_date, provider_nit, provider_name, provider_address, provider_city, provider_phone, provider_email, subtotal, iva, retefuente, reteiva, reteica, total, cost_center, notes, status, siigo_status, siigo_id, siigo_number, siigo_error, siigo_error_kind, siigo_trace, siigo_attempts, siigo_last_attempt_at, ds_dian_status, ds_sent_date, vendor_id_type, vendor_is_natural, vendor_declarant, vendor_filled, iva_confirmed, raw_extraction, source_override, doc_kind, invoice_lines(account_code, account_name, description)")
        .eq("company_id", companyId!).eq("doc_kind", "soporte").order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Ds[];
    },
  });
  // Envíos de más de 5 minutos en "Sincronizando" pasan a "Envío interrumpido".
  useEffect(() => { if (companyId) void release({ data: { companyId } }).then((r) => { if ((r as { count?: number })?.count) void docs.refetch(); }).catch(() => {}); }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!companyId) return <EmptyCompany />;
  const all = docs.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["ds", companyId] });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Documentos soporte</h1>
        <p className="text-sm text-muted-foreground">Cargar → Borradores → Aprobar → Crear en Siigo → Historial. Siigo transmite los documentos a la DIAN.</p>
      </div>
      <Tabs defaultValue="borradores">
        <TabsList>
          <TabsTrigger value="cargar">Cargar</TabsTrigger>
          <TabsTrigger value="borradores">Borradores ({all.filter((d) => d.status !== "historico").length})</TabsTrigger>
          <TabsTrigger value="historial">Historial</TabsTrigger>
          <TabsTrigger value="terceros">Terceros por actualizar</TabsTrigger>
          <TabsTrigger value="config">Configuración</TabsTrigger>
        </TabsList>
        <TabsContent value="cargar"><Cargar companyId={companyId} onDone={refresh} /></TabsContent>
        <TabsContent value="borradores"><Borradores companyId={companyId} docs={all.filter((d) => d.status !== "historico")} onDone={refresh} /></TabsContent>
        <TabsContent value="historial"><Historial companyId={companyId} docs={all.filter((d) => d.status === "historico")} onDone={refresh} /></TabsContent>
        <TabsContent value="terceros"><Terceros docs={all} /></TabsContent>
        <TabsContent value="config"><Configuracion companyId={companyId} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ------------------------------------------------------------------ Cargar
function Cargar({ companyId, onDone }: { companyId: string; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<SupportProgress | null>(null);
  const [rowErrors, setRowErrors] = useState<RowError[]>([]);
  const [running, setRunning] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!running) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [running]);

  const plantilla = () => {
    const ws = XLSX.utils.aoa_to_sheet([[...DS_TEMPLATE_COLUMNS], ["05/10/2026", "CC", "71654321", "Juan Carlos Pérez Gómez", "", "Medellín", "", "", "015", "Clase de danza", 1, 500000, 500000, "", "Crédito"]]);
    // NIT/CC y número de cuenta de cobro como TEXTO.
    for (const c of ["C2", "I2"]) if (ws[c]) ws[c].t = "s";
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Documentos soporte");
    XLSX.writeFile(wb, "Plantilla documentos soporte.xlsx");
  };

  const subir = async (files: File[]) => {
    if (!files.length) return;
    setRunning(true); setRowErrors([]); setProgress(null); setNow(Date.now());
    try {
      const r = await processSupportUpload({ companyId, files, onProgress: setProgress });
      setRowErrors(r.rowErrors);
      toast.success(`${r.progress.ok} documento(s) en borradores · ${r.progress.errors + r.rowErrors.length} con novedad.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible procesar la carga.");
    } finally { setRunning(false); onDone(); if (input.current) input.current.value = ""; }
  };

  const seg = progress ? Math.max(0, Math.round(((running ? now : Date.now()) - progress.startedAt) / 1000)) : 0;
  return (
    <div className="space-y-4 pt-4">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => input.current?.click()} disabled={running}>
          {running ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Upload className="mr-2 size-4" />} Cargar PDF, ZIP o Excel
        </Button>
        <Button variant="outline" onClick={plantilla}><FileSpreadsheet className="mr-2 size-4" /> Plantilla documentos soporte.xlsx</Button>
        <input ref={input} type="file" multiple accept=".pdf,.zip,.xlsx,.xls" className="hidden" onChange={(e) => void subir(Array.from(e.target.files ?? []))} />
      </div>
      {progress && (
        <div className="space-y-2 rounded-md border p-4">
          <div className="flex justify-between text-sm"><span>{progress.done} de {progress.total}</span><span>{Math.floor(seg / 60)}:{String(seg % 60).padStart(2, "0")}</span></div>
          <Progress value={progress.total ? (progress.done / progress.total) * 100 : 0} />
          <p className="text-xs text-muted-foreground">{progress.ok} en borradores · {progress.errors} con error</p>
          {progress.messages.map((m, i) => <p key={i} className="text-xs text-destructive">{m}</p>)}
        </div>
      )}
      {rowErrors.length > 0 && (
        <div className="rounded-md border border-destructive/40 p-4">
          <p className="mb-2 text-sm font-medium">Errores de formato en el Excel (estas filas no se cargaron):</p>
          {rowErrors.map((e) => <p key={e.row} className="text-xs">Fila {e.row}: {e.message}</p>)}
        </div>
      )}
      <HistorialCargas companyId={companyId} />
    </div>
  );
}

function HistorialCargas({ companyId }: { companyId: string }) {
  const { data = [] } = useQuery({
    queryKey: ["ds-uploads", companyId],
    queryFn: async () => (await supabase.from("bulk_uploads").select("id, file_name, files_found, processed_count, error_count, created_at, status").eq("company_id", companyId).eq("doc_kind", "soporte").order("created_at", { ascending: false }).limit(30)).data ?? [],
    refetchInterval: 5000,
  });
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold">Historial de cargas</h2>
      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground"><tr><th className="p-2">Archivo</th><th className="p-2">Fecha</th><th className="p-2 text-right">Leídos</th><th className="p-2 text-right">Creados</th><th className="p-2 text-right">Con error</th></tr></thead>
        <tbody>
          {data.length === 0 && <tr><td colSpan={5} className="p-3 text-center text-muted-foreground">Sin cargas.</td></tr>}
          {data.map((u) => <tr key={u.id} className="border-t"><td className="p-2">{u.file_name}</td><td className="p-2">{fechaHora(u.created_at)}</td><td className="p-2 text-right">{u.files_found}</td><td className="p-2 text-right">{u.processed_count}</td><td className="p-2 text-right">{u.error_count}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ Tabla común
function CuentaCelda({ d }: { d: Ds }) {
  const codes = [...new Set(d.invoice_lines.map((l) => l.account_code).filter(Boolean))] as string[];
  if (!codes.length || codes.some((c) => !isValidExpenseAccount(c))) return <span className="text-xs text-destructive">Pendiente de cuenta</span>;
  const dec = Object.values(d.raw_extraction?.account_decisions ?? {});
  return (
    <div className="space-y-1">
      {codes.map((c) => {
        const o = dec.filter((x) => x.code === c).map((x) => (x.origin === "HISTORIAL" || x.origin === "APRENDIZAJE") && x.reason ? x.reason : ORIGIN[x.origin ?? ""] ?? x.origin);
        return <div key={c}><span className="font-mono text-xs">{c}</span><div className="text-[10px] text-muted-foreground">{[...new Set(o)].join(" · ") || "Sin origen registrado"}</div></div>;
      })}
    </div>
  );
}

// El número de la cuenta de cobro lo asigna Siigo (consecutivo DSEB) al crear el documento.

function Alertas({ d }: { d: Ds }) {
  const a: string[] = [];
  const faltan = missingIdentity({ idNumber: d.provider_nit, idType: d.vendor_id_type, name: d.provider_name });
  if (faltan.length) a.push(`Incompleto: falta ${faltan.join(", ")}`);
  if (d.vendor_is_natural && d.vendor_declarant == null) a.push("Definir si es declarante");
  if (Number(d.iva) > 0 && !d.iva_confirmed) a.push("Revisar: documento soporte con IVA");
  if ((d.vendor_filled ?? []).length) a.push("Dato tomado de la empresa: " + (d.vendor_filled ?? []).map((f) => FILLED_LABEL[f]).join(", "));
  if (!a.length) return null;
  return <div className="space-y-0.5">{a.map((x) => <div key={x} className="flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-400"><AlertTriangle className="mt-0.5 size-3 shrink-0" />{x}</div>)}</div>;
}

function Detalle({ d, onClose }: { d: Ds | null; onClose: () => void }) {
  const t = (d?.siigo_trace ?? {}) as Record<string, unknown>;
  return (
    <Dialog open={!!d} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-auto">
        <DialogHeader><DialogTitle>Detalle {d ? label(d) : ""}</DialogTitle></DialogHeader>
        {d?.siigo_error && <p className="whitespace-pre-wrap text-sm text-destructive">{d.siigo_error}</p>}
        {d && (
          <div className="space-y-1 text-sm">
            <p>Fecha de la operación: <b>{fecha(d.issue_date)}</b>{d.ds_sent_date ? <> · Enviada a Siigo: <b>{fecha(d.ds_sent_date)}</b></> : null}</p>
            {Array.isArray(t["fechas_intentadas"]) && (t["fechas_intentadas"] as Array<{ fecha?: string }>).length > 0 && (
              <p className="text-xs text-muted-foreground">Fechas intentadas: {(t["fechas_intentadas"] as Array<{ fecha?: string }>).map((x) => fecha(x.fecha ?? null)).join(", ")}</p>
            )}
          </div>
        )}
        <p className="text-xs font-semibold">JSON enviado a Siigo</p>
        <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-[11px]">{JSON.stringify(t["siigo_request"] ?? null, null, 2)}</pre>
        <p className="text-xs font-semibold">Respuesta de Siigo</p>
        <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-[11px]">{JSON.stringify(t["siigo_verificacion"] ?? t["siigo_respuesta"] ?? t["error"] ?? null, null, 2)}</pre>
      </DialogContent>
    </Dialog>
  );
}

function exportarComprobante(d: Ds) {
  void (async () => {
    const { data } = await supabase.from("journal_lines").select("*").eq("invoice_id", d.id).order("position");
    try { exportXlsx(d as never, (data ?? []) as unknown as JournalLine[]); } catch (e) { toast.error(e instanceof Error ? e.message : "No se pudo exportar."); }
  })();
}

// ------------------------------------------------------------------ Borradores
function Borradores({ companyId, docs, onDone }: { companyId: string; docs: Ds[]; onDone: () => void }) {
  const sync = useServerFn(siigoSyncSupportDocument);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirmar, setConfirmar] = useState<Ds[] | null>(null);
  const [iva, setIva] = useState<Ds | null>(null);
  const [detalle, setDetalle] = useState<Ds | null>(null);
  const [busy, setBusy] = useState(false);
  const [envio, setEnvio] = useState<{ done: number; total: number } | null>(null);
  const elegidos = docs.filter((d) => sel.has(d.id));
  const aprobables = elegidos.filter((d) => d.status === "borrador" || d.status === "incompleto");
  const creables = elegidos.filter((d) => d.status === "aprobado" && !d.siigo_id && d.siigo_status !== "sincronizando" && d.siigo_status !== "error");

  const aprobar = async () => {
    setBusy(true);
    let ok = 0; const fallos: string[] = [];
    const { data: u } = await supabase.auth.getUser();
    for (const d of aprobables) {
      const faltan = missingIdentity({ idNumber: d.provider_nit, idType: d.vendor_id_type, name: d.provider_name });
      if (faltan.length) { fallos.push(`${label(d)}: falta ${faltan.join(", ")}`); continue; }
      if (d.invoice_lines.some((l) => !isValidExpenseAccount(l.account_code))) { fallos.push(`${label(d)}: Pendiente de cuenta`); continue; }
      if (Number(d.iva) > 0 && !d.iva_confirmed) { fallos.push(`${label(d)}: confirme el IVA`); continue; }
      const { error } = await supabase.from("invoices").update({ status: "aprobado", approved_at: new Date().toISOString(), approved_by: u.user?.id ?? null }).eq("id", d.id);
      if (error) { fallos.push(`${label(d)}: ${error.message}`); continue; }
      // La cuenta aprobada que no venía de una regla queda como regla del vendedor.
      const dec = Object.values(d.raw_extraction?.account_decisions ?? {});
      const cuenta = d.invoice_lines.find((l) => isValidExpenseAccount(l.account_code));
      if (cuenta?.account_code && d.provider_nit && !dec.some((x) => x.code === cuenta.account_code && x.origin === "REGLA"))
        await aprenderReglaProveedor({ companyId, userId: u.user?.id ?? null, providerNit: d.provider_nit, providerName: d.provider_name, keyword: "(todas)", expenseAccount: cuenta.account_code, expenseAccountName: cuenta.account_name });
      ok += 1;
    }
    setBusy(false); setSel(new Set()); onDone();
    if (ok) toast.success(`${ok} documento(s) aprobado(s).`);
    if (fallos.length) toast.error(fallos.join("\n"));
  };

  const [propuestas, setPropuestas] = useState<Array<{ d: Ds; fecha: string }> | null>(null);
  const [reintento, setReintento] = useState<{ d: Ds; fecha: string } | null>(null);

  const crear = async (lista: Ds[], confirmadas?: Map<string, string>) => {
    setConfirmar(null); setBusy(true); setEnvio({ done: 0, total: lista.length });
    const res: string[] = []; let ok = 0; let i = 0;
    let next = 0; let detener = false;
    const pendientesFecha: Array<{ d: Ds; fecha: string }> = [];
    await Promise.all(Array.from({ length: Math.min(3, lista.length) }, async () => {
      while (next < lista.length && !detener) {
        const d = lista[next++]!;
        try {
          const cf = confirmadas?.get(d.id);
          const r = await sync({ data: cf ? { invoiceId: d.id, confirmDate: cf } : { invoiceId: d.id } });
          if (r.ok) ok += 1;
          else if (r.status === "confirmar_fecha" && r.proposedDate) pendientesFecha.push({ d, fecha: r.proposedDate });
          else {
            res.push(r.message);
            // Si Siigo rechazó la fecha, se detiene el lote y se pregunta antes de seguir.
            if ((r as { status?: string }).status === "error" && /no acepta la fecha/i.test(r.message)) detener = true;
          }
        } catch (e) { res.push(`${label(d)}: ${e instanceof Error ? e.message : String(e)}`); }
        setEnvio({ done: ++i, total: lista.length });
      }
    }));
    setBusy(false); setEnvio(null); setSel(new Set()); onDone();
    if (pendientesFecha.length) { setPropuestas(pendientesFecha); return; }
    if (ok) toast.success(`${ok} documento(s) soporte creado(s) en Siigo.`);
    if (res.length) toast.error(res.join("\n"), { duration: 15000 });
  };

  const confirmarFechas = async () => {
    const lista = propuestas ?? [];
    setPropuestas(null);
    await crear(lista.map((p) => p.d), new Map(lista.map((p) => [p.d.id, p.fecha])));
  };

  const declarante = async (d: Ds, v: string) => { await supabase.from("invoices").update({ vendor_declarant: v === "" ? null : v === "si" }).eq("id", d.id); onDone(); };
  const confirmarIva = async () => { if (!iva) return; await supabase.from("invoices").update({ iva_confirmed: true }).eq("id", iva.id); setIva(null); onDone(); };

  return (
    <div className="space-y-3 pt-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setSel(new Set(docs.map((d) => d.id)))}>Seleccionar todos</Button>
        <Button variant="outline" size="sm" onClick={() => setSel(new Set())}>Deseleccionar</Button>
        <Button size="sm" disabled={busy || !aprobables.length} onClick={() => void aprobar()}><CheckCircle2 className="mr-1 size-4" /> Aprobar ({aprobables.length})</Button>
        <Button size="sm" disabled={busy || !creables.length} onClick={() => setConfirmar(creables)}><Send className="mr-1 size-4" /> Crear en Siigo ({creables.length})</Button>
        {envio && <span className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> {envio.done} de {envio.total}</span>}
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs">
            <tr><th className="p-2" /><th className="p-2">Documento</th><th className="p-2">Vendedor</th><th className="p-2">Fecha</th><th className="p-2 text-right">Total</th><th className="p-2 text-right">Retención</th><th className="p-2 text-right">CxP</th><th className="p-2">Cuenta</th><th className="p-2">Estado</th><th className="p-2" /></tr>
          </thead>
          <tbody>
            {docs.length === 0 && <tr><td colSpan={10} className="p-6 text-center text-muted-foreground">No hay documentos soporte en borradores.</td></tr>}
            {docs.map((d) => {
              const ret = Number(d.retefuente) + Number(d.reteiva) + Number(d.reteica);
              const est = estado(d);
              return (
                <tr key={d.id} className="border-t align-top">
                  <td className="p-2"><Checkbox checked={sel.has(d.id)} onCheckedChange={(c) => setSel((s) => { const n = new Set(s); if (c) n.add(d.id); else n.delete(d.id); return n; })} /></td>
                  <td className="p-2 font-mono text-xs">
                    {String(d.number ?? "").trim() ? label(d) : <NumeroEditor d={d} onDone={onDone} />}
                  </td>
                  <td className="p-2">
                    <div>{d.provider_name ?? <span className="text-destructive">Sin nombre</span>}</div>
                    <div className="text-xs text-muted-foreground">{d.vendor_id_type ? VENDOR_ID_LABEL[d.vendor_id_type as VendorIdType] : "Sin tipo"} {d.provider_nit}</div>
                    {d.vendor_is_natural && (
                      <select className="mt-1 rounded border bg-background px-1 text-[11px]" value={d.vendor_declarant == null ? "" : d.vendor_declarant ? "si" : "no"} onChange={(e) => void declarante(d, e.target.value)}>
                        <option value="">¿Declarante?</option><option value="si">Declarante: sí</option><option value="no">Declarante: no</option>
                      </select>
                    )}
                    <Alertas d={d} />
                    {Number(d.iva) > 0 && !d.iva_confirmed && <Button size="sm" variant="link" className="h-auto p-0 text-[11px]" onClick={() => setIva(d)}>Confirmar IVA</Button>}
                  </td>
                  <td className="p-2 text-xs">{fecha(d.issue_date)}</td>
                  <td className="p-2 text-right">{cop(d.total)}</td>
                  <td className="p-2 text-right">{cop(ret)}</td>
                  <td className="p-2 text-right">{cop(Number(d.total) - ret)}</td>
                  <td className="p-2"><CuentaCelda d={d} /></td>
                  <td className="p-2 text-xs">
                    {d.siigo_error ? (
                      <TooltipProvider><Tooltip><TooltipTrigger className="text-left text-destructive">{est}</TooltipTrigger><TooltipContent className="max-w-md whitespace-pre-wrap">{d.siigo_error}</TooltipContent></Tooltip></TooltipProvider>
                    ) : est}
                    {d.siigo_number && <div className="font-mono">{d.siigo_number}</div>}
                  </td>
                  <td className="p-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      {!d.siigo_id && (d.status === "borrador" || d.status === "incompleto") && (
                        <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs"><Link to="/causar" search={{ id: d.id } as never}><Pencil className="size-3.5" /> Editar</Link></Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setDetalle(d)}><Eye className="size-3.5" /> Ver detalle</Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => exportarComprobante(d)}><Download className="size-3.5" /> Comprobante</Button>
                      {d.siigo_error_kind === "fecha_invalida" && !d.siigo_id && d.issue_date && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => {
                          const [y, m] = d.issue_date!.split("-").map(Number);
                          const ultimo = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
                          setReintento({ d, fecha: ultimo });
                        }}>Reintentar con el último día del mes</Button>
                      )}
                      <SiigoErrorActions invoice={d} onDone={onDone} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Dialog open={!!confirmar} onOpenChange={(o) => !o && setConfirmar(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Crear en Siigo</DialogTitle></DialogHeader>
          <p className="text-sm">Se crearán {confirmar?.length ?? 0} documentos soporte en Siigo y Siigo los transmitirá a la DIAN. ¿Confirmar?</p>
          <DialogFooter><Button variant="outline" onClick={() => setConfirmar(null)}>Cancelar</Button><Button onClick={() => confirmar && void crear(confirmar)}>Confirmar</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!iva} onOpenChange={(o) => !o && setIva(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Documento soporte con IVA</DialogTitle></DialogHeader>
          <p className="text-sm">{iva ? `${label(iva)} trae IVA por ${cop(iva.iva)}. Los documentos soporte normalmente no llevan IVA. ¿Confirma que es correcto?` : ""}</p>
          <DialogFooter><Button variant="outline" onClick={() => setIva(null)}>Cancelar</Button><Button onClick={() => void confirmarIva()}>Sí, es correcto</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!propuestas} onOpenChange={(o) => !o && setPropuestas(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Confirmar fechas de envío</DialogTitle></DialogHeader>
          <p className="text-sm">Estas fechas de operación están fuera de la ventana que permite Siigo. Se enviarán con la fecha propuesta:</p>
          <div className="max-h-48 space-y-1 overflow-auto text-sm">
            {(propuestas ?? []).map((p) => <p key={p.d.id}>{label(p.d)}: operación {fecha(p.d.issue_date)} → se enviará con {fecha(p.fecha)}</p>)}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setPropuestas(null)}>Cancelar</Button><Button onClick={() => void confirmarFechas()}>Confirmar y crear</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!reintento} onOpenChange={(o) => !o && setReintento(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reintentar con el último día del mes</DialogTitle></DialogHeader>
          <p className="text-sm">{reintento ? `${label(reintento.d)}: Siigo no aceptó la fecha enviada. Se reintentará con ${fecha(reintento.fecha)} (último día del mes del documento). ¿Confirmar?` : ""}</p>
          <DialogFooter><Button variant="outline" onClick={() => setReintento(null)}>Cancelar</Button><Button onClick={() => { const r = reintento; setReintento(null); if (r) void crear([r.d], new Map([[r.d.id, r.fecha]])); }}>Confirmar</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Detalle d={detalle} onClose={() => setDetalle(null)} />
    </div>
  );
}

// ------------------------------------------------------------------ Historial
function Historial({ docs, onDone }: { companyId: string; docs: Ds[]; onDone: () => void }) {
  const [detalle, setDetalle] = useState<Ds | null>(null);
  const [soloPendientes, setSoloPendientes] = useState(false);
  const hoy = new Date().toISOString().slice(0, 10);
  const pendienteDian = (d: Ds) => dianLabel(d.ds_dian_status) === "Guardado – pendiente envío DIAN";
  const lista = soloPendientes ? docs.filter(pendienteDian) : docs;
  return (
    <div className="space-y-3 pt-4">
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={soloPendientes} onCheckedChange={(c) => setSoloPendientes(!!c)} /> Pendientes de envío DIAN</label>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs"><tr><th className="p-2">Documento</th><th className="p-2">Vendedor</th><th className="p-2">Fecha</th><th className="p-2 text-right">Total</th><th className="p-2">Siigo</th><th className="p-2">Transmisión DIAN</th><th className="p-2" /></tr></thead>
          <tbody>
            {lista.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Aún no hay documentos soporte creados en Siigo.</td></tr>}
            {lista.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="p-2 font-mono text-xs">{label(d)}</td>
                <td className="p-2">{d.provider_name}<div className="text-xs text-muted-foreground">{d.provider_nit}</div></td>
                <td className="p-2 text-xs">Operación {fecha(d.issue_date)}{d.ds_sent_date && d.ds_sent_date !== d.issue_date ? <div>Enviado {fecha(d.ds_sent_date)}</div> : null}</td>
                <td className="p-2 text-right">{cop(d.total)}</td>
                <td className="p-2 font-mono text-xs">{d.siigo_number}</td>
                <td className="p-2 text-xs">
                  {dianLabel(d.ds_dian_status)}
                  {pendienteDian(d) && (() => { const n = diasParaDian(d.ds_sent_date, hoy); return n == null ? null : (
                    <div className={6 - n <= 2 ? "font-semibold text-destructive" : "text-muted-foreground"}>Días para enviar a la DIAN: {n} de 6</div>
                  ); })()}
                </td>
                <td className="p-2"><div className="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setDetalle(d)}><Eye className="size-3.5" /> Ver detalle</Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => exportarComprobante(d)}><Download className="size-3.5" /> Comprobante</Button>
                  <SiigoErrorActions invoice={d} onDone={onDone} />
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Detalle d={detalle} onClose={() => setDetalle(null)} />
    </div>
  );
}

// ------------------------------------------------------------------ Terceros por actualizar
function Terceros({ docs }: { docs: Ds[] }) {
  const map = new Map<string, Ds>();
  for (const d of docs) if ((d.vendor_filled ?? []).length && d.provider_nit && !map.has(d.provider_nit)) map.set(d.provider_nit, d);
  const rows = [...map.values()];
  const exportar = () => {
    const ws = XLSX.utils.json_to_sheet(rows.map((d) => ({ NIT: d.provider_nit ?? "", Nombre: d.provider_name ?? "", Documento: label(d), "Datos tomados de la empresa": (d.vendor_filled ?? []).map((f) => FILLED_LABEL[f]).join(", "), Dirección: d.provider_address ?? "", Ciudad: d.provider_city ?? "", Teléfono: d.provider_phone ?? "", Correo: d.provider_email ?? "" })));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Terceros por actualizar"); XLSX.writeFile(wb, "terceros_por_actualizar.xlsx");
  };
  return (
    <div className="space-y-3 pt-4">
      <div className="flex items-center justify-between"><p className="text-sm text-muted-foreground">Vendedores creados con datos de contacto de la empresa. Actualícelos en Siigo con sus datos reales.</p>
        <Button size="sm" variant="outline" disabled={!rows.length} onClick={exportar}><Download className="mr-1 size-4" /> Exportar a Excel</Button></div>
      <table className="w-full rounded-md border text-sm">
        <thead className="bg-muted/50 text-left text-xs"><tr><th className="p-2">NIT/CC</th><th className="p-2">Nombre</th><th className="p-2">Dato tomado de la empresa</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={3} className="p-6 text-center text-muted-foreground">Sin terceros por actualizar.</td></tr>}
          {rows.map((d) => <tr key={d.provider_nit} className="border-t"><td className="p-2 font-mono">{d.provider_nit}</td><td className="p-2">{d.provider_name}</td><td className="p-2">{(d.vendor_filled ?? []).map((f) => FILLED_LABEL[f]).join(", ")}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ Configuración
function Configuracion({ companyId }: { companyId: string }) {
  const listTypes = useServerFn(siigoListDsTypes);
  type F = { address?: string; city?: string; department?: string; country?: string; phone?: string; email?: string; ds_document_id?: string; ds_document_code?: string; ds_window_days?: string; ds_date_ref?: string; ds_payable_account?: string };
  const [f, setF] = useState<F>({});
  const [types, setTypes] = useState<Array<{ id: number; code: string; name: string }>>([]);
  const [loadingTypes, setLoadingTypes] = useState(false);
  useEffect(() => {
    void supabase.from("company_parameters").select("*").eq("company_id", companyId).maybeSingle().then(({ data }) => {
      setF({ address: data?.address ?? "", city: data?.city ?? "", department: data?.department ?? "", country: data?.country ?? "", phone: data?.phone ?? "", email: data?.email ?? "", ds_document_id: data?.ds_document_id ? String(data.ds_document_id) : "", ds_document_code: data?.ds_document_code ?? "", ds_window_days: String(data?.ds_window_days ?? 10), ds_date_ref: data?.ds_date_ref ?? "fin_mes", ds_payable_account: data?.ds_payable_account ?? "23359501" });
    });
  }, [companyId]);
  const sincronizar = async () => {
    setLoadingTypes(true);
    try { setTypes(await listTypes({ data: { companyId } })); } catch (e) { toast.error(e instanceof Error ? e.message : "No se pudo consultar Siigo."); } finally { setLoadingTypes(false); }
  };
  const guardar = async () => {
    const { error } = await supabase.from("company_parameters").upsert({ company_id: companyId, address: f.address || null, city: f.city || null, department: f.department || null, country: f.country || null, phone: f.phone || null, email: f.email || null, ds_document_id: f.ds_document_id ? Number(f.ds_document_id) : null, ds_document_code: f.ds_document_code || null, ds_window_days: Math.max(1, Number(f.ds_window_days) || 10), ds_date_ref: f.ds_date_ref === "hoy" ? "hoy" : "fin_mes", ds_payable_account: f.ds_payable_account || "23359501", updated_at: new Date().toISOString() });
    if (error) toast.error(error.message); else toast.success("Parámetros guardados.");
  };
  const campo = (k: keyof F, l: string) => <label className="space-y-1 text-sm"><span className="text-muted-foreground">{l}</span><Input value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>;
  return (
    <div className="max-w-2xl space-y-6 pt-4">
      <section className="space-y-3">
        <h2 className="font-semibold">Parámetros de la empresa</h2>
        <p className="text-xs text-muted-foreground">Se usan solo para completar datos de contacto faltantes del vendedor. Nunca reemplazan identificación, tipo de documento ni nombre.</p>
        <div className="grid grid-cols-2 gap-3">{campo("address", "Dirección")}{campo("city", "Ciudad")}{campo("department", "Departamento")}{campo("country", "País")}{campo("phone", "Teléfono")}{campo("email", "Correo")}</div>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Tipo de comprobante documento soporte</h2>
        <div className="flex items-end gap-2">
          <select className="h-9 flex-1 rounded-md border bg-background px-2 text-sm" value={f.ds_document_id ?? ""} onChange={(e) => { const t = types.find((x) => String(x.id) === e.target.value); setF({ ...f, ds_document_id: e.target.value, ds_document_code: t ? `DS-${t.code} ${t.name}` : f.ds_document_code ?? "" }); }}>
            <option value="">{f.ds_document_code || "Seleccione…"}</option>
            {types.map((t) => <option key={t.id} value={t.id}>DS-{t.code} · {t.name}</option>)}
          </select>
          <Button variant="outline" onClick={() => void sincronizar()} disabled={loadingTypes}>{loadingTypes && <Loader2 className="mr-1 size-4 animate-spin" />} Sincronizar desde Siigo</Button>
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Ventana de fechas de Siigo</h2>
        <p className="text-xs text-muted-foreground">Siigo acepta documentos soporte de un mes con fecha desde (fecha de referencia − N días) hasta la referencia. Si la fecha de la operación está fuera, se propone la fecha mínima y se pide confirmación antes de enviar.</p>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-sm"><span className="text-muted-foreground">Días permitidos antes del cierre del mes</span><Input type="number" min={1} value={f.ds_window_days ?? "10"} onChange={(e) => setF({ ...f, ds_window_days: e.target.value })} /></label>
          <label className="space-y-1 text-sm"><span className="text-muted-foreground">Fecha de referencia</span>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={f.ds_date_ref ?? "fin_mes"} onChange={(e) => setF({ ...f, ds_date_ref: e.target.value })}>
              <option value="fin_mes">Último día del mes del documento</option>
              <option value="hoy">Fecha de hoy</option>
            </select>
          </label>
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Cuenta por pagar de documentos soporte</h2>
        <p className="text-xs text-muted-foreground">Se usa cuando el vendedor no tiene historial de cuenta por pagar. Si el vendedor ya tiene historial, se usa el de él.</p>
        <div className="max-w-xs">{campo("ds_payable_account", "Cuenta CxP por defecto documento soporte")}</div>
      </section>
      <Resoluciones companyId={companyId} />
      <Button onClick={() => void guardar()}>Guardar</Button>
    </div>
  );
}

// ------------------------------------------------------------------ Resoluciones de numeración
type Resolucion = { id: string; prefix: string; from_number: number; to_number: number; approval_date: string; validity_months: number; active: boolean };

function Resoluciones({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { data: rows = [] } = useQuery({
    queryKey: ["ds-res", companyId],
    queryFn: async () => (await supabase.from("ds_resolutions").select("*").eq("company_id", companyId).order("created_at", { ascending: false })).data ?? [],
  });
  const [n, setN] = useState({ prefix: "", from: "", to: "", date: "", months: "12" });
  const hoy = new Date().toISOString().slice(0, 10);
  const agregar = async () => {
    if (!n.prefix.trim() || !n.from || !n.to || !n.date) { toast.error("Complete prefijo, rango y fecha de aprobación."); return; }
    const { error } = await supabase.from("ds_resolutions").insert({ company_id: companyId, prefix: n.prefix.trim().toUpperCase(), from_number: Number(n.from), to_number: Number(n.to), approval_date: n.date, validity_months: Number(n.months) || 12 });
    if (error) toast.error(error.message);
    else { toast.success("Resolución registrada."); setN({ prefix: "", from: "", to: "", date: "", months: "12" }); void qc.invalidateQueries({ queryKey: ["ds-res", companyId] }); }
  };
  const desactivar = async (id: string) => { await supabase.from("ds_resolutions").update({ active: false }).eq("id", id); void qc.invalidateQueries({ queryKey: ["ds-res", companyId] }); };
  return (
    <section className="space-y-3">
      <h2 className="font-semibold">Resolución de numeración</h2>
      {rows.map((r) => {
        const vence = resolutionExpiry(r.approval_date, r.validity_months);
        const dias = Math.round((Date.parse(`${vence}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86400000);
        return (
          <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
            <span className="font-mono font-semibold">{r.prefix}</span>
            <span>Rango {r.from_number} a {r.to_number}</span>
            <span>Aprobada {fecha(r.approval_date)} · vigencia {r.validity_months} meses</span>
            {r.active && dias <= 30 && <span className={dias < 0 ? "font-semibold text-destructive" : "font-semibold text-amber-600"}>La resolución {r.prefix} {dias < 0 ? "venció" : "vence"} el {fecha(vence)}</span>}
            {!r.active && <span className="text-muted-foreground">(inactiva)</span>}
            {r.active && rows.some((x) => x.id !== r.id && x.active) && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void desactivar(r.id)}>Desactivar</Button>}
          </div>
        );
      })}
      <div className="grid max-w-2xl grid-cols-2 gap-3 md:grid-cols-5">
        <Input placeholder="Prefijo (DSEB)" value={n.prefix} onChange={(e) => setN({ ...n, prefix: e.target.value })} />
        <Input placeholder="Desde (739)" type="number" value={n.from} onChange={(e) => setN({ ...n, from: e.target.value })} />
        <Input placeholder="Hasta (10000)" type="number" value={n.to} onChange={(e) => setN({ ...n, to: e.target.value })} />
        <Input type="date" value={n.date} onChange={(e) => setN({ ...n, date: e.target.value })} />
        <Input placeholder="Vigencia meses" type="number" value={n.months} onChange={(e) => setN({ ...n, months: e.target.value })} />
      </div>
      <Button variant="outline" size="sm" onClick={() => void agregar()}>Registrar nueva resolución</Button>
      <p className="text-xs text-muted-foreground">Registrar una nueva resolución no borra la anterior. Se bloquea el envío si la fecha del documento es posterior al vencimiento o si el consecutivo supera el rango.</p>
    </section>
  );
}
