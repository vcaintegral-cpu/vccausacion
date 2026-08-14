// Cuenta de contrapartida (obligación por pagar) de las facturas de compra.
// Regla: la factura SIEMPRE se causa contra una cuenta de pasivo (grupos 22 o 23).
// La cuenta NO depende de la descripción, del producto ni de la cuenta de gasto:
// se determina por PROVEEDOR → NIT → HISTÓRICO CONTABLE → CUENTA POR PAGAR.
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { resolveOperationalAccount, type PucAccount } from "@/lib/puc-hierarchy";
import { isPayableCode } from "@/lib/accounting";

export { isPayableCode };

/** Cuenta por pagar predeterminada para proveedores nuevos o histórico no válido. */
export const DEFAULT_PAYABLE_ACCOUNT = "22050501";

export type PayableOrigin =
  | "APRENDIZAJE"       // cuenta confirmada por el usuario para ese proveedor en esta empresa
  | "HISTORIAL"         // cuenta usada históricamente con ese proveedor en esta empresa
  | "FACTURAS"          // cuenta usada en facturas aprobadas o sincronizadas del proveedor
  | "CONFIGURACION"     // cuenta genérica configurada para la empresa
  | "HISTORIAL_EMPRESA" // cuenta de pasivo más usada por la empresa
  | "MANUAL"            // cuenta seleccionada manualmente en el borrador
  | "DEFECTO";          // proveedor nuevo o histórico no válido

/** Valores persistidos en la factura (accounts_payable_source). */
export type PayableSource = "historical" | "new_supplier_default" | "manual" | "fallback";

export const PAYABLE_SOURCE_LABEL: Record<PayableSource, string> = {
  historical: "Histórico",
  new_supplier_default: "Predeterminada - proveedor nuevo",
  manual: "Asignación manual",
  fallback: "Predeterminada - respaldo",
};

export type PayableDecision = {
  code: string;
  name: string;
  origin: PayableOrigin;
  source: PayableSource;
  reason: string;
  confidence: number;
  /** Advertencia visible cuando la cuenta histórica no pudo utilizarse. */
  warning?: string | null;
};

type CandidateRow = {
  provider_nit?: string | null;
  account_code: string;
  uses: number;
  last_used: string | null;
  source: string;
};

type LegacyRow = { provider_nit?: string | null; account_code: string; uses: number };

const rpc = supabase.rpc.bind(supabase) as unknown as (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

const cache = new Map<string, Promise<PayableDecision>>();

/** Limpia la caché (al configurar la empresa o al aprender una cuenta nueva). */
export function clearPayableCache(companyId?: string) {
  if (!companyId) cache.clear();
  else for (const key of [...cache.keys()]) if (key.startsWith(`${companyId}|`)) cache.delete(key);
}

const porDefecto = (reason: string, source: PayableSource = "new_supplier_default"): PayableDecision => ({
  code: DEFAULT_PAYABLE_ACCOUNT,
  name: "Proveedores nacionales",
  origin: "DEFECTO",
  source,
  reason,
  confidence: 0.4,
  warning: null,
});

async function resolve(companyId: string, providerNit: string | null): Promise<PayableDecision> {
  // 1) Cuenta habitual marcada manualmente para ese proveedor DENTRO de esta empresa.
  if (providerNit) {
    const { data } = await supabase
      .from("providers")
      .select("default_payable_account")
      .eq("company_id", companyId)
      .eq("nit", providerNit)
      .maybeSingle();
    const code = String(data?.default_payable_account ?? "").trim();
    if (isPayableCode(code))
      return {
        code,
        name: "",
        origin: "APRENDIZAJE",
        source: "historical",
        reason: "Cuenta por pagar habitual confirmada antes para este proveedor.",
        confidence: 0.98,
        warning: null,
      };
  }

  // 2) Histórico contable + facturas aprobadas/sincronizadas del mismo NIT en esta empresa.
  //    Prioridad: mayor frecuencia; en caso de empate, uso más reciente.
  if (providerNit) {
    try {
      const { data } = await rpc("provider_payable_candidates", {
        _company_id: companyId,
        _nits: [providerNit],
      });
      const rows = ((data ?? []) as CandidateRow[]).filter((r) => isPayableCode(String(r.account_code ?? "").trim()));
      const agrupado = new Map<string, { uses: number; last: number; sources: Set<string> }>();
      for (const r of rows) {
        const code = String(r.account_code).trim();
        const prev = agrupado.get(code) ?? { uses: 0, last: 0, sources: new Set<string>() };
        prev.uses += Number(r.uses || 0);
        prev.last = Math.max(prev.last, r.last_used ? Date.parse(r.last_used) || 0 : 0);
        prev.sources.add(String(r.source ?? ""));
        agrupado.set(code, prev);
      }
      const mejor = [...agrupado.entries()].sort((a, b) => b[1].uses - a[1].uses || b[1].last - a[1].last)[0];
      if (mejor) {
        const total = [...agrupado.values()].reduce((s, x) => s + x.uses, 0) || 1;
        return {
          code: mejor[0],
          name: "",
          origin: mejor[1].sources.has("historial") ? "HISTORIAL" : "FACTURAS",
          source: "historical",
          reason: `Cuenta usada ${mejor[1].uses} vez(ces) con este proveedor (NIT ${providerNit}) en esta empresa.`,
          confidence: Math.min(0.99, 0.6 + (mejor[1].uses / total) * 0.39),
          warning: null,
        };
      }
    } catch {
      // El histórico es una ayuda, no un requisito.
    }
  }

  // 3) Cuenta genérica configurada para la empresa.
  const { data: empresa } = await supabase
    .from("companies")
    .select("default_payable_account")
    .eq("id", companyId)
    .maybeSingle();
  const generica = String((empresa as { default_payable_account?: string | null } | null)?.default_payable_account ?? "").trim();
  if (isPayableCode(generica))
    return {
      code: generica,
      name: "",
      origin: "CONFIGURACION",
      source: "fallback",
      reason: "Cuenta genérica de cuentas por pagar configurada para la empresa.",
      confidence: 0.6,
      warning: null,
    };

  // 4) Cuenta de pasivo más usada por la empresa.
  try {
    const { data } = await rpc("history_top_payable_accounts", { _company_id: companyId, _limit: 20 });
    const best = ((data ?? []) as LegacyRow[])
      .filter((r) => isPayableCode(String(r.account_code ?? "").trim()))
      .sort((a, b) => Number(b.uses) - Number(a.uses))[0];
    if (best)
      return {
        code: String(best.account_code).trim(),
        name: "",
        origin: "HISTORIAL_EMPRESA",
        source: "fallback",
        reason: "Cuenta por pagar más usada por la empresa en su histórico.",
        confidence: 0.55,
        warning: null,
      };
  } catch {
    /* sin histórico */
  }

  return porDefecto(
    providerNit
      ? "Proveedor sin movimientos contables previos: se asignó la cuenta por pagar predeterminada."
      : "Factura sin NIT del proveedor: se asignó la cuenta por pagar predeterminada.",
  );
}

/** Cuenta por pagar de la factura (empresa + NIT del proveedor). Nunca devuelve bancos ni caja. */
export function fetchPayableAccount(
  companyId: string | null | undefined,
  providerNit?: string | null,
): Promise<PayableDecision> {
  if (!companyId) return Promise.resolve(porDefecto("Sin empresa activa.", "fallback"));
  const nit = (providerNit ?? "").trim() || null;
  const key = `${companyId}|${nit ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const run = resolve(companyId, nit);
  cache.set(key, run);
  return run;
}

/**
 * Ajusta la decisión al PUC de la empresa: nombre real y auxiliar operativo.
 * Si la cuenta no existe, no es de movimiento o no es de pasivo, se usa la
 * cuenta predeterminada 22050501 con una advertencia visible.
 */
export function applyPucToPayable(decision: PayableDecision, puc: PucAccount[]): PayableDecision {
  if (puc.length === 0) return decision;
  const resolution = resolveOperationalAccount(puc, decision.code);
  const code =
    resolution.operationalAccount && isPayableCode(resolution.operationalAccount)
      ? resolution.operationalAccount
      : decision.code;
  const cuenta = puc.find((p) => p.code === code);
  const valida = !!cuenta && isPayableCode(code) && cuenta.active !== false;
  if (!valida) {
    const alterna = puc.find((p) => p.code === DEFAULT_PAYABLE_ACCOUNT);
    return {
      code: alterna?.code ?? DEFAULT_PAYABLE_ACCOUNT,
      name: alterna?.name ?? "Proveedores nacionales",
      origin: "DEFECTO",
      source: "fallback",
      reason: decision.reason,
      confidence: 0.4,
      warning: `La cuenta histórica del proveedor (${decision.code}) no está disponible. Se asignó ${DEFAULT_PAYABLE_ACCOUNT} como cuenta por pagar predeterminada.`,
    };
  }
  return { ...decision, code, name: cuenta?.name ?? decision.name };
}

/** Decisión ya tomada manualmente por el usuario en el borrador: nunca se recalcula. */
export function manualPayable(code: string, name?: string | null): PayableDecision {
  return {
    code,
    name: name ?? "",
    origin: "MANUAL",
    source: "manual",
    reason: "Cuenta por pagar seleccionada manualmente en el borrador.",
    confidence: 1,
    warning: null,
  };
}

/** Hook de lectura para la interfaz. */
export function usePayableAccount(companyId: string | null | undefined, providerNit?: string | null) {
  return useQuery({
    queryKey: ["payable-account", companyId, providerNit ?? ""],
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchPayableAccount(companyId, providerNit),
  });
}

/** Campos de trazabilidad que se guardan en la factura. */
export function payableInvoiceFields(decision: PayableDecision, userId?: string | null) {
  return {
    payable_account: decision.code,
    payable_source: decision.source,
    payable_suggested: decision.source === "manual" ? undefined : decision.code,
    payable_manual: decision.source === "manual",
    payable_confidence: decision.confidence,
    payable_updated_at: new Date().toISOString(),
    payable_updated_by: userId ?? null,
  };
}

/**
 * Aprendizaje: al aprobar o sincronizar la factura se guarda la cuenta por pagar
 * usada para ese proveedor DENTRO de esa empresa (nunca se comparte entre empresas).
 */
export async function learnPayableAccount(
  companyId: string,
  providerNit: string | null | undefined,
  code: string | null | undefined,
) {
  const nit = (providerNit ?? "").trim();
  const cuenta = String(code ?? "").trim();
  if (!companyId || !nit || !isPayableCode(cuenta)) return;
  await supabase
    .from("providers")
    .update({ default_payable_account: cuenta })
    .eq("company_id", companyId)
    .eq("nit", nit);
  clearPayableCache(companyId);
}
