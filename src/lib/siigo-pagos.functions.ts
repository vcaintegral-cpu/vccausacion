// Recibos de pago / egreso (RP) en Siigo — núcleo global: todas las empresas.
//
// API: POST /v1/payment-receipts con tipo
//   - DebtPayment   (abono a deuda): paga una compra ya causada en Siigo (FC-1-757).
//   - AdvancePayment (anticipo): pago al proveedor sin factura todavía.
// La forma de pago de Siigo (payment.id) es la que tiene la cuenta de caja/banco del
// pago; se toma de las formas sincronizadas (siigo_payment_types.account_code) o la elige
// la usuaria. Nunca se reenvía un recibo que ya tiene identidad en Siigo.
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type TipoRP = { id: number; code?: string | null; name: string; active: boolean };
type FormaPago = { id: number; name: string; active: boolean; dueDate: boolean; accountCode: string | null };

const nitSinDv = (nit: string | null | undefined) => {
  const t = String(nit ?? "").trim();
  const m = /^(.*)-\s*\d\s*$/.exec(t);
  return (m ? m[1]! : t).replace(/\D/g, "");
};

/** "FC-1-757" → { prefix: "FC-1", consecutive: 757 }. */
export function vencimientoDeComprobante(nombre: string | null | undefined): { prefix: string; consecutive: number } | null {
  const m = /^\s*([A-Za-z]+-\d+)-(\d+)\s*$/.exec(String(nombre ?? ""));
  return m ? { prefix: m[1]!.toUpperCase(), consecutive: Number(m[2]) } : null;
}

/** Tipos de recibo de pago (RP) y formas de pago de proveedor de la empresa en Siigo. */
export const siigoRecibosConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => {
    if (!input?.companyId) throw new Error("companyId requerido");
    return input;
  })
  .handler(async ({ data, context }): Promise<{ tipos: TipoRP[]; formas: FormaPago[] }> => {
    const { siigoGet, siigoUseCompany } = await import("./siigo.server");
    await siigoUseCompany(data.companyId);
    type DocType = { id?: number; code?: string | number; name?: string; active?: boolean; type?: string };
    const docs = await siigoGet<DocType[] | { results?: DocType[] }>("/v1/document-types?type=RP");
    const tipos = (Array.isArray(docs) ? docs : (docs.results ?? []))
      .filter((d) => d.id != null)
      .map((d) => ({ id: Number(d.id), code: d.code != null ? String(d.code) : null, name: String(d.name ?? `RP ${d.code ?? d.id}`), active: d.active !== false }));
    type Pay = { id?: number; name?: string; active?: boolean; due_date?: boolean; type?: string };
    let pays: Pay[] = [];
    for (const tipo of ["RP", "FC"]) {
      try {
        const r = await siigoGet<Pay[] | { results?: Pay[] }>(`/v1/payment-types?document_type=${tipo}`);
        pays = Array.isArray(r) ? r : (r.results ?? []);
        if (pays.length) break;
      } catch {
        /* se intenta con el siguiente tipo de documento */
      }
    }
    const { data: locales } = await context.supabase
      .from("siigo_payment_types")
      .select("siigo_id, account_code")
      .eq("company_id", data.companyId);
    const cuentaDe = new Map((locales ?? []).map((l) => [String(l.siigo_id), l.account_code ?? null]));
    const formas = pays
      .filter((p) => p.id != null)
      .map((p) => ({
        id: Number(p.id),
        name: String(p.name ?? p.id),
        active: p.active !== false,
        dueDate: !!p.due_date,
        accountCode: cuentaDe.get(String(p.id)) ?? null,
      }));
    return { tipos, formas };
  });

type ResultadoRP = { ok: boolean; siigoId: string | null; nombre: string | null; message: string };

async function crearRP(payload: Record<string, unknown>) {
  const { siigoGet, siigoPost } = await import("./siigo.server");
  const res = await siigoPost<{ id?: string; name?: string; number?: number; document?: { id?: number } }>(
    "/v1/payment-receipts",
    payload,
  );
  if (!res?.id) throw new Error("Siigo no devolvió el identificador del recibo de pago.");
  // Lectura de verificación: el recibo existe y su valor es el enviado.
  let verificado: { name?: string; payment?: { value?: number } } | null = null;
  try {
    verificado = await siigoGet<{ name?: string; payment?: { value?: number } }>(`/v1/payment-receipts/${res.id}`);
  } catch {
    verificado = null;
  }
  return { id: String(res.id), nombre: String(verificado?.name ?? res.name ?? ""), verificado };
}

/** Envía a Siigo el recibo de pago (abono a deuda) de una compra ya causada en Siigo. */
export const siigoEnviarRecibo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { receiptId: string; documentId?: number | null; paymentTypeId?: number | null }) => {
    if (!input?.receiptId) throw new Error("receiptId requerido");
    return input;
  })
  .handler(async ({ data, context }): Promise<ResultadoRP> => {
    const supabase = context.supabase;
    const { data: rec, error } = await supabase
      .from("payment_receipts")
      .select("id, company_id, invoice_id, payment_date, amount, account_code, receipt_number, notes, siigo_id, siigo_status")
      .eq("id", data.receiptId)
      .single();
    if (error || !rec) throw new Error(error?.message ?? "Recibo no encontrado.");
    if (rec.siigo_id) return { ok: true, siigoId: rec.siigo_id, nombre: null, message: "Este recibo ya está en Siigo; no se reenvía." };
    const { data: inv } = await supabase
      .from("invoices")
      .select("id, provider_nit, siigo_number, prefix, number")
      .eq("id", rec.invoice_id)
      .single();
    const venc = vencimientoDeComprobante(inv?.siigo_number);
    if (!venc) throw new Error("La compra aún no tiene consecutivo de Siigo (FC-…): cáusala en Siigo antes de enviar el pago.");

    const { siigoUseCompany } = await import("./siigo.server");
    await siigoUseCompany(rec.company_id);
    // Forma de pago: la elegida, o la forma de Siigo cuya cuenta es la del pago.
    let paymentTypeId = data.paymentTypeId ?? null;
    if (!paymentTypeId) {
      const { data: formas } = await supabase
        .from("siigo_payment_types")
        .select("siigo_id, account_code, due_date_required, active")
        .eq("company_id", rec.company_id)
        .eq("account_code", rec.account_code);
      const f = (formas ?? []).find((x) => x.active !== false && !x.due_date_required);
      paymentTypeId = f ? Number(f.siigo_id) : null;
    }
    if (!paymentTypeId)
      throw new Error(`No hay forma de pago de Siigo asociada a la cuenta ${rec.account_code}: elígela al enviar el recibo.`);
    let documentId = data.documentId ?? null;
    if (!documentId) {
      const { siigoGet } = await import("./siigo.server");
      const docs = await siigoGet<Array<{ id?: number; active?: boolean }> | { results?: Array<{ id?: number; active?: boolean }> }>("/v1/document-types?type=RP");
      documentId = (Array.isArray(docs) ? docs : (docs.results ?? [])).find((d) => d.id && d.active !== false)?.id ?? null;
    }
    if (!documentId) throw new Error("La empresa no tiene un tipo de recibo de pago (RP) activo en Siigo.");

    // Bloqueo contra doble envío.
    const { data: bloqueado } = await supabase
      .from("payment_receipts")
      .update({ siigo_status: "enviando", siigo_error: null })
      .eq("id", rec.id)
      .is("siigo_id", null)
      .neq("siigo_status", "enviando")
      .select("id");
    if (!bloqueado?.length) throw new Error("El recibo ya se está enviando a Siigo.");

    const valor = Math.round(Number(rec.amount) * 100) / 100;
    const payload = {
      document: { id: documentId },
      date: String(rec.payment_date).slice(0, 10),
      type: "DebtPayment",
      supplier: { identification: nitSinDv(inv?.provider_nit), branch_office: 0 },
      items: [{ due: { prefix: venc.prefix, consecutive: venc.consecutive, quote: 1 }, value: valor }],
      payment: { id: paymentTypeId, value: valor },
      observations: `Pago ${[inv?.prefix, inv?.number].filter(Boolean).join("-")} · recibo interno ${rec.receipt_number}`,
    };
    try {
      const r = await crearRP(payload);
      await supabase
        .from("payment_receipts")
        .update({ siigo_id: r.id, siigo_status: "enviado", siigo_error: null, notes: [rec.notes, `Siigo ${r.nombre || r.id}`].filter(Boolean).join(" · ") })
        .eq("id", rec.id);
      return { ok: true, siigoId: r.id, nombre: r.nombre || null, message: `Recibo ${r.nombre || r.id} creado en Siigo y aplicado a ${inv?.siigo_number}.` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supabase.from("payment_receipts").update({ siigo_status: "error", siigo_error: msg.slice(0, 2000) }).eq("id", rec.id);
      return { ok: false, siigoId: null, nombre: null, message: msg };
    }
  });

/** Crea un anticipo a un proveedor en Siigo (también sirve como prueba de conexión del RP). */
export const siigoCrearAnticipo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; nit: string; fecha: string; valor: number; paymentTypeId: number; documentId: number; observaciones?: string }) => {
      if (!input?.companyId || !input.nit || !input.fecha || !(Number(input.valor) > 0) || !input.paymentTypeId || !input.documentId)
        throw new Error("Faltan datos del anticipo (proveedor, fecha, valor, forma de pago y tipo de recibo).");
      return input;
    },
  )
  .handler(async ({ data }): Promise<ResultadoRP> => {
    const { siigoUseCompany } = await import("./siigo.server");
    await siigoUseCompany(data.companyId);
    const valor = Math.round(Number(data.valor) * 100) / 100;
    try {
      const r = await crearRP({
        document: { id: data.documentId },
        date: data.fecha,
        type: "AdvancePayment",
        supplier: { identification: nitSinDv(data.nit), branch_office: 0 },
        payment: { id: data.paymentTypeId, value: valor },
        observations: data.observaciones ?? "Anticipo",
      });
      return { ok: true, siigoId: r.id, nombre: r.nombre || null, message: `Anticipo ${r.nombre || r.id} creado en Siigo.` };
    } catch (e) {
      return { ok: false, siigoId: null, nombre: null, message: e instanceof Error ? e.message : String(e) };
    }
  });

/** Borra un recibo de pago en Siigo (y lo desmarca en la herramienta si estaba ligado a uno interno). */
export const siigoBorrarRecibo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; siigoId: string; receiptId?: string | null }) => {
    if (!input?.companyId || !input.siigoId) throw new Error("companyId y siigoId requeridos");
    return input;
  })
  .handler(async ({ data, context }): Promise<{ ok: boolean; message: string }> => {
    const { siigoDelete, siigoUseCompany } = await import("./siigo.server");
    await siigoUseCompany(data.companyId);
    try {
      await siigoDelete(`/v1/payment-receipts/${encodeURIComponent(data.siigoId)}`);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    if (data.receiptId)
      await context.supabase
        .from("payment_receipts")
        .update({ siigo_id: null, siigo_status: "borrado_en_siigo" })
        .eq("id", data.receiptId)
        .eq("siigo_id", data.siigoId);
    return { ok: true, message: "Recibo borrado en Siigo." };
  });
