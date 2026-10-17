// RECUPERACIÓN DE ENVÍOS A SIIGO
// Acciones persistentes sobre compras en "Error Siigo", independientes de la sesión:
//  - Consultar de nuevo un documento ya creado (nunca reenvía).
//  - Marcar como correcto (conciliación manual con comentario obligatorio).
//  - Marcar como anulado en Siigo (libera el consecutivo para reenviar).
//  - Liberar envíos interrumpidos y buscar en Siigo si quedaron creados.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  INTERRUPTED_AFTER_MS,
  purchaseReadbackComparison,
  readbackExpectedFromDoc,
  type PurchaseReadback,
  type ReadbackRow,
} from "@/lib/siigo-purchase-validation";

type Supa = SupabaseClient<Database>;

const INV_COLS =
  "id, company_id, prefix, number, provider_nit, provider_name, issue_date, total, iva, impoconsumo, retefuente, reteiva, reteica, status, siigo_status, siigo_id, siigo_number, siigo_error_kind, siigo_trace, siigo_voided, siigo_last_attempt_at";

type InvRow = {
  id: string; company_id: string; prefix: string | null; number: string | null;
  provider_nit: string | null; provider_name: string | null; issue_date: string | null;
  total: number; iva: number; impoconsumo: number; retefuente: number; reteiva: number; reteica: number;
  status: string; siigo_status: string; siigo_id: string | null; siigo_number: string | null;
  siigo_error_kind: string | null; siigo_trace: Json | null; siigo_voided: Json | null; siigo_last_attempt_at: string | null;
};

export type RecoveryResult = { ok: boolean; message: string; status?: string; comparacion?: ReadbackRow[] };

async function loadInvoice(supabase: Supa, id: string): Promise<InvRow> {
  const { data, error } = await supabase.from("invoices").select(INV_COLS).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Factura no encontrada o sin acceso.");
  return data as InvRow;
}

const label = (i: InvRow) => [i.prefix, i.number].filter(Boolean).join("-") || "Sin número";
const traceObj = (t: Json | null) => (t && typeof t === "object" && !Array.isArray(t) ? (t as Record<string, unknown>) : {});

async function logEvent(supabase: Supa, inv: InvRow, action: string, message: string, userId: string, status: string, siigoStatus: string) {
  await supabase.from("invoice_events").insert({
    company_id: inv.company_id, invoice_id: inv.id, status, siigo_status: siigoStatus, action, message, created_by: userId,
  });
}

/** Re-reads the existing Siigo document and compares gross vs gross and net vs net. */
async function recheck(supabase: Supa, inv: InvRow, userId: string): Promise<RecoveryResult> {
  if (!inv.siigo_id) return { ok: false, message: "La factura no tiene documento creado en Siigo para consultar." };
  const { siigoGet, siigoUseCompany } = await import("./siigo.server");
  await siigoUseCompany(inv.company_id);
  let doc: PurchaseReadback & { retentions?: Array<{ value?: number }>; name?: string };
  try {
    doc = await siigoGet(`/v1/purchases/${inv.siigo_id}`);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    if (/404|not.?found/i.test(raw))
      return { ok: false, message: `Siigo no encontró ${inv.siigo_number ?? inv.siigo_id}. Si lo anuló, use "Marcado como anulado en Siigo".` };
    throw new Error(`No fue posible consultar Siigo: ${raw}`);
  }
  const comparacion = purchaseReadbackComparison(doc, readbackExpectedFromDoc(doc, inv, Number(traceObj(inv.siigo_trace)["inc_como_costo"] ?? 0), { ivaAsCost: Number(traceObj(inv.siigo_trace)["iva_capitalizado"] ?? 0), providerRounding: Number(traceObj(inv.siigo_trace)["redondeo_proveedor"] ?? 0) }));
  const diferencias = comparacion.filter((r) => !r.ok);
  const now = new Date().toISOString();
  const trace = { ...traceObj(inv.siigo_trace), comparacion, siigo_verificacion: doc as unknown as Json, consultado_at: now } as Json;
  if (diferencias.length === 0) {
    const { error } = await supabase.from("invoices").update({
      siigo_status: "sincronizada", status: "historico", siigo_error: null, siigo_error_kind: null,
      siigo_synced_at: now, siigo_synced_by: userId, siigo_trace: { ...(trace as object), resultado: "sincronizada" } as Json,
    }).eq("id", inv.id);
    if (error) throw new Error(error.message);
    return { ok: true, status: "sincronizada", comparacion, message: `${label(inv)}: Siigo ${inv.siigo_number ?? ""} coincide con la fuente. Pasó a Sincronizada.` };
  }
  const message = "Diferencia Siigo: " + diferencias.map((r) => `${r.campo}: origen ${r.origen}, Siigo ${r.siigo ?? "no informado"}`).join("; ") + ". No reenvíe el documento creado.";
  await supabase.from("invoices").update({
    siigo_error: message, siigo_error_kind: "creado_diferencia",
    siigo_trace: { ...(trace as object), resultado: "Diferencia Siigo", diferencias: diferencias.map((d) => d.campo) } as Json,
  }).eq("id", inv.id);
  return { ok: false, status: "error", comparacion, message };
}

export const siigoRecheckInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { invoiceId: string }) => { if (!i?.invoiceId) throw new Error("invoiceId requerido"); return i; })
  .handler(async ({ data, context }): Promise<RecoveryResult> => {
    const inv = await loadInvoice(context.supabase, data.invoiceId);
    return recheck(context.supabase, inv, context.userId);
  });

export const siigoMarkReconciled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { invoiceId: string; comment: string }) => {
    if (!i?.invoiceId) throw new Error("invoiceId requerido");
    if (!i.comment || i.comment.trim().length < 5) throw new Error("El comentario es obligatorio (mínimo 5 caracteres).");
    return { invoiceId: i.invoiceId, comment: i.comment.trim().slice(0, 1000) };
  })
  .handler(async ({ data, context }): Promise<RecoveryResult> => {
    const inv = await loadInvoice(context.supabase, data.invoiceId);
    if (!inv.siigo_id && !inv.siigo_number) return { ok: false, message: "Solo se concilian documentos que existen en Siigo." };
    if (inv.siigo_status !== "error") return { ok: false, message: "La factura no está en Error Siigo." };
    const now = new Date().toISOString();
    const { error } = await context.supabase.from("invoices").update({
      siigo_status: "sincronizada", status: "historico", siigo_error: null, siigo_error_kind: null,
      siigo_synced_at: now, siigo_synced_by: context.userId,
      siigo_reconciled_note: data.comment, siigo_reconciled_by: context.userId, siigo_reconciled_at: now,
    }).eq("id", inv.id);
    if (error) throw new Error(error.message);
    await logEvent(context.supabase, inv, "Sincronizada – conciliada manualmente", `${inv.siigo_number ?? inv.siigo_id}: ${data.comment}`, context.userId, "historico", "sincronizada");
    return { ok: true, status: "sincronizada", message: `${label(inv)} marcada como correcta en Siigo.` };
  });

export const siigoMarkVoided = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { invoiceId: string; comment?: string }) => {
    if (!i?.invoiceId) throw new Error("invoiceId requerido");
    return { invoiceId: i.invoiceId, comment: (i.comment ?? "").trim().slice(0, 1000) };
  })
  .handler(async ({ data, context }): Promise<RecoveryResult> => {
    const inv = await loadInvoice(context.supabase, data.invoiceId);
    if (!inv.siigo_id && !inv.siigo_number) return { ok: false, message: "La factura no tiene consecutivo en Siigo." };
    if (inv.siigo_status !== "error") return { ok: false, message: "Solo se marcan como anulados documentos en Error Siigo." };
    const anterior = Array.isArray(inv.siigo_voided) ? inv.siigo_voided : [];
    const registro = { siigo_id: inv.siigo_id, siigo_number: inv.siigo_number, anulado_at: new Date().toISOString(), anulado_por: context.userId, comentario: data.comment || null };
    const { error } = await context.supabase.from("invoices").update({
      siigo_voided: [...anterior, registro] as unknown as Json,
      siigo_id: null, siigo_number: null, siigo_document_url: null,
      siigo_error_kind: "sin_crear",
      siigo_error: `Documento ${inv.siigo_number ?? inv.siigo_id} anulado en Siigo. Listo para reenviar.`,
    }).eq("id", inv.id);
    if (error) throw new Error(error.message);
    await logEvent(context.supabase, inv, "Marcado como anulado en Siigo", `Consecutivo anulado: ${inv.siigo_number ?? inv.siigo_id}${data.comment ? ` · ${data.comment}` : ""}`, context.userId, inv.status, "error");
    return { ok: true, status: "error", message: `${label(inv)}: ${inv.siigo_number ?? "documento"} anulado. Ya puede reintentar el envío.` };
  });

/** Moves sends stuck in "Sincronizando" for more than five minutes to "Envío interrumpido". */
export const siigoReleaseInterrupted = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { companyId: string }) => { if (!i?.companyId) throw new Error("companyId requerido"); return i; })
  .handler(async ({ data, context }): Promise<{ released: number }> => {
    const limite = new Date(Date.now() - INTERRUPTED_AFTER_MS).toISOString();
    const { data: rows, error } = await context.supabase.from("invoices")
      .update({ siigo_status: "error", siigo_error_kind: "interrumpido", siigo_error: "Error Siigo – Envío interrumpido. Consulte Siigo antes de reintentar." })
      .eq("company_id", data.companyId).eq("siigo_status", "sincronizando")
      .or(`siigo_last_attempt_at.is.null,siigo_last_attempt_at.lt.${limite}`)
      .select("id");
    if (error) throw new Error(error.message);
    return { released: (rows ?? []).length };
  });

type SiigoListed = { id?: string; name?: string; supplier?: { identification?: string }; provider_invoice?: { prefix?: string; number?: string | number } };
const digits = (v: unknown) => String(v ?? "").split("-")[0]!.replace(/\D/g, "");

/** After an interrupted send, searches Siigo by provider + invoice number before allowing a retry. */
export const siigoCheckInterrupted = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { invoiceId: string }) => { if (!i?.invoiceId) throw new Error("invoiceId requerido"); return i; })
  .handler(async ({ data, context }): Promise<RecoveryResult & { found: boolean }> => {
    const inv = await loadInvoice(context.supabase, data.invoiceId);
    if (inv.siigo_id) return { ok: true, found: true, message: "La factura ya tiene documento en Siigo." };
    const { siigoGet, siigoUseCompany } = await import("./siigo.server");
    await siigoUseCompany(inv.company_id);
    const nit = digits(inv.provider_nit);
    const numero = String(inv.number ?? "").replace(/\D/g, "");
    const prefijo = (inv.prefix ?? "").trim().toUpperCase() || "FC";
    const dia = (iso: string | null) => (iso ?? "").slice(0, 10);
    const consultas = [
      inv.siigo_last_attempt_at ? `created_start=${dia(inv.siigo_last_attempt_at)}` : null,
      inv.issue_date ? `date_start=${inv.issue_date}&date_end=${inv.issue_date}` : null,
    ].filter(Boolean) as string[];
    let consultadas = 0;
    let encontrado: SiigoListed | null = null;
    for (const filtro of consultas) {
      try {
        for (let page = 1; page <= 5 && !encontrado; page += 1) {
          const res = await siigoGet<{ results?: SiigoListed[]; pagination?: { total_results?: number } }>(`/v1/purchases?${filtro}&page_size=100&page=${page}`);
          const lista = res.results ?? [];
          encontrado = lista.find((p) => digits(p.supplier?.identification) === nit
            && String(p.provider_invoice?.number ?? "").replace(/\D/g, "") === numero
            && String(p.provider_invoice?.prefix ?? "").trim().toUpperCase() === prefijo) ?? null;
          if (lista.length < 100) break;
        }
        consultadas += 1;
      } catch (e) {
        console.warn("[siigo][interrumpido] consulta fallida", filtro, e);
      }
      if (encontrado) break;
    }
    if (!encontrado && consultadas === 0)
      return { ok: false, found: false, message: "No fue posible consultar Siigo. Intente de nuevo; el reenvío sigue bloqueado para evitar duplicados." };
    if (encontrado?.id) {
      await context.supabase.from("invoices").update({
        siigo_id: String(encontrado.id), siigo_number: encontrado.name ?? String(encontrado.id),
        siigo_error_kind: "creado_diferencia", siigo_error: `Diferencia Siigo: documento ${encontrado.name ?? encontrado.id} encontrado tras envío interrumpido, pendiente de verificar.`,
      }).eq("id", inv.id);
      const actualizado = await loadInvoice(context.supabase, inv.id);
      const r = await recheck(context.supabase, actualizado, context.userId);
      return { ...r, found: true, message: `Siigo ya tenía el documento ${encontrado.name ?? ""}. ${r.message}` };
    }
    await context.supabase.from("invoices").update({
      siigo_error_kind: "sin_crear", siigo_error: "Envío interrumpido: Siigo no tiene el documento. Listo para reintentar.",
    }).eq("id", inv.id);
    return { ok: true, found: false, message: `${label(inv)}: no existe en Siigo. Ya puede reintentar el envío.` };
  });
