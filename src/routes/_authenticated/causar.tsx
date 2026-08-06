import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FileUp, Loader2, Save, Sparkles, Trash2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany, useCompanies } from "@/components/app-shell";
import { extractInvoice, type ExtractedInvoice } from "@/lib/extract.functions";
import { applyRulesToLines, buildJournal, totals, type Line, type Rule, type TaxRate } from "@/lib/accounting";
import { AccountCombobox } from "@/components/account-combobox";
import { cop } from "@/lib/format";
import { InvoicePdfPasswordError, prepareInvoiceFile } from "@/lib/invoice-file";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/causar")({
  head: () => ({
    meta: [
      { title: "Causar factura de compra con IA" },
      { name: "description", content: "Carga PDF, XML DIAN o imagen y obtén el comprobante contable sugerido automáticamente." },
      { property: "og:title", content: "Causar factura de compra" },
      { property: "og:description", content: "Lectura automática de facturas y comprobante contable sugerido." },
    ],
  }),
  component: Causar,
});

const emptyLine = (): Line => ({
  description: "",
  quantity: 1,
  unit_value: 0,
  discount: 0,
  iva: 0,
  retention: 0,
  impoconsumo: 0,
  total: 0,
  account_code: "",
  account_name: "",
  item_type: "gasto",
});

const ITEM_TYPES = ["producto", "servicio", "gasto", "activo"] as const;

type Header = Omit<ExtractedInvoice, "lines">;

const emptyHeader = (): Header => ({
  prefix: "", number: "", issue_date: "", due_date: "",
  provider_nit: "", provider_name: "", provider_address: "", provider_city: "",
  provider_phone: "", provider_email: "", cufe: "", payment_form: "", payment_method: "",
  currency: "COP", cost_center: "", notes: "",
  subtotal: 0, discount: 0, iva: 0, impoconsumo: 0, total: 0,
});

function Causar() {
  const navigate = useNavigate();
  const companyId = useActiveCompany();
  const { data: companies, isLoading: loadingCompanies } = useCompanies();
  const extract = useServerFn(extractInvoice);
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [pdfPassword, setPdfPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [header, setHeader] = useState<Header>(emptyHeader());
  const [lines, setLines] = useState<Line[]>([]);
  const [recordar, setRecordar] = useState<{ index: number; code: string; name: string | null } | null>(null);
  // Impuesto/retención elegido por renglón (índice -> ids)
  const [lineTax, setLineTax] = useState<Record<number, { iva?: string | undefined; ret?: string | undefined }>>({});

  const { data: config } = useQuery({
    queryKey: ["config", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const [rules, taxes, centers, accounts, products, categories] = await Promise.all([
        supabase.from("accounting_rules").select("*").eq("company_id", companyId!),
        supabase.from("tax_rates").select("*").eq("company_id", companyId!),
        supabase.from("cost_centers").select("*").eq("company_id", companyId!).order("code"),
        supabase.from("puc_accounts").select("code, name").eq("company_id", companyId!).order("code"),
        supabase.from("products").select("code, name, kind, account_code, account_name").eq("company_id", companyId!).eq("active", true).order("code"),
        supabase.from("product_categories").select("name, kind, account_code, account_name").eq("company_id", companyId!).eq("active", true),
      ]);
      return {
        rules: (rules.data ?? []) as Rule[],
        taxes: (taxes.data ?? []) as TaxRate[],
        centers: centers.data ?? [],
        accounts: accounts.data ?? [],
        products: products.data ?? [],
        categories: categories.data ?? [],
      };
    },
  });

  const baseGravable = useMemo(
    () => lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0), 0),
    [lines],
  );
  // Si la factura trae IVA en los renglones, ese es el IVA que se causa; si no, el del encabezado.
  const ivaLineas = useMemo(() => lines.reduce((s, l) => s + Number(l.iva || 0), 0), [lines]);
  const ivaTotal = ivaLineas > 0 ? ivaLineas : Number(header.iva || 0);
  const retencionLineas = useMemo(() => lines.reduce((s, l) => s + Number(l.retention || 0), 0), [lines]);

  // Solo se aplican los impuestos/retenciones elegidos en cada renglón.
  const impuestos = config?.taxes ?? [];
  const impuestosIva = impuestos.filter((t) => String(t.kind) === "iva" || String(t.kind) === "impoconsumo");
  const impuestosRet = impuestos.filter((t) => String(t.kind).startsWith("rete"));

  const retenciones = useMemo(() => {
    const r = { retefuente: 0, reteiva: 0, reteica: 0, autorretencion: 0, detalle: [] as any[] };
    lines.forEach((l, i) => {
      const amount = Number(l.retention || 0);
      if (!amount) return;
      const base = Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0);
      const tx = impuestosRet.find((t) => String(t.id) === lineTax[i]?.ret);
      const kind = (String(tx?.kind ?? "retefuente") as "retefuente" | "reteiva" | "reteica");
      const key = kind === "reteiva" ? "reteiva" : kind === "reteica" ? "reteica" : "retefuente";
      r[key] += amount;
      r.detalle.push({
        kind: key,
        name: tx?.name ?? "Retención de la factura",
        rate: Number(tx?.rate ?? 0),
        base,
        amount,
        account_code: (tx as any)?.account_code ?? null,
      });
    });
    return r;
  }, [lines, impuestosRet, lineTax]);
  const journal = useMemo(
    () =>
      buildJournal({
        lines,
        iva: ivaTotal,
        impoconsumo: Number(header.impoconsumo || 0),
        retenciones,
        costCenter: header.cost_center,
      }),
    [lines, ivaTotal, header.impoconsumo, header.cost_center, retenciones],
  );
  const t = totals(journal);

  async function leer(password?: string) {
    if (!file) { toast.error("Selecciona un archivo de factura."); return; }
    setReading(true);
    try {
      const content = await prepareInvoiceFile(file, password);
      const data = (await extract({
        data: { fileName: file.name, mimeType: file.type || "application/octet-stream", ...content },
      })) as ExtractedInvoice;
      const { lines: extracted, ...rest } = data;
      setHeader({ ...emptyHeader(), ...rest });
      let provider = null;
      if (rest.provider_nit && companyId) {
        const { data: p } = await supabase
          .from("providers").select("*").eq("company_id", companyId).eq("nit", rest.provider_nit).maybeSingle();
        provider = p;
      }
      const catalogo = config?.products ?? [];
      const norm = (s: string) => (s ?? "").toLowerCase().trim();
      const conCatalogo = extracted.map((l) => {
        const base = { ...emptyLine(), ...l };
        const prod =
          catalogo.find((p) => base.code && norm(p.code) === norm(String(base.code))) ??
          catalogo.find((p) => norm(p.name) === norm(base.description ?? ""));
        if (!prod) return base;
        return {
          ...base,
          account_code: base.account_code || prod.account_code || "",
          account_name: base.account_name || prod.account_name || "",
          item_type: prod.kind ?? base.item_type,
        };
      });
      setLines(applyRulesToLines(conCatalogo, config?.rules ?? [], provider));
      setPasswordOpen(false);
      setPdfPassword("");
      setPasswordError("");
      toast.success("Factura leída. Revisa y ajusta el comprobante.");
    } catch (err) {
      if (err instanceof InvoicePdfPasswordError) {
        setPasswordError(err.incorrect ? "La contraseña no es correcta. Inténtala nuevamente." : "");
        setPasswordOpen(true);
        return;
      }
      toast.error(err instanceof Error ? err.message : "No fue posible leer la factura.");
    } finally {
      setReading(false);
    }
  }

  function setLine(i: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  const autoLearning = (companies ?? []).find((c) => c.id === companyId)?.auto_learning ?? true;

  async function guardarAprendizaje() {
    if (!recordar || !companyId) return;
    const line = lines[recordar.index];
    const { error } = await supabase.from("learning_rules").insert({
      company_id: companyId,
      provider_nit: header.provider_nit || null,
      provider_name: header.provider_name || null,
      concept: line?.description || null,
      account_code: recordar.code,
      account_name: recordar.name,
      cost_center: header.cost_center || null,
      iva: Number(line?.iva ?? 0),
      item_type: line?.item_type ?? "gasto",
    });
    setRecordar(null);
    if (error) { toast.error(error.message); return; }
    toast.success("Regla aprendida guardada para este proveedor.");
  }

  async function guardar(status: "borrador" | "aprobado") {
    if (!companyId) return;
    if (lines.length === 0) { toast.error("Agrega al menos un renglón."); return; }
    if (Math.abs(t.diferencia) > 1) { toast.error("El comprobante está descuadrado."); return; }
    setSaving(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth.user?.id;

      let filePath: string | null = null;
      if (file && userId) {
        const path = `${userId}/${companyId}/${Date.now()}-${file.name.replace(/[^\w.-]/g, "_")}`;
        const { error: upErr } = await supabase.storage.from("facturas").upload(path, file);
        if (!upErr) filePath = path;
      }

      if (header.provider_nit) {
        await supabase.from("providers").upsert(
          {
            company_id: companyId,
            nit: header.provider_nit,
            name: header.provider_name || header.provider_nit,
            address: header.provider_address,
            city: header.provider_city,
            phone: header.provider_phone,
            email: header.provider_email,
          },
          { onConflict: "company_id,nit", ignoreDuplicates: true },
        );
      }

      const total = baseGravable + ivaTotal + Number(header.impoconsumo || 0);
      const { data: inv, error } = await supabase
        .from("invoices")
        .insert({
          company_id: companyId,
          prefix: header.prefix,
          number: header.number,
          issue_date: header.issue_date || null,
          due_date: header.due_date || null,
          provider_nit: header.provider_nit,
          provider_name: header.provider_name,
          provider_address: header.provider_address,
          provider_city: header.provider_city,
          provider_phone: header.provider_phone,
          provider_email: header.provider_email,
          cufe: header.cufe,
          payment_form: header.payment_form,
          payment_method: header.payment_method,
          currency: header.currency || "COP",
          cost_center: header.cost_center,
          notes: header.notes,
          subtotal: baseGravable,
          discount: Number(header.discount || 0),
          iva: ivaTotal,
          impoconsumo: Number(header.impoconsumo || 0),
          retefuente: retenciones.retefuente,
          reteiva: retenciones.reteiva,
          reteica: retenciones.reteica,
          total,
          status,
          dian_status: header.cufe ? "con CUFE" : "sin CUFE",
          file_path: filePath,
          file_name: file?.name ?? null,
        })
        .select()
        .single();
      if (error) throw error;

      await Promise.all([
        supabase.from("invoice_lines").insert(
          lines.map((l, i) => ({
            invoice_id: inv.id,
            company_id: companyId,
            code: l.code ?? null,
            description: l.description,
            quantity: Number(l.quantity || 0),
            unit_value: Number(l.unit_value || 0),
            discount: Number(l.discount || 0),
            iva: Number(l.iva || 0),
            retention: Number(l.retention || 0),
            impoconsumo: Number(l.impoconsumo || 0),
            total: Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0),
            account_code: l.account_code ?? null,
            account_name: l.account_name ?? null,
            item_type: l.item_type ?? "gasto",
            position: i,
          })),
        ),
        supabase.from("journal_lines").insert(
          journal.map((j, i) => ({
            invoice_id: inv.id,
            company_id: companyId,
            account_code: j.account_code,
            account_name: j.account_name,
            debit: j.debit,
            credit: j.credit,
            cost_center: j.cost_center ?? null,
            position: i,
          })),
        ),
        ...lines
          .filter((l) => l.account_code)
          .map((l) =>
            supabase.from("learning_events").insert({
              company_id: companyId,
              provider_nit: header.provider_nit,
              concept: l.description,
              account_code: l.account_code!,
            }),
          ),
      ]);

      toast.success(status === "aprobado" ? "Comprobante aprobado." : "Comprobante guardado en borrador.");
      navigate({ to: "/facturas" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No fue posible guardar el comprobante.");
    } finally {
      setSaving(false);
    }
  }

  if (!loadingCompanies && (companies ?? []).length === 0) return <EmptyCompany />;

  const field = (label: string, key: keyof Header, type = "text") => (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Input
        type={type}
        value={String(header[key] ?? "")}
        onChange={(e) => setHeader({ ...header, [key]: type === "number" ? Number(e.target.value) : e.target.value })}
      />
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Causar factura</h1>
        <p className="mt-1 text-sm text-muted-foreground">Carga la factura (PDF, XML DIAN, JPG o PNG) y la IA propone el comprobante.</p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-5">
        <div className="min-w-64 flex-1 space-y-1.5">
          <Label htmlFor="archivo">Archivo de la factura</Label>
          <Input
            id="archivo"
            ref={fileRef}
            type="file"
            accept=".pdf,.xml,.jpg,.jpeg,.png,application/pdf,text/xml,image/*"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPdfPassword("");
              setPasswordError("");
              setPasswordOpen(false);
            }}
          />
        </div>
        <Button onClick={() => void leer()} disabled={reading || !file}>
          {reading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          {reading ? "Preparando y leyendo…" : "Leer con IA"}
        </Button>
        <Button variant="outline" onClick={() => setLines((p) => [...p, emptyLine()])}>
          <FileUp className="size-4" /> Renglón manual
        </Button>
      </div>

      <Dialog open={passwordOpen} onOpenChange={(open) => !reading && setPasswordOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>PDF protegido</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="pdf-password">Contraseña del archivo</Label>
            <Input
              id="pdf-password"
              type="password"
              autoComplete="off"
              autoFocus
              value={pdfPassword}
              onChange={(event) => {
                setPdfPassword(event.target.value);
                setPasswordError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && pdfPassword && !reading) void leer(pdfPassword);
              }}
            />
            {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasswordOpen(false)} disabled={reading}>Cancelar</Button>
            <Button onClick={() => void leer(pdfPassword)} disabled={!pdfPassword || reading}>
              {reading && <Loader2 className="size-4 animate-spin" />}
              Desbloquear y leer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid gap-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-2 xl:grid-cols-4">
        {field("Prefijo", "prefix")}
        {field("Número", "number")}
        {field("Fecha", "issue_date", "date")}
        {field("Vencimiento", "due_date", "date")}
        {field("NIT proveedor", "provider_nit")}
        {field("Proveedor", "provider_name")}
        {field("Ciudad", "provider_city")}
        {field("CUFE", "cufe")}
        {field("IVA total", "iva", "number")}
        {field("Impoconsumo", "impoconsumo", "number")}
        {field("Forma de pago", "payment_form")}
        <div className="space-y-1.5">
          <Label className="text-xs">Centro de costo</Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={header.cost_center ?? ""}
            onChange={(e) => setHeader({ ...header, cost_center: e.target.value })}
          >
            <option value="">Sin centro de costo</option>
            {(config?.centers ?? []).map((c) => (
              <option key={c.id} value={c.code}>
                {c.code} · {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5 sm:col-span-2 xl:col-span-4">
          <Label className="text-xs">Notas</Label>
          <Textarea rows={2} value={header.notes ?? ""} onChange={(e) => setHeader({ ...header, notes: e.target.value })} />
        </div>
      </div>

      {lines.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Descripción</th>
                <th className="px-3 py-2 font-medium">Tipo</th>
                <th className="px-3 py-2 font-medium">Cant.</th>
                <th className="px-3 py-2 font-medium">Vr. unitario</th>
                <th className="px-3 py-2 font-medium">Descuento</th>
                <th className="px-3 py-2 font-medium">Cuenta PUC</th>
                <th className="px-3 py-2 font-medium">IVA</th>
                <th className="px-3 py-2 font-medium">Retención</th>
                <th className="px-3 py-2 text-right font-medium">Valor</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5">
                    <Input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                  </td>
                  <td className="px-3 py-1.5 w-32">
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-1 text-xs"
                      value={l.item_type ?? "gasto"}
                      onChange={(e) => setLine(i, { item_type: e.target.value })}
                    >
                      {ITEM_TYPES.map((k) => (
                        <option key={k} value={k}>{k}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-1.5 w-24">
                    <Input type="number" value={l.quantity} onChange={(e) => setLine(i, { quantity: Number(e.target.value) })} />
                  </td>
                  <td className="px-3 py-1.5 w-32">
                    <Input type="number" value={l.unit_value} onChange={(e) => setLine(i, { unit_value: Number(e.target.value) })} />
                  </td>
                  <td className="px-3 py-1.5 w-28">
                    <Input type="number" value={l.discount} onChange={(e) => setLine(i, { discount: Number(e.target.value) })} />
                  </td>
                  <td className="px-3 py-1.5 w-56">
                    <AccountCombobox
                      accounts={config?.accounts ?? []}
                      value={l.account_code ?? ""}
                      onChange={(code, name) => {
                        setLine(i, { account_code: code, account_name: name });
                        if (autoLearning && code) setRecordar({ index: i, code, name });
                      }}
                    />
                  </td>
                  <td className="px-3 py-1.5 w-56">
                    <div className="flex items-center gap-1">
                      <Input
                        className="w-24"
                        type="number"
                        value={l.iva}
                        onChange={(e) => setLine(i, { iva: Number(e.target.value) })}
                      />
                      <select
                        className="h-9 w-28 rounded-md border border-input bg-background px-1 text-xs"
                        value={lineTax[i]?.iva ?? ""}
                        onChange={(e) => {
                          const id = e.target.value;
                          setLineTax((p) => ({ ...p, [i]: { ...p[i], iva: id || undefined } }));
                          const tx = impuestosIva.find((t) => String(t.id) === id);
                          const base = Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0);
                          setLine(i, { iva: tx ? Math.round((base * Number(tx.rate)) / 100) : 0 });
                        }}
                      >
                        <option value="">Sin impuesto</option>
                        {impuestosIva.map((t) => (
                          <option key={String(t.id)} value={String(t.id)}>
                            {t.name} {Number(t.rate)}%
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 w-56">
                    <div className="flex items-center gap-1">
                      <Input
                        className="w-24"
                        type="number"
                        value={l.retention}
                        onChange={(e) => setLine(i, { retention: Number(e.target.value) })}
                      />
                      <select
                        className="h-9 w-28 rounded-md border border-input bg-background px-1 text-xs"
                        value={lineTax[i]?.ret ?? ""}
                        onChange={(e) => {
                          const id = e.target.value;
                          setLineTax((p) => ({ ...p, [i]: { ...p[i], ret: id || undefined } }));
                          const tx = impuestosRet.find((t) => String(t.id) === id);
                          const base = Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0);
                          const baseRet = String(tx?.kind) === "reteiva" ? Number(l.iva || 0) : base;
                          setLine(i, { retention: tx ? Math.round((baseRet * Number(tx.rate)) / 100) : 0 });
                        }}
                      >
                        <option value="">Sin retención</option>
                        {impuestosRet.map((t) => (
                          <option key={String(t.id)} value={String(t.id)}>
                            {t.name} {Number(t.rate)}%
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {cop(Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0))}
                  </td>
                  <td className="px-3 py-1.5">
                    <Button variant="ghost" size="icon" onClick={() => setLines((p) => p.filter((_, idx) => idx !== i))}>
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lines.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-sm font-semibold">Resumen de impuestos</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Los impuestos y retenciones se eligen en cada renglón, junto al valor.
            </p>
            <dl className="mt-3 space-y-1.5 text-sm">
              <Row k="Base gravable" v={cop(baseGravable)} />
              <Row k="IVA" v={cop(ivaTotal)} />
              <Row k="Retefuente" v={cop(retenciones.retefuente)} />
              <Row k="ReteIVA" v={cop(retenciones.reteiva)} />
              <Row k="ReteICA" v={cop(retenciones.reteica)} />
              <Row k="Total factura" v={cop(baseGravable + ivaTotal + Number(header.impoconsumo || 0))} />
              <Row
                k="Neto a pagar"
                v={cop(baseGravable + ivaTotal + Number(header.impoconsumo || 0) - retenciones.retefuente - retenciones.reteiva - retenciones.reteica)}
              />
            </dl>
          </div>

          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="border-b border-border px-5 py-3 text-sm font-semibold">Comprobante contable</div>
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
      )}

      {lines.length > 0 && (
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => guardar("borrador")} disabled={saving} variant="outline">
            <Save className="size-4" /> Guardar borrador
          </Button>
          <Button onClick={() => guardar("aprobado")} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Aprobar comprobante
          </Button>
        </div>
      )}

      <Dialog open={!!recordar} onOpenChange={(o) => !o && setRecordar(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>¿Desea recordar esta cuenta para futuras facturas de este proveedor?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Se guardará una regla de aprendizaje para {header.provider_name || header.provider_nit || "este proveedor"} con la cuenta{" "}
            <span className="font-mono">{recordar?.code}</span>. Solo aplica a esta empresa.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecordar(null)}>
              No
            </Button>
            <Button onClick={guardarAprendizaje}>Sí, recordar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-mono tabular-nums">{v}</dd>
    </div>
  );
}
