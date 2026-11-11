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

type SiigoGet = <T>(path: string) => Promise<T>;

/**
 * Lee la compra en Siigo por su identificador; si Siigo no la devuelve, la busca por su
 * número (FC-1-5705) entre las compras de esas fechas.
 */
async function leerCompra(
  siigoGet: SiigoGet,
  siigoId: string,
  nombre: string | null,
  fecha: string | null,
): Promise<{ doc: DocCompra; id: string }> {
  try {
    return {
      doc: await siigoGet<DocCompra>(`/v1/purchases/${encodeURIComponent(siigoId)}`),
      id: siigoId,
    };
  } catch (e) {
    if (!nombre || !fecha) throw e;
    const desde = new Date(`${fecha.slice(0, 10)}T00:00:00Z`);
    desde.setUTCDate(desde.getUTCDate() - 5);
    const hasta = new Date(`${fecha.slice(0, 10)}T00:00:00Z`);
    hasta.setUTCDate(hasta.getUTCDate() + 60);
    for (let page = 1; page <= 3; page++) {
      const r = await siigoGet<{ results?: DocCompra[] } | DocCompra[]>(
        `/v1/purchases?date_start=${desde.toISOString().slice(0, 10)}&date_end=${hasta.toISOString().slice(0, 10)}&page=${page}&page_size=100`,
      );
      const lista = Array.isArray(r) ? r : (r.results ?? []);
      const d = lista.find((x) => String(x.name ?? "").toUpperCase() === nombre.toUpperCase());
      if (d?.id) {
        try {
          return {
            doc: await siigoGet<DocCompra>(`/v1/purchases/${encodeURIComponent(d.id)}`),
            id: d.id,
          };
        } catch {
          return { doc: d, id: d.id };
        }
      }
      if (lista.length < 100) break;
    }
    throw e;
  }
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
          "id, siigo_id, siigo_number, provider_name, provider_nit, prefix, number, issue_date, total, payment_type_id, payment_type_name, payment_method",
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
        const fila = (
          pagos: Array<{ name: string; value: number }>,
          nota?: string,
        ): CompraPagada => ({
          invoiceId: inv.id,
          siigoId: String(inv.siigo_id),
          siigoNumero: inv.siigo_number ?? null,
          proveedor: inv.provider_name,
          nit: inv.provider_nit,
          factura: [inv.prefix, inv.number].filter(Boolean).join("-"),
          fecha: inv.issue_date,
          total: pagos.reduce((s, p) => s + p.value, 0) || Number(inv.total ?? 0),
          pagos: nota ? [...pagos, { name: nota, value: 0 }] : pagos,
        });
        try {
          const { doc } = await leerCompra(
            siigoGet,
            String(inv.siigo_id),
            inv.siigo_number,
            inv.issue_date,
          );
          const pagos = (doc.payments ?? []).map((p) => ({
            id: String(p.id ?? ""),
            name: String(p.name ?? porId.get(String(p.id))?.name ?? p.id ?? ""),
            value: Number(p.value ?? 0),
          }));
          // Sin formas de pago en la lectura no se puede afirmar que esté por pagar.
          const porPagar =
            pagos.length > 0 &&
            pagos.every((p) => {
              const local = porId.get(p.id);
              return esFormaPorPagar(
                local ?? { name: p.name, method: null, due_date_required: null },
              );
            });
          if (!porPagar) pagadas.push(fila(pagos.map(({ name, value }) => ({ name, value }))));
        } catch (e) {
          // Siigo no devolvió la compra: se usa la forma de pago con que la envió la herramienta.
          const local = inv.payment_type_id ? porId.get(String(inv.payment_type_id)) : undefined;
          const nombre = String(inv.payment_type_name ?? local?.name ?? "");
          const pagadaSegunApp =
            inv.payment_method === "contado" ||
            (nombre !== "" &&
              !esFormaPorPagar(local ?? { name: nombre, method: null, due_date_required: null }));
          if (pagadaSegunApp)
            pagadas.push(
              fila(
                [{ name: nombre || "contado", value: Number(inv.total ?? 0) }],
                "(según la herramienta; Siigo no devolvió la compra)",
              ),
            );
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
    const { doc, id: compraId } = await leerCompra(
      siigoGet,
      inv.siigo_id,
      inv.siigo_number,
      inv.issue_date,
    );
    const porId = new Map(formas.map((f) => [String(f.siigo_id), f]));
    const yaPorPagar =
      (doc.payments ?? []).length > 0 &&
      (doc.payments ?? []).every((p) =>
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
      await siigoPut(`/v1/purchases/${encodeURIComponent(compraId)}`, cuerpo);
    } catch (e) {
      return {
        ok: false,
        message: `Siigo no aceptó el cambio de ${inv.siigo_number} (la compra quedó igual): ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    // Verificación: la compra quedó con la forma por pagar y con saldo.
    const leido = await siigoGet<DocCompra>(`/v1/purchases/${encodeURIComponent(compraId)}`);
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
