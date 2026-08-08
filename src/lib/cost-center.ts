import { supabase } from "@/integrations/supabase/client";

export type CostCenterSuggestion = {
  code: string;
  /** MANUAL | PROVEEDOR | HISTORIAL | REGLA */
  origin: "MANUAL" | "PROVEEDOR" | "HISTORIAL" | "REGLA" | "NINGUNO";
  detail: string;
};

/**
 * Centro de costo sugerido para un proveedor de la empresa activa.
 * Prioridad: 2) configuración del proveedor · 3) historial de causaciones del
 * mismo proveedor (el más usado) · 4) regla contable aprendida.
 * La prioridad 1 (elección manual) la resuelve la pantalla.
 */
export async function suggestCostCenter(params: {
  companyId: string;
  providerNit: string | null | undefined;
}): Promise<CostCenterSuggestion | null> {
  const { companyId, providerNit } = params;
  if (!companyId || !providerNit) return null;

  // Historial: siempre por empresa + proveedor, nunca solo por nombre.
  const { data: previas } = await supabase
    .from("invoices")
    .select("cost_center, issue_date, created_at")
    .eq("company_id", companyId)
    .eq("provider_nit", providerNit)
    .not("cost_center", "is", null)
    .order("created_at", { ascending: false })
    .limit(20);

  const usos = new Map<string, number>();
  for (const row of previas ?? []) {
    const code = String(row.cost_center ?? "").trim();
    if (!code) continue;
    usos.set(code, (usos.get(code) ?? 0) + 1);
  }
  if (usos.size > 0) {
    const [code, veces] = [...usos.entries()].sort((a, b) => b[1] - a[1])[0]!;
    return {
      code,
      origin: "HISTORIAL",
      detail: `Centro de costo sugerido por historial del proveedor (usado ${veces} vez/veces).`,
    };
  }

  const { data: reglas } = await supabase
    .from("learning_rules")
    .select("cost_center, times_used")
    .eq("company_id", companyId)
    .eq("provider_nit", providerNit)
    .eq("active", true)
    .not("cost_center", "is", null)
    .order("times_used", { ascending: false })
    .limit(5);

  const regla = (reglas ?? []).find((r) => String(r.cost_center ?? "").trim());
  if (regla)
    return {
      code: String(regla.cost_center),
      origin: "REGLA",
      detail: "Centro de costo sugerido por una regla contable del proveedor.",
    };

  return null;
}
