// Reconstrucción de la jerarquía del PUC por empresa (server-only).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { buildHierarchy } from "@/lib/puc-hierarchy";

type Client = SupabaseClient<Database>;

/** Recalcula nivel, padre, hijas y cuentas de movimiento de todo el PUC de una empresa. */
export async function rebuildPucHierarchy(supabase: Client, companyId: string) {
  const { data, error } = await supabase
    .from("puc_accounts")
    .select("id, code, name, nature, active, source, siigo_id, siigo_code")
    .eq("company_id", companyId)
    .order("code")
    .range(0, 49999);
  if (error) throw new Error(`No fue posible leer el PUC: ${error.message}`);
  const rows = data ?? [];
  if (rows.length === 0) return { total: 0, movimiento: 0 };

  const hierarchy = buildHierarchy(rows.map((r) => ({ code: r.code, name: r.name, active: r.active })));
  const byCode = new Map(hierarchy.map((h) => [h.code, h]));
  const now = new Date().toISOString();

  const updates = rows.map((r) => {
    const h = byCode.get(r.code)!;
    return {
      id: r.id,
      company_id: companyId,
      code: r.code,
      name: r.name,
      nature: r.nature,
      active: r.active,
      source: r.source,
      level: h.level,
      parent_code: h.parent_code,
      has_children: h.has_children,
      is_movement: h.is_movement,
      siigo_id: r.siigo_id ?? null,
      siigo_code: r.siigo_code ?? r.code,
      synced_at: now,
    };
  });

  for (let i = 0; i < updates.length; i += 500) {
    const { error: upErr } = await supabase.from("puc_accounts").upsert(updates.slice(i, i + 500), { onConflict: "id" });
    if (upErr) throw new Error(`No fue posible guardar la jerarquía del PUC: ${upErr.message}`);
  }

  return { total: updates.length, movimiento: updates.filter((u) => u.is_movement).length };
}
