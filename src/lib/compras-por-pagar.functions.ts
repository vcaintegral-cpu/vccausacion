// Compras enviadas a Siigo como PAGADAS que deben quedar POR PAGAR (función por empresa
// `compras_por_pagar`). La corrección edita la forma de pago de la compra en Siigo
// (PUT /v1/purchases/{id}) solo con la confirmación de la usuaria.
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { esFormaPorPagar, formaPagoPorPagar, type FormaPagoLocal } from "@/lib/compras-por-pagar";
import type { DocCompra } from "@/lib/egresos-diferencias";

export type CompraPagada = {
  /** Factura en la herramienta (null si la compra se registró directamente en Siigo). */
  invoiceId: string | null;
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
    for (let page = 1; page <= 5; page++) {
      const r = await siigoGet<{ results?: DocCompra[] } | DocCompra[]>(
        // El listado de compras de Siigo filtra por fecha de CREACIÓN (created_start).
        `/v1/purchases?created_start=${desde.toISOString().slice(0, 10)}&page=${page}&page_size=100`,
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

/**
 * Revisa las compras del mes directamente en Siigo (listado por fechas, 100 por página) y
 * devuelve las que quedaron pagadas (tarjeta, efectivo, banco, contado). La fuente es Siigo:
 * no depende de las fechas ni de los identificadores guardados en la herramienta.
 */
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
      const pagina = (data.desde ?? 0) + 1; // «desde» = páginas ya leídas
      const formas = await formasLocales(db, data.companyId);
      const porId = new Map(formas.map((f) => [String(f.siigo_id), f]));
      const { siigoGet, siigoUseCompany } = await import("./siigo.server");
      await siigoUseCompany(data.companyId);
      const errores: string[] = [];
      type Lista = { results?: DocCompra[]; pagination?: { total_results?: number } } | DocCompra[];
      const r = await siigoGet<Lista>(
        // Siigo filtra el listado por fecha de CREACIÓN: se piden las creadas desde el inicio
        // del mes y aquí se dejan solo las elaboradas (fecha de la compra) en el mes.
        `/v1/purchases?created_start=${data.periodo}-01&page=${pagina}&page_size=100`,
      );
      const lista = Array.isArray(r) ? r : (r.results ?? []);
      const total = Array.isArray(r)
        ? lista.length
        : Number(r.pagination?.total_results ?? lista.length);
      // Compras de la herramienta (para ligar la corrección con su factura).
      const nombres = lista.map((d) => String(d.name ?? "")).filter(Boolean);
      const { data: propias } = nombres.length
        ? await db
            .from("invoices")
            .select("id, siigo_number, provider_name, provider_nit, prefix, number, issue_date")
            .eq("company_id", data.companyId)
            .in("siigo_number", nombres)
        : { data: [] };
      const porNombre = new Map(
        (
          (propias ?? []) as Array<{
            id: string;
            siigo_number: string;
            provider_name: string | null;
            provider_nit: string | null;
            prefix: string | null;
            number: string | null;
            issue_date: string | null;
          }>
        ).map((i) => [i.siigo_number.toUpperCase(), i]),
      );
      const pagadas: CompraPagada[] = [];
      for (const d of lista) {
        const fechaCompra = String(d.date ?? "").slice(0, 10);
        if (fechaCompra && (fechaCompra < `${data.periodo}-01` || fechaCompra > fin)) continue;
        let doc = d;
        try {
          if (!(doc.payments ?? []).length && doc.id)
            doc = await siigoGet<DocCompra>(`/v1/purchases/${encodeURIComponent(doc.id)}`);
        } catch (e) {
          errores.push(`${d.name ?? d.id}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        const pagos = (doc.payments ?? []).map((p) => ({
          id: String(p.id ?? ""),
          name: String(p.name ?? porId.get(String(p.id))?.name ?? p.id ?? ""),
          value: Number(p.value ?? 0),
        }));
        // Sin formas de pago en la lectura no se sabe cómo quedó: se informa, no se corrige.
        if (!pagos.length) {
          errores.push(
            `${doc.name ?? doc.id}: Siigo no devolvió sus formas de pago; revísala en Siigo.`,
          );
          continue;
        }
        const porPagar = pagos.every((p) =>
          esFormaPorPagar(
            porId.get(p.id) ?? { name: p.name, method: null, due_date_required: null },
          ),
        );
        if (porPagar) continue;
        const inv = porNombre.get(String(doc.name ?? "").toUpperCase());
        pagadas.push({
          invoiceId: inv?.id ?? null,
          siigoId: String(doc.id ?? ""),
          siigoNumero: doc.name ?? null,
          proveedor: inv?.provider_name ?? null,
          nit:
            inv?.provider_nit ??
            (doc.supplier?.identification ? String(doc.supplier.identification) : null),
          factura:
            [doc.provider_invoice?.prefix, doc.provider_invoice?.number]
              .filter((x) => x != null && String(x).trim())
              .join("-") || [inv?.prefix, inv?.number].filter(Boolean).join("-"),
          fecha: String(doc.date ?? inv?.issue_date ?? "").slice(0, 10) || null,
          total: pagos.reduce((s, p) => s + p.value, 0),
          pagos: pagos.length
            ? pagos.map(({ name, value }) => ({ name, value }))
            : [{ name: "sin forma de pago en Siigo", value: 0 }],
        });
      }
      const revisadas = Math.min(total, (pagina - 1) * 100 + lista.length);
      return {
        total,
        revisadas,
        siguiente: lista.length === 100 && revisadas < total ? pagina : null,
        pagadas,
        errores,
      };
    },
  );

/** Cambia en Siigo la forma de pago de una compra pagada a la forma por pagar (crédito) de la empresa. */
export const compraPasarAPorPagar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      siigoId: string;
      invoiceId?: string | null;
      confirmado: boolean;
    }) => {
      if (!input?.companyId || !input.siigoId) throw new Error("Datos incompletos.");
      if (input.confirmado !== true)
        throw new Error("La corrección en Siigo requiere tu confirmación.");
      return input;
    },
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean; message: string }> => {
    const db = context.supabase;
    await verificarFuncion(db, data.companyId);
    // La compra de la herramienta (si la hay) aporta la cuenta CxP y el vencimiento.
    const { data: invRow } = data.invoiceId
      ? await db
          .from("invoices")
          .select("id, siigo_number, provider_nit, issue_date, due_date, payable_account")
          .eq("id", data.invoiceId)
          .eq("company_id", data.companyId)
          .maybeSingle()
      : { data: null };
    const inv = {
      id: invRow?.id ?? null,
      siigo_id: data.siigoId,
      siigo_number: invRow?.siigo_number ?? null,
      provider_nit: invRow?.provider_nit ?? null,
      issue_date: invRow?.issue_date ?? null,
      due_date: invRow?.due_date ?? null,
      payable_account: invRow?.payable_account ?? null,
    };
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
    if (inv.id)
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
