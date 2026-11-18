// Aprender de lo que la usuaria corrige a mano en los borradores (antes de aprobarlos).
// Cuando cambia la cuenta de un renglón (selector, lápiz o «Asignar»), la herramienta guarda la regla
// proveedor + concepto → cuenta + tipo (producto si es inventario / gasto si es costo o gasto), la misma
// que se aprende al aprobar, para que los siguientes borradores del proveedor (y conceptos parecidos de otros)
// salgan con esa cuenta y tipo, sin esperar a que el piloto o ella aprueben. Una vez por estado final.
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient;

type Decision = { code?: string; origin?: string };

export async function aprenderDeBorradoresManuales(
  db: Db,
  companyId: string,
  mes: { desde: string; hasta: string },
  usuarioId: string | null,
): Promise<number> {
  if (!usuarioId) return 0;
  const { data: invs } = await db
    .from("invoices")
    .select("id, provider_nit, provider_name, cost_center, raw_extraction")
    .eq("company_id", companyId)
    .eq("doc_kind", "compra")
    .eq("status", "borrador")
    .gte("issue_date", mes.desde)
    .lte("issue_date", mes.hasta)
    .is("siigo_id", null)
    .limit(200);
  const facturas = (invs ?? []) as Array<{
    id: string;
    provider_nit: string | null;
    provider_name: string | null;
    cost_center: string | null;
    raw_extraction: Record<string, unknown> | null;
  }>;
  let aprendidas = 0;
  const { aprenderDeCausacion } = await import("./learning-rules");
  for (const f of facturas) {
    const raw = f.raw_extraction ?? {};
    const decisiones = (raw["account_decisions"] ?? {}) as Record<string, Decision>;
    const { data: lin } = await db
      .from("invoice_lines")
      .select("position, description, item_type, account_code, account_name, iva")
      .eq("invoice_id", f.id)
      .order("position");
    const lineas = (lin ?? []) as Array<{
      position: number;
      description: string | null;
      item_type: string | null;
      account_code: string | null;
      account_name: string | null;
      iva: number | null;
    }>;
    // Manual = elegida por la usuaria (decisión MANUAL) o cuenta distinta de la que propuso el motor.
    const manuales = lineas.filter((l) => {
      const d = decisiones[String(l.position)];
      const cuenta = String(l.account_code ?? "").trim();
      if (!cuenta) return false;
      // Una cuenta padre/hija de la propuesta del motor (p. ej. 5195 → 51952501) es la misma, no una corrección.
      const relacionada =
        !!d?.code && (d.code === cuenta || cuenta.startsWith(d.code) || d.code.startsWith(cuenta));
      return d?.origin === "MANUAL" || (!!d?.code && !relacionada);
    });
    if (!manuales.length) continue;
    const firma = manuales.map((l) => `${l.position}:${l.account_code}:${l.item_type}`).join("|");
    if (raw["aprendido_manual"] === firma) continue;
    await aprenderDeCausacion({
      companyId,
      invoiceId: f.id,
      userId: usuarioId,
      providerNit: f.provider_nit,
      providerName: f.provider_name,
      costCenter: f.cost_center,
      lines: manuales.map((l) => ({
        description: l.description,
        item_type: /^14/.test(String(l.account_code ?? "")) ? "producto" : (l.item_type ?? "gasto"),
        account_code: l.account_code,
        account_name: l.account_name,
        iva: l.iva,
      })),
    });
    await db
      .from("invoices")
      .update({ raw_extraction: { ...raw, aprendido_manual: firma } as never })
      .eq("id", f.id);
    aprendidas += manuales.length;
  }
  return aprendidas;
}
