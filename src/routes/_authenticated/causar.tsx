import { captureSource, sourceFromRaw, sourceErrors, alignJournalToSource, type SourceValues } from "@/lib/source-values";
import { SourceValuesCorrection } from "@/components/source-values-correction";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FileUp, Loader2, Save, Sparkles, Trash2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { ITEM_TYPES, normalizeItemType } from "@/lib/item-type";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany, useCompanies } from "@/components/app-shell";
import { extractInvoice, type ExtractedInvoice } from "@/lib/extract.functions";
import { buildJournal, suggestAccount, totals, type Line, type Rule, type TaxRate } from "@/lib/accounting";
import {
  PAYABLE_SOURCE_LABEL,
  applyPucToPayable,
  learnPayableAccount,
  manualPayable,
  usePayableAccount,
} from "@/lib/payable-account";
import {
  applyEngineToLines,
  emptyKnowledge,
  fetchCompanyKnowledge,
  knowledgeForProvider,
  registrarAprendizaje,
  type LineDecisions,
} from "@/lib/causacion-engine";
import { buildIvaGroups, findTaxById, findSourceIvaTax, resolveImpoconsumoAccount, resolveTaxAccount, taxTrace, type TaxRecord } from "@/lib/tax-selection";
import { retencionesReportadas } from "@/lib/retenciones";
import {
  buildRetenciones,
  emptyRetBlocks,
  erroresRetenciones,
  seedRetBlocks,
  totalRetenciones,
  type RetBlocks,
  type TaxLike,
} from "@/lib/retenciones-multi";
import { RetencionesPanel } from "@/components/retenciones-panel";
import { aprenderDeCausacion, buscarRegla, fetchCompanyRules } from "@/lib/learning-rules";
import {
  applyIvaTreatment,
  fetchIvaEvidence,
  IVA_TREATMENT_LABEL,
  learnIvaTreatment,
  resolveIvaTreatment,
  useIvaConfig,
  type IvaTreatment,
  type IvaTreatmentDecision,
} from "@/lib/iva-treatment";
import { AccountCombobox } from "@/components/account-combobox";
import { CUENTA_PADRE_MSG, resolveOperationalAccount, validarCuenta, type PucAccount } from "@/lib/puc-hierarchy";
import { costCentersEnabled, costCenterForCompany, useCostCenterPolicy, validateCostCenter } from "@/lib/cost-center-config";
import { fetchCompanyPuc } from "@/lib/puc-data";
import { applyProviderRuleToLines, fetchProviderRulesCached } from "@/lib/provider-rules";
import { ProductCombobox, type ProductOption } from "@/components/product-combobox";
import { BulkApply } from "@/components/bulk-apply";
import { resolveProductAccount, SIN_CUENTA_MSG } from "@/lib/product-account";
import { suggestCostCenter } from "@/lib/cost-center";
import { checkInvoiceCompany, motivoBloqueoEmpresa } from "@/lib/company-validation";
import { cop } from "@/lib/format";
import { netoAPagarCOP, roundCOP } from "@/lib/money";
import { InvoicePdfPasswordError, prepareInvoiceFile } from "@/lib/invoice-file";
import { BulkZipProcessor } from "@/components/bulk-zip-processor";
import { IvaTreatmentPanel } from "@/components/iva-treatment-panel";
import { DraftSyncDialog, type DraftSyncRequest } from "@/components/draft-sync-dialog";
import { diffSnapshots, fetchBorradoresDelProveedor, fetchDraftSnapshot, type DraftSnapshot } from "@/lib/draft-sync";
import { useDraftsRealtime } from "@/lib/realtime-drafts";
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
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
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
  subtotal: 0, discount: 0, iva: 0, impoconsumo: 0,
  retefuente: 0, reteiva: 0, reteica: 0, total: 0,
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
  const queryClient = useQueryClient();
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
  const [source, setSource] = useState<SourceValues | null>(null);
  const [header, setHeader] = useState<Header>(emptyHeader());
  const [lines, setLines] = useState<Line[]>([]);
  // El aprendizaje ya no pregunta: se guarda automáticamente al aprobar.
  // Impuesto/retención elegido por renglón (índice -> ids)
  const [lineTax, setLineTax] = useState<Record<number, { iva?: string | undefined; ret?: string | undefined }>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [existingFile, setExistingFile] = useState<{ path: string | null; name: string | null }>({ path: null, name: null });
  const [centroSugerido, setCentroSugerido] = useState<string | null>(null);
  const [centroTocado, setCentroTocado] = useState(false);
  const [duplicado, setDuplicado] = useState<DuplicateInvoice | null>(null);
  const [plazoTocado, setPlazoTocado] = useState(false);
  // Trazabilidad de la sugerencia automática por renglón (motor de causación).
  const [decisiones, setDecisiones] = useState<LineDecisions>({});
  // Retenciones múltiples e independientes de ESTA factura.
  const [retBlocks, setRetBlocks] = useState<RetBlocks>(emptyRetBlocks());
  const [retTocado, setRetTocado] = useState(false);
  // Sincronización contable con los demás borradores del mismo proveedor.
  const [syncRequest, setSyncRequest] = useState<DraftSyncRequest | null>(null);
  const [avisoRemoto, setAvisoRemoto] = useState(false);

  // Tiempo real: si otra sesión cambia este borrador, se avisa sin recargar.
  useDraftsRealtime(companyId, () => { if (editingId) setAvisoRemoto(true); });

  // El plazo de crédito se recalcula con la fecha de vencimiento, salvo edición manual.
  useEffect(() => {
    if (plazoTocado) return;
    const term = creditTermFromDates(header.issue_date, header.due_date);
    if (term !== header.payment_form) setHeader((h) => ({ ...h, payment_form: term }));
  }, [header.issue_date, header.due_date, header.payment_form, plazoTocado]);

  const { data: config, isLoading: cargandoConfig } = useQuery({
    queryKey: ["config", companyId],
    enabled: !!companyId,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    queryFn: async () => {
      // Paginación sin tope: catálogos de cualquier tamaño (5.000, 10.000 o más registros).
      const PAGE = 1000;
      const fetchAll = async <T,>(
        run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
      ) => {
        const out: T[] = [];
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await run(from, from + PAGE - 1);
          if (error) throw new Error(error.message);
          const page = data ?? [];
          out.push(...page);
          if (page.length < PAGE) break;
        }
        return out;
      };
      const [rules, taxes, centers, accounts, products, categories] = await Promise.all([
        supabase.from("accounting_rules").select("*").eq("company_id", companyId!),
        supabase.from("tax_rates").select("*").eq("company_id", companyId!),
        supabase.from("cost_centers").select("*").eq("company_id", companyId!).order("code"),
        fetchCompanyPuc(companyId!),
        fetchAll((from, to) =>
          supabase
            .from("products")
            .select("code, name, kind, category, category_id, account_code, account_name")
            .eq("company_id", companyId!)
            .eq("active", true)
            .order("code")
            .range(from, to),
        ),
        fetchAll((from, to) =>
          supabase
            .from("product_categories")
            .select("id, name, kind, account_code, account_name")
            .eq("company_id", companyId!)
            .eq("active", true)
            .range(from, to),
        ),
      ]);
      return {
        rules: (rules.data ?? []) as Rule[],
        taxes: (taxes.data ?? []) as TaxRate[],
        centers: centers.data ?? [],
        accounts,
        products,
        categories,
      };
    },
  });

  /** Conocimiento contable de la empresa activa: reglas aprendidas + historial real. */
  const { data: knowledge } = useQuery({
    queryKey: ["knowledge", companyId],
    enabled: !!companyId,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    queryFn: () => fetchCompanyKnowledge(companyId!),
  });

  const baseGravable = useMemo(
    () =>
      roundCOP(
        lines.reduce(
          (s, l) => s + roundCOP((l.subtotal ?? roundCOP(Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0)))),
          0,
        ),
      ),
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
    setSource((inv["source_override"] as SourceValues | null) ?? sourceFromRaw(inv["raw_extraction"]));
    setEditingId(inv['id'] as string);
    setExistingFile({ path: (inv['file_path'] as string) ?? null, name: (inv['file_name'] as string) ?? null });
    // Cuenta por pagar corregida manualmente antes: se respeta y no se recalcula.
    if (inv['payable_manual'] && inv['payable_account'])
      setPayableManual({ code: String(inv['payable_account']), name: "" });
    // Otra factura: sus retenciones se vuelven a leer desde su propio documento.
    setRetTocado(false);
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
      subtotal: sourceFromRaw(inv["raw_extraction"]) ? Number(l["total"] ?? 0) : undefined,
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
    // El impuesto elegido se recupera por su identificador guardado, nunca por tarifa.
    const seleccion: Record<number, { iva?: string | undefined; ret?: string | undefined }> = {};
    (borrador.lines as Record<string, any>[]).forEach((l, i) => {
      const origin = (inv["source_override"] as SourceValues | null) ?? sourceFromRaw(inv["raw_extraction"]);
      const ivaId = l["iva_tax_id"] ? String(l["iva_tax_id"]) : findSourceIvaTax(config.taxes as unknown as TaxRecord[], origin?.lines[i])?.id;
      const retId = l["ret_tax_id"] ? String(l["ret_tax_id"]) : undefined;
      if (ivaId || retId) seleccion[i] = { iva: ivaId, ret: retId };
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
    const puc = (config?.accounts ?? []) as PucAccount[];
    lines.forEach((l, i) => {
      const kind = normalizeItemType(l.item_type);
      // La cuenta escogida debe ser cuenta de movimiento del PUC de esta empresa.
      if (l.account_code && puc.length === 0) {
        out[i] = "No hay un PUC cargado para la empresa activa. Importe o sincronice las cuentas antes de aprobar.";
        return;
      }
      if (l.account_code) {
        const check = validarCuenta(puc, l.account_code);
        if (!check.ok && check.problema) {
          out[i] = check.problema;
          return;
        }
      }
      if (kind !== "producto" && kind !== "servicio") return;
      if (l.account_code) return;
      const prod = buscarProducto(l, kind);
      if (!prod) { out[i] = SIN_CUENTA_MSG; return; }
      const r = resolverCuentaItem(prod);
      if (r.error) out[i] = r.error;
    });
    return out;
  }, [lines, buscarProducto, resolverCuentaItem, config?.accounts]);
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

  const baseDe = (l: Line) => (l.subtotal ?? roundCOP(Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0)));

  /** Aplica el mismo tipo de ítem a todos los renglones, recalculando su cuenta. */
  function aplicarTipoTodos(kind: string) {
    setLines((prev) => prev.map((l) => ({ ...l, ...parcheDeTipo(l, kind) })));
    toast.success(`Tipo "${kind}" aplicado a todos los renglones.`);
  }

  /** Aplica el mismo impuesto (IVA/impoconsumo) a todos los renglones. */
  function aplicarIvaTodos(id: string) {
    const tx = impuestosIva.find((t) => String(t.id) === id);
    if (!source) setLines((prev) => prev.map((l) => ({ ...l, iva: tx ? roundCOP((baseDe(l) * Number(tx.rate)) / 100) : 0 })));
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
        return { ...l, retention: tx ? roundCOP((base * Number(tx.rate)) / 100) : 0 };
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
  const ivaLineas = useMemo(() => roundCOP(lines.reduce((s, l) => s + roundCOP(l.iva), 0)), [lines]);
  const ivaTotal = source ? roundCOP(header.iva) : ivaLineas > 0 ? ivaLineas : roundCOP(header.iva);
  const sourceIssues = source ? sourceErrors(source) : [];
  const invoiceTotal = source ? header.total : roundCOP(baseGravable + ivaTotal + roundCOP(header.impoconsumo));
  const retencionLineas = useMemo(() => roundCOP(lines.reduce((s, l) => s + roundCOP(l.retention), 0)), [lines]);

  // Solo se aplican los impuestos/retenciones elegidos en cada renglón.
  const impuestos = config?.taxes ?? [];
  const impuestosIva = impuestos.filter((t) => String(t.kind) === "iva" || String(t.kind) === "impoconsumo");
  const impuestosRet = impuestos.filter((t) => String(t.kind).startsWith("rete"));

  // Las retenciones de la factura salen de la sección RETENCIONES: Retefuente,
  // ReteIVA y ReteICA son independientes y pueden coexistir en la misma factura.
  const retenciones = useMemo(() => buildRetenciones(retBlocks), [retBlocks]);
  const erroresRet = useMemo(() => erroresRetenciones(retBlocks), [retBlocks]);

  // Reglas contables aprendidas de ESTA empresa (estructura completa).
  const { data: reglasEmpresa } = useQuery({
    queryKey: ["learning_rules", companyId],
    enabled: !!companyId,
    queryFn: () => fetchCompanyRules(companyId!),
  });
  const reglaProveedor = useMemo(
    () =>
      buscarRegla(reglasEmpresa ?? [], {
        providerNit: header.provider_nit,
        concept: lines[0]?.description ?? null,
        itemType: lines[0]?.item_type ?? null,
      }),
    [reglasEmpresa, header.provider_nit, lines],
  );

  // Semilla: lo que reporta el documento (encabezado o renglones). Mientras el
  // usuario no edite la sección, las tres retenciones se recalculan solas.
  useEffect(() => {
    if (retTocado) return;
    const reportado = retencionesReportadas({
      header: { retefuente: header.retefuente, reteiva: header.reteiva, reteica: header.reteica },
      lineRetention: retencionLineas,
      baseGravable,
      ivaTotal,
      taxes: impuestosRet as unknown as TaxRate[],
    });
    const semilla = seedRetBlocks({
      reportado,
      baseGravable,
      ivaTotal,
      taxes: impuestosRet as unknown as TaxLike[],
      puc: (config?.accounts ?? []) as PucAccount[],
    });
    // Si la regla aprendida del proveedor ya conoce la cuenta de una retención,
    // se usa solo cuando la semilla no logró resolverla (nunca cambia valores).
    const aprendida = reglaProveedor?.rule;
    if (aprendida) {
      for (const k of ["retefuente", "reteiva", "reteica"] as const) {
        const cuenta = aprendida[`${k}_account`];
        if (semilla[k].apply && !semilla[k].account_code && cuenta) semilla[k].account_code = cuenta;
      }
    }
    setRetBlocks(semilla);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    retTocado,
    header.retefuente,
    header.reteiva,
    header.reteica,
    retencionLineas,
    baseGravable,
    ivaTotal,
    impuestosRet.length,
    config?.accounts,
    reglaProveedor?.rule.id,
  ]);

  // IVA: la cuenta sale del registro exacto del impuesto elegido en cada renglón.
  const ivaGroups = useMemo(
    () =>
      buildIvaGroups(
        lines.map((l, i) => ({
          tax: (findTaxById(impuestosIva as unknown as TaxRecord[], lineTax[i]?.iva) as TaxRecord | null),
          amount: Number(l.iva || 0),
        })),
        (config?.accounts ?? []) as PucAccount[],
      ),
    [lines, impuestosIva, lineTax, config?.accounts],
  );

  // Errores de configuración de impuestos (IVA y retenciones) del renglón.
  const erroresImpuestos = useMemo(() => {
    const puc = (config?.accounts ?? []) as PucAccount[];
    const out = [...ivaGroups.errors];
    for (const e of erroresRet) if (!out.includes(e)) out.push(e);
    void puc;
    return out;
  }, [ivaGroups.errors, erroresRet, config?.accounts]);

  // Centros de costo: dependen de la configuración de la empresa y de la cuenta contable.
  const { data: costPolicy } = useCostCenterPolicy(companyId);

  // Tratamiento contable del IVA: descontable, mayor valor del gasto o mayor valor del costo.
  // No cambia el cálculo del IVA (módulo de impuestos), solo la cuenta donde se contabiliza.
  const { data: ivaConfig } = useIvaConfig(companyId);
  const { data: ivaEvidence } = useQuery({
    queryKey: ["iva-evidence", companyId, header.provider_nit ?? ""],
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchIvaEvidence(companyId!, header.provider_nit),
  });
  const [ivaOverride, setIvaOverride] = useState<{ treatment: IvaTreatment; account: string } | null>(null);
  const ivaDecision = useMemo<IvaTreatmentDecision | null>(() => {
    if (!ivaConfig || !ivaEvidence) return null;
    return resolveIvaTreatment({
      config: ivaConfig,
      evidence: ivaEvidence,
      providerNit: header.provider_nit,
      expenseAccounts: [...new Set(lines.map((l) => String(l.account_code ?? "").trim()).filter(Boolean))],
      concepts: lines.map((l) => l.description ?? ""),
      puc: (config?.accounts ?? []) as PucAccount[],
      taxAccount: ivaGroups.groups[0]?.account_code ?? null,
    });
  }, [ivaConfig, ivaEvidence, header.provider_nit, lines, config?.accounts, ivaGroups.groups]);
  const ivaFinal = useMemo<IvaTreatmentDecision | null>(() => {
    if (!ivaDecision) return null;
    if (!ivaOverride) return ivaDecision;
    const puc = (config?.accounts ?? []) as PucAccount[];
    return {
      ...ivaDecision,
      treatment: ivaOverride.treatment,
      account: ivaOverride.account,
      accountName: puc.find((p) => p.code === ivaOverride.account)?.name ?? "",
      origin: "CORRECCION",
      reason: "Tratamiento del IVA corregido manualmente en esta factura.",
      confidence: 1,
      warning: null,
    };
  }, [ivaDecision, ivaOverride, config?.accounts]);
  const ivaDetalle = useMemo(() => applyIvaTreatment(ivaGroups.groups, ivaFinal), [ivaGroups.groups, ivaFinal]);
  /** Cuenta de IVA que realmente se contabiliza cuando el usuario la corrige o cambia el tratamiento. */
  const cuentaIvaEfectiva = useMemo(
    () =>
      ivaFinal?.account && (ivaFinal.treatment !== "descontable" || ivaFinal.origin === "CORRECCION")
        ? ivaFinal.account
        : null,
    [ivaFinal],
  );


  const usaCentros = costCentersEnabled(costPolicy ?? null);
  const erroresCentro = useMemo(
    () =>
      validateCostCenter({
        policy: costPolicy ?? null,
        accounts: (config?.accounts ?? []) as PucAccount[],
        costCenter: header.cost_center,
        lines,
      }),
    [costPolicy, config?.accounts, header.cost_center, lines],
  );
  // Contrapartida: obligación por pagar según histórico de ESTA empresa con ESTE proveedor.
  const [payableManual, setPayableManual] = useState<{ code: string; name: string } | null>(null);
  const { data: payableBase } = usePayableAccount(companyId, header.provider_nit);
  const payable = useMemo(() => {
    // Una cuenta seleccionada manualmente nunca se recalcula ni se sobrescribe.
    if (payableManual?.code) return manualPayable(payableManual.code, payableManual.name);
    return payableBase ? applyPucToPayable(payableBase, (config?.accounts ?? []) as PucAccount[]) : null;
  }, [payableBase, config?.accounts, payableManual]);
  // El impoconsumo se registra en la cuenta auxiliar configurada, nunca en la mayor.
  const impoconsumoCuenta = useMemo(
    () => resolveImpoconsumoAccount(impuestos as TaxRecord[], (config?.accounts ?? []) as PucAccount[]),
    [impuestos, config?.accounts],
  );
  const journal = useMemo(
    () =>
      ((built) => source ? alignJournalToSource(built, source, retenciones.retefuente + retenciones.reteiva + retenciones.reteica) : built)(buildJournal({
        lines,
        iva: ivaTotal,
        impoconsumo: Number(header.impoconsumo || 0),
        retenciones,
        costCenter: costCenterForCompany(costPolicy ?? null, header.cost_center),
        ivaDetalle: ivaDetalle,
        payableAccount: payable,
        impoconsumoAccount: impoconsumoCuenta,
      })),
    [source, lines, ivaTotal, header.impoconsumo, header.cost_center, retenciones, ivaDetalle, costPolicy, payable, impoconsumoCuenta],
  );
  const operationalJournal = useMemo(() => {
    const puc = (config?.accounts ?? []) as PucAccount[];
    return journal.map((line) => {
      const resolution = resolveOperationalAccount(puc, line.account_code);
      return resolution.operationalAccount ? { ...line, account_code: resolution.operationalAccount, account_name: resolution.operational?.name ?? line.account_name } : line;
    });
  }, [journal, config?.accounts]);
  const t = totals(operationalJournal);

  /** Validación contable del asiento: nivel, movimiento, auxiliares y cuenta operativa por cuenta. */
  const validacionAsiento = useMemo(() => {
    const puc = (config?.accounts ?? []) as PucAccount[];
    const codes = [...new Set(journal.map((j) => j.account_code).filter(Boolean))];
    return codes.map((code) => {
      if (puc.length === 0)
        return {
          code,
          existe: false,
          nombre: "",
          fuente: "—",
          nivel: "—",
          movimiento: false,
          activa: false,
          enSiigo: false,
          auxiliares: 0,
          operativa: code,
          resultado: "PUC SIN CARGAR" as const,
          ok: false,
          problema: "No hay un PUC cargado para la empresa activa.",
        };
      const e = resolveOperationalAccount(puc, code);
      return {
        code,
        existe: !!e.account,
        nombre: e.account?.name ?? "",
        fuente: e.account?.source ?? "—",
        nivel: e.account ? e.account.level ?? "—" : e.level ?? "—",
        movimiento: e.hasMovement,
        activa: e.active,
        enSiigo: e.siigoExists,
        auxiliares: e.candidates.length,
        operativa: e.operationalAccount ?? "—",
        resultado: e.result,
        ok: e.valid,
        problema: e.message ?? "",
      };
    });
  }, [journal, config?.accounts]);
  const asientoInvalido = validacionAsiento.some((v) => !v.ok);

  async function leer(password?: string) {
    if (!file) { toast.error("Selecciona un archivo de factura."); return; }
    setReading(true);
    try {
      const content = await prepareInvoiceFile(file, password);
      const data = (await extract({
        data: { fileName: file.name, mimeType: file.type || "application/octet-stream", ...content },
      })) as ExtractedInvoice;
      setSource(captureSource(data, "pdf"));
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
      setRetTocado(false);
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
        return prod ? { ...base, item_type: prod.kind ?? base.item_type } : base;
      });
      // Reglas del proveedor antes del historial, sin otra lectura con IA.
      const conocimiento = companyId
        ? await knowledgeForProvider(companyId, rest.provider_nit, knowledge ?? emptyKnowledge())
        : (knowledge ?? emptyKnowledge());
      const providerRules = companyId ? await fetchProviderRulesCached(companyId) : [];
      const ruled = applyProviderRuleToLines(conCatalogo, providerRules, rest.provider_nit);
      const motor = applyEngineToLines(ruled.lines, {
        providerNit: rest.provider_nit,
        knowledge: conocimiento,
        products: catalogo,
        categories: config?.categories ?? [],
        rules: config?.rules ?? [],
        puc: (config?.accounts ?? []) as PucAccount[],
        provider,
      });
      setLines(motor.lines);
      const selectedTaxes: Record<number, { iva?: string }> = {};
      const captured = captureSource(data, "pdf");
      captured.lines.forEach((line, i) => {
        const tax = findSourceIvaTax(impuestosIva as unknown as TaxRecord[], line);
        if (tax) selectedTaxes[i] = { iva: tax.id };
      });
      setLineTax(selectedTaxes);
      setDecisiones(motor.decisions);
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
    if (source && ["quantity", "unit_value", "discount", "iva", "impoconsumo", "total", "subtotal"].some(k => k in patch)) return;
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
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

  async function guardar(status: "borrador" | "aprobado") {
    if (!companyId) return;
    if (status === "aprobado" && sourceIssues[0]) { toast.error(sourceIssues[0]); return; }
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
    if (erroresImpuestos.length > 0) { toast.error(erroresImpuestos[0]!); return; }
    if (status === "aprobado" && erroresCentro.length > 0) { toast.error(erroresCentro[0]!); return; }
    if (status === "aprobado" && Math.abs(t.diferencia) >= 0.005) {
      toast.error(
        `El asiento no está cuadrado. Revise los valores tributarios y contables. Diferencia: ${cop(t.diferencia)}`,
      );
      return;
    }
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

      // Configuración contable ANTES de guardar: permite detectar exactamente
      // qué cuentas cambió el usuario en este borrador.
      const configAntes: DraftSnapshot | null =
        editingId && status === "borrador" ? await fetchDraftSnapshot(editingId) : null;

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

      // Secuencia única: LEER → CALCULAR → REDONDEAR → GUARDAR → CONTABILIZAR → ENVIAR.
      const impoconsumoTotal = roundCOP(header.impoconsumo);
      const retefuente = roundCOP(retenciones.retefuente);
      const reteiva = roundCOP(retenciones.reteiva);
      const reteica = roundCOP(retenciones.reteica);
      const total = invoiceTotal;
      const netoAPagar = netoAPagarCOP(total, retefuente + reteiva + reteica);
      console.log("[causacion] TOTAL FACTURA:", total, "RETEFUENTE:", retefuente, "RETEIVA:", reteiva,
        "RETEICA:", reteica, "NETO A PAGAR:", netoAPagar, "TOTAL DÉBITOS:", t.debito, "TOTAL CRÉDITOS:", t.credito,
        "DIFERENCIA:", t.diferencia);
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
          cost_center: costCenterForCompany(costPolicy ?? null, header.cost_center),
          notes: header.notes,
          subtotal: source ? header.subtotal : baseGravable,
          discount: roundCOP(header.discount),
          iva: ivaTotal,
          impoconsumo: impoconsumoTotal,
          retefuente,
          reteiva,
          reteica,
          total,
          status: "borrador",
          ...(source && !editingId ? { raw_extraction: { valores_origen: source, ia: { ...header, lines } } as never } : {}),
          dian_status: header.cufe ? "con CUFE" : "sin CUFE",
          // Cuenta por pagar: se determina por NIT + histórico, no por la descripción.
          ...(payable
            ? {
                payable_account: payable.code,
                payable_suggested: payableBase?.code ?? payable.code,
                payable_source: payable.source,
                payable_manual: payable.source === "manual",
                payable_confidence: payable.confidence,
                payable_updated_at: new Date().toISOString(),
              }
            : {}),
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

      const savedRows = await Promise.all([
        supabase.from("invoice_lines").insert(
          lines.map((l, i) => {
            const puc = (config?.accounts ?? []) as PucAccount[];
            const ivaTax = findTaxById(impuestosIva as unknown as TaxRecord[], lineTax[i]?.iva) as TaxRecord | null;
            const retTax = findTaxById(impuestosRet as unknown as TaxRecord[], lineTax[i]?.ret) as TaxRecord | null;
            const ivaTrace = ivaTax ? taxTrace(ivaTax, resolveTaxAccount(ivaTax, puc).code || null) : null;
            const retTrace = retTax ? taxTrace(retTax, resolveTaxAccount(retTax, puc).code || null) : null;
            return {
            invoice_id: inv.id,
            company_id: companyId,
            code: l.code ?? null,
            description: l.description,
            quantity: Number(l.quantity || 0),
            unit_value: l.unit_value,
            discount: roundCOP(l.discount),
            iva: roundCOP(l.iva),
            retention: roundCOP(l.retention),
            impoconsumo: roundCOP(l.impoconsumo),
            total: roundCOP(l.subtotal ?? l.total),
            account_code: l.account_code ?? null,
            account_name: l.account_name ?? null,
            item_type: normalizeItemType(l.item_type),
            position: i,
            iva_tax_id: ivaTrace?.tax_id ?? null,
            iva_tax_name: ivaTrace?.tax_name ?? null,
            iva_tax_rate: ivaTrace?.tax_rate ?? null,
            // La cuenta de IVA guardada es la realmente usada en el asiento
            // (incluida la corrección manual), para que la sincronización la detecte.
            iva_account_code: cuentaIvaEfectiva ?? ivaTrace?.account_code ?? null,
            iva_operational_account: cuentaIvaEfectiva ?? ivaTrace?.operational_account ?? null,

            iva_siigo_id: ivaTrace?.siigo_id ?? null,
            iva_siigo_name: ivaTrace?.siigo_name ?? null,
            ret_tax_id: retTrace?.tax_id ?? null,
            ret_tax_kind: retTrace?.tax_type ?? null,
            ret_tax_name: retTrace?.tax_name ?? null,
            ret_tax_rate: retTrace?.tax_rate ?? null,
            ret_account_code: retTrace?.account_code ?? null,
            ret_operational_account: retTrace?.operational_account ?? null,
            ret_siigo_id: retTrace?.siigo_id ?? null,
            ret_siigo_name: retTrace?.siigo_name ?? null,
            };
          }),
        ),
        supabase.from("journal_lines").insert(
          operationalJournal.map((j, i) => ({
            invoice_id: inv.id,
            company_id: companyId,
            account_code: j.account_code,
            account_name: j.account_name,
            debit: roundCOP(j.debit),
            credit: roundCOP(j.credit),
            cost_center: usaCentros ? (j.cost_center ?? null) : null,
            position: i,
          })),
        ),
      ]);

      for (const result of savedRows) if (result.error) throw result.error;
      // Cuenta elegida por el usuario: queda registrada como MANUAL para que ningún
      // recálculo (reglas, historial) la vuelva a cambiar y se muestre su origen real.
      if (editingId) {
        const { data: cur } = await supabase.from("invoices").select("raw_extraction").eq("id", inv.id).maybeSingle();
        const raw = (cur?.raw_extraction ?? {}) as Record<string, unknown>;
        const prev = (raw["account_decisions"] ?? {}) as Record<string, { code?: string; origin?: string }>;
        const next: Record<string, unknown> = { ...prev };
        let changed = false;
        lines.forEach((l, i) => {
          const code = l.account_code ?? "";
          if (code && prev[i]?.code !== code) {
            next[i] = { code, name: l.account_name ?? null, origin: "MANUAL", reason: "Cuenta elegida por el usuario", confidence: "ALTA", score: 1, error: null };
            changed = true;
          }
        });
        if (changed) await supabase.from("invoices").update({ raw_extraction: { ...raw, account_decisions: next } as never }).eq("id", inv.id);
      }
      void queryClient.invalidateQueries({ queryKey: ["ds"] });
      if (status === "aprobado") {
        const approved = await supabase.from("invoices").update({ status: "aprobado" }).eq("id", inv.id);
        if (approved.error) throw approved.error;
      }

      // El aprendizaje solo se registra cuando la causación queda aprobada.
      if (status === "aprobado") {
        // Aprendizaje: cuenta por pagar aprobada para este proveedor en esta empresa.
        await learnPayableAccount(companyId, header.provider_nit, payable?.code);
        await registrarAprendizaje({
          companyId,
          invoiceId: inv.id,
          userId,
          providerNit: header.provider_nit,
          providerName: header.provider_name,
          costCenter: costCenterForCompany(costPolicy ?? null, header.cost_center),
          lines,
          decisions: decisiones,
          puc: (config?.accounts ?? []) as PucAccount[],
          autoLearning,
        });
        // Regla contable integral: toda la estructura aprobada (cuenta, centro de
        // costo, IVA y su tratamiento, retenciones, CxP y forma de pago).
        if (autoLearning) {
          try {
            await aprenderDeCausacion({
              companyId,
              invoiceId: inv.id,
              userId,
              providerNit: header.provider_nit,
              providerName: header.provider_name,
              costCenter: costCenterForCompany(costPolicy ?? null, header.cost_center),
              lines,
              retBlocks,
              ivaTreatment: ivaFinal?.treatment ?? null,
              ivaAccount: ivaFinal?.account || ivaDetalle[0]?.account_code || null,
              ivaRate: Number(lines[0]?.iva ?? 0) || null,
              payableAccount: payable?.code ?? null,
              paymentForm: header.payment_form || null,
            });
          } catch (e) {
            // El aprendizaje nunca debe impedir la aprobación de la factura.
            console.warn("[aprendizaje] no se pudo guardar la regla", e);
          }
        }
        // Aprendizaje del tratamiento del IVA con el contexto de la operación
        // (proveedor + cuenta de gasto/costo + concepto), nunca como regla global.
        if (ivaFinal && ivaTotal > 0) {
          const cuentaIva = ivaFinal.account || ivaDetalle[0]?.account_code || "";
          await learnIvaTreatment({
            companyId,
            userId: userId ?? null,
            providerNit: header.provider_nit,
            concept: lines[0]?.description ?? null,
            expenseAccount: lines[0]?.account_code ?? null,
            ivaAccount: cuentaIva,
            treatment: ivaFinal.treatment,
          });
        }
      }

      toast.success(status === "aprobado" ? "Comprobante aprobado." : "Comprobante guardado en borrador.");

      // ¿La configuración contable cambió y hay más borradores del mismo proveedor?
      if (configAntes && editingId) {
        try {
          const cambios = diffSnapshots(configAntes, await fetchDraftSnapshot(editingId));
          if (cambios.length > 0) {
            const otros = await fetchBorradoresDelProveedor({
              companyId,
              providerNit: header.provider_nit,
              excludeInvoiceId: editingId,
            });
            if (otros.length > 0) {
              setSyncRequest({
                companyId,
                invoiceId: editingId,
                invoiceLabel: [header.prefix, header.number].filter(Boolean).join("-") || "Sin número",
                providerNit: header.provider_nit || null,
                providerName: header.provider_name || null,
                changes: cambios,
                drafts: otros,
              });
              return; // la navegación ocurre al cerrar la confirmación
            }
          }
        } catch (e) {
          console.warn("[sincronizacion] no fue posible revisar los borradores del proveedor", e);
        }
      }
      navigate({ to: "/borradores" });
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
        readOnly={!!source && ["subtotal", "discount", "iva", "impoconsumo", "total"].includes(key)}
        value={String(header[key] ?? "")}
        onChange={(e) => setHeader({ ...header, [key]: type === "number" ? Number(e.target.value) : e.target.value })}
      />
    </div>
  );

  return (
    <div className="space-y-6">
      {sourceIssues.map(issue => <p key={issue} className="text-sm text-destructive">{source?.source === "pdf" ? "Revisar lectura del PDF. " : ""}{issue}</p>)}
      {source && editingId && companyId && <SourceValuesCorrection source={source} invoiceId={editingId} companyId={companyId} />}
      {borrador?.invoice?.["value_modified"] && <p className="text-sm text-destructive">Valor modificado manualmente</p>}
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
        <Button disabled={!!source} variant="outline" onClick={() => setLines((p) => [...p, emptyLine()])}>
          <FileUp className="size-4" /> Renglón manual
        </Button>
      </div>

      <BulkZipProcessor
        companyId={companyId ?? ""}
        config={config as never}
        knowledge={knowledge}
        extract={extract as never}
        loadingConfig={cargandoConfig}
      />

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
            onChange={(e) => { setPlazoTocado(true); setHeader({ ...header, payment_form: e.target.value }); }}
          >
            {CREDIT_TERMS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        {usaCentros && (
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
          {erroresCentro.map((e, i) => (
            <p key={i} className="text-xs text-destructive">{e}</p>
          ))}
        </div>
        )}
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
                    <Input readOnly={!!source} type="number" value={l.quantity} onChange={(e) => setLine(i, { quantity: Number(e.target.value) })} />
                  </td>
                  <td className="px-3 py-1.5 w-32">
                    <Input readOnly={!!source} type="number" value={l.unit_value} onChange={(e) => setLine(i, { unit_value: Number(e.target.value) })} />
                  </td>
                  <td className="px-3 py-1.5 w-28">
                    <Input readOnly={!!source} type="number" value={l.discount} onChange={(e) => setLine(i, { discount: Number(e.target.value) })} />
                  </td>
                  <td className="px-3 py-1.5 w-56">
                    <AccountCombobox
                      accounts={config?.accounts ?? []}
                      value={l.account_code ?? ""}
                      onChange={(code, name) => {
                        setLine(i, { account_code: code, account_name: name });
                      }}
                    />
                    {lineErrors[i] && <p className="mt-1 text-xs text-destructive">{lineErrors[i]}</p>}
                    {decisiones[i]?.code && (
                      <p
                        className={`mt-1 text-xs ${
                          decisiones[i]!.confidence === "ALTA"
                            ? "text-primary"
                            : decisiones[i]!.confidence === "MEDIA"
                              ? "text-foreground"
                              : "text-muted-foreground"
                        }`}
                      >
                        Confianza {decisiones[i]!.confidence} · {decisiones[i]!.origin}: {decisiones[i]!.reason}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-1.5 w-56">
                    <div className="flex items-center gap-1">
                      <Input
                        className="w-24"
                        type="number"
                        readOnly={!!source}
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
                          const base = (l.subtotal ?? roundCOP(Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0)));
                          if (!source) setLine(i, { iva: tx ? roundCOP((base * Number(tx.rate)) / 100) : 0 });
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
                          const base = (l.subtotal ?? roundCOP(Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0)));
                          const baseRet = String(tx?.kind) === "reteiva" ? Number(l.iva || 0) : base;
                          setLine(i, { retention: tx ? roundCOP((baseRet * Number(tx.rate)) / 100) : 0 });
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
                    {cop((l.subtotal ?? roundCOP(Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0))))}
                  </td>
                  <td className="px-3 py-1.5">
                    <Button disabled={!!source} variant="ghost" size="icon" onClick={() => setLines((p) => p.filter((_, idx) => idx !== i))}>
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
              <Row k="Retefuente" v={retBlocks.retefuente.apply ? cop(retenciones.retefuente) : "—"} />
              <Row k="ReteIVA" v={retBlocks.reteiva.apply ? cop(retenciones.reteiva) : "—"} />
              <Row k="ReteICA" v={retBlocks.reteica.apply ? cop(retenciones.reteica) : "—"} />
              <Row k="Total retenciones" v={cop(totalRetenciones(retBlocks))} />
              <Row k="Total factura" v={cop(invoiceTotal)} />
              <Row
                k="Neto a pagar"
                v={cop(
                  netoAPagarCOP(
                    invoiceTotal,
                    totalRetenciones(retBlocks),
                  ),
                )}
              />
            </dl>
          </div>

          <RetencionesPanel
            blocks={retBlocks}
            taxes={impuestosRet as unknown as TaxLike[]}
            accounts={(config?.accounts ?? []) as PucAccount[]}
            baseGravable={baseGravable}
            ivaTotal={ivaTotal}
            errors={erroresRet}
            onChange={(next) => { setRetTocado(true); setRetBlocks(next); }}
          />

          <IvaTreatmentPanel
            decision={ivaFinal}
            ivaTotal={ivaTotal}
            accounts={(config?.accounts ?? []) as PucAccount[]}
            overridden={!!ivaOverride}
            onChange={(v) => setIvaOverride(v)}
            onReset={() => setIvaOverride(null)}
          />

          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="border-b border-border px-5 py-3 text-sm font-semibold">Comprobante contable</div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {operationalJournal.map((j, i) => (
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
                    {Math.abs(t.diferencia) < 0.005 ? "Comprobante cuadrado" : `Descuadre ${cop(t.diferencia)}`}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{cop(t.debito)}</td>
                  <td className="px-4 py-2 text-right font-mono">{cop(t.credito)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {lines.length > 0 && journal.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border px-5 py-3 text-sm font-semibold">Validación contable</div>
          {payable && (
            <div className="flex flex-wrap items-end gap-4 border-b border-border px-5 py-4">
              <div className="min-w-[280px] flex-1">
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  Cuenta por pagar del proveedor (NIT {header.provider_nit || "sin NIT"})
                </p>
                <AccountCombobox
                  accounts={config?.accounts ?? []}
                  value={payable.code}
                  onChange={(code, name) => setPayableManual(code ? { code, name: name ?? "" } : null)}
                />
              </div>
              <div className="text-xs text-muted-foreground">
                <p>
                  Origen: <span className="font-medium text-foreground">{PAYABLE_SOURCE_LABEL[payable.source]}</span>
                </p>
                <p>{payable.reason}</p>
                {payable.warning && <p className="text-destructive">{payable.warning}</p>}
                {payableManual && (
                  <button type="button" className="mt-1 underline" onClick={() => setPayableManual(null)}>
                    Volver a la cuenta sugerida por el histórico
                  </button>
                )}
              </div>
            </div>
          )}
          {erroresImpuestos.length > 0 && (
            <ul className="list-disc space-y-1 border-b border-border bg-destructive/5 px-8 py-3 text-xs text-destructive">
              {erroresImpuestos.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Cuenta solicitada</th>
                <th className="px-4 py-2 text-left font-medium">PUC</th>
                <th className="px-4 py-2 text-left font-medium">Nivel</th>
                <th className="px-4 py-2 text-left font-medium">Movimiento</th>
                <th className="px-4 py-2 text-left font-medium">Activa</th>
                <th className="px-4 py-2 text-left font-medium">Siigo</th>
                <th className="px-4 py-2 text-left font-medium">Auxiliares</th>
                <th className="px-4 py-2 text-left font-medium">Cuenta operativa</th>
                <th className="px-4 py-2 text-left font-medium">Resultado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {validacionAsiento.map((v) => (
                <tr key={v.code}>
                  <td className="px-4 py-1.5 font-mono text-xs">{v.code}</td>
                  <td className="px-4 py-1.5 text-xs">
                    {v.existe ? `Sí · ${v.nombre || "Sin nombre"} · ${v.fuente}` : "No"}
                  </td>
                  <td className="px-4 py-1.5 text-xs capitalize">{v.nivel}</td>
                  <td className="px-4 py-1.5 text-xs">{v.movimiento ? "Sí" : "No"}</td>
                  <td className="px-4 py-1.5 text-xs">{v.activa ? "Sí" : "No"}</td>
                  <td className="px-4 py-1.5 text-xs">{v.enSiigo ? "Sí" : "No"}</td>
                  <td className="px-4 py-1.5 text-xs">{v.auxiliares > 0 ? `Sí (${v.auxiliares})` : "No"}</td>
                  <td className="px-4 py-1.5 font-mono text-xs">{v.operativa}</td>
                  <td className={`px-4 py-1.5 text-xs ${v.ok ? "text-success" : "text-destructive"}`}>
                    {v.ok ? (v.resultado === "RESUELTA A AUXILIAR" ? "✓ RESUELTA A AUXILIAR" : "✓ VÁLIDA") : `⚠ ${v.resultado} · ${v.problema}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
            disabled={saving || hayErroresDeCuenta || asientoInvalido || !!bloqueoEmpresa || erroresCentro.length > 0}
            title={bloqueoEmpresa ?? undefined}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Aprobar comprobante
          </Button>
        </div>
      )}

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

      <DraftSyncDialog
        request={syncRequest}
        onClose={() => { setSyncRequest(null); navigate({ to: "/borradores" }); }}
      />

      {avisoRemoto && (
        <div className="fixed bottom-4 right-4 z-50 rounded-lg border border-border bg-card px-4 py-2 text-xs shadow-lg">
          Este borrador cambió en otra sesión.{" "}
          <button type="button" className="font-medium text-primary underline" onClick={() => window.location.reload()}>
            Ver los datos actualizados
          </button>
        </div>
      )}
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
