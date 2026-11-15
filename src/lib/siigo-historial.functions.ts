// Historial contable desde la API de Siigo (función «historial_api_siigo», Soluciones y Diseños).
// Primer paso: ver QUÉ entrega realmente la API de compras de esa empresa (renglones, cuentas,
// impuestos, centro de costo) antes de construir una sincronización. No guarda nada.
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Db = import("@supabase/supabase-js").SupabaseClient;

async function verificarEmpresa(db: Db, companyId: string) {
  const { data, error } = await db.from("companies").select("nit").eq("id", companyId).single();
  if (error || !data) throw new Error("Empresa no encontrada.");
  const { funcionActiva } = await import("@/empresas/registro");
  if (!funcionActiva((data as { nit: string | null }).nit, "historial_api_siigo"))
    throw new Error(
      "La lectura del historial desde la API de Siigo no está habilitada para esta empresa.",
    );
}

export type DiagnosticoCompras = {
  consulta: string;
  total: number | null;
  pagina: number;
  /** Campos que trae cada compra (para ver qué datos entrega la API). */
  camposCompra: string[];
  camposRenglon: string[];
  /** Compras tal como las devuelve Siigo (recortadas). */
  muestra: string;
};

const claves = (o: unknown) => (o && typeof o === "object" ? Object.keys(o as object).sort() : []);

export const siigoDiagnosticoCompras = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; desde: string }) => {
    if (!input?.companyId) throw new Error("companyId requerido");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.desde ?? ""))
      throw new Error("Fecha inválida (use AAAA-MM-DD).");
    return input;
  })
  .handler(async ({ data, context }): Promise<DiagnosticoCompras> => {
    await verificarEmpresa(context.supabase as unknown as Db, data.companyId);
    const { siigoGet, siigoUseCompany } = await import("./siigo.server");
    await siigoUseCompany(data.companyId);
    const consulta = `/v1/purchases?created_start=${data.desde}&page=1&page_size=5`;
    const res = await siigoGet<{
      results?: Array<Record<string, unknown> & { items?: unknown[] }>;
      pagination?: { total_results?: number; page?: number };
    }>(consulta);
    const compras = res.results ?? [];
    const renglones = compras.flatMap((c) => (Array.isArray(c.items) ? c.items : []));
    return {
      consulta,
      total: res.pagination?.total_results ?? null,
      pagina: res.pagination?.page ?? 1,
      camposCompra: [...new Set(compras.flatMap(claves))].sort(),
      camposRenglon: [...new Set(renglones.flatMap(claves))].sort(),
      muestra: JSON.stringify(compras.slice(0, 2), null, 2).slice(0, 20000),
    };
  });
