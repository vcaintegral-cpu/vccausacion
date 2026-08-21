import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, History, Loader2, Pencil, RotateCcw, Send, Stamp, Trash2, Undo2, Wallet } from "lucide-react";


import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany, useCompanies } from "@/components/app-shell";
import { fetchCompanyPuc } from "@/lib/puc-data";
import { cop, fecha } from "@/lib/format";
import { ESTADO_LABEL, estadoUnico, type EstadoFactura } from "@/lib/invoice-duplicates";
import { siigoSyncInvoice } from "@/lib/siigo.functions";
import { IVA_TREATMENT_LABEL, treatmentForAccount } from "@/lib/iva-treatment";
import { PAYABLE_SOURCE_LABEL, isPayableCode, learnPayableAccount, type PayableSource } from "@/lib/payable-account";
import { AccountCombobox } from "@/components/account-combobox";
import { METODO_LABEL, usePaymentTypes } from "@/lib/payment-types";

import { deshacerSincronizacion, fetchSyncHistory, type SyncEvento } from "@/lib/draft-sync";
import { useDraftsRealtime } from "@/lib/realtime-drafts";
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
  type Cuenta,
  type JournalRow,
  type ResultadoFactura,
} from "@/lib/draft-review";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { PaymentReceiptDialog, type FacturaPagable } from "@/components/payment-receipt-dialog";
import { ESTADO_PAGO_LABEL, saldoPendiente, type EstadoPago } from "@/lib/payments";
import { roundCOP } from "@/lib/money";

/** Muestra código + nombre de todas las cuentas de una categoría del asiento. */
function Cuentas({ items, nombres }: { items: Cuenta[] | undefined; nombres: Map<string, string> }) {
  const list = (items ?? []).filter((c) => !!c?.code);
  if (list.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="space-y-1">
      {list.map((c) => {
        const name = c.name ?? nombres.get(c.code) ?? "";
        return (
          <div key={c.code}>
            <span className="font-mono text-xs">{c.code}</span>
            {name && <div className="max-w-[180px] truncate text-[11px] text-muted-foreground" title={name}>{name}</div>}
          </div>
        );
      })}
    </div>
  );
}
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Columnas congeladas: checkbox, factura, proveedor y NIT. */
const STICKY = [
  "sticky left-0 z-20 w-[44px] min-w-[44px] max-w-[44px]",
  "sticky left-[44px] z-20 w-[150px] min-w-[150px] max-w-[150px]",
  "sticky left-[194px] z-20 w-[220px] min-w-[220px] max-w-[220px]",
  "sticky left-[414px] z-20 w-[120px] min-w-[120px] max-w-[120px] border-r border-border",
];


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
  "id, company_id, prefix, number, issue_date, due_date, provider_nit, provider_name, cufe, cost_center, subtotal, iva, retefuente, reteiva, reteica, total, status, siigo_status, siigo_id, siigo_number, siigo_error, voucher_number, posted_at, approved_at, processing_at, posting_error, file_path, file_name, payable_account, payable_source, payable_manual, sync_source_label, sync_applied_at, sync_event_id, paid_amount, payment_status, payment_enabled, payment_method, payment_type_id, payment_type_name, payment_form_manual";

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
  const [historialOpen, setHistorialOpen] = useState(false);
  const [pagoOpen, setPagoOpen] = useState(false);
  const [pagoFacturas, setPagoFacturas] = useState<FacturaPagable[]>([]);
  const [borrarOpen, setBorrarOpen] = useState(false);
  const [borrando, setBorrando] = useState(false);

  // Desplazamiento horizontal sincronizado: barra superior ↔ contenedor de la tabla.
  const tablaRef = useRef<HTMLDivElement | null>(null);
  const barraRef = useRef<HTMLDivElement | null>(null);
  const [anchoTabla, setAnchoTabla] = useState(0);
  const sincronizando = useRef(false);


  // Tiempo real: los cambios contables de otras sesiones se reflejan solos.
  useDraftsRealtime(companyId, () => {
    void queryClient.invalidateQueries({ queryKey: ["borradores", companyId] });
  });

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
      // Valor de la cuenta por pagar de cada factura (base del recibo de pago).
      const cxp = new Map<string, number>();
      for (const inv of invoices) {
        const payable = String(inv.payable_account ?? "").trim();
        const desdeAsiento = (porFactura.get(inv.id) ?? [])
          .filter((l) => payable && String(l.account_code ?? "").trim() === payable && Number(l.credit ?? 0) > 0)
          .reduce((s, l) => s + Number(l.credit ?? 0), 0);
        const fallback =
          Number(inv.total ?? 0) - Number(inv.retefuente ?? 0) - Number(inv.reteiva ?? 0) - Number(inv.reteica ?? 0);
        cxp.set(inv.id, roundCOP(desdeAsiento > 0 ? desdeAsiento : fallback));
      }
      const puc = await fetchCompanyPuc(companyId!);
      return {
        invoices,
        accounts,
        cxp,
        puc,
        pucCodes: new Set(puc.map((p) => p.code)),
        pucNames: new Map(puc.map((p) => [p.code, p.name])),
      };
    },
  });

  const invoices = data?.invoices ?? [];
  const accounts = data?.accounts ?? new Map<string, DraftAccounts>();
  const pucCodes = data?.pucCodes ?? new Set<string>();
  const pucNames = data?.pucNames ?? new Map<string, string>();
  const cxpPorFactura = data?.cxp ?? new Map<string, number>();
  const puc = data?.puc ?? [];
  // Solo cuentas por pagar (grupos 22 y 23) para el selector de CxP.
  const cuentasPagar = useMemo(() => puc.filter((p) => isPayableCode(p.code)), [puc]);
  const formasPago = usePaymentTypes(companyId).data ?? [];


  /** Saldo pendiente de la cuenta por pagar de una factura. */
  const saldoDe = (r: DraftInvoice) =>
    saldoPendiente({ cxp: cxpPorFactura.get(r.id) ?? 0, pagado: Number(r.paid_amount ?? 0) });

  /** El pago solo procede cuando la factura ya está causada y queda saldo. */
  const pagable = (r: DraftInvoice) => !!r.voucher_number && saldoDe(r) > 0;

  const aFacturaPagable = (r: DraftInvoice): FacturaPagable => ({
    id: r.id,
    etiqueta: etiquetaFactura(r),
    proveedor: r.provider_name ?? "—",
    nit: r.provider_nit ?? "",
    saldo: saldoDe(r),
  });

  /** Interruptor ON/OFF del recibo: marca la factura para generar pago. */
  async function alternarPago(r: DraftInvoice, activo: boolean) {
    const { error } = await supabase.from("invoices").update({ payment_enabled: activo }).eq("id", r.id);
    if (error) { toast.error(error.message); return; }
    await queryClient.invalidateQueries({ queryKey: ["borradores", companyId] });
  }

  /**
   * Cambia SOLO la cuenta por pagar. Queda marcada como manual y nunca la
   * sobrescribe la IA ni la forma de pago.
   */
  async function cambiarCxP(r: DraftInvoice, code: string, name: string | null) {
    const codigo = code.trim();
    if (codigo && !isPayableCode(codigo)) {
      toast.error(`La cuenta ${codigo} no es una cuenta por pagar válida (grupos 22 o 23).`);
      return;
    }
    const { error } = await supabase
      .from("invoices")
      .update({
        payable_account: codigo || null,
        payable_source: codigo ? "manual" : null,
        payable_manual: !!codigo,
        payable_updated_at: new Date().toISOString(),
      })
      .eq("id", r.id);
    if (error) { toast.error(error.message); return; }
    if (codigo) {
      // La cuenta manual también actualiza el asiento para que Siigo reciba lo mismo.
      const anterior = accounts.get(r.id)?.payable?.code;
      if (anterior && anterior !== codigo)
        await supabase
          .from("journal_lines")
          .update({ account_code: codigo, account_name: name ?? pucNames.get(codigo) ?? null })
          .eq("invoice_id", r.id)
          .eq("account_code", anterior)
          .gt("credit", 0);
      await learnPayableAccount(r.company_id, r.provider_nit, codigo);
    }
    toast.success("Cuenta por pagar actualizada.");
    await queryClient.invalidateQueries({ queryKey: ["borradores", companyId] });
  }

  /** Cambia SOLO la forma de pago (Siigo). No toca la cuenta por pagar. */
  async function cambiarFormaPago(r: DraftInvoice, siigoId: string) {
    const forma = formasPago.find((f) => f.siigo_id === siigoId) ?? null;
    const { error } = await supabase
      .from("invoices")
      .update({
        payment_type_id: forma?.siigo_id ?? null,
        payment_type_name: forma?.name ?? null,
        payment_method: forma?.method ?? null,
        payment_form_manual: !!forma,
      })
      .eq("id", r.id);
    if (error) { toast.error(error.message); return; }
    toast.success(forma ? `Forma de pago: ${forma.name}.` : "Forma de pago sin definir.");
    await queryClient.invalidateQueries({ queryKey: ["borradores", companyId] });
  }


  function abrirPago(facturas: DraftInvoice[]) {
    const objetivo = facturas.filter(pagable);
    if (objetivo.length === 0) {
      toast.error("Solo se pueden pagar facturas ya causadas y con saldo pendiente en la cuenta por pagar.");
      return;
    }
    setPagoFacturas(objetivo.map(aFacturaPagable));
    setPagoOpen(true);
  }

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

  // Mide el ancho real de la tabla para dimensionar la barra superior.
  useLayoutEffect(() => {
    const el = tablaRef.current;
    if (!el) return;
    const medir = () => setAnchoTabla(el.scrollWidth);
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    const inner = el.firstElementChild;
    if (inner) ro.observe(inner);
    return () => ro.disconnect();
  }, [rows.length]);

  useEffect(() => {
    const tabla = tablaRef.current;
    const barra = barraRef.current;
    if (!tabla || !barra) return;
    const espejo = (origen: HTMLDivElement, destino: HTMLDivElement) => () => {
      if (sincronizando.current) { sincronizando.current = false; return; }
      sincronizando.current = true;
      destino.scrollLeft = origen.scrollLeft;
    };
    const a = espejo(barra, tabla);
    const b = espejo(tabla, barra);
    barra.addEventListener("scroll", a);
    tabla.addEventListener("scroll", b);
    return () => {
      barra.removeEventListener("scroll", a);
      tabla.removeEventListener("scroll", b);
    };
  }, [anchoTabla]);

  /** Solo se eliminan facturas en estado Borrador; nunca aprobadas, causadas ni sincronizadas. */
  const eliminables = seleccionadas.filter(
    (r) => estadoUnico(r) === "borrador" && !r.voucher_number && r.siigo_status !== "sincronizada" && !r.siigo_id,
  );

  async function eliminarSeleccionadas() {
    if (eliminables.length === 0) return;
    setBorrando(true);
    try {
      const ids = eliminables.map((r) => r.id);
      const { data: borradas, error } = await supabase
        .from("invoices")
        .delete()
        .in("id", ids)
        .eq("company_id", companyId!)
        .eq("status", "borrador")
        .is("voucher_number", null)
        .neq("siigo_status", "sincronizada")
        .select("id");
      if (error) { toast.error(error.message); return; }
      const n = (borradas ?? []).length;
      setBorrarOpen(false);
      setSel({});
      await queryClient.invalidateQueries({ queryKey: ["borradores", companyId] });
      await queryClient.invalidateQueries({ queryKey: ["invoices", companyId] });
      if (n === 0) toast.error("No fue posible eliminar: las facturas ya no están en borrador.");
      else toast.success(n === 1 ? "1 factura eliminada correctamente." : `${n} facturas eliminadas correctamente.`);
    } finally {
      setBorrando(false);
    }
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
              if (res.supplierAction === "creado") tercerosCreados += 1;
              else if (res.supplierAction === "encontrado") tercerosExistentes += 1;
              const tercero =
                res.supplierAction === "creado" ? " Tercero creado automáticamente en Siigo." : "";
              out.push({
                id: inv.id,
                etiqueta,
                ok: res.ok,
                message: res.ok
                  ? `Siigo N° ${res.siigoNumber ?? res.siigoId ?? "creado"}.${tercero}`
                  : (res.error ?? "Siigo rechazó el comprobante."),
              });
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
          <Button
            variant="destructive"
            onClick={() => setBorrarOpen(true)}
            disabled={!!busy || eliminables.length === 0}
            title="Eliminar facturas en borrador"
          >
            <Trash2 className="size-4" /> Eliminar ({eliminables.length})
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
          <Button
            variant="secondary"
            onClick={() => abrirPago(seleccionadas.filter((r) => r.payment_enabled))}
            disabled={!!busy || seleccionadas.filter((r) => r.payment_enabled && pagable(r)).length === 0}
          >
            <Wallet className="size-4" /> Generar recibos ({seleccionadas.filter((r) => r.payment_enabled && pagable(r)).length})
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
        <button
          type="button"
          onClick={() => setHistorialOpen(true)}
          className="ml-auto inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 font-medium text-muted-foreground hover:text-foreground"
        >
          <History className="size-3.5" /> Historial de sincronizaciones
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

      {/* Barra de desplazamiento horizontal superior, sincronizada con la tabla. */}
      <div ref={barraRef} className="overflow-x-auto overflow-y-hidden rounded-t-lg border border-b-0 border-border bg-card">
        <div style={{ width: anchoTabla || 2000, height: 1 }} />
      </div>

      <div ref={tablaRef} className="max-h-[70vh] overflow-auto rounded-b-lg border border-border bg-card">
        <table className="w-full min-w-[2000px] text-sm">
          <thead className="sticky top-0 z-30 bg-muted text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className={`bg-muted px-3 py-2 ${STICKY[0]}`}>
                <Checkbox checked={todasVisiblesMarcadas} onCheckedChange={(v) => marcarTodas(!!v)} aria-label="Seleccionar todos" />
              </th>
              <th className={`bg-muted px-3 py-2 font-medium ${STICKY[1]}`}>Factura</th>
              <th className={`bg-muted px-3 py-2 font-medium ${STICKY[2]}`}>Proveedor</th>
              <th className={`bg-muted px-3 py-2 font-medium ${STICKY[3]}`}>NIT</th>

              <th className="px-3 py-2 font-medium">Fecha</th>
              <th className="px-3 py-2 text-right font-medium">Base</th>
              <th className="px-3 py-2 text-right font-medium">IVA</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
              <th className="px-3 py-2 font-medium">Cuenta gasto/costo</th>
              <th className="px-3 py-2 font-medium">Cuenta IVA</th>
              <th className="px-3 py-2 font-medium">Cuenta Retefuente</th>
              <th className="px-3 py-2 font-medium">Cuenta ReteIVA</th>
              <th className="px-3 py-2 font-medium">Cuenta ReteICA</th>
              <th className="px-3 py-2 font-medium">Otras retenciones</th>
              <th className="px-3 py-2 font-medium">Tratamiento IVA</th>
              <th className="px-3 py-2 font-medium">Cuenta CxP</th>
              <th className="px-3 py-2 font-medium">Origen cuenta por pagar</th>
              <th className="px-3 py-2 font-medium">Forma de pago</th>

              <th className="px-3 py-2 font-medium">Centro de costo</th>
              <th className="px-3 py-2 text-right font-medium">Saldo por pagar</th>
              <th className="px-3 py-2 font-medium">Generar recibo</th>
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
                  <td className={`bg-card px-3 py-2 ${STICKY[0]}`}>
                    <Checkbox
                      checked={!!sel[r.id]}
                      onCheckedChange={(v) => setSel((prev) => ({ ...prev, [r.id]: !!v }))}
                      aria-label={`Seleccionar ${etiquetaFactura(r)}`}
                    />
                  </td>
                  <td className={`bg-card px-3 py-2 font-mono text-xs ${STICKY[1]}`}>
                    {etiquetaFactura(r)}
                    {r.voucher_number && <div className="text-[11px] text-muted-foreground">Comprobante {r.voucher_number}</div>}
                    {r.sync_applied_at && (
                      <div
                        className="mt-1 inline-block rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300"
                        title={`Configuración contable copiada desde ${r.sync_source_label ?? "otro borrador"} el ${fecha(r.sync_applied_at.slice(0, 10))}`}
                      >
                        Actualizado automáticamente
                      </div>
                    )}
                  </td>
                  <td className={`truncate bg-card px-3 py-2 ${STICKY[2]}`} title={r.provider_name ?? ""}>{r.provider_name ?? "—"}</td>
                  <td className={`bg-card px-3 py-2 font-mono text-xs text-muted-foreground ${STICKY[3]}`}>{r.provider_nit ?? "—"}</td>

                  <td className="px-3 py-2 text-muted-foreground">{fecha(r.issue_date)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{cop(r.subtotal)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{cop(r.iva)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{cop(r.total)}</td>
                  <td className="px-3 py-2"><Cuentas items={acc?.gastos} nombres={pucNames} /></td>
                  <td className="px-3 py-2"><Cuentas items={acc?.ivas} nombres={pucNames} /></td>
                  <td className="px-3 py-2"><Cuentas items={acc?.retefuente} nombres={pucNames} /></td>
                  <td className="px-3 py-2"><Cuentas items={acc?.reteiva} nombres={pucNames} /></td>
                  <td className="px-3 py-2"><Cuentas items={acc?.reteica} nombres={pucNames} /></td>
                  <td className="px-3 py-2"><Cuentas items={acc?.otrasRetenciones} nombres={pucNames} /></td>
                  <td className="px-3 py-2 text-[11px] text-muted-foreground">
                    {Number(r.iva || 0) > 0
                      ? acc?.iva?.code
                        ? IVA_TREATMENT_LABEL[treatmentForAccount(acc.iva.code)]
                        : "Sin cuenta de IVA"
                      : "Sin IVA"}
                  </td>
                  <td className="px-3 py-2">
                    {e === "borrador" || e === "error" ? (
                      <AccountCombobox
                        accounts={cuentasPagar}
                        value={acc?.payable?.code ?? r.payable_account ?? ""}
                        onChange={(code, name) => void cambiarCxP(r, code, name)}
                        placeholder="Buscar cuenta por pagar…"
                        className="min-w-[190px]"
                      />
                    ) : (
                      <Cuentas
                        items={
                          acc?.payable
                            ? [acc.payable]
                            : r.payable_account
                              ? [{ code: r.payable_account, name: null }]
                              : []
                        }
                        nombres={pucNames}
                      />
                    )}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-muted-foreground">{origenPayable(r)}</td>
                  <td className="px-3 py-2">
                    {e === "borrador" || e === "error" ? (
                      <select
                        className="h-9 w-full min-w-[170px] rounded-md border border-input bg-background px-2 text-xs"
                        value={r.payment_type_id ?? ""}
                        onChange={(ev) => void cambiarFormaPago(r, ev.target.value)}
                        aria-label={`Forma de pago de ${etiquetaFactura(r)}`}
                      >
                        <option value="">Seleccionar…</option>
                        {formasPago
                          .filter((f) => f.active)
                          .map((f) => (
                            <option key={f.siigo_id} value={f.siigo_id}>
                              {f.name} · {METODO_LABEL[f.method]}
                            </option>
                          ))}
                      </select>
                    ) : (
                      <span className="text-xs">{r.payment_type_name ?? "—"}</span>
                    )}
                    {formasPago.length === 0 && (
                      <div className="mt-1 text-[11px] text-amber-600">
                        Sincroniza las formas de pago desde Integraciones.
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{acc?.costCenter ?? r.cost_center ?? "—"}</td>

                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                    {cop(saldoDe(r))}
                    {Number(r.paid_amount ?? 0) > 0 && (
                      <div className="text-[11px] text-muted-foreground">Pagado {cop(Number(r.paid_amount ?? 0))}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={!!r.payment_enabled}
                        onCheckedChange={(v) => void alternarPago(r, v)}
                        disabled={!pagable(r)}
                        aria-label={`Generar recibo de pago para ${etiquetaFactura(r)}`}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Generar recibo de pago"
                        disabled={!pagable(r)}
                        onClick={() => abrirPago([r])}
                      >
                        <Wallet className="size-4" />
                      </Button>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {!r.voucher_number
                        ? "Requiere causación"
                        : ESTADO_PAGO_LABEL[(r.payment_status ?? "pendiente") as EstadoPago]}
                    </div>
                  </td>
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
                <td colSpan={23} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {isLoading ? "Cargando facturas…" : "No hay facturas que coincidan con el filtro."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={borrarOpen} onOpenChange={(o) => !borrando && setBorrarOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Eliminar borradores</DialogTitle>
          </DialogHeader>
          <p className="text-sm">
            {eliminables.length === 1
              ? "¿Está seguro de eliminar la factura seleccionada? Esta acción eliminará la factura del listado de borradores."
              : `¿Está seguro de eliminar las ${eliminables.length} facturas seleccionadas? Esta acción eliminará estas facturas del listado de borradores.`}
          </p>
          {seleccionadas.length > eliminables.length && (
            <p className="text-xs text-muted-foreground">
              {seleccionadas.length - eliminables.length} factura(s) seleccionadas no se eliminarán porque ya fueron aprobadas, causadas o sincronizadas.
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBorrarOpen(false)} disabled={borrando}>Cancelar</Button>
            <Button variant="destructive" onClick={() => void eliminarSeleccionadas()} disabled={borrando}>
              {borrando ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              {eliminables.length === 1 ? "Eliminar factura" : `Eliminar ${eliminables.length} facturas`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <PaymentReceiptDialog
        open={pagoOpen}
        onOpenChange={setPagoOpen}
        companyId={companyId}
        puc={puc}
        facturas={pagoFacturas}
        onDone={async (res) => {
          setResultados(res.map((r) => ({ id: r.id, etiqueta: r.etiqueta, ok: r.ok, message: r.message })));
          const ok = res.filter((r) => r.ok).length;
          if (ok) toast.success(`${ok} recibo(s) de pago generado(s).`);
          if (res.length - ok) toast.error(`${res.length - ok} factura(s) no se pudieron pagar.`);
          await queryClient.invalidateQueries({ queryKey: ["borradores", companyId] });
        }}
      />

      <SyncHistoryDialog
        companyId={companyId}
        open={historialOpen}
        onOpenChange={setHistorialOpen}
        onChanged={() => void queryClient.invalidateQueries({ queryKey: ["borradores", companyId] })}
      />
    </div>
  );
}

/** Historial de sincronizaciones contables entre borradores, con opción de deshacer. */
function SyncHistoryDialog({
  companyId,
  open,
  onOpenChange,
  onChanged,
}: {
  companyId: string | null | undefined;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onChanged: () => void;
}) {
  const [undoing, setUndoing] = useState<string | null>(null);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["draft-sync-history", companyId],
    enabled: !!companyId && open,
    queryFn: () => fetchSyncHistory(companyId!),
  });
  const eventos: SyncEvento[] = data ?? [];

  async function deshacer(id: string) {
    setUndoing(id);
    try {
      const res = await deshacerSincronizacion(id);
      if (!res.ok) { toast.error(res.message ?? "No fue posible deshacer la sincronización."); return; }
      toast.success(res.message ?? "Sincronización deshecha.");
      await refetch();
      onChanged();
    } finally {
      setUndoing(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Historial de sincronizaciones</DialogTitle>
        </DialogHeader>
        {isLoading && <p className="text-sm text-muted-foreground">Cargando historial…</p>}
        {!isLoading && eventos.length === 0 && (
          <p className="text-sm text-muted-foreground">Todavía no se han aplicado cambios contables a varios borradores a la vez.</p>
        )}
        <div className="max-h-96 space-y-2 overflow-y-auto">
          {eventos.map((ev) => (
            <div key={ev.id} className="rounded-md border border-border p-3 text-xs">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    {ev.provider_name ?? "Proveedor sin nombre"}
                    {ev.provider_nit ? ` · NIT ${ev.provider_nit}` : ""}
                  </p>
                  <p className="text-muted-foreground">
                    {fecha(ev.created_at.slice(0, 10))} · desde {ev.source_label ?? "—"} · {ev.invoice_count} borrador(es)
                    {ev.undone_at ? " · deshecha" : ""}
                  </p>
                </div>
                {!ev.undone_at && (
                  <Button size="sm" variant="outline" onClick={() => void deshacer(ev.id)} disabled={undoing === ev.id}>
                    {undoing === ev.id ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />} Deshacer
                  </Button>
                )}
              </div>
              <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-muted-foreground">
                {(ev.changes ?? []).map((c, i) => (
                  <li key={`${ev.id}-${i}`}>{c.label}: {c.old || "—"} → {c.new}</li>
                ))}
              </ul>
              {(ev.affected ?? []).length > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Facturas: {(ev.affected ?? []).map((a) => a.label).join(", ")}
                </p>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
