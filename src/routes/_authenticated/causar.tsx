import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, FileUp, Layers, Loader2, Save, Sparkles, Trash2, XCircle } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { ITEM_TYPES, normalizeItemType } from "@/lib/item-type";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany, useCompanies } from "@/components/app-shell";
import { extractInvoice, type ExtractedInvoice } from "@/lib/extract.functions";
import { applyRulesToLines, buildJournal, suggestAccount, totals, type Line, type Rule, type TaxRate } from "@/lib/accounting";
import { AccountCombobox } from "@/components/account-combobox";
import { ProductCombobox, type ProductOption } from "@/components/product-combobox";
import { BulkApply } from "@/components/bulk-apply";
import { resolveProductAccount, SIN_CUENTA_MSG } from "@/lib/product-account";
import { suggestCostCenter } from "@/lib/cost-center";
import { checkInvoiceCompany, motivoBloqueoEmpresa } from "@/lib/company-validation";
import { cop } from "@/lib/format";
import { InvoicePdfPasswordError, prepareInvoiceFile } from "@/lib/invoice-file";
import { expandInvoiceFiles, processInvoiceFile } from "@/lib/bulk-invoices";
import {
  ESTADO_LABEL,
  estadoUnico,
  findExistingInvoice,
  mensajeDuplicado,
  type DuplicateInvoice,
} from "@/lib/invoice-duplicates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/causar")({
  validateSearch: (search: Record<string, unknown>) => ({
    id: typeof search['id'] === "string" && search['id'] ? (search['id'] as string) : undefined,
  }),
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


type Header = Omit<ExtractedInvoice, "lines">;

const emptyHeader = (): Header => ({
  prefix: "", number: "", issue_date: "", due_date: "",
  provider_nit: "", provider_name: "", provider_address: "", provider_city: "",
  provider_phone: "", provider_email: "", cufe: "", payment_form: "Crédito", payment_method: "",
  buyer_nit: "", buyer_name: "",
  currency: "COP", cost_center: "", notes: "",
  subtotal: 0, discount: 0, iva: 0, impoconsumo: 0, total: 0,
});

/** Plazo de crédito según los días entre la fecha de la factura y su vencimiento. */
const CREDIT_TERMS = ["Crédito", "Crédito 15 días", "Crédito 30 días", "Crédito 45 días"] as const;

function creditTermFromDates(issue?: string | null, due?: string | null): string {
  if (!issue || !due) return "Crédito";
  const a = new Date(issue);
  const b = new Date(due);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return "Crédito";
  const dias = Math.round((b.getTime() - a.getTime()) / 86_400_000);
  if (dias <= 7) return "Crédito";
  if (dias <= 22) return "Crédito 15 días";
  if (dias <= 37) return "Crédito 30 días";
  return "Crédito 45 días";
}

function Causar() {
  const navigate = useNavigate();
  const { id: editId } = Route.useSearch();
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
  const bulkRef = useRef<HTMLInputElement>(null);
  const [bulkFiles, setBulkFiles] = useState<File[]>([]);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkResults, setBulkResults] = useState<{ name: string; ok: boolean; detail: string }[]>([]);
  // Impuesto/retención elegido por renglón (índice -> ids)
  const [lineTax, setLineTax] = useState<Record<number, { iva?: string | undefined; ret?: string | undefined }>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [existingFile, setExistingFile] = useState<{ path: string | null; name: string | null }>({ path: null, name: null });
  const [centroSugerido, setCentroSugerido] = useState<string | null>(null);
  const [centroTocado, setCentroTocado] = useState(false);
  const [duplicado, setDuplicado] = useState<DuplicateInvoice | null>(null);

  const { data: config } = useQuery({
    queryKey: ["config", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const [rules, taxes, centers, accounts, products, categories] = await Promise.all([
        supabase.from("accounting_rules").select("*").eq("company_id", companyId!),
        supabase.from("tax_rates").select("*").eq("company_id", companyId!),
        supabase.from("cost_centers").select("*").eq("company_id", companyId!).order("code"),
        supabase.from("puc_accounts").select("code, name").eq("company_id", companyId!).order("code").range(0, 19999),
        supabase.from("products").select("code, name, kind, category, category_id, account_code, account_name").eq("company_id", companyId!).eq("active", true).order("code").range(0, 19999),
        supabase.from("product_categories").select("id, name, kind, account_code, account_name").eq("company_id", companyId!).eq("active", true).range(0, 19999),
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

  /** Borrador existente (carga individual o masiva): se abre en este mismo editor. */
  const { data: borrador } = useQuery({
    queryKey: ["invoice-edit", editId],
    enabled: !!editId && !!companyId,
    queryFn: async () => {
      const [inv, invLines] = await Promise.all([
        supabase.from("invoices").select("*").eq("id", editId!).maybeSingle(),
        supabase.from("invoice_lines").select("*").eq("invoice_id", editId!).order("position"),
      ]);
      if (inv.error) throw inv.error;
      return { invoice: inv.data, lines: invLines.data ?? [] };
    },
  });

  useEffect(() => {
    if (!borrador?.invoice || !config) return;
    if (editingId === borrador.invoice.id) return;
    const inv = borrador.invoice as Record<string, any>;
    setEditingId(inv['id'] as string);
    setExistingFile({ path: (inv['file_path'] as string) ?? null, name: (inv['file_name'] as string) ?? null });
    setHeader({
      ...emptyHeader(),
      prefix: inv['prefix'] ?? "",
      number: inv['number'] ?? "",
      issue_date: inv['issue_date'] ?? "",
      due_date: inv['due_date'] ?? "",
      provider_nit: inv['provider_nit'] ?? "",
      provider_name: inv['provider_name'] ?? "",
      provider_address: inv['provider_address'] ?? "",
      provider_city: inv['provider_city'] ?? "",
      provider_phone: inv['provider_phone'] ?? "",
      provider_email: inv['provider_email'] ?? "",
      buyer_nit: inv['buyer_nit'] ?? "",
      buyer_name: inv['buyer_name'] ?? "",
      cufe: inv['cufe'] ?? "",
      payment_form: creditTermFromDates(inv['issue_date'], inv['due_date']),
      payment_method: inv['payment_method'] ?? "",
      currency: inv['currency'] ?? "COP",
      cost_center: inv['cost_center'] ?? "",
      notes: inv['notes'] ?? "",
      subtotal: Number(inv['subtotal'] ?? 0),
      discount: Number(inv['discount'] ?? 0),
      iva: Number(inv['iva'] ?? 0),
      impoconsumo: Number(inv['impoconsumo'] ?? 0),
      total: Number(inv['total'] ?? 0),
    });
    const cargadas: Line[] = (borrador.lines as Record<string, any>[]).map((l) => ({
      code: l['code'] ?? null,
      description: l['description'] ?? "",
      quantity: Number(l['quantity'] ?? 0),
      unit_value: Number(l['unit_value'] ?? 0),
      discount: Number(l['discount'] ?? 0),
      iva: Number(l['iva'] ?? 0),
      retention: Number(l['retention'] ?? 0),
      impoconsumo: Number(l['impoconsumo'] ?? 0),
      total: Number(l['total'] ?? 0),
      account_code: l['account_code'] ?? "",
      account_name: l['account_name'] ?? "",
      item_type: normalizeItemType(l["item_type"] as string | null),
    }));
    setLines(cargadas);
    // Reconstruye la tarifa elegida por renglón a partir de los valores guardados.
    const impuestosGuardados = config.taxes ?? [];
    const seleccion: Record<number, { iva?: string | undefined; ret?: string | undefined }> = {};
    cargadas.forEach((l, i) => {
      const base = Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0);
      const ivaTax = Number(l.iva || 0)
        ? impuestosGuardados.find(
            (t) =>
              (String(t.kind) === "iva" || String(t.kind) === "impoconsumo") &&
              Math.abs(Math.round((base * Number(t.rate)) / 100) - Number(l.iva)) <= 1,
          )
        : undefined;
      const retTax = Number(l.retention || 0)
        ? impuestosGuardados.find((t) => {
            if (!String(t.kind).startsWith("rete")) return false;
            const b = String(t.kind) === "reteiva" ? Number(l.iva || 0) : base;
            return Math.abs(Math.round((b * Number(t.rate)) / 100) - Number(l.retention)) <= 1;
          })
        : undefined;
      if (ivaTax || retTax)
        seleccion[i] = { iva: ivaTax ? String(ivaTax.id) : undefined, ret: retTax ? String(retTax.id) : undefined };
    });
    setLineTax(seleccion);
  }, [borrador, config, editingId]);

  /** Cuenta del ítem: 1) cuenta propia del producto, 2) cuenta de su categoría, 3) reglas de aprendizaje. */
  const resolverCuentaItem = useCallback(
    (
      p: {
        code?: string | null;
        name?: string | null;
        kind?: string | null;
        category?: string | null;
        category_id?: string | null;
        account_code?: string | null;
        account_name?: string | null;
      },
      log = false,
    ) => {
      const r = resolveProductAccount(p, config?.categories ?? [], config?.rules ?? [], { log });
      const nombre =
        r.name || (config?.accounts ?? []).find((a) => a.code === r.code)?.name || "";
      return { code: r.code, name: nombre, origin: r.origin, error: r.error };
    },
    [config?.accounts, config?.categories, config?.rules],
  );
  /** Compatibilidad con el flujo previo: devuelve la cuenta o null. */
  const cuentaDeProducto = useCallback(
    (p: { kind?: string | null; category?: string | null; category_id?: string | null; account_code?: string | null; account_name?: string | null }) => {
      const r = resolverCuentaItem(p);
      return r.code ? { code: r.code, name: r.name } : null;
    },
    [resolverCuentaItem],
  );

  const normTxt = (s?: string | null) => (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

  /**
   * Centro de costo del proveedor: 1) elección manual, 2) proveedor,
   * 3) historial de causaciones del mismo proveedor, 4) regla contable.
   */
  useEffect(() => {
    const nit = header.provider_nit;
    if (!companyId) { setCentroSugerido(null); return; }
    let cancelado = false;
    void suggestCostCenter({ companyId, providerNit: nit }).then((s) => {
      if (cancelado || !s) return;
      setCentroSugerido(s.detail);
      console.log("[causacion] centro de costo sugerido:", { proveedor: nit, centro: s.code, origen: s.origin });
      setHeader((prev) => (centroTocado || prev.cost_center ? prev : { ...prev, cost_center: s.code }));
    });
    return () => { cancelado = true; };
  }, [companyId, header.provider_nit, centroTocado]);

  /** Busca el producto/servicio del catálogo que corresponde a un renglón. */
  const buscarProducto = useCallback(
    (l: Line, kind: string) => {
      const catalogo = (config?.products ?? []).filter((p) => normTxt(p.kind) === normTxt(kind));
      return (
        catalogo.find((p) => l.code && normTxt(p.code) === normTxt(String(l.code))) ??
        catalogo.find((p) => normTxt(p.name) === normTxt(l.description ?? ""))
      );
    },
    [config?.products],
  );

  /** Errores de configuración por renglón (categoría o cuenta PUC faltante). */
  const lineErrors = useMemo(() => {
    const out: Record<number, string> = {};
    lines.forEach((l, i) => {
      const kind = normalizeItemType(l.item_type);
      if (kind !== "producto" && kind !== "servicio") return;
      if (l.account_code) return;
      const prod = buscarProducto(l, kind);
      if (!prod) { out[i] = SIN_CUENTA_MSG; return; }
      const r = resolverCuentaItem(prod);
      if (r.error) out[i] = r.error;
    });
    return out;
  }, [lines, buscarProducto, resolverCuentaItem]);
  const hayErroresDeCuenta = Object.keys(lineErrors).length > 0;

  // Validación determinística: el NIT del comprador de la factura debe ser el de la empresa activa.
  const empresaActiva = useMemo(() => (companies ?? []).find((c) => c.id === companyId) ?? null, [companies, companyId]);
  const chequeoEmpresa = useMemo(
    () => checkInvoiceCompany(empresaActiva, { buyer_nit: header.buyer_nit, buyer_name: header.buyer_name }),
    [empresaActiva, header.buyer_nit, header.buyer_name],
  );
  const empresaIncorrecta = chequeoEmpresa.status === "mismatch";
  // Bloqueo total (guardar / aprobar / causar) cuando la factura no se puede atribuir a la empresa activa.
  const bloqueoEmpresa = motivoBloqueoEmpresa(chequeoEmpresa);
  // Solo se muestra el aviso cuando ya hay una factura cargada; el formulario vacío no debe alertar.
  const facturaConDatos = useMemo(
    () =>
      !!(
        header.buyer_nit ||
        header.number ||
        header.prefix ||
        header.provider_nit ||
        header.provider_name ||
        header.cufe ||
        lines.length > 0
      ),
    [header, lines.length],
  );
  const avisoEmpresa = facturaConDatos ? bloqueoEmpresa : null;

  /** Cambios de un renglón al cambiar su tipo de ítem, conservando la lógica producto → categoría → cuenta. */
  const parcheDeTipo = useCallback(
    (actual: Line, kind: string, log = false): Partial<Line> => {
      if (kind === "producto" || kind === "servicio") {
        const prod = buscarProducto({ ...actual, item_type: kind }, kind);
        if (!prod) return { item_type: kind };
        const r = resolverCuentaItem(prod, log);
        if (r.error && log) toast.warning(r.error);
        return { item_type: kind, code: prod.code, account_code: r.code, account_name: r.name };
      }
      const s = suggestAccount(actual.description ?? "", config?.rules ?? [], null);
      return { item_type: kind, account_code: s.code, account_name: s.name };
    },
    [buscarProducto, resolverCuentaItem, config?.rules],
  );

  /** Al cambiar el tipo de ítem se recalcula la cuenta contable según el nuevo tipo. */
  function cambiarTipo(i: number, kind: string) {
    const actual = lines[i];
    if (!actual) return;
    setLine(i, parcheDeTipo(actual, kind, true));
  }

  const baseDe = (l: Line) => Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0);

  /** Aplica el mismo tipo de ítem a todos los renglones, recalculando su cuenta. */
  function aplicarTipoTodos(kind: string) {
    setLines((prev) => prev.map((l) => ({ ...l, ...parcheDeTipo(l, kind) })));
    toast.success(`Tipo "${kind}" aplicado a todos los renglones.`);
  }

  /** Aplica el mismo impuesto (IVA/impoconsumo) a todos los renglones. */
  function aplicarIvaTodos(id: string) {
    const tx = impuestosIva.find((t) => String(t.id) === id);
    setLines((prev) => prev.map((l) => ({ ...l, iva: tx ? Math.round((baseDe(l) * Number(tx.rate)) / 100) : 0 })));
    setLineTax((prev) => {
      const out = { ...prev };
      lines.forEach((_, i) => { out[i] = { ...out[i], iva: tx ? String(tx.id) : undefined }; });
      return out;
    });
    toast.success(tx ? `${tx.name} aplicado a todos los renglones.` : "Todos los renglones quedaron sin impuesto.");
  }

  /** Aplica la misma retención a todos los renglones. */
  function aplicarRetencionTodos(id: string) {
    const tx = impuestosRet.find((t) => String(t.id) === id);
    setLines((prev) =>
      prev.map((l) => {
        const base = String(tx?.kind) === "reteiva" ? Number(l.iva || 0) : baseDe(l);
        return { ...l, retention: tx ? Math.round((base * Number(tx.rate)) / 100) : 0 };
      }),
    );
    setLineTax((prev) => {
      const out = { ...prev };
      lines.forEach((_, i) => { out[i] = { ...out[i], ret: tx ? String(tx.id) : undefined }; });
      return out;
    });
    toast.success(tx ? `${tx.name} aplicada a todos los renglones.` : "Todos los renglones quedaron sin retención.");
  }

  /** Aplica manualmente la misma cuenta PUC a todos los renglones. */
  function aplicarCuentaTodos(code: string, name: string | null) {
    setLines((prev) => prev.map((l) => ({ ...l, account_code: code, account_name: name })));
    toast.success(code ? `Cuenta ${code} aplicada a todos los renglones.` : "Cuenta retirada de todos los renglones.");
  }

  /** Aplica el mismo producto/servicio a todos los renglones, con su cuenta automática. */
  function aplicarProductoTodos(p: ProductOption) {
    const cuenta = resolverCuentaItem(p);
    if (cuenta.error) toast.warning(cuenta.error);
    setLines((prev) =>
      prev.map((l) => ({
        ...l,
        code: p.code,
        description: p.name,
        item_type: p.kind,
        account_code: cuenta.code,
        account_name: cuenta.name,
      })),
    );
    toast.success(`"${p.name}" aplicado a todos los renglones.`);
  }
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
      // Control de duplicados por empresa antes de crear cualquier borrador.
      if (companyId) {
        const existente = await findExistingInvoice(
          companyId,
          { cufe: rest.cufe, provider_nit: rest.provider_nit, prefix: rest.prefix, number: rest.number },
          editingId,
        );
        if (existente) {
          setDuplicado(existente);
          toast.error(mensajeDuplicado(existente));
          return;
        }
      }
      // La forma de pago siempre es crédito; el plazo sale de la fecha de vencimiento.
      setHeader({
        ...emptyHeader(),
        ...rest,
        payment_form: creditTermFromDates(rest.issue_date, rest.due_date),
      });
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
        const cuenta = cuentaDeProducto(prod);
        return {
          ...base,
          account_code: base.account_code || cuenta?.code || "",
          account_name: base.account_name || cuenta?.name || "",
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

  async function seleccionarMasivo(selected: FileList | null) {
    setBulkResults([]);
    if (!selected || selected.length === 0) { setBulkFiles([]); return; }
    try {
      const expanded = await expandInvoiceFiles(Array.from(selected));
      setBulkFiles(expanded);
      if (expanded.length === 0) toast.error("El archivo no contiene facturas PDF, XML, JPG o PNG.");
    } catch {
      toast.error("No fue posible abrir el archivo comprimido.");
      setBulkFiles([]);
    }
  }

  async function procesarMasivo() {
    if (!companyId || bulkFiles.length === 0 || !config) return;
    setBulkRunning(true);
    setBulkResults([]);
    let ok = 0;
    for (const f of bulkFiles) {
      try {
        const r = await processInvoiceFile({ file: f, companyId, config: config as never, extract: extract as never });
        ok += 1;
        setBulkResults((p) => [...p, { name: f.name, ok: true, detail: `${r.numero} · ${cop(r.total)}` }]);
      } catch (err) {
        setBulkResults((p) => [
          ...p,
          { name: f.name, ok: false, detail: err instanceof Error ? err.message : "Error al procesar" },
        ]);
      }
    }
    setBulkRunning(false);
    toast.success(`${ok} de ${bulkFiles.length} facturas causadas como borrador.`);
  }

  /** Al elegir un producto o servicio del catálogo se traen nombre, tipo y la cuenta de su categoría. */
  function elegirProducto(i: number, p: ProductOption) {
    const cuenta = resolverCuentaItem(p, true);
    if (cuenta.error) toast.warning(cuenta.error);
    setLine(i, {
      code: p.code,
      description: p.name,
      item_type: p.kind,
      account_code: cuenta.code,
      account_name: cuenta.name,
    });
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
      item_type: normalizeItemType(line?.item_type),
    });
    setRecordar(null);
    if (error) { toast.error(error.message); return; }
    toast.success("Regla aprendida guardada para este proveedor.");
  }

  async function guardar(status: "borrador" | "aprobado") {
    if (!companyId) return;
    if (lines.length === 0) { toast.error("Agrega al menos un renglón."); return; }
    // Se revalida al guardar y al aprobar: no basta con deshabilitar los botones.
    const bloqueo = motivoBloqueoEmpresa(
      checkInvoiceCompany(empresaActiva, { buyer_nit: header.buyer_nit, buyer_name: header.buyer_name }),
    );
    if (bloqueo) { toast.error(bloqueo); return; }
    if (status === "aprobado" && hayErroresDeCuenta) {
      toast.error(Object.values(lineErrors)[0] ?? "Hay renglones sin cuenta contable.");
      return;
    }
    if (Math.abs(t.diferencia) > 1) { toast.error("El comprobante está descuadrado."); return; }
    setSaving(true);
    try {
      const existente = await findExistingInvoice(
        companyId,
        { cufe: header.cufe, provider_nit: header.provider_nit, prefix: header.prefix, number: header.number },
        editingId,
      );
      if (existente) {
        setDuplicado(existente);
        toast.error(mensajeDuplicado(existente));
        return;
      }
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
      const payload = {
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
          buyer_nit: header.buyer_nit || null,
          buyer_name: header.buyer_name || null,
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
          // Al aprobar tras corregir, se limpia el error previo y queda pendiente de envío.
          ...(status === "aprobado" ? { siigo_status: "pendiente", siigo_error: null } : {}),
        file_path: filePath ?? existingFile.path,
        file_name: file?.name ?? existingFile.name,
      };

      let inv: { id: string };
      if (editingId) {
        const { data, error } = await supabase
          .from("invoices")
          .update(payload)
          .eq("id", editingId)
          .select("id")
          .single();
        if (error) throw error;
        inv = data as { id: string };
        await Promise.all([
          supabase.from("invoice_lines").delete().eq("invoice_id", editingId),
          supabase.from("journal_lines").delete().eq("invoice_id", editingId),
        ]);
      } else {
        const { data, error } = await supabase
          .from("invoices")
          .insert({ company_id: companyId, ...payload })
          .select("id")
          .single();
        if (error) throw error;
        inv = data as { id: string };
      }

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
            item_type: normalizeItemType(l.item_type),
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
      const msg = err instanceof Error ? err.message : "No fue posible guardar el comprobante.";
      toast.error(
        /duplicate key|ux_invoices_company/.test(msg)
          ? "Esta factura ya está registrada en esta empresa."
          : msg,
      );
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
        <h1 className="text-xl font-semibold">{editingId ? "Editar borrador" : "Causar factura"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {editingId
            ? "Ajusta cualquier dato del comprobante. Al guardar se actualiza este mismo borrador."
            : "Carga la factura (PDF, XML DIAN, JPG o PNG) y la IA propone el comprobante."}
        </p>
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

      <div className="space-y-3 rounded-lg border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
            <Layers className="size-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">Carga masiva</h2>
            <p className="text-xs text-muted-foreground">
              Sube un archivo .zip con hasta cientos de facturas (o varios archivos a la vez). Cada una se lee con IA y se
              guarda como borrador para revisarla después.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1 space-y-1.5">
            <Label htmlFor="masivo">Archivos o comprimido (.zip)</Label>
            <Input
              id="masivo"
              ref={bulkRef}
              type="file"
              multiple
              accept=".zip,.pdf,.xml,.jpg,.jpeg,.png,application/zip,application/pdf,text/xml,image/*"
              onChange={(e) => void seleccionarMasivo(e.target.files)}
            />
          </div>
          <Button onClick={() => void procesarMasivo()} disabled={bulkRunning || bulkFiles.length === 0 || !companyId}>
            {bulkRunning ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {bulkRunning
              ? `Procesando ${bulkResults.length + 1} de ${bulkFiles.length}…`
              : `Procesar ${bulkFiles.length || ""} facturas`}
          </Button>
        </div>
        {bulkFiles.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {bulkFiles.length} factura(s) detectada(s). {bulkResults.length > 0 ? `${bulkResults.length} procesada(s).` : ""}
          </p>
        ) : null}
        {bulkResults.length > 0 ? (
          <ul className="max-h-64 space-y-1 overflow-auto rounded-md border border-border p-2">
            {bulkResults.map((r, i) => (
              <li key={`${r.name}-${i}`} className="flex items-start gap-2 text-xs">
                {r.ok ? (
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                ) : (
                  <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                )}
                <span className="truncate font-medium">{r.name}</span>
                <span className="text-muted-foreground">{r.detail}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {bulkResults.some((r) => r.ok) ? (
          <Button variant="outline" onClick={() => navigate({ to: "/facturas" })}>
            Ver facturas causadas
          </Button>
        ) : null}
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
        {facturaConDatos && empresaIncorrecta && (
          <div className="sm:col-span-2 xl:col-span-4 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
            <p className="font-semibold uppercase text-destructive">Esta factura no pertenece a la empresa seleccionada</p>
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              <p>
                Empresa activa: <span className="font-medium">{empresaActiva?.name ?? "—"}</span> · NIT:{" "}
                <span className="font-medium">{empresaActiva?.nit ?? "—"}</span>
              </p>
              <p>
                Comprador de la factura: <span className="font-medium">{header.buyer_name || "—"}</span> · NIT:{" "}
                <span className="font-medium">{header.buyer_nit || "—"}</span>
              </p>
            </div>
            <p className="mt-2 text-muted-foreground">
              Verifique que haya seleccionado la empresa correcta antes de continuar.
            </p>
            <p className="mt-1 font-medium text-destructive">No es posible guardar, aprobar ni causar esta factura.</p>
          </div>
        )}
        {!empresaIncorrecta && avisoEmpresa && (
          <div className="sm:col-span-2 xl:col-span-4 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
            <p className="font-medium text-destructive">{avisoEmpresa}</p>
          </div>
        )}
        {chequeoEmpresa.status === "ok" && chequeoEmpresa.nameMismatch && (
          <div className="sm:col-span-2 xl:col-span-4 rounded-md border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
            El NIT del comprador coincide, pero la razón social de la factura ({header.buyer_name}) difiere de la empresa activa ({empresaActiva?.name}).
          </div>
        )}
        {field("Prefijo", "prefix")}
        {field("Número", "number")}
        {field("Fecha", "issue_date", "date")}
        {field("Vencimiento", "due_date", "date")}
        {field("NIT proveedor", "provider_nit")}
        {field("Proveedor", "provider_name")}
        {field("Ciudad", "provider_city")}
        {field("NIT comprador", "buyer_nit")}
        {field("Comprador", "buyer_name")}
        {field("CUFE", "cufe")}
        {field("IVA total", "iva", "number")}
        {field("Impoconsumo", "impoconsumo", "number")}
        <div className="space-y-1.5">
          <Label className="text-xs">Forma de pago</Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={
              CREDIT_TERMS.includes(String(header.payment_form ?? "") as (typeof CREDIT_TERMS)[number])
                ? String(header.payment_form)
                : "Crédito"
            }
            onChange={(e) => setHeader({ ...header, payment_form: e.target.value })}
          >
            {CREDIT_TERMS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Centro de costo</Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={header.cost_center ?? ""}
            onChange={(e) => { setCentroTocado(true); setHeader({ ...header, cost_center: e.target.value }); }}
          >
            <option value="">Sin centro de costo</option>
            {(config?.centers ?? []).map((c) => (
              <option key={c.id} value={c.code}>
                {c.code} · {c.name}
              </option>
            ))}
          </select>
          {centroSugerido && !centroTocado && (
            <p className="text-xs text-muted-foreground">{centroSugerido}</p>
          )}
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
                <th className="px-3 py-2 font-medium">
                  <span className="inline-flex items-center">
                    Descripción
                    <BulkApply title="Producto / descripción" className="w-96 space-y-2 p-3">
                      {(close) => (
                        <>
                          <ProductCombobox
                            products={((config?.products ?? []) as ProductOption[]).filter(
                              (p) => !!(p.code ?? "").trim() && !!(p.name ?? "").trim(),
                            )}
                            value=""
                            onSelect={(p) => { aplicarProductoTodos(p); close(); }}
                          />
                          <p className="text-xs normal-case tracking-normal text-muted-foreground">
                            Se aplica el producto y su cuenta contable automática a todos los renglones.
                          </p>
                        </>
                      )}
                    </BulkApply>
                  </span>
                </th>
                <th className="px-3 py-2 font-medium">
                  <span className="inline-flex items-center">
                    Tipo
                    <BulkApply title="Tipo de ítem" className="w-64 space-y-2 p-3">
                      {(close) => (
                        <div className="grid gap-1">
                          {(["producto", "servicio", "gasto"] as const).map((k) => (
                            <Button
                              key={k}
                              type="button"
                              variant="outline"
                              size="sm"
                              className="justify-start text-xs normal-case tracking-normal"
                              onClick={() => { aplicarTipoTodos(k); close(); }}
                            >
                              {k}
                            </Button>
                          ))}
                        </div>
                      )}
                    </BulkApply>
                  </span>
                </th>
                <th className="px-3 py-2 font-medium">Cant.</th>
                <th className="px-3 py-2 font-medium">Vr. unitario</th>
                <th className="px-3 py-2 font-medium">Descuento</th>
                <th className="px-3 py-2 font-medium">
                  <span className="inline-flex items-center">
                    Cuenta PUC
                    <BulkApply title="Cuenta PUC" className="w-96 space-y-2 p-3">
                      {(close) => (
                        <>
                          <AccountCombobox
                            accounts={config?.accounts ?? []}
                            value=""
                            onChange={(code, name) => { aplicarCuentaTodos(code, name); close(); }}
                          />
                          <p className="text-xs normal-case tracking-normal text-muted-foreground">
                            Asignación manual: no reemplaza la lógica automática producto → categoría → cuenta.
                          </p>
                        </>
                      )}
                    </BulkApply>
                  </span>
                </th>
                <th className="px-3 py-2 font-medium">
                  <span className="inline-flex items-center">
                    IVA
                    <BulkApply title="IVA" className="w-72 space-y-2 p-3">
                      {(close) => (
                        <select
                          className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs normal-case tracking-normal"
                          defaultValue=""
                          onChange={(e) => { aplicarIvaTodos(e.target.value); close(); }}
                        >
                          <option value="" disabled>Selecciona un impuesto…</option>
                          <option value="">Sin impuesto</option>
                          {impuestosIva.map((t) => (
                            <option key={String(t.id)} value={String(t.id)}>
                              {t.name} {Number(t.rate)}%
                            </option>
                          ))}
                        </select>
                      )}
                    </BulkApply>
                  </span>
                </th>
                <th className="px-3 py-2 font-medium">
                  <span className="inline-flex items-center">
                    Retención
                    <BulkApply title="Retención" className="w-72 space-y-2 p-3">
                      {(close) => (
                        <select
                          className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs normal-case tracking-normal"
                          defaultValue=""
                          onChange={(e) => { aplicarRetencionTodos(e.target.value); close(); }}
                        >
                          <option value="" disabled>Selecciona una retención…</option>
                          <option value="">Sin retención</option>
                          {impuestosRet.map((t) => (
                            <option key={String(t.id)} value={String(t.id)}>
                              {t.name} {Number(t.rate)}%
                            </option>
                          ))}
                        </select>
                      )}
                    </BulkApply>
                  </span>
                </th>
                <th className="px-3 py-2 text-right font-medium">Valor</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5">
                    <div className="space-y-1">
                      {(l.item_type === "producto" || l.item_type === "servicio") && (
                        <ProductCombobox
                          products={((config?.products ?? []) as ProductOption[]).filter(
                            (p) => !!(p.code ?? "").trim() && !!(p.name ?? "").trim(),
                          )}
                          kind={l.item_type}
                          value={l.code ?? ""}
                          onSelect={(p) => elegirProducto(i, p)}
                        />
                      )}
                      <Input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                    </div>
                  </td>
                  <td className="px-3 py-1.5 w-32">
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-1 text-xs"
                      value={normalizeItemType(l.item_type)}
                      onChange={(e) => cambiarTipo(i, e.target.value)}
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
                    {lineErrors[i] && <p className="mt-1 text-xs text-destructive">{lineErrors[i]}</p>}
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
          <Button
            onClick={() => guardar("borrador")}
            disabled={saving || !!bloqueoEmpresa}
            title={bloqueoEmpresa ?? undefined}
            variant="outline"
          >
            <Save className="size-4" /> Guardar borrador
          </Button>
          <Button
            onClick={() => guardar("aprobado")}
            disabled={saving || hayErroresDeCuenta || !!bloqueoEmpresa}
            title={bloqueoEmpresa ?? undefined}
          >
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

      <Dialog open={!!duplicado} onOpenChange={(o) => !o && setDuplicado(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {duplicado && estadoUnico(duplicado) === "sincronizada" ? "Factura ya sincronizada" : "Esta factura ya fue procesada"}
            </DialogTitle>
          </DialogHeader>
          {duplicado && (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">{mensajeDuplicado(duplicado)}</p>
              <dl className="space-y-1">
                <Row k="Proveedor" v={duplicado.provider_name ?? "—"} />
                <Row k="NIT" v={duplicado.provider_nit ?? "—"} />
                <Row k="Factura" v={[duplicado.prefix, duplicado.number].filter(Boolean).join("-") || "—"} />
                <Row k="Fecha" v={duplicado.issue_date ?? "—"} />
                <Row k="Total" v={cop(Number(duplicado.total ?? 0))} />
                <Row k="CUFE" v={duplicado.cufe ? `${duplicado.cufe.slice(0, 16)}…` : "—"} />
                <Row k="Estado" v={ESTADO_LABEL[estadoUnico(duplicado)] ?? estadoUnico(duplicado)} />
                {duplicado.siigo_number && <Row k="Documento Siigo" v={duplicado.siigo_number} />}
                {duplicado.siigo_synced_at && <Row k="Sincronización" v={duplicado.siigo_synced_at.slice(0, 10)} />}
              </dl>
            </div>
          )}
          <DialogFooter>
            {duplicado && estadoUnico(duplicado) !== "sincronizada" && (
              <Button
                variant="outline"
                onClick={() => {
                  const id = duplicado.id;
                  setDuplicado(null);
                  navigate({ to: "/causar", search: { id } });
                }}
              >
                Continuar con el registro existente
              </Button>
            )}
            <Button onClick={() => { setDuplicado(null); navigate({ to: "/facturas" }); }}>Ver histórico</Button>
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
