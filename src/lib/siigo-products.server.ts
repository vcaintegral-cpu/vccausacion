import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { siigoGet } from "./siigo.server";

export type SiigoRawProduct = {
  id?: string;
  code?: string | number;
  name?: string;
  type?: string;
  active?: boolean;
  account_group?: { id?: number; name?: string } | null;
  accounting_account?: string | number | null;
  account?: { code?: string | number; name?: string } | null;
};

export type ProductSyncStats = {
  consultados: number;
  nuevos: number;
  actualizados: number;
  activos: number;
  inactivos: number;
  errores: string[];
};

const norm = (s: string) =>
  String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

/** Descarga TODO el catálogo de productos de la empresa conectada en Siigo. */
export async function fetchAllSiigoProducts(): Promise<SiigoRawProduct[]> {
  const list: SiigoRawProduct[] = [];
  for (let page = 1; page <= 200; page++) {
    const res = await siigoGet<{ results?: SiigoRawProduct[]; pagination?: { total_results?: number } }>(
      `/v1/products?page=${page}&page_size=100`,
    );
    const chunk = res.results ?? [];
    list.push(...chunk);
    if (chunk.length < 100) break;
  }
  return list;
}

/** Busca un producto puntual en Siigo por su código real. */
export async function fetchSiigoProductByCode(code: string): Promise<SiigoRawProduct | null> {
  const res = await siigoGet<{ results?: SiigoRawProduct[] }>(
    `/v1/products?page_size=25&code=${encodeURIComponent(code)}`,
  );
  const exact = (res.results ?? []).find((p) => String(p.code ?? "").trim() === code.trim());
  return exact ?? null;
}

/**
 * Sincroniza productos de Siigo hacia la empresa activa.
 * Nunca borra la cuenta PUC ni la categoría ya configuradas localmente:
 * code = código real del producto, account_code = cuenta contable PUC.
 */
export async function upsertSiigoProducts(
  supabase: SupabaseClient<Database>,
  companyId: string,
  list: SiigoRawProduct[],
): Promise<ProductSyncStats> {
  const stats: ProductSyncStats = {
    consultados: list.length,
    nuevos: 0,
    actualizados: 0,
    activos: 0,
    inactivos: 0,
    errores: [],
  };
  if (list.length === 0) return stats;

  const { data: puc } = await supabase
    .from("puc_accounts")
    .select("code, name")
    .eq("company_id", companyId)
    .range(0, 19999);
  const cuentas = puc ?? [];

  const { data: cats } = await supabase
    .from("product_categories")
    .select("id, name")
    .eq("company_id", companyId);
  const categorias = new Map<string, string>();
  for (const c of cats ?? []) categorias.set(norm(String(c.name ?? "")), c.id as string);

  const nuevasCategorias = Array.from(
    new Set(
      list
        .map((p) => (p.account_group?.name ?? "").trim())
        .filter((n) => n && !categorias.has(norm(n))),
    ),
  );
  if (nuevasCategorias.length > 0) {
    const { data: creadas } = await supabase
      .from("product_categories")
      .upsert(
        nuevasCategorias.map((name) => ({
          company_id: companyId,
          name,
          kind: "producto",
          active: true,
          source: "siigo",
        })),
        { onConflict: "company_id,kind,name" },
      )
      .select("id, name");
    for (const c of creadas ?? []) categorias.set(norm(String(c.name ?? "")), c.id as string);
  }

  // Productos ya existentes de ESTA empresa: se conserva su cuenta y categoría.
  const { data: existentes } = await supabase
    .from("products")
    .select("code, account_code, account_name, category, category_id")
    .eq("company_id", companyId)
    .range(0, 19999);
  const previos = new Map((existentes ?? []).map((p) => [String(p.code ?? "").trim(), p]));

  const rows = list
    .map((p) => {
      const code = String(p.code ?? "").trim();
      if (!code) return null;
      const previo = previos.get(code);
      const catName = p.account_group?.name?.trim() || null;
      const catId = catName ? (categorias.get(norm(catName)) ?? null) : null;

      const rawAccount = String(p.accounting_account ?? p.account?.code ?? "").replace(/\s+/g, "");
      const account_code: string | null = previo?.account_code ?? (rawAccount || null);
      let account_name = previo?.account_name ?? p.account?.name ?? null;
      if (account_code && !account_name) {
        account_name = cuentas.find((c) => c.code === account_code)?.name ?? null;
      }

      if (p.active === false) stats.inactivos += 1;
      else stats.activos += 1;
      if (previo) stats.actualizados += 1;
      else stats.nuevos += 1;

      return {
        company_id: companyId,
        code,
        name: String(p.name ?? "").trim() || `Producto ${code}`,
        kind: String(p.type ?? "").toLowerCase().startsWith("serv") ? "servicio" : "producto",
        // Nunca se borra la categoría ya configurada localmente.
        category: previo?.category ?? catName,
        category_id: previo?.category_id ?? catId,
        // Nunca se borra la cuenta PUC ya configurada localmente.
        account_code,
        account_name,
        active: p.active !== false,
        source: "siigo",
        siigo_id: p.id ? String(p.id) : null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const unicos = Array.from(new Map(rows.map((r) => [r.code, r])).values());
  for (let i = 0; i < unicos.length; i += 500) {
    const { error } = await supabase
      .from("products")
      .upsert(unicos.slice(i, i + 500), { onConflict: "company_id,code" });
    if (error) stats.errores.push(error.message);
  }
  return stats;
}
