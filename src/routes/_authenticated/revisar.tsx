import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, PackageSearch, Send, Sparkles } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/lib/active-company";
import { buildJournal, totals, type JournalLine, type Retenciones } from "@/lib/accounting";
import { ITEM_TYPES, type LearningRule } from "@/lib/learning";
import { cop, fecha } from "@/lib/format";
import { suggestCostCenter } from "@/lib/cost-center";
import { siigoCreateProduct, siigoFindProduct, siigoSyncInvoice } from "@/lib/siigo.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/revisar")({
  validateSearch: (search: Record<string, unknown>) => ({ id: String(search['id'] ?? "") }),
  head: () => ({
    meta: [
      { title: "Revisar y causar factura en Siigo" },
      { name: "description", content: "Valida cuentas, centros de costo, impuestos y retenciones antes de enviar el comprobante contable a Siigo." },
      { property: "og:title", content: "Revisar y causar factura en Siigo" },
      { property: "og:description", content: "Revisión previa, validaciones y resumen contable antes de sincronizar." },
    ],
  }),
  component: Revisar,
});

type InvRow = {
  id: string;
  company_id: string;
  prefix: string | null;
  number: string | null;
  issue_date: string | null;
  provider_nit: string | null;
  provider_name: string | null;
  cost_center: string | null;
  payment_form: string | null;
  notes: string | null;
  iva: number;
  impoconsumo: number;
  retefuente: number;
  reteiva: number;
  reteica: number;
  status: string;
  siigo_status: string;
  siigo_id: string | null;
  siigo_number: string | null;
  siigo_document_url: string | null;
  siigo_synced_at: string | null;
};

type LineRow = {
  id: string;
  code: string | null;
  description: string | null;
  quantity: number;
  unit_value: number;
  discount: number;
  iva: number;
  retention: number;
  account_code: string | null;
  account_name: string | null;
  item_type: string;
  position: number;
};

function Revisar() {
  const { id } = Route.useSearch();
  const navigate = useNavigate();
  const companyId = useActiveCompany();
  const queryClient = useQueryClient();
  const sync = useServerFn(siigoSyncInvoice);
  const findProduct = useServerFn(siigoFindProduct);
  const createProduct = useServerFn(siigoCreateProduct);

  const [header, setHeader] = useState<InvRow | null>(null);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [sending, setSending] = useState(false);
  const [ok, setOk] = useState<{ number: string | null; id: string | null; date: string | null; url: string | null } | null>(null);
  const [inventario, setInventario] = useState<{ index: number; query: string; results: { id: string; code: string; name: string }[] | null; busy: boolean } | null>(null);
  const [centroSugerido, setCentroSugerido] = useState<string | null>(null);
  const [centroTocado, setCentroTocado] = useState(false);

  const { data } = useQuery({
    queryKey: ["revisar", id],
    enabled: !!id,
    queryFn: async () => {
      const [inv, ln, centers, accounts, learning] = await Promise.all([
        supabase.from("invoices").select("*").eq("id", id).single(),
        supabase.from("invoice_lines").select("*").eq("invoice_id", id).order("position"),
        supabase.from("cost_centers").select("code, name").eq("company_id", companyId ?? "").order("code"),
        supabase.from("puc_accounts").select("code, name").eq("company_id", companyId ?? "").order("code").range(0, 19999),
        supabase.from("learning_rules").select("*").eq("company_id", companyId ?? ""),
      ]);
      if (inv.error) throw inv.error;
      return {
        invoice: inv.data as unknown as InvRow,
        lines: (ln.data ?? []) as unknown as LineRow[],
        centers: centers.data ?? [],
        accounts: accounts.data ?? [],
        learning: (learning.data ?? []) as unknown as LearningRule[],
      };
    },
  });

  useEffect(() => {
    if (data) {
      setHeader(data.invoice);
      setLines(data.lines);
    }
  }, [data]);

  /** Centro de costo sugerido por el historial del proveedor en esta empresa. */
  useEffect(() => {
    const nit = header?.provider_nit;
    const company = header?.company_id;
    if (!company || !nit) return;
    let cancelado = false;
    void suggestCostCenter({ companyId: company, providerNit: nit }).then((s) => {
      if (cancelado || !s) return;
      setCentroSugerido(s.detail);
      console.log("[revision] centro de costo sugerido:", { proveedor: nit, centro: s.code, origen: s.origin });
      setHeader((prev) => (!prev || centroTocado || prev.cost_center ? prev : { ...prev, cost_center: s.code }));
    });
    return () => { cancelado = true; };
  }, [header?.provider_nit, header?.company_id, centroTocado]);

  const base = useMemo(
    () => lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0), 0),
    [lines],
  );

  const retenciones: Retenciones = useMemo(
    () => ({
      retefuente: Number(header?.retefuente ?? 0),
      reteiva: Number(header?.reteiva ?? 0),
      reteica: Number(header?.reteica ?? 0),
      autorretencion: 0,
      detalle: [
        { kind: "retefuente", name: "Retefuente", rate: 0, base, amount: Number(header?.retefuente ?? 0), account_code: null },
        { kind: "reteiva", name: "ReteIVA", rate: 0, base, amount: Number(header?.reteiva ?? 0), account_code: null },
        { kind: "reteica", name: "ReteICA", rate: 0, base, amount: Number(header?.reteica ?? 0), account_code: null },
      ].filter((d) => d.amount > 0),
    }),
    [header?.retefuente, header?.reteiva, header?.reteica, base],
  );

  const journal: JournalLine[] = useMemo(
    () =>
      buildJournal({
        lines: lines.map((l) => ({
          description: l.description ?? "",
          quantity: Number(l.quantity || 0),
          unit_value: Number(l.unit_value || 0),
          discount: Number(l.discount || 0),
          iva: Number(l.iva || 0),
          retention: Number(l.retention || 0),
          impoconsumo: 0,
          total: 0,
          account_code: l.account_code,
          account_name: l.account_name,
        })),
        iva: Number(header?.iva ?? 0),
        impoconsumo: Number(header?.impoconsumo ?? 0),
        retenciones,
        costCenter: header?.cost_center ?? null,
      }),
    [lines, header?.iva, header?.impoconsumo, header?.cost_center, retenciones],
  );
  const t = totals(journal);

  const errores = useMemo(() => {
    const e: string[] = [];
    if (!header) return e;
    if (!header.provider_nit) e.push("Falta el NIT del proveedor.");
    if (lines.length === 0) e.push("La factura no tiene renglones.");
    const pucCodes = new Set((data?.accounts ?? []).map((a) => a.code));
    lines.forEach((l, i) => {
      if (!l.account_code) e.push(`Renglón ${i + 1}: falta la cuenta contable.`);
      else if (pucCodes.size > 0 && !pucCodes.has(l.account_code)) e.push(`Renglón ${i + 1}: la cuenta ${l.account_code} no existe en el PUC de la empresa.`);
      if (!ITEM_TYPES.includes(l.item_type as never)) e.push(`Renglón ${i + 1}: tipo de ítem inválido.`);
    });
    if (!header.cost_center) e.push("Falta el centro de costo.");
    if (Number(header.iva) < 0) e.push("El IVA no puede ser negativo.");
    if (retenciones.retefuente < 0 || retenciones.reteiva < 0 || retenciones.reteica < 0) e.push("Las retenciones no pueden ser negativas.");
    if (Math.abs(t.diferencia) > 1) e.push(`El comprobante está descuadrado por ${cop(t.diferencia)}.`);
    if (base <= 0) e.push("La base gravable debe ser mayor a cero.");
    return e;
  }, [header, lines, data?.accounts, retenciones, t.diferencia, base]);

  async function guardarCambios() {
    if (!header) return;
    await supabase
      .from("invoices")
      .update({
        cost_center: header.cost_center,
        payment_form: header.payment_form,
        notes: header.notes,
        iva: Number(header.iva || 0),
        retefuente: Number(header.retefuente || 0),
        reteiva: Number(header.reteiva || 0),
        reteica: Number(header.reteica || 0),
        subtotal: base,
        total: base + Number(header.iva || 0) + Number(header.impoconsumo || 0),
      })
      .eq("id", header.id);

    await Promise.all(
      lines.map((l) =>
        supabase
          .from("invoice_lines")
          .update({
            account_code: l.account_code,
            account_name: l.account_name,
            item_type: l.item_type,
            iva: Number(l.iva || 0),
            retention: Number(l.retention || 0),
          })
          .eq("id", l.id),
      ),
    );

    await supabase.from("journal_lines").delete().eq("invoice_id", header.id);
    await supabase.from("journal_lines").insert(
      journal.map((j, i) => ({
        invoice_id: header.id,
        company_id: header.company_id,
        account_code: j.account_code,
        account_name: j.account_name,
        debit: j.debit,
        credit: j.credit,
        cost_center: j.cost_center ?? null,
        position: i,
      })),
    );
  }

  async function causar() {
    if (!header) return;
    if (errores.length > 0) { toast.error("Corrige los errores antes de enviar la factura."); return; }
    setSending(true);
    try {
      await guardarCambios();
      // Diagnóstico: lo que se ve en pantalla es exactamente lo que se envía.
      console.log("========== CAUSACIÓN ANTES DE ENVIAR ==========");
      console.log("Proveedor:", header.provider_name, "· NIT:", header.provider_nit);
      console.log("Centro de costo:", header.cost_center || "—");
      lines.forEach((l, i) =>
        console.log(`Renglón ${i + 1}:`, {
          tipo_item: l.item_type,
          producto: l.code ?? null,
          descripcion: l.description,
          cuenta: l.account_code,
          iva: l.iva,
          retencion: l.retention,
          centro_costo: header.cost_center ?? null,
        }),
      );
      console.log("===============================================");
      const res = await sync({ data: { invoiceId: header.id } });
      if (!res.ok) { toast.error(res.error ?? "Siigo rechazó el comprobante."); return; }
      setOk({ number: res.siigoNumber, id: res.siigoId, date: res.syncedAt, url: res.documentUrl });
      toast.success("Factura sincronizada correctamente.");
      await queryClient.invalidateQueries({ queryKey: ["invoices", companyId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No fue posible causar la factura en Siigo.");
    } finally {
      setSending(false);
    }
  }

  async function buscarProducto(index: number) {
    const l = lines[index];
    if (!l) return;
    const query = l.code || l.description || "";
    setInventario({ index, query, results: null, busy: true });
    try {
      const results = await findProduct({ data: { query } });
      setInventario({ index, query, results, busy: false });
    } catch (err) {
      setInventario({ index, query, results: [], busy: false });
      toast.error(err instanceof Error ? err.message : "No fue posible consultar productos en Siigo.");
    }
  }

  async function crearProducto() {
    if (!inventario) return;
    const l = lines[inventario.index];
    if (!l) return;
    setInventario({ ...inventario, busy: true });
    try {
      const p = await createProduct({
        data: { code: l.code || (l.description ?? "ITEM").slice(0, 20).toUpperCase().replace(/\s+/g, "-"), name: l.description || "Producto" },
      });
      setLines((prev) => prev.map((x, i) => (i === inventario.index ? { ...x, code: p.code } : x)));
      toast.success(`Producto creado en Siigo con el código ${p.code}.`);
      setInventario(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No fue posible crear el producto en Siigo.");
      setInventario({ ...inventario, busy: false });
    }
  }

  function setLine(i: number, patch: Partial<LineRow>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function aplicarATodos() {
    const first = lines[0];
    if (!first) return;
    setLines((prev) =>
      prev.map((l) => ({ ...l, account_code: first.account_code, account_name: first.account_name, item_type: first.item_type, iva: first.iva, retention: first.retention })),
    );
    toast.success("Cuenta, tipo de ítem, IVA y retención copiados a todos los renglones.");
  }

  if (!id) return <p className="text-sm text-muted-foreground">Selecciona una factura desde el historial.</p>;
  if (!header) return <p className="text-sm text-muted-foreground">Cargando la factura…</p>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            Revisión y causación · {[header.prefix, header.number].filter(Boolean).join("-") || "Sin número"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {header.provider_name ?? "Sin proveedor"} · {fecha(header.issue_date)} · Estado Siigo: {header.siigo_status}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/facturas">Volver al historial</Link>
        </Button>
      </div>

      <div className="grid gap-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-1.5">
          <Label className="text-xs">Centro de costo</Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={header.cost_center ?? ""}
            onChange={(e) => { setCentroTocado(true); setHeader({ ...header, cost_center: e.target.value }); }}
          >
            <option value="">Sin centro de costo</option>
            {(data?.centers ?? []).map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} · {c.name}
              </option>
            ))}
          </select>
          {centroSugerido && !centroTocado && <p className="text-xs text-muted-foreground">{centroSugerido}</p>}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Forma de pago</Label>
          <Input value={header.payment_form ?? ""} onChange={(e) => setHeader({ ...header, payment_form: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">IVA</Label>
          <Input type="number" value={header.iva} onChange={(e) => setHeader({ ...header, iva: Number(e.target.value) })} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Retefuente</Label>
          <Input type="number" value={header.retefuente} onChange={(e) => setHeader({ ...header, retefuente: Number(e.target.value) })} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">ReteIVA</Label>
          <Input type="number" value={header.reteiva} onChange={(e) => setHeader({ ...header, reteiva: Number(e.target.value) })} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">ReteICA</Label>
          <Input type="number" value={header.reteica} onChange={(e) => setHeader({ ...header, reteica: Number(e.target.value) })} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs">Observaciones</Label>
          <Textarea rows={2} value={header.notes ?? ""} onChange={(e) => setHeader({ ...header, notes: e.target.value })} />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Renglones</h2>
          <Button size="sm" variant="outline" onClick={aplicarATodos}>
            <Sparkles className="size-4" /> Aplicar a todos
          </Button>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[1000px] text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Descripción</th>
                <th className="px-3 py-2 font-medium">Cuenta contable</th>
                <th className="px-3 py-2 font-medium">Tipo de ítem</th>
                <th className="px-3 py-2 font-medium">IVA</th>
                <th className="px-3 py-2 font-medium">Retención</th>
                <th className="px-3 py-2 text-right font-medium">Valor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.map((l, i) => (
                <tr key={l.id}>
                  <td className="px-3 py-1.5">{l.description}</td>
                  <td className="px-3 py-1.5 w-64">
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={l.account_code ?? ""}
                      onChange={(e) => {
                        const acc = (data?.accounts ?? []).find((a) => a.code === e.target.value);
                        setLine(i, { account_code: e.target.value, account_name: acc?.name ?? null });
                      }}
                    >
                      <option value="">Seleccionar…</option>
                      {(data?.accounts ?? []).map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-1.5 w-44">
                    <div className="flex items-center gap-1">
                      <select
                        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm capitalize"
                        value={l.item_type}
                        onChange={(e) => {
                          setLine(i, { item_type: e.target.value });
                          if (e.target.value === "inventario") void buscarProducto(i);
                        }}
                      >
                        {ITEM_TYPES.map((it) => (
                          <option key={it} value={it}>
                            {it}
                          </option>
                        ))}
                      </select>
                      {l.item_type === "inventario" && (
                        <Button variant="ghost" size="icon" title="Buscar en Siigo" onClick={() => buscarProducto(i)}>
                          <PackageSearch className="size-4" />
                        </Button>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 w-28">
                    <Input type="number" value={l.iva} onChange={(e) => setLine(i, { iva: Number(e.target.value) })} />
                  </td>
                  <td className="px-3 py-1.5 w-28">
                    <Input type="number" value={l.retention} onChange={(e) => setLine(i, { retention: Number(e.target.value) })} />
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {cop(Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {errores.length > 0 && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="flex items-center gap-2 font-medium text-destructive">
            <AlertTriangle className="size-4" /> No es posible enviar la factura
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {errores.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold">Resumen contable</h2>
          <dl className="mt-3 space-y-1.5 text-sm">
            <Row k="Proveedor" v={`${header.provider_name ?? "—"} (${header.provider_nit ?? "—"})`} />
            <Row k="Centro de costo" v={header.cost_center || "—"} />
            <Row
              k="Tipos de ítem"
              v={[...new Set(lines.map((l) => l.item_type))].join(", ").toUpperCase() || "—"}
            />
            <Row k="Cuentas" v={[...new Set(lines.map((l) => l.account_code ?? "—"))].join(", ")} />
            <Row k="Subtotal" v={cop(base)} />
            <Row k="IVA" v={cop(Number(header.iva))} />
            <Row k="Retenciones" v={cop(retenciones.retefuente + retenciones.reteiva + retenciones.reteica)} />
            <Row k="Total" v={cop(base + Number(header.iva) + Number(header.impoconsumo ?? 0))} />
          </dl>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border px-5 py-3 text-sm font-semibold">Asiento contable generado</div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border">
              {journal.map((j, i) => (
                <tr key={i}>
                  <td className="px-4 py-1.5 font-mono text-xs">{j.account_code}</td>
                  <td className="px-4 py-1.5 text-muted-foreground">{j.account_name}</td>
                  <td className="px-4 py-1.5 text-right font-mono tabular-nums">{j.debit ? cop(j.debit) : ""}</td>
                  <td className="px-4 py-1.5 text-right font-mono tabular-nums">{j.credit ? cop(j.credit) : ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-border bg-muted/40 text-xs">
              <tr>
                <td className="px-4 py-2 font-medium" colSpan={2}>
                  {Math.abs(t.diferencia) <= 1 ? "Comprobante cuadrado" : `Descuadre ${cop(t.diferencia)}`}
                </td>
                <td className="px-4 py-2 text-right font-mono">{cop(t.debito)}</td>
                <td className="px-4 py-2 text-right font-mono">{cop(t.credito)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          onClick={async () => {
            await guardarCambios();
            toast.success("Cambios guardados.");
          }}
        >
          Guardar cambios
        </Button>
        <Button onClick={causar} disabled={sending || errores.length > 0}>
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Causar en Siigo
        </Button>
      </div>

      <Dialog open={!!inventario} onOpenChange={(o) => !o && setInventario(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Producto de inventario en Siigo</DialogTitle>
          </DialogHeader>
          {inventario?.busy && <p className="text-sm text-muted-foreground">Consultando Siigo…</p>}
          {!inventario?.busy && (inventario?.results?.length ?? 0) > 0 && (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">El producto ya existe en Siigo. Se usará el código existente.</p>
              {inventario!.results!.map((p) => (
                <button
                  key={p.id || p.code}
                  className="w-full rounded-md border border-border px-3 py-2 text-left hover:bg-muted/40"
                  onClick={() => {
                    setLines((prev) => prev.map((x, i) => (i === inventario!.index ? { ...x, code: p.code } : x)));
                    setInventario(null);
                  }}
                >
                  <span className="font-mono text-xs">{p.code}</span> · {p.name}
                </button>
              ))}
            </div>
          )}
          {!inventario?.busy && inventario?.results?.length === 0 && (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">El producto no existe en Siigo. ¿Deseas crearlo?</p>
              <Button onClick={crearProducto}>Crear producto automáticamente en Siigo</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!ok} onOpenChange={(o) => !o && setOk(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-primary" /> Factura sincronizada correctamente
            </DialogTitle>
          </DialogHeader>
          <dl className="space-y-1.5 text-sm">
            <Row k="Número generado por Siigo" v={ok?.number ?? "—"} />
            <Row k="ID del documento" v={ok?.id ?? "—"} />
            <Row k="Fecha" v={ok?.date ? new Date(ok.date).toLocaleString("es-CO") : "—"} />
            <Row k="Estado" v="Sincronizada" />
          </dl>
          <DialogFooter className="gap-2">
            {ok?.url && (
              <Button asChild variant="outline">
                <a href={ok.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" /> Ver documento en Siigo
                </a>
              </Button>
            )}
            <Button onClick={() => navigate({ to: "/facturas" })}>Ir al historial</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right font-mono tabular-nums">{v}</dd>
    </div>
  );
}
