import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  PackageSearch,
  Send,
  Sparkles,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { fetchCompanyPuc } from "@/lib/puc-data";
import { resolveOperationalAccount, type PucAccount } from "@/lib/puc-hierarchy";
import { useActiveCompany } from "@/lib/active-company";
import { buildJournal, totals, type JournalLine, type Retenciones } from "@/lib/accounting";
import { applyPucToPayable, learnPayableAccount, usePayableAccount } from "@/lib/payable-account";
import { aprenderDeCausacion } from "@/lib/learning-rules";
import {
  buildIvaGroups,
  findTaxById,
  resolveImpoconsumoAccount,
  resolveTaxAccount,
  taxTrace,
  type TaxRecord,
} from "@/lib/tax-selection";
import {
  applyIvaTreatment,
  fetchIvaEvidence,
  learnIvaTreatment,
  resolveIvaTreatment,
  useIvaConfig,
  type IvaTreatment,
  type IvaTreatmentDecision,
} from "@/lib/iva-treatment";
import { IvaTreatmentPanel } from "@/components/iva-treatment-panel";
import { retencionesReportadas } from "@/lib/retenciones";
import {
  buildRetenciones,
  emptyRetBlocks,
  erroresRetenciones,
  seedRetBlocks,
  totalRetenciones,
  type RetBlocks,
  type TaxLike as TaxLikeRet,
} from "@/lib/retenciones-multi";
import { RetencionesPanel } from "@/components/retenciones-panel";
import { type LearningRule } from "@/lib/learning";
import { ITEM_TYPES, isValidItemType, normalizeItemType } from "@/lib/item-type";
import { cop, fecha } from "@/lib/format";
import { netoAPagarCOP, roundCOP } from "@/lib/money";
import { suggestCostCenter } from "@/lib/cost-center";
import {
  costCentersEnabled,
  costCenterForCompany,
  useCostCenterPolicy,
  validateCostCenter,
} from "@/lib/cost-center-config";
import { checkInvoiceCompany, motivoBloqueoEmpresa } from "@/lib/company-validation";
import { siigoCreateProduct, siigoFindProduct, siigoSyncInvoice } from "@/lib/siigo.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/revisar")({
  validateSearch: (search: Record<string, unknown>) => ({ id: String(search["id"] ?? "") }),
  head: () => ({
    meta: [
      { title: "Revisar y causar factura en Siigo" },
      {
        name: "description",
        content:
          "Valida cuentas, centros de costo, impuestos y retenciones antes de enviar el comprobante contable a Siigo.",
      },
      { property: "og:title", content: "Revisar y causar factura en Siigo" },
      {
        property: "og:description",
        content: "Revisión previa, validaciones y resumen contable antes de sincronizar.",
      },
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
  buyer_nit: string | null;
  buyer_name: string | null;
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
  iva_tax_id?: string | null;
  ret_tax_id?: string | null;
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
  const [ok, setOk] = useState<{
    number: string | null;
    id: string | null;
    date: string | null;
    url: string | null;
  } | null>(null);
  const [inventario, setInventario] = useState<{
    index: number;
    query: string;
    results: { id: string; code: string; name: string }[] | null;
    busy: boolean;
  } | null>(null);
  const [centroSugerido, setCentroSugerido] = useState<string | null>(null);
  const [centroTocado, setCentroTocado] = useState(false);
  // Cuentas confirmadas contra la base (company_id + código) cuando no vienen en el listado local.
  const [cuentasVerificadas, setCuentasVerificadas] = useState<
    Record<string, { exists: boolean; name: string | null }>
  >({});
  // Retenciones múltiples e independientes de ESTA factura.
  const [retBlocks, setRetBlocks] = useState<RetBlocks>(emptyRetBlocks());
  const [retTocado, setRetTocado] = useState(false);

  const { data } = useQuery({
    queryKey: ["revisar", id],
    enabled: !!id,
    queryFn: async () => {
      const [inv, ln, centers, accounts, learning, taxes] = await Promise.all([
        supabase.from("invoices").select("*").eq("id", id).single(),
        supabase.from("invoice_lines").select("*").eq("invoice_id", id).order("position"),
        supabase
          .from("cost_centers")
          .select("code, name")
          .eq("company_id", companyId ?? "")
          .order("code"),
        fetchCompanyPuc(companyId ?? ""),
        supabase
          .from("learning_rules")
          .select("*")
          .eq("company_id", companyId ?? ""),
        supabase
          .from("tax_rates")
          .select("*")
          .eq("company_id", companyId ?? "")
          .order("name"),
      ]);
      if (inv.error) throw inv.error;
      const company = await supabase
        .from("companies")
        .select("id, name, nit")
        .eq("id", companyId ?? "")
        .maybeSingle();
      return {
        invoice: inv.data as unknown as InvRow,
        company: company.data ?? null,
        lines: (ln.data ?? []) as unknown as LineRow[],
        centers: centers.data ?? [],
        accounts,
        learning: (learning.data ?? []) as unknown as LearningRule[],
        taxes: (taxes.data ?? []) as unknown as TaxRecord[],
      };
    },
  });

  useEffect(() => {
    if (data) {
      setHeader(data.invoice);
      // Una sola fuente de verdad: el tipo de ítem se normaliza al cargar y nunca se degrada a gasto.
      setLines(data.lines.map((l) => ({ ...l, item_type: normalizeItemType(l.item_type) })));
      setRetTocado(false);
    }
  }, [data]);

  /** Verifica en la base las cuentas de los renglones que no están en el listado cargado. */
  useEffect(() => {
    const company = header?.company_id;
    if (!company) return;
    const conocidas = new Set((data?.accounts ?? []).map((a) => a.code));
    const faltantes = [
      ...new Set(lines.map((l) => l.account_code).filter((c): c is string => !!c)),
    ].filter((c) => !conocidas.has(c) && !(c in cuentasVerificadas));
    if (faltantes.length === 0) return;
    let cancelado = false;
    void supabase
      .from("puc_accounts")
      .select("code, name")
      .eq("company_id", company)
      .in("code", faltantes)
      .then(({ data: rows }) => {
        if (cancelado) return;
        const encontrado = new Map(
          (rows ?? []).map((r) => [r.code as string, (r.name ?? null) as string | null]),
        );
        setCuentasVerificadas((prev) => {
          const next = { ...prev };
          for (const code of faltantes) {
            next[code] = encontrado.has(code)
              ? { exists: true, name: encontrado.get(code) ?? null }
              : { exists: false, name: null };
          }
          return next;
        });
      });
    return () => {
      cancelado = true;
    };
  }, [lines, data?.accounts, header?.company_id, cuentasVerificadas]);

  /** Centro de costo sugerido por el historial del proveedor en esta empresa. */
  useEffect(() => {
    const nit = header?.provider_nit;
    const company = header?.company_id;
    if (!company || !nit) return;
    let cancelado = false;
    void suggestCostCenter({ companyId: company, providerNit: nit }).then((s) => {
      if (cancelado || !s) return;
      setCentroSugerido(s.detail);
      console.log("[revision] centro de costo sugerido:", {
        proveedor: nit,
        centro: s.code,
        origen: s.origin,
      });
      setHeader((prev) =>
        !prev || centroTocado || prev.cost_center ? prev : { ...prev, cost_center: s.code },
      );
    });
    return () => {
      cancelado = true;
    };
  }, [header?.provider_nit, header?.company_id, centroTocado]);

  const base = useMemo(
    () =>
      roundCOP(
        lines.reduce(
          (s, l) =>
            s +
            roundCOP(Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0)),
          0,
        ),
      ),
    [lines],
  );

  const impuestos = (data?.taxes ?? []) as TaxRecord[];
  const impuestosIva = impuestos.filter(
    (t) => String(t.kind) === "iva" || String(t.kind) === "impoconsumo",
  );
  const impuestosRet = impuestos.filter((t) => String(t.kind).startsWith("rete"));
  const puc = (data?.accounts ?? []) as PucAccount[];

  // Retefuente, ReteIVA y ReteICA son independientes y pueden coexistir.
  const retenciones: Retenciones = useMemo(() => buildRetenciones(retBlocks), [retBlocks]);
  const erroresRet = useMemo(() => erroresRetenciones(retBlocks), [retBlocks]);
  const ivaHeader = roundCOP(header?.iva ?? 0);
  const retLineas = useMemo(
    () => roundCOP(lines.reduce((s, l) => s + roundCOP(l.retention), 0)),
    [lines],
  );

  // Semilla desde la factura guardada; el usuario puede corregirla libremente.
  useEffect(() => {
    if (retTocado || !header) return;
    const reportado = retencionesReportadas({
      header: { retefuente: header.retefuente, reteiva: header.reteiva, reteica: header.reteica },
      lineRetention: retLineas,
      baseGravable: base,
      ivaTotal: ivaHeader,
      taxes: impuestosRet as never,
    });
    setRetBlocks(
      seedRetBlocks({
        reportado,
        baseGravable: base,
        ivaTotal: ivaHeader,
        taxes: impuestosRet as unknown as TaxLikeRet[],
        puc,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    retTocado,
    header?.id,
    header?.retefuente,
    header?.reteiva,
    header?.reteica,
    retLineas,
    base,
    ivaHeader,
    impuestosRet.length,
    puc,
  ]);

  const ivaGroups = useMemo(
    () =>
      buildIvaGroups(
        lines.map((l) => ({
          tax: findTaxById(impuestosIva, l.iva_tax_id),
          amount: Number(l.iva || 0),
        })),
        puc,
      ),
    [lines, impuestosIva, puc],
  );

  // Centros de costo condicionales por empresa y por cuenta contable.
  const { data: costPolicy } = useCostCenterPolicy(companyId);
  const usaCentros = costCentersEnabled(costPolicy ?? null);

  // Tratamiento contable del IVA de esta factura (descontable, gasto o costo).
  const { data: ivaConfig } = useIvaConfig(companyId);
  const { data: ivaEvidence } = useQuery({
    queryKey: ["iva-evidence", companyId, header?.provider_nit ?? ""],
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchIvaEvidence(companyId!, header?.provider_nit ?? null),
  });
  const [ivaOverride, setIvaOverride] = useState<{
    treatment: IvaTreatment;
    account: string;
  } | null>(null);
  const ivaDecision = useMemo<IvaTreatmentDecision | null>(() => {
    if (!ivaConfig || !ivaEvidence) return null;
    return resolveIvaTreatment({
      config: ivaConfig,
      evidence: ivaEvidence,
      providerNit: header?.provider_nit ?? null,
      expenseAccounts: [
        ...new Set(lines.map((l) => String(l.account_code ?? "").trim()).filter(Boolean)),
      ],
      concepts: lines.map((l) => l.description ?? ""),
      puc,
      taxAccount: ivaGroups.groups[0]?.account_code ?? null,
    });
  }, [ivaConfig, ivaEvidence, header?.provider_nit, lines, puc, ivaGroups.groups]);
  const ivaFinal = useMemo<IvaTreatmentDecision | null>(() => {
    if (!ivaDecision) return null;
    if (!ivaOverride) return ivaDecision;
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
  }, [ivaDecision, ivaOverride, puc]);
  const ivaDetalle = useMemo(
    () => applyIvaTreatment(ivaGroups.groups, ivaFinal),
    [ivaGroups.groups, ivaFinal],
  );

  const erroresImpuestos = useMemo(() => {
    const out = [...ivaGroups.errors];
    for (const e of erroresRet) if (!out.includes(e)) out.push(e);
    return out;
  }, [ivaGroups.errors, erroresRet]);

  // Contrapartida: obligación por pagar de esta empresa con este proveedor.
  const { data: payableBase } = usePayableAccount(companyId, header?.provider_nit);
  const payable = useMemo(
    () => (payableBase ? applyPucToPayable(payableBase, puc) : null),
    [payableBase, puc],
  );
  // El impoconsumo se registra en la cuenta auxiliar configurada, nunca en la mayor.
  const impoconsumoCuenta = useMemo(() => resolveImpoconsumoAccount(impuestos, puc), [impuestos, puc]);
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
        costCenter: costCenterForCompany(costPolicy ?? null, header?.cost_center),
        ivaDetalle: ivaDetalle,
        payableAccount: payable,
        impoconsumoAccount: impoconsumoCuenta,
      }),
    [
      lines,
      header?.iva,
      header?.impoconsumo,
      header?.cost_center,
      retenciones,
      ivaDetalle,
      costPolicy,
      payable,
      impoconsumoCuenta,
    ],
  );
  const operationalJournal = useMemo(() => {
    const puc = (data?.accounts ?? []) as PucAccount[];
    return journal.map((line) => {
      const resolution = resolveOperationalAccount(puc, line.account_code);
      return resolution.operationalAccount
        ? {
            ...line,
            account_code: resolution.operationalAccount,
            account_name: resolution.operational?.name ?? line.account_name,
          }
        : line;
    });
  }, [journal, data?.accounts]);
  const t = totals(operationalJournal);

  const errores = useMemo(() => {
    const e: string[] = [];
    if (!header) return e;
    // Segunda barrera: la factura debe pertenecer a la empresa activa (NIT del comprador).
    const bloqueo = motivoBloqueoEmpresa(checkInvoiceCompany(data?.company ?? null, header));
    if (bloqueo) e.push(bloqueo);
    if (!header.provider_nit) e.push("Falta el NIT del proveedor.");
    if (lines.length === 0) e.push("La factura no tiene renglones.");
    const pucCodes = new Set((data?.accounts ?? []).map((a) => a.code));
    lines.forEach((l, i) => {
      if (!l.account_code) e.push(`Renglón ${i + 1}: falta la cuenta contable.`);
      else {
        const resolution = resolveOperationalAccount(
          (data?.accounts ?? []) as PucAccount[],
          l.account_code,
        );
        if (!resolution.valid) {
          e.push(
            `Renglón ${i + 1}: ${resolution.message ?? `la cuenta ${l.account_code} no es operativa.`}`,
          );
          return;
        }
        const verificada = cuentasVerificadas[l.account_code];
        // Solo se marca inexistente cuando la base confirmó que no está (company_id + código).
        if (!pucCodes.has(l.account_code) && verificada && !verificada.exists) {
          e.push(
            `Renglón ${i + 1}: la cuenta ${l.account_code} no existe en el PUC de la empresa.`,
          );
        }
      }
      if (!isValidItemType(l.item_type)) e.push(`Renglón ${i + 1}: tipo de ítem inválido.`);
      const tipo = normalizeItemType(l.item_type);
      if ((tipo === "producto" || tipo === "servicio") && !String(l.code ?? "").trim()) {
        e.push(
          `Renglón ${i + 1}: el producto no tiene código válido de Siigo. Sincronice los productos con Siigo antes de causar.`,
        );
      }
    });
    e.push(
      ...validateCostCenter({
        policy: costPolicy ?? null,
        accounts: (data?.accounts ?? []) as PucAccount[],
        costCenter: header.cost_center,
        lines,
      }),
    );
    if (Number(header.iva) < 0) e.push("El IVA no puede ser negativo.");
    e.push(...erroresImpuestos);
    if (retenciones.retefuente < 0 || retenciones.reteiva < 0 || retenciones.reteica < 0)
      e.push("Las retenciones no pueden ser negativas.");
    if (Math.abs(t.diferencia) >= 0.005)
      e.push(
        `El asiento no está cuadrado. Revise los valores tributarios y contables. Diferencia: ${cop(t.diferencia)}`,
      );
    if (base <= 0) e.push("La base gravable debe ser mayor a cero.");
    return e;
  }, [
    header,
    lines,
    data?.accounts,
    data?.company,
    cuentasVerificadas,
    retenciones,
    t.diferencia,
    base,
    erroresImpuestos,
    costPolicy,
  ]);

  async function guardarCambios() {
    if (!header) return;
    const { error: invoiceError } = await supabase
      .from("invoices")
      .update({
        cost_center: costCenterForCompany(costPolicy ?? null, header.cost_center),
        payment_form: header.payment_form,
        notes: header.notes,
        iva: roundCOP(header.iva),
        retefuente: roundCOP(retenciones.retefuente),
        reteiva: roundCOP(retenciones.reteiva),
        reteica: roundCOP(retenciones.reteica),
        subtotal: base,
        total: roundCOP(base + roundCOP(header.iva) + roundCOP(header.impoconsumo)),
      })
      .eq("id", header.id);
    if (invoiceError)
      throw new Error(
        `No se pudieron guardar las retenciones de la factura: ${invoiceError.message}`,
      );

    const lineUpdates = await Promise.all(
      lines.map((l) =>
        supabase
          .from("invoice_lines")
          .update(
            (() => {
              const ivaTax = findTaxById(impuestosIva, l.iva_tax_id);
              // El panel de retenciones múltiples es la fuente vigente después de
              // una corrección manual. Una línea solo admite un impuesto y no puede
              // representar simultáneamente Retefuente, ReteIVA y ReteICA; se limpia
              // entonces la selección histórica para que Siigo no reutilice su valor.
              const retTax = retTocado ? null : findTaxById(impuestosRet, l.ret_tax_id);
              const ivaTrace = ivaTax
                ? taxTrace(ivaTax, resolveTaxAccount(ivaTax, puc).code || null)
                : null;
              const retTrace = retTax
                ? taxTrace(retTax, resolveTaxAccount(retTax, puc).code || null)
                : null;
              return {
                account_code: l.account_code,
                account_name: l.account_name,
                item_type: l.item_type,
                iva: roundCOP(l.iva),
                retention: retTocado ? 0 : roundCOP(l.retention),
                iva_tax_id: ivaTrace?.tax_id ?? null,
                iva_tax_name: ivaTrace?.tax_name ?? null,
                iva_tax_rate: ivaTrace?.tax_rate ?? null,
                iva_account_code: ivaTrace?.account_code ?? null,
                iva_operational_account: ivaTrace?.operational_account ?? null,
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
            })(),
          )
          .eq("id", l.id),
      ),
    );
    const lineError = lineUpdates.find((result) => result.error)?.error;
    if (lineError)
      throw new Error(
        `No se pudieron guardar los impuestos de los renglones: ${lineError.message}`,
      );

    const { error: deleteJournalError } = await supabase
      .from("journal_lines")
      .delete()
      .eq("invoice_id", header.id);
    if (deleteJournalError)
      throw new Error(`No se pudo actualizar el asiento contable: ${deleteJournalError.message}`);
    const { error: insertJournalError } = await supabase.from("journal_lines").insert(
      operationalJournal.map((j, i) => ({
        invoice_id: header.id,
        company_id: header.company_id,
        account_code: j.account_code,
        account_name: j.account_name,
        debit: roundCOP(j.debit),
        credit: roundCOP(j.credit),
        cost_center: usaCentros ? (j.cost_center ?? null) : null,
        position: i,
      })),
    );
    if (insertJournalError)
      throw new Error(
        `No se pudo guardar el asiento contable actualizado: ${insertJournalError.message}`,
      );
  }

  async function causar() {
    if (!header) return;
    // Diagnóstico: la validación usa exactamente las líneas visibles en pantalla.
    lines.forEach((l, i) =>
      console.log("VALIDACIÓN DE LÍNEA", {
        line_index: i,
        description: l.description,
        item_type: l.item_type,
        product_code: l.code,
        account_code: l.account_code,
        account_name: l.account_name,
        cost_center: header.cost_center ?? null,
      }),
    );
    if (errores.length > 0) {
      toast.error("Corrige los errores antes de enviar la factura.");
      return;
    }
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
      console.log("========== PAYLOAD CONTABLE FINAL ==========");
      console.log("company_id:", header.company_id, "· proveedor:", header.provider_nit);
      lines.forEach((l, i) =>
        console.log(`LINEA ${i + 1}`, {
          description: l.description,
          item_type: l.item_type,
          product_code: l.code,
          account_code: l.account_code,
          account_name: l.account_name,
          cost_center: header.cost_center ?? null,
          value: Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0),
          iva: Number(l.iva || 0),
        }),
      );
      console.log("============================================");
      const res = await sync({ data: { invoiceId: header.id } });
      if (res.supplierMessage) toast.info(res.supplierMessage);
      if (!res.ok) {
        toast.error(res.error ?? "Siigo rechazó el comprobante.");
        return;
      }

      // Aprendizaje: la cuenta por pagar aprobada queda asociada al proveedor DENTRO de esta empresa.
      await learnPayableAccount(header.company_id, header.provider_nit, payable?.code);
      // Aprendizaje del tratamiento del IVA aprobado para este proveedor y concepto.
      if (ivaFinal && Number(header.iva || 0) > 0) {
        await learnIvaTreatment({
          companyId: header.company_id,
          providerNit: header.provider_nit,
          concept: lines[0]?.description ?? null,
          expenseAccount: lines[0]?.account_code ?? null,
          ivaAccount: ivaFinal.account || ivaDetalle[0]?.account_code || null,
          treatment: ivaFinal.treatment,
        });
      }
      // Regla contable integral con la estructura realmente causada.
      try {
        const { data: auth } = await supabase.auth.getUser();
        await aprenderDeCausacion({
          companyId: header.company_id,
          invoiceId: header.id,
          userId: auth.user?.id ?? null,
          providerNit: header.provider_nit,
          providerName: header.provider_name,
          costCenter: header.cost_center ?? null,
          lines,
          retBlocks,
          ivaTreatment: ivaFinal?.treatment ?? null,
          ivaAccount: ivaFinal?.account || ivaDetalle[0]?.account_code || null,
          ivaRate: Number(lines[0]?.iva ?? 0) || null,
          payableAccount: payable?.code ?? null,
          paymentForm: header.payment_form ?? null,
        });
      } catch (e) {
        console.warn("[aprendizaje] no se pudo guardar la regla", e);
      }
      setOk({ number: res.siigoNumber, id: res.siigoId, date: res.syncedAt, url: res.documentUrl });
      toast.success(res.error ?? "Factura sincronizada correctamente.");
      await queryClient.invalidateQueries({ queryKey: ["invoices", companyId] });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "No fue posible causar la factura en Siigo.",
      );
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
      const results = await findProduct({
        data: { query, companyId: header?.company_id ?? companyId ?? "" },
      });
      setInventario({ index, query, results, busy: false });
    } catch (err) {
      setInventario({ index, query, results: [], busy: false });
      toast.error(
        err instanceof Error ? err.message : "No fue posible consultar productos en Siigo.",
      );
    }
  }

  async function crearProducto() {
    if (!inventario) return;
    const l = lines[inventario.index];
    if (!l) return;
    setInventario({ ...inventario, busy: true });
    try {
      const p = await createProduct({
        data: {
          code: l.code || (l.description ?? "ITEM").slice(0, 20).toUpperCase().replace(/\s+/g, "-"),
          name: l.description || "Producto",
          companyId: header?.company_id ?? companyId ?? "",
        },
      });
      setLines((prev) => prev.map((x, i) => (i === inventario.index ? { ...x, code: p.code } : x)));
      toast.success(`Producto creado en Siigo con el código ${p.code}.`);
      setInventario(null);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "No fue posible crear el producto en Siigo.",
      );
      setInventario({ ...inventario, busy: false });
    }
  }

  function setLine(i: number, patch: Partial<LineRow>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  /**
   * Copia TODA la configuración del primer renglón al resto: producto,
   * descripción, cuenta contable, tipo de ítem, IVA y retención.
   * Los impuestos se recalculan sobre la base propia de cada renglón para no
   * romper el cuadre de la factura.
   */
  function aplicarATodos() {
    const first = lines[0];
    if (!first) return;
    if (lines.length < 2) {
      toast.info("La factura solo tiene un renglón.");
      return;
    }
    const ivaTax = findTaxById(impuestosIva, first.iva_tax_id ?? null);
    const retTax = findTaxById(impuestosRet, first.ret_tax_id ?? null);
    setLines((prev) =>
      prev.map((l, idx) => {
        if (idx === 0) return l;
        const baseLinea =
          Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0);
        const iva = ivaTax
          ? roundCOP((baseLinea * Number(ivaTax.rate)) / 100)
          : Number(first.iva_tax_id ? 0 : l.iva);
        const baseRet = String(retTax?.kind) === "reteiva" ? iva : baseLinea;
        const retention = retTax
          ? roundCOP((baseRet * Number(retTax.rate)) / 100)
          : Number(first.ret_tax_id ? 0 : l.retention);
        return {
          ...l,
          code: first.code,
          description: first.description,
          account_code: first.account_code,
          account_name: first.account_name,
          item_type: normalizeItemType(first.item_type),
          iva_tax_id: first.iva_tax_id ?? null,
          ret_tax_id: first.ret_tax_id ?? null,
          iva,
          retention,
        };
      }),
    );
    toast.success(
      `Producto, descripción, cuenta, tipo de ítem, IVA y retención copiados a ${lines.length - 1} renglón(es).`,
    );
  }


  if (!id)
    return (
      <p className="text-sm text-muted-foreground">Selecciona una factura desde el historial.</p>
    );
  if (!header) return <p className="text-sm text-muted-foreground">Cargando la factura…</p>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            Revisión y causación ·{" "}
            {[header.prefix, header.number].filter(Boolean).join("-") || "Sin número"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {header.provider_name ?? "Sin proveedor"} · {fecha(header.issue_date)} · Estado Siigo:{" "}
            {header.siigo_status}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/facturas">Volver al historial</Link>
        </Button>
      </div>

      <div className="grid gap-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-2 xl:grid-cols-4">
        {usaCentros && (
          <div className="space-y-1.5">
            <Label className="text-xs">Centro de costo</Label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={header.cost_center ?? ""}
              onChange={(e) => {
                setCentroTocado(true);
                setHeader({ ...header, cost_center: e.target.value });
              }}
            >
              <option value="">Sin centro de costo</option>
              {(data?.centers ?? []).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} · {c.name}
                </option>
              ))}
            </select>
            {centroSugerido && !centroTocado && (
              <p className="text-xs text-muted-foreground">{centroSugerido}</p>
            )}
          </div>
        )}
        <div className="space-y-1.5">
          <Label className="text-xs">Forma de pago</Label>
          <Input
            value={header.payment_form ?? ""}
            onChange={(e) => setHeader({ ...header, payment_form: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">IVA</Label>
          <Input
            type="number"
            value={header.iva}
            onChange={(e) => setHeader({ ...header, iva: Number(e.target.value) })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Retefuente</Label>
          <Input
            type="number"
            value={header.retefuente}
            onChange={(e) => setHeader({ ...header, retefuente: Number(e.target.value) })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">ReteIVA</Label>
          <Input
            type="number"
            value={header.reteiva}
            onChange={(e) => setHeader({ ...header, reteiva: Number(e.target.value) })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">ReteICA</Label>
          <Input
            type="number"
            value={header.reteica}
            onChange={(e) => setHeader({ ...header, reteica: Number(e.target.value) })}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs">Observaciones</Label>
          <Textarea
            rows={2}
            value={header.notes ?? ""}
            onChange={(e) => setHeader({ ...header, notes: e.target.value })}
          />
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
                        setLine(i, {
                          account_code: e.target.value,
                          account_name: acc?.name ?? null,
                        });
                      }}
                    >
                      <option value="">Seleccionar…</option>
                      {l.account_code &&
                        !(data?.accounts ?? []).some((a) => a.code === l.account_code) && (
                          <option value={l.account_code}>
                            {l.account_code} ·{" "}
                            {l.account_name ??
                              cuentasVerificadas[l.account_code]?.name ??
                              "Cuenta del renglón"}
                          </option>
                        )}
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
                        value={normalizeItemType(l.item_type)}
                        onChange={(e) => {
                          setLine(i, { item_type: normalizeItemType(e.target.value) });
                        }}
                      >
                        {ITEM_TYPES.map((it) => (
                          <option key={it} value={it}>
                            {it}
                          </option>
                        ))}
                      </select>
                      {normalizeItemType(l.item_type) === "producto" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Buscar en Siigo"
                          onClick={() => buscarProducto(i)}
                        >
                          <PackageSearch className="size-4" />
                        </Button>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 w-28">
                    <Input
                      type="number"
                      value={l.iva}
                      onChange={(e) => setLine(i, { iva: Number(e.target.value) })}
                    />
                    <select
                      className="mt-1 h-8 w-full rounded-md border border-input bg-background px-1 text-xs"
                      value={l.iva_tax_id ?? ""}
                      onChange={(e) => {
                        const id = e.target.value || null;
                        const tx = findTaxById(impuestosIva, id);
                        const baseLinea =
                          Number(l.quantity || 0) * Number(l.unit_value || 0) -
                          Number(l.discount || 0);
                        setLine(i, {
                          iva_tax_id: id,
                          iva: tx ? roundCOP((baseLinea * Number(tx.rate)) / 100) : 0,
                        });
                      }}
                    >
                      <option value="">Sin impuesto</option>
                      {impuestosIva.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.rate}%) · {t.account_code ?? "sin cuenta"}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-1.5 w-28">
                    <Input
                      type="number"
                      value={l.retention}
                      onChange={(e) => setLine(i, { retention: Number(e.target.value) })}
                    />
                    <select
                      className="mt-1 h-8 w-full rounded-md border border-input bg-background px-1 text-xs"
                      value={l.ret_tax_id ?? ""}
                      onChange={(e) => {
                        const id = e.target.value || null;
                        const tx = findTaxById(impuestosRet, id);
                        const baseLinea =
                          String(tx?.kind) === "reteiva"
                            ? Number(l.iva || 0)
                            : Number(l.quantity || 0) * Number(l.unit_value || 0) -
                              Number(l.discount || 0);
                        setLine(i, {
                          ret_tax_id: id,
                          retention: tx ? roundCOP((baseLinea * Number(tx.rate)) / 100) : 0,
                        });
                      }}
                    >
                      <option value="">Sin retención</option>
                      {impuestosRet.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.rate}%) · {t.account_code ?? "sin cuenta"}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {cop(
                      Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0),
                    )}
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
            <Row
              k="Proveedor"
              v={`${header.provider_name ?? "—"} (${header.provider_nit ?? "—"})`}
            />
            {usaCentros && <Row k="Centro de costo" v={header.cost_center || "—"} />}
            <Row
              k="Tipos de ítem"
              v={[...new Set(lines.map((l) => l.item_type))].join(", ").toUpperCase() || "—"}
            />
            <Row k="Cuentas" v={[...new Set(lines.map((l) => l.account_code ?? "—"))].join(", ")} />
            <Row k="Subtotal" v={cop(base)} />
            <Row k="IVA" v={cop(Number(header.iva))} />
            <Row
              k="Total factura"
              v={cop(roundCOP(base + roundCOP(header.iva) + roundCOP(header.impoconsumo)))}
            />
            <Row
              k="Retefuente"
              v={retBlocks.retefuente.apply ? cop(retenciones.retefuente) : "—"}
            />
            <Row k="ReteIVA" v={retBlocks.reteiva.apply ? cop(retenciones.reteiva) : "—"} />
            <Row k="ReteICA" v={retBlocks.reteica.apply ? cop(retenciones.reteica) : "—"} />
            <Row k="Total retenciones" v={cop(totalRetenciones(retBlocks))} />
            <Row
              k="NETO A PAGAR"
              v={cop(
                netoAPagarCOP(
                  roundCOP(base + roundCOP(header.iva) + roundCOP(header.impoconsumo)),
                  totalRetenciones(retBlocks),
                ),
              )}
            />
          </dl>
        </div>

        <RetencionesPanel
          blocks={retBlocks}
          taxes={impuestosRet as unknown as TaxLikeRet[]}
          accounts={puc}
          baseGravable={base}
          ivaTotal={ivaHeader}
          errors={erroresRet}
          onChange={(next) => {
            setRetTocado(true);
            setRetBlocks(next);
          }}
        />

        <IvaTreatmentPanel
          decision={ivaFinal}
          ivaTotal={Number(header.iva || 0)}
          accounts={puc}
          overridden={!!ivaOverride}
          onChange={(v) => setIvaOverride(v)}
          onReset={() => setIvaOverride(null)}
        />

        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border px-5 py-3 text-sm font-semibold">
            Asiento contable generado
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border">
              {operationalJournal.map((j, i) => (
                <tr key={i}>
                  <td className="px-4 py-1.5 font-mono text-xs">{j.account_code}</td>
                  <td className="px-4 py-1.5 text-muted-foreground">{j.account_name}</td>
                  <td className="px-4 py-1.5 text-right font-mono tabular-nums">
                    {j.debit ? cop(j.debit) : ""}
                  </td>
                  <td className="px-4 py-1.5 text-right font-mono tabular-nums">
                    {j.credit ? cop(j.credit) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-border bg-muted/40 text-xs">
              <tr>
                <td className="px-4 py-2 font-medium" colSpan={2}>
                  {Math.abs(t.diferencia) < 0.005
                    ? "Comprobante cuadrado"
                    : `Descuadre ${cop(t.diferencia)}`}
                </td>
                <td className="px-4 py-2 text-right font-mono">{cop(t.debito)}</td>
                <td className="px-4 py-2 text-right font-mono">{cop(t.credito)}</td>
              </tr>
            </tfoot>
          </table>
          <dl className="space-y-1 border-t border-border px-5 py-3 text-xs">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="font-mono tabular-nums">{cop(base)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">IVA</dt>
              <dd className="font-mono tabular-nums">{cop(Number(header.iva))}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Total factura</dt>
              <dd className="font-mono tabular-nums">
                {cop(base + Number(header.iva) + Number(header.impoconsumo ?? 0))}
              </dd>
            </div>
            {retenciones.detalle.map((d) => (
              <div className="flex justify-between" key={d.kind}>
                <dt className="text-muted-foreground">{d.name}</dt>
                <dd className="font-mono tabular-nums">-{cop(d.amount)}</dd>
              </div>
            ))}
            <div className="flex justify-between border-t border-border pt-1 font-semibold">
              <dt>NETO A PAGAR</dt>
              <dd className="font-mono tabular-nums">
                {cop(
                  netoAPagarCOP(
                    roundCOP(base + roundCOP(header.iva) + roundCOP(header.impoconsumo)),
                    totalRetenciones(retBlocks),
                  ),
                )}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          onClick={async () => {
            try {
              await guardarCambios();
              toast.success("Cambios guardados.");
            } catch (error) {
              toast.error(
                error instanceof Error ? error.message : "No fue posible guardar los cambios.",
              );
            }
          }}
        >
          Guardar cambios
        </Button>
        <Button onClick={causar} disabled={sending || errores.length > 0}>
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          {sending ? "Enviando a Siigo…" : "Causar en Siigo"}
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
              <p className="text-muted-foreground">
                El producto ya existe en Siigo. Se usará el código existente.
              </p>
              {inventario!.results!.map((p) => (
                <button
                  key={p.id || p.code}
                  className="w-full rounded-md border border-border px-3 py-2 text-left hover:bg-muted/40"
                  onClick={() => {
                    setLines((prev) =>
                      prev.map((x, i) => (i === inventario!.index ? { ...x, code: p.code } : x)),
                    );
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
              <p className="text-muted-foreground">
                El producto no existe en Siigo. ¿Deseas crearlo?
              </p>
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
