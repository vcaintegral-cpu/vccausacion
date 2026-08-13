// Cuenta de contrapartida (obligación por pagar) de las facturas de compra.
// Regla: la factura SIEMPRE se causa contra una cuenta de pasivo (grupos 22 o 23),
// nunca contra bancos, caja ni cuentas de pago. La cuenta NO está fija en 2205:
// se toma del comportamiento histórico real de CADA empresa con CADA proveedor.
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { resolveOperationalAccount, type PucAccount } from "@/lib/puc-hierarchy";

/** Prefijos que NUNCA pueden ser la contrapartida (retenciones e impuestos). */
const PROHIBIDOS = ["2365", "2367", "2368", "2404", "2408"];

/** ¿El código corresponde a una cuenta por pagar válida (proveedores u otros pasivos)? */
export function isPayableCode(code?: string | null): boolean {
  const c = String(code ?? "").trim();
  if (!/^\d+$/.test(c)) return false;
  if (!(c.startsWith("22") || c.startsWith("23"))) return false;
  return !PROHIBIDOS.some((p) => c.startsWith(p));
}

export type PayableOrigin =
  | "APRENDIZAJE"       // cuenta confirmada por el usuario para ese proveedor en esta empresa
  | "HISTORIAL"         // cuenta usada históricamente con ese proveedor en esta empresa
  | "CONFIGURACION"     // cuenta genérica configurada para la empresa
  | "HISTORIAL_EMPRESA" // cuenta de pasivo más usada por la empresa
  | "DEFECTO";          // último recurso

export type PayableDecision = {
  code: string;
  name: string;
  origin: PayableOrigin;
  reason: string;
};

type PayableRow = { provider_nit?: string | null; account_code: string; uses: number };

const rpc = supabase.rpc.bind(supabase) as unknown as (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: PayableRow[] | null; error: { message: string } | null }>;

const cache = new Map<string, Promise<PayableDecision>>();

/** Limpia la caché (al configurar la empresa o al aprender una cuenta nueva). */
export function clearPayableCache(companyId?: string) {
  if (!companyId) cache.clear();
  else for (const key of [...cache.keys()]) if (key.startsWith(`${companyId}|`)) cache.delete(key);
}

async function resolve(companyId: string, providerNit: string | null): Promise<PayableDecision> {
  // 1) Aprendizaje del usuario para ese proveedor DENTRO de esta empresa.
  if (providerNit) {
    const { data } = await supabase
      .from("providers")
      .select("default_payable_account")
      .eq("company_id", companyId)
      .eq("nit", providerNit)
      .maybeSingle();
    const code = String(data?.default_payable_account ?? "").trim();
    if (isPayableCode(code))
      return { code, name: "", origin: "APRENDIZAJE", reason: "Cuenta por pagar confirmada antes para este proveedor." };
  }

  // 2) Histórico contable del mismo proveedor en esta empresa.
  if (providerNit) {
    try {
      const { data } = await rpc("history_provider_payable_accounts", {
        _company_id: companyId,
        _nits: [providerNit],
        _limit: 50,
      });
      const best = (data ?? []).filter((r) => isPayableCode(r.account_code)).sort((a, b) => b.uses - a.uses)[0];
      if (best)
        return {
          code: String(best.account_code).trim(),
          name: "",
          origin: "HISTORIAL",
          reason: `Cuenta usada ${best.uses} vez(ces) con este proveedor en esta empresa.`,
        };
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
    return { code: generica, name: "", origin: "CONFIGURACION", reason: "Cuenta genérica de cuentas por pagar de la empresa." };

  // 4) Cuenta de pasivo más usada por la empresa.
  try {
    const { data } = await rpc("history_top_payable_accounts", { _company_id: companyId, _limit: 20 });
    const best = (data ?? []).filter((r) => isPayableCode(r.account_code)).sort((a, b) => b.uses - a.uses)[0];
    if (best)
      return {
        code: String(best.account_code).trim(),
        name: "",
        origin: "HISTORIAL_EMPRESA",
        reason: "Cuenta por pagar más usada por la empresa en su histórico.",
      };
  } catch {
    /* sin histórico */
  }

  return {
    code: "220505",
    name: "Proveedores nacionales",
    origin: "DEFECTO",
    reason: "Sin histórico ni configuración: configure la cuenta genérica de cuentas por pagar de la empresa.",
  };
}

/** Cuenta por pagar de la factura (empresa + proveedor). Nunca devuelve bancos ni caja. */
export function fetchPayableAccount(
  companyId: string | null | undefined,
  providerNit?: string | null,
): Promise<PayableDecision> {
  if (!companyId)
    return Promise.resolve({ code: "220505", name: "Proveedores nacionales", origin: "DEFECTO", reason: "Sin empresa activa." });
  const nit = (providerNit ?? "").trim() || null;
  const key = `${companyId}|${nit ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const run = resolve(companyId, nit);
  cache.set(key, run);
  return run;
}

/** Ajusta la decisión al PUC de la empresa: nombre real y auxiliar operativo. */
export function applyPucToPayable(decision: PayableDecision, puc: PucAccount[]): PayableDecision {
  if (puc.length === 0) return decision;
  const resolution = resolveOperationalAccount(puc, decision.code);
  const code = resolution.operationalAccount && isPayableCode(resolution.operationalAccount)
    ? resolution.operationalAccount
    : decision.code;
  const name = puc.find((p) => p.code === code)?.name ?? decision.name;
  return { ...decision, code, name };
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

/**
 * Aprendizaje: al aprobar la factura se guarda la cuenta por pagar usada para
 * ese proveedor DENTRO de esa empresa (nunca se comparte entre empresas).
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
