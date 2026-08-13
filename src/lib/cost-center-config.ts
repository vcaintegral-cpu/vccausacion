import { useQuery } from "@tanstack/react-query";

import { db as supabase } from "@/lib/db-client";
import type { PucAccount } from "@/lib/puc-hierarchy";

/**
 * Configuración de centros de costo por empresa.
 * `null` = pendiente de configurar (no se asume nada para empresas existentes).
 */
export type CostCenterPolicy = boolean | null;

const cache = new Map<string, Promise<CostCenterPolicy>>();

/** Lee (con caché por empresa) si la empresa maneja centros de costo. */
export function companyUsesCostCenters(companyId: string | null | undefined): Promise<CostCenterPolicy> {
  if (!companyId) return Promise.resolve(null);
  const hit = cache.get(companyId);
  if (hit) return hit;
  const promise = (async (): Promise<CostCenterPolicy> => {
    const { data } = await supabase
      .from("companies")
      .select("uses_cost_centers")
      .eq("id", companyId)
      .maybeSingle();
    return (data?.uses_cost_centers ?? null) as CostCenterPolicy;
  })();
  cache.set(companyId, promise);
  return promise;
}

/** Limpia la caché al cambiar la configuración de una empresa. */
export function clearCostCenterPolicyCache(companyId?: string) {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

/** Hook de lectura para la interfaz. */
export function useCostCenterPolicy(companyId: string | null | undefined) {
  return useQuery({
    queryKey: ["cost-center-policy", companyId],
    enabled: !!companyId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies")
        .select("uses_cost_centers")
        .eq("id", companyId!)
        .maybeSingle();
      if (error) throw error;
      return (data?.uses_cost_centers ?? null) as CostCenterPolicy;
    },
  });
}

/** ¿La empresa tiene habilitados los centros de costo? Pendiente (null) = deshabilitado. */
export const costCentersEnabled = (policy: CostCenterPolicy) => policy === true;

/** ¿Una cuenta contable exige centro de costo? Solo aplica si la empresa los maneja. */
export function accountRequiresCostCenter(accounts: PucAccount[] | undefined, code: string | null | undefined) {
  const c = String(code ?? "").trim();
  if (!c) return false;
  return (accounts ?? []).some((a) => a.code === c && a.requires_cost_center === true);
}

/**
 * Validación única de centro de costo, compartida por causación manual, masiva y envío a Siigo.
 * - Empresa que no los maneja (o pendiente): nunca exige centro de costo.
 * - Empresa que los maneja: exige solo en las cuentas marcadas como obligatorias.
 */
export function validateCostCenter(params: {
  policy: CostCenterPolicy;
  accounts: PucAccount[] | undefined;
  costCenter: string | null | undefined;
  lines: { account_code?: string | null }[];
}): string[] {
  if (!costCentersEnabled(params.policy)) return [];
  const centro = String(params.costCenter ?? "").trim();
  if (centro) return [];
  const requiere = params.lines.some((l) => accountRequiresCostCenter(params.accounts, l.account_code));
  return requiere ? ["Esta cuenta requiere centro de costo. Seleccione uno antes de aprobar."] : [];
}

/** Centro de costo que debe guardarse/enviarse: se descarta si la empresa no los maneja. */
export function costCenterForCompany(policy: CostCenterPolicy, value: string | null | undefined): string | null {
  if (!costCentersEnabled(policy)) return null;
  const centro = String(value ?? "").trim();
  return centro || null;
}
