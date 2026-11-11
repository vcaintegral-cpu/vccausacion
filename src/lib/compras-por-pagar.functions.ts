// Compras enviadas a Siigo como PAGADAS que deben quedar POR PAGAR (función por empresa
// `compras_por_pagar`). La corrección edita la forma de pago de la compra en Siigo
// (PUT /v1/purchases/{id}) solo con la confirmación de la usuaria.
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { esFormaPorPagar, formaPagoPorPagar, type FormaPagoLocal } from "@/lib/compras-por-pagar";
import type { DocCompra } from "@/lib/egresos-diferencias";

export type CompraPagada = {
  invoiceId: string;
  siigoId: string;
  siigoNumero: string | null;
  proveedor: string | null;
  nit: string | null;
  factura: string;
  fecha: string | null;
  total: number;
  pagos: Array<{ name: string; value: number }>;
};

const LOTE = 20; // compras leídas de Siigo por llamada (el Worker limita las llamadas externas)

async function verificarFuncion(db: { from: (t: string) => unknown }, companyId: string) {
  const { funcionActiva } = await import("@/empresas/registro");
  const { data } = await (db as import("@supabase/supabase-js").SupabaseClient)
    .from("companies")
    .select("nit")
    .eq("id", companyId)
    .single();
  if (!funcionActiva((data as { nit?: string } | null)?.nit ?? null, "compras_por_pagar"))
    throw new Error("Esta empresa no tiene activa la regla de compras siempre por pagar.");
}

async function formasLocales(
  db: import("@supabase/supabase-js").SupabaseClient,
  companyId: string,
) {
  const { data } = await db
    .from("siigo_payment_types")
    .select("siigo_id, name, method, account_code, active, due_date_required")
    .eq("company_id", companyId);
  return (data ?? []) as FormaPagoLocal[];
}

/** Revisa en Siigo, por lotes, las compras del mes enviadas desde la herramienta y devuelve las que quedaron pagadas. */
export const comprasPagadasRevisar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; periodo: string; desde?: number }) => {
    if (!input?.companyId || !/^\d{4}-\d{2}$/.test(input.periodo ?? ""))
      throw new Error("Empresa y mes requeridos.");
    return input;
  })
  .handler(
    async ({
      data,
      context,
    }): Promise<{
      total: number;
      revisadas: number;
      siguiente: number | null;
      pagadas: CompraPagada[];
      errores: string[];
    }> => {
      const db = context.supabase;
      await verificarFuncion(db, data.companyId);
      const [anio, mes] = data.periodo.split("-").map(Number) as [number, number];
      const fin = new Date(Date.UTC(anio, mes, 0)).toISOString().slice(0, 10);
      const {
        data: facturas,
        error,
        count,
      } = await db
        .from("invoices")
        .select(
          "id, siigo_id, siigo_number, provider_name, provider_nit, prefix, number, issue_date, total",
          { count: "exact" },
        )
        .eq("company_id", data.companyId)
        .eq("doc_kind", "compra")
        .not("siigo_id", "is", null)
        .gte("issue_date", `${data.periodo}-01`)
        .lte("issue_date", fin)
        .order("issue_date")
        .range(data.desde ?? 0, (data.desde ?? 0) + LOTE - 1);
      if (error) throw new Error(error.message);
      const formas = await formasLocales(db, data.companyId);
      const porId = new Map(formas.map((f) => [String(f.siigo_id), f]));
      const { siigoGet, siigoUseCompany } = await import("./siigo.server");
      await siigoUseCompany(data.companyId);
      const pagadas: CompraPagada[] = [];
      const errores: string[] = [];
      for (const inv of facturas ?? []) {
        try {
          const doc = await siigoGet<DocCompra>(
            `/v1/purchases/${encodeURIComponent(String(inv.siigo_id))}`,
          );
          const pagos = (doc.payments ?? []).map((p) => ({
            id: String(p.id ?? ""),
            name: String(p.name ?? porId.get(String(p.id))?.name ?? p.id ?? ""),
            value: Number(p.value ?? 0),
          }));
          const porPagar = pagos.every((p) => {
            const local = porId.get(p.id);
            return esFormaPorPagar(
              local ?? { name: p.name, method: null, due_date_required: null },
            );
          });
          if (!porPagar)
            pagadas.push({
              invoiceId: inv.id,
              siigoId: String(inv.siigo_id),
              siigoNumero: inv.siigo_number ?? doc.name ?? null,
              proveedor: inv.provider_name,
              nit: inv.provider_nit,
              factura: [inv.prefix, inv.number].filter(Boolean).join("-"),
              fecha: inv.issue_date,
              total: pagos.reduce((s, p) => s + p.value, 0),
              pagos: pagos.map(({ name, value }) => ({ name, value })),
            });
        } catch (e) {
          errores.push(
            `${inv.siigo_number ?? inv.id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      const revisadas = (data.desde ?? 0) + (facturas ?? []).length;
      return {
        total: count ?? revisadas,
        revisadas,
        siguiente: revisadas < (count ?? 0) ? revisadas : null,
        pagadas,
        errores,
      };
    },
  );

/** Cambia en Siigo la forma de pago de una compra pagada a la forma por pagar (crédito) de la empresa. */
export const compraPasarAPorPagar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; invoiceId: string; confirmado: boolean }) => {
    if (!input?.companyId || !input.invoiceId) throw new Error("Datos incompletos.");
    if (input.confirmado !== true)
      throw new Error("La corrección en Siigo requiere tu confirmación.");
    return input;
  })
  .handler(async ({ data, context }): Promise<{ ok: boolean; message: string }> => {
    const db = context.supabase;
    await verificarFuncion(db, data.companyId);
    const { data: inv, error } = await db
      .from("invoices")
      .select(
        "id, company_id, siigo_id, siigo_number, provider_nit, issue_date, due_date, payable_account",
      )
      .eq("id", data.invoiceId)
      .eq("company_id", data.companyId)
      .single();
    if (error || !inv?.siigo_id) throw new Error(error?.message ?? "La compra no está en Siigo.");
    const formas = await formasLocales(db, data.companyId);
    const forma = formaPagoPorPagar(formas, inv.payable_account);
    if ("error" in forma) return { ok: false, message: forma.error };

    const { siigoGet, siigoPut, siigoUseCompany } = await import("./siigo.server");
    await siigoUseCompany(data.companyId);
    const doc = await siigoGet<DocCompra>(`/v1/purchases/${encodeURIComponent(inv.siigo_id)}`);
    const porId = new Map(formas.map((f) => [String(f.siigo_id), f]));
    const yaPorPagar = (doc.payments ?? []).every((p) =>
      esFormaPorPagar(
        porId.get(String(p.id)) ?? {
          name: String(p.name ?? ""),
          method: null,
          due_date_required: null,
        },
      ),
    );
    if (yaPorPagar) return { ok: true, message: `${inv.siigo_number} ya está por pagar en Siigo.` };
    const fecha = String(doc.date ?? inv.issue_date ?? "").slice(0, 10);
    const venceFactura = String(inv.due_date ?? "").slice(0, 10);
    const vencimiento = venceFactura && venceFactura >= fecha ? venceFactura : fecha;
    const { compraPorPagar } = await import("./egresos-diferencias");
    const cuerpo = compraPorPagar(doc, Number(forma.id), vencimiento);
    try {
      await siigoPut(`/v1/purchases/${encodeURIComponent(inv.siigo_id)}`, cuerpo);
    } catch (e) {
      return {
        ok: false,
        message: `Siigo no aceptó el cambio de ${inv.siigo_number} (la compra quedó igual): ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    // Verificación: la compra quedó con la forma por pagar y con saldo.
    const leido = await siigoGet<DocCompra>(`/v1/purchases/${encodeURIComponent(inv.siigo_id)}`);
    const ok = (leido.payments ?? []).every((p) => String(p.id) === String(forma.id));
    await db
      .from("invoices")
      .update({
        payment_method: "credito",
        payment_type_id: String(forma.id),
        payment_type_name: forma.name,
      })
      .eq("id", inv.id);
    if (inv.provider_nit) {
      const { sincronizarCxP } = await import("./egresos.server");
      const nit = String(inv.provider_nit)
        .replace(/-\s*\d\s*$/, "")
        .replace(/\D/g, "");
      await sincronizarCxP(db, data.companyId, { soloNit: nit }).catch(() => undefined);
    }
    return {
      ok,
      message: ok
        ? `${inv.siigo_number}: ahora queda por pagar con «${forma.name}» (vence ${vencimiento}).`
        : `${inv.siigo_number}: Siigo aceptó la edición pero la lectura no muestra la forma «${forma.name}»; revísala en Siigo.`,
    };
  });
