import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, History, Loader2, Pencil, RotateCcw, Send, Stamp, Undo2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany, useCompanies } from "@/components/app-shell";
import { fetchCompanyPuc } from "@/lib/puc-data";
import { cop, fecha } from "@/lib/format";
import { ESTADO_LABEL, estadoUnico, type EstadoFactura } from "@/lib/invoice-duplicates";
import { siigoSyncInvoice } from "@/lib/siigo.functions";
import { IVA_TREATMENT_LABEL, treatmentForAccount } from "@/lib/iva-treatment";
import { PAYABLE_SOURCE_LABEL, type PayableSource } from "@/lib/payable-account";
import {
  alertasBorrador,
  accionDisponible,
  aprobarBorrador,
  causarFactura,
  classifyJournal,
  devolverABorrador,
  revertirCausacion,
  ETAPA_LABEL,
  type EtapaMasiva,
  type DraftAccounts,
  type DraftInvoice,
  type JournalRow,
  type ResultadoFactura,
} from "@/lib/draft-review";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/borradores")({
  head: () => ({
    meta: [
      { title: "Borradores: revisión y aprobación masiva" },
      { name: "description", content: "Revisa las cuentas sugeridas de todas las facturas en borrador, apruébalas y cáusalas en lote sin abrir una por una." },
      { property: "og:title", content: "Borradores: revisión y aprobación masiva" },
      { property: "og:description", content: "Aprobación y causación masiva con un comprobante independiente por factura." },
    ],
  }),
  component: Borradores,
});

const COLS =
  "id, company_id, prefix, number, issue_date, provider_nit, provider_name, cufe, cost_center, subtotal, iva, retefuente, reteiva, reteica, total, status, siigo_status, siigo_id, siigo_number, siigo_error, voucher_number, posted_at, approved_at, processing_at, posting_error, file_path, file_name, payable_account, payable_source, payable_manual";

/** Origen visible de la cuenta por pagar del borrador. */
const origenPayable = (i: DraftInvoice) => {
  if (i.payable_manual) return PAYABLE_SOURCE_LABEL.manual;
  const s = (i.payable_source ?? "") as PayableSource;
  return PAYABLE_SOURCE_LABEL[s] ?? "—";
};

const etiquetaFactura = (i: DraftInvoice) => [i.prefix, i.number].filter(Boolean).join("-") || "Sin número";

const ESTADO_CLASS: Record<string, string> = {
  borrador: "bg-muted text-muted-foreground",
  aprobado: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  causada: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  sincronizando: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  sincronizada: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  error_siigo: "bg-destructive/10 text-destructive",
  error: "bg-destructive/10 text-destructive",
};

const ETAPAS: EstadoFactura[] = ["borrador", "aprobado", "causada", "sincronizando", "error_siigo", "sincronizada", "error"];

type EventoFactura = {
  id: string;
  action: string;
  message: string | null;
  status: string;
  siigo_status: string | null;
  created_at: string;
};

function Borradores() {
  const companyId = useActiveCompany();
  const queryClient = useQueryClient();
  const { data: companies, isLoading: loadingCompanies } = useCompanies();
  const sync = useServerFn(siigoSyncInvoice);

  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  const [proveedor, setProveedor] = useState("");
  const [cuenta, setCuenta] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [estado, setEstado] = useState<EstadoFactura | "todas">("borrador");
  const [busy, setBusy] = useState<null | string>(null);
  const [avance, setAvance] = useState<{ hechas: number; total: number } | null>(null);
  const [traza, setTraza] = useState<DraftInvoice | null>(null);
  const [resultados, setResultados] = useState<ResultadoFactura[] | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["borradores", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const inv = await supabase
        .from("invoices")
        .select(COLS)
        .eq("company_id", companyId!)
        .order("issue_date", { ascending: false });
      if (inv.error) throw inv.error;
      const invoices = (inv.data ?? []) as unknown as DraftInvoice[];
      const ids = invoices.map((i) => i.id);
      const journal: JournalRow[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const { data: rows, error } = await supabase
          .from("journal_lines")
          .select("invoice_id, account_code, account_name, debit, credit, cost_center")
          .in("invoice_id", ids.slice(i, i + 200));
        if (error) throw error;
        journal.push(...((rows ?? []) as unknown as JournalRow[]));
      }
      const porFactura = new Map<string, JournalRow[]>();
      for (const r of journal) {
        const list = porFactura.get(r.invoice_id) ?? [];
        list.push(r);
        porFactura.set(r.invoice_id, list);
      }
      const accounts = new Map<string, DraftAccounts>();
      for (const [id, rows] of porFactura) accounts.set(id, classifyJournal(rows));
      const puc = await fetchCompanyPuc(companyId!);
      return {
        invoices,
        accounts,
        pucCodes: new Set(puc.map((p) => p.code)),
        pucNames: new Map(puc.map((p) => [p.code, p.name])),
      };
    },
  });

  const invoices = data?.invoices ?? [];
  const accounts = data?.accounts ?? new Map<string, DraftAccounts>();
  const pucCodes = data?.pucCodes ?? new Set<string>();
  const pucNames = data?.pucNames ?? new Map<string, string>();

  const proveedores = useMemo(
    () => [...new Set(invoices.map((i) => i.provider_name).filter((x): x is string => !!x))].sort(),
    [invoices],
  );

  const rows = useMemo(
    () =>
      invoices.filter((r) => {
        const e = estadoUnico(r);
        if (estado !== "todas" && e !== estado) return false;
        const texto = `${r.prefix ?? ""}${r.number ?? ""} ${r.provider_name ?? ""} ${r.provider_nit ?? ""}`.toLowerCase();
        if (q && !texto.includes(q.toLowerCase())) return false;
        if (proveedor && r.provider_name !== proveedor) return false;
        if (desde && (r.issue_date ?? "") < desde) return false;
        if (hasta && (r.issue_date ?? "") > hasta) return false;
        if (cuenta) {
          const a = accounts.get(r.id);
          const codes = [
            ...(a?.gastos ?? []).map((x) => x.code),
            ...(a?.ivas ?? []).map((x) => x.code),
            ...(a?.retenciones ?? []).map((x) => x.code),
            a?.payable?.code,
            r.payable_account,
          ]
            .filter(Boolean)
            .join(" ");
          if (!codes.includes(cuenta.trim())) return false;
        }
        return true;
      }),
    [invoices, accounts, estado, q, proveedor, desde, hasta, cuenta],
  );

  const seleccionadas = rows.filter((r) => sel[r.id]);
  const todasVisiblesMarcadas = rows.length > 0 && rows.every((r) => sel[r.id]);

  /** Conteo por etapa del flujo, sobre todas las facturas de la empresa. */
  const resumen = useMemo(() => {
    const base: Record<string, number> = {};
    for (const i of invoices) {
      const e = estadoUnico(i);
      base[e] = (base[e] ?? 0) + 1;
    }
    return base;
  }, [invoices]);

  /** Cuántas de las seleccionadas pueden realmente ejecutar cada etapa. */
  const elegibles = (etapa: EtapaMasiva) => seleccionadas.filter((r) => accionDisponible(estadoUnico(r), etapa));

  const { data: eventos, isLoading: cargandoTraza } = useQuery({
    queryKey: ["invoice-events", traza?.id],
    enabled: !!traza,
    queryFn: async () => {
      const { data: rowsEv, error } = await supabase
        .from("invoice_events")
        .select("id, action, message, status, siigo_status, created_at")
        .eq("invoice_id", traza!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (rowsEv ?? []) as unknown as EventoFactura[];
    },
  });

  function marcarTodas(valor: boolean) {
    setSel((prev) => {
      const next = { ...prev };
      for (const r of rows) if (valor) next[r.id] = true; else delete next[r.id];
      return next;
    });
  }

  async function ejecutar(tipo: EtapaMasiva) {
    // Protección contra doble clic: mientras haya un proceso activo no se inicia otro.
    if (busy || seleccionadas.length === 0) return;
    const objetivo = elegibles(tipo);
    const fueraDeEtapa = seleccionadas.filter((r) => !accionDisponible(estadoUnico(r), tipo));
    if (objetivo.length === 0) {
      toast.error(`Ninguna de las facturas seleccionadas está en la etapa requerida para "${ETAPA_LABEL[tipo]}".`);
      return;
    }
    setBusy(tipo);
    setAvance({ hechas: 0, total: objetivo.length });
    const userId = (await supabase.auth.getUser()).data.user?.id ?? null;
    const out: ResultadoFactura[] = fueraDeEtapa.map((inv) => ({
      id: inv.id,
      etiqueta: etiquetaFactura(inv),
      ok: false,
      message: `Omitida: está en estado ${ESTADO_LABEL[estadoUnico(inv)]} y esta acción requiere otra etapa del flujo.`,
    }));
    try {
      for (const inv of objetivo) {
        const etiqueta = etiquetaFactura(inv);
        try {
          if (tipo === "aprobar") out.push(await aprobarBorrador(inv, accounts.get(inv.id), pucCodes, etiqueta, userId));
          else if (tipo === "causar") out.push(await causarFactura(inv, etiqueta));
          else if (tipo === "devolver") out.push(await devolverABorrador(inv, etiqueta));
          else if (tipo === "revertir") out.push(await revertirCausacion(inv, etiqueta));
          else {
            if (inv.siigo_status === "sincronizada" || inv.siigo_id) {
              out.push({ id: inv.id, etiqueta, ok: true, message: `Esta factura ya fue causada en Siigo${inv.siigo_number ? ` · N° ${inv.siigo_number}` : ""}.` });
            } else if (!inv.voucher_number) {
              out.push({ id: inv.id, etiqueta, ok: false, message: "Debe causarse internamente antes de causar en Siigo." });
            } else {
              const res = await sync({ data: { invoiceId: inv.id } });
              out.push({ id: inv.id, etiqueta, ok: res.ok, message: res.ok ? `Siigo N° ${res.siigoNumber ?? res.siigoId ?? "creado"}.` : res.error ?? "Siigo rechazó el comprobante." });
            }
          }
        } catch (err) {
          out.push({ id: inv.id, etiqueta, ok: false, message: err instanceof Error ? err.message : "Error inesperado." });
        } finally {
          setAvance((p) => (p ? { ...p, hechas: p.hechas + 1 } : p));
        }
      }
    } finally {
      setBusy(null);
      setAvance(null);
      setResultados(out);
      setSel({});
      await queryClient.invalidateQueries({ queryKey: ["borradores", companyId] });
      await queryClient.invalidateQueries({ queryKey: ["invoices", companyId] });
    }
    const ok = out.filter((r) => r.ok).length;
    if (ok) toast.success(`${ok} factura(s) procesada(s) correctamente.`);
    if (out.length - ok) toast.error(`${out.length - ok} factura(s) requieren revisión.`);
  }

  if (!loadingCompanies && (companies ?? []).length === 0) return <EmptyCompany />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Borradores</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Revisa las cuentas sugeridas por el motor de causación, aprueba y causa en lote. Cada factura genera su propio comprobante.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => marcarTodas(true)} disabled={rows.length === 0}>Seleccionar todos</Button>
          <Button variant="outline" onClick={() => setSel({})} disabled={seleccionadas.length === 0}>Deseleccionar todos</Button>
          <Button onClick={() => void ejecutar("aprobar")} disabled={!!busy || elegibles("aprobar").length === 0}>
            {busy === "aprobar" ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Aprobar ({elegibles("aprobar").length})
          </Button>
          <Button variant="secondary" onClick={() => void ejecutar("causar")} disabled={!!busy || elegibles("causar").length === 0}>
            {busy === "causar" ? <Loader2 className="size-4 animate-spin" /> : <Stamp className="size-4" />} Causar ({elegibles("causar").length})
          </Button>
          <Button variant="outline" onClick={() => void ejecutar("siigo")} disabled={!!busy || elegibles("siigo").length === 0}>
            {busy === "siigo" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Causar en Siigo ({elegibles("siigo").length})
          </Button>
          <Button variant="ghost" onClick={() => void ejecutar("devolver")} disabled={!!busy || elegibles("devolver").length === 0}>
            {busy === "devolver" ? <Loader2 className="size-4 animate-spin" /> : <Undo2 className="size-4" />} Devolver a borrador ({elegibles("devolver").length})
          </Button>
          <Button variant="ghost" onClick={() => void ejecutar("revertir")} disabled={!!busy || elegibles("revertir").length === 0}>
            {busy === "revertir" ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} Revertir causación ({elegibles("revertir").length})
          </Button>
        </div>
      </div>

      {/* Flujo obligatorio y conteo por etapa */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3 text-xs">
        <span className="mr-1 font-medium text-muted-foreground">Flujo:</span>
        {ETAPAS.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => setEstado(e)}
            className={`rounded-full px-2.5 py-1 font-medium transition ${ESTADO_CLASS[e]} ${estado === e ? "ring-2 ring-primary/50" : "opacity-80 hover:opacity-100"}`}
          >
            {ESTADO_LABEL[e]} · {resumen[e] ?? 0}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setEstado("todas")}
          className={`rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground ${estado === "todas" ? "ring-2 ring-primary/50" : ""}`}
        >
          Todas · {invoices.length}
        </button>
      </div>

      {busy && avance && (
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">
              {busy === "siigo" ? "Causando en Siigo" : `${ETAPA_LABEL[busy as EtapaMasiva]} en proceso…`}
            </span>
            <span className="text-muted-foreground">{avance.hechas} de {avance.total}</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${avance.total ? (avance.hechas / avance.total) * 100 : 0}%` }} />
          </div>
        </div>
      )}

      <div className="grid gap-3 rounded-lg border border-border bg-card p-4 lg:grid-cols-6">
        <Input placeholder="Buscar factura, proveedor o NIT" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={proveedor} onChange={(e) => setProveedor(e.target.value)}>
          <option value="">Todos los proveedores</option>
          {proveedores.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <Input placeholder="Filtrar por cuenta" value={cuenta} onChange={(e) => setCuenta(e.target.value)} />
        <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={estado} onChange={(e) => setEstado(e.target.value as typeof estado)}>
          <option value="borrador">Borradores</option>
          <option value="aprobado">Aprobadas</option>
          <option value="causada">Causadas</option>
          <option value="sincronizando">Sincronizando</option>
          <option value="error_siigo">Error Siigo</option>
          <option value="error">Error de causación</option>
          <option value="sincronizada">Histórico</option>
          <option value="todas">Todas</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[1400px] text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">
                <Checkbox checked={todasVisiblesMarcadas} onCheckedChange={(v) => marcarTodas(!!v)} aria-label="Seleccionar todos" />
              </th>
              <th className="px-3 py-2 font-medium">Factura</th>
              <th className="px-3 py-2 font-medium">Proveedor</th>
              <th className="px-3 py-2 font-medium">NIT</th>
              <th className="px-3 py-2 font-medium">Fecha</th>
              <th className="px-3 py-2 text-right font-medium">Base</th>
              <th className="px-3 py-2 text-right font-medium">IVA</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
              <th className="px-3 py-2 font-medium">Cuenta gasto/costo</th>
              <th className="px-3 py-2 font-medium">Cuenta IVA</th>
              <th className="px-3 py-2 font-medium">Tratamiento IVA</th>
              <th className="px-3 py-2 font-medium">Cuenta CxP</th>
              <th className="px-3 py-2 font-medium">Origen cuenta por pagar</th>
              <th className="px-3 py-2 font-medium">Centro de costo</th>
              <th className="px-3 py-2 font-medium">Estado</th>
              <th className="px-3 py-2 font-medium">Advertencias</th>
              <th className="px-3 py-2 text-right font-medium">Editar</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => {
              const acc = accounts.get(r.id);
              const alertas = alertasBorrador(r, acc, pucCodes);
              const nivel = alertas.some((a) => a.level === "error") ? "error" : alertas.some((a) => a.level === "warn") ? "warn" : "ok";
              const fila = nivel === "error" ? "bg-destructive/5" : nivel === "warn" ? "bg-amber-500/5" : "";
              const e = estadoUnico(r);
              return (
                <tr key={r.id} className={`${fila} hover:bg-muted/30`}>
                  <td className="px-3 py-2">
                    <Checkbox
                      checked={!!sel[r.id]}
                      onCheckedChange={(v) => setSel((prev) => ({ ...prev, [r.id]: !!v }))}
                      aria-label={`Seleccionar ${etiquetaFactura(r)}`}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {etiquetaFactura(r)}
                    {r.voucher_number && <div className="text-[11px] text-muted-foreground">Comprobante {r.voucher_number}</div>}
                  </td>
                  <td className="max-w-[220px] truncate px-3 py-2" title={r.provider_name ?? ""}>{r.provider_name ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.provider_nit ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{fecha(r.issue_date)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{cop(r.subtotal)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{cop(r.iva)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{cop(r.total)}</td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs">{acc?.gasto?.code ?? "—"}</span>
                    <div className="max-w-[180px] truncate text-[11px] text-muted-foreground">{acc?.gasto?.name ?? ""}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs">{acc?.iva?.code ?? "—"}</span>
                    <div className="max-w-[180px] truncate text-[11px] text-muted-foreground">{acc?.iva?.name ?? ""}</div>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-muted-foreground">
                    {Number(r.iva || 0) > 0
                      ? acc?.iva?.code
                        ? IVA_TREATMENT_LABEL[treatmentForAccount(acc.iva.code)]
                        : "Sin cuenta de IVA"
                      : "Sin IVA"}
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs">{acc?.payable?.code ?? r.payable_account ?? "—"}</span>
                    <div className="max-w-[180px] truncate text-[11px] text-muted-foreground">{acc?.payable?.name ?? ""}</div>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-muted-foreground">{origenPayable(r)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{acc?.costCenter ?? r.cost_center ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${ESTADO_CLASS[e] ?? "bg-muted text-muted-foreground"}`}>
                      {ESTADO_LABEL[e] ?? e}
                    </span>
                    {e === "error_siigo" && r.siigo_error && (
                      <div className="mt-0.5 max-w-[200px] truncate text-[11px] text-destructive" title={r.siigo_error}>{r.siigo_error}</div>
                    )}
                    {r.siigo_number && <div className="mt-0.5 text-[11px] text-muted-foreground">Siigo N° {r.siigo_number}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        nivel === "error" ? "bg-destructive/10 text-destructive" : nivel === "warn" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : "bg-primary/10 text-primary"
                      }`}
                      title={alertas.map((a) => a.message).join(" · ")}
                    >
                      {alertas[0]?.message}
                    </span>
                    {alertas.length > 1 && <div className="text-[11px] text-muted-foreground">+{alertas.length - 1} más</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <Button asChild variant="ghost" size="icon" title="Editar con el lápiz">
                      <Link to={e === "borrador" || e === "error" ? "/causar" : "/revisar"} search={{ id: r.id }}>
                        <Pencil className="size-4" />
                      </Link>
                    </Button>
                    <Button variant="ghost" size="icon" title="Ver trazabilidad" onClick={() => setTraza(r)}>
                      <History className="size-4" />
                    </Button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={17} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {isLoading ? "Cargando facturas…" : "No hay facturas que coincidan con el filtro."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!traza} onOpenChange={(o) => !o && setTraza(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Trazabilidad · {traza ? etiquetaFactura(traza) : ""}</DialogTitle>
          </DialogHeader>
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {cargandoTraza && <p className="text-sm text-muted-foreground">Cargando historial…</p>}
            {!cargandoTraza && (eventos ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">Aún no hay eventos registrados para esta factura.</p>
            )}
            {(eventos ?? []).map((ev) => (
              <div key={ev.id} className="rounded-md border border-border px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{ev.action}</span>
                  <span className="text-muted-foreground">{new Date(ev.created_at).toLocaleString("es-CO")}</span>
                </div>
                <div className="mt-0.5 text-muted-foreground">
                  Estado: {ESTADO_LABEL[estadoUnico({ status: ev.status, siigo_status: ev.siigo_status })]}
                </div>
                {ev.message && <div className="mt-0.5 text-muted-foreground">{ev.message}</div>}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!resultados} onOpenChange={(o) => !o && setResultados(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Proceso terminado</DialogTitle>
          </DialogHeader>
          <p className="text-sm">
            {(resultados ?? []).filter((r) => r.ok).length} factura(s) procesadas correctamente ·{" "}
            {(resultados ?? []).filter((r) => !r.ok).length} con novedad.
          </p>
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {(resultados ?? []).map((r) => (
              <div key={r.id} className={`rounded-md border px-3 py-1.5 text-xs ${r.ok ? "border-border" : "border-destructive/40 bg-destructive/5"}`}>
                <span className="font-mono">{r.etiqueta}</span> · {r.message}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
