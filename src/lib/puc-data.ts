import { supabase } from "@/integrations/supabase/client";
import type { PucAccount } from "@/lib/puc-hierarchy";

const PUC_PAGE_SIZE = 1000;

/** Lee el PUC completo de una empresa; nunca usa una consulta parcial como fuente de validación. */
export async function fetchCompanyPuc(companyId: string): Promise<PucAccount[]> {
  if (!companyId) return [];
  const accounts: PucAccount[] = [];
  for (let from = 0; ; from += PUC_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("puc_accounts")
      .select("code, name, active, level, parent_code, has_children, is_movement, source, siigo_id, siigo_code, synced_at, excel_active, siigo_active, siigo_is_movement, siigo_seen_at")
      .eq("company_id", companyId)
      .order("code")
      .range(from, from + PUC_PAGE_SIZE - 1);
    if (error) throw new Error(`No fue posible leer el PUC completo: ${error.message}`);
    const page = (data ?? []) as PucAccount[];
    accounts.push(...page);
    if (page.length < PUC_PAGE_SIZE) break;
  }
  return accounts;
}