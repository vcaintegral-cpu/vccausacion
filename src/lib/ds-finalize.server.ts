// DOCUMENTOS SOPORTE: después de crear en Siigo.
// 1) Lee el consecutivo que asignó Siigo (respuesta → GET por id → búsqueda por fecha/proveedor/total).
// 2) Guarda prefijo + número (ej.: DSEB-1153) como número del documento y de la cuenta de cobro.
// 3) Genera la cuenta de cobro en PDF con ese número.
// 4) Si el documento sigue sin enviar a la DIAN, agrega el número a las observaciones (PUT, stamp.send=false).
//    Si Siigo no lo permite, no se reintenta.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { dianTransmitted, dsConsecutive } from "@/lib/support-docs";
import { toCents } from "@/lib/money";

type Inv = Database["public"]["Tables"]["invoices"]["Row"];
type SiigoDs = Record<string, unknown> & { id?: string; name?: string; number?: number | string; date?: string; total?: number; stamp?: { status?: string }; supplier?: { identification?: string } };
const DS_PATH = "/v1/purchase-support-documents";

export async function finalizarDocumentoSoporte(opts: {
  supabase: SupabaseClient<Database>;
  userId: string;
  inv: Inv;
  siigoId: string;
  doc?: SiigoDs | null;
}): Promise<{ full: string | null; trace: Record<string, unknown>; dian: string | null }> {
  const { supabase, userId, inv, siigoId } = opts;
  const { siigoGet, siigoPut } = await import("./siigo.server");
  const trace: Record<string, unknown> = { ...((inv.siigo_trace as Record<string, unknown> | null) ?? {}) };

  // ---------- 1. Consecutivo ----------
  let doc: SiigoDs | null = opts.doc ?? null;
  let fuente = "respuesta";
  if (!doc || dsConsecutive(doc, null).number == null) {
    try { doc = await siigoGet<SiigoDs>(`${DS_PATH}/${siigoId}`); fuente = "consulta_id"; } catch (e) { trace["consulta_id_error"] = e instanceof Error ? e.message : String(e); }
  }
  if (!doc || dsConsecutive(doc, null).number == null) {
    const fecha = inv.ds_sent_date ?? inv.issue_date ?? new Date().toISOString().slice(0, 10);
    try {
      const res = await siigoGet<{ results?: SiigoDs[] } | SiigoDs[]>(`${DS_PATH}?date_start=${fecha}&date_end=${fecha}`);
      const list = Array.isArray(res) ? res : (res.results ?? []);
      const nit = String(inv.provider_nit ?? "").replace(/\D/g, "");
      const m = list.find((d) => d.id === siigoId) ?? list.find((d) => String(d.supplier?.identification ?? "").replace(/\D/g, "") === nit && toCents(d.total) === toCents(inv.total));
      if (m) { doc = m; fuente = "busqueda"; }
    } catch (e) { trace["busqueda_error"] = e instanceof Error ? e.message : String(e); }
  }
  const dian = doc ? (String(doc.stamp?.status ?? "") || null) : inv.ds_dian_status;
  if (!doc) return { full: null, trace: { ...trace, consecutivo_error: "Siigo no devolvió el consecutivo." }, dian };

  const { data: resol } = await supabase.from("ds_resolutions").select("prefix").eq("company_id", inv.company_id).eq("active", true).order("created_at", { ascending: false }).limit(1);
  const c = dsConsecutive(doc, resol?.[0]?.prefix ?? null);
  if (c.number == null) return { full: null, trace: { ...trace, siigo_documento: doc as Json, consecutivo_error: "Siigo no devolvió el consecutivo." }, dian };
  const full = c.full!;
  trace["siigo_documento"] = doc as Json;
  trace["siigo_consecutivo"] = { fuente, nombre_siigo: doc.name ?? null, numero: c.number, prefijo: c.prefix, completo: full };

  const anterior = [inv.prefix, inv.number].filter(Boolean).join("-");
  await supabase.from("invoices").update({ siigo_id: siigoId, siigo_number: full, prefix: c.prefix, number: String(c.number), ds_dian_status: dian, siigo_trace: trace as Json }).eq("id", inv.id);
  if (anterior !== full)
    await supabase.from("invoice_events").insert({ company_id: inv.company_id, invoice_id: inv.id, status: inv.status, siigo_status: inv.siigo_status, action: "Consecutivo de Siigo asignado", message: `${anterior || "Sin número"} → ${full} (Siigo: ${doc.name ?? c.number})`, created_by: userId });

  // ---------- 3. Cuenta de cobro en PDF ----------
  const fecOp = inv.issue_date ? inv.issue_date.split("-").reverse().join("/") : "";
  const retencion = (toCents(inv.retefuente) + toCents(inv.reteiva) + toCents(inv.reteica)) / 100;
  try {
    const { cuentaCobroPdf } = await import("./cc-pdf.server");
    const [{ data: comp }, { data: params }, { data: lines }] = await Promise.all([
      supabase.from("companies").select("name, nit").eq("id", inv.company_id).maybeSingle(),
      supabase.from("company_parameters").select("address, city, phone").eq("company_id", inv.company_id).maybeSingle(),
      supabase.from("invoice_lines").select("description, account_name").eq("invoice_id", inv.id).order("position"),
    ]);
    let original: Uint8Array | null = null;
    if (inv.file_path) {
      const dl = await supabase.storage.from("facturas").download(inv.file_path);
      if (!dl.error && dl.data) original = new Uint8Array(await dl.data.arrayBuffer());
    }
    const pdf = await cuentaCobroPdf(original, {
      dseb: full, fechaOperacion: fecOp,
      empresa: { nombre: comp?.name ?? "", nit: comp?.nit ?? "", direccion: params?.address ?? "", ciudad: params?.city ?? "", telefono: params?.phone ?? "" },
      vendedor: { nombre: inv.provider_name ?? "", identificacion: inv.provider_nit ?? "", direccion: inv.provider_address, ciudad: inv.provider_city, telefono: inv.provider_phone },
      descripcion: (lines ?? []).map((l) => l.description ?? l.account_name ?? "").filter(Boolean).join("; ") || "Servicios prestados",
      valor: Number(inv.total), retencion, neto: Number(inv.total) - retencion,
    });
    // Ruta dentro de la carpeta del usuario y de la empresa (permisos de almacenamiento).
    const ccPath = `${userId}/${inv.company_id}/soporte-cc/${inv.id}.pdf`;
    const up = await supabase.storage.from("facturas").upload(ccPath, pdf, { contentType: "application/pdf", upsert: true });
    if (up.error) trace["cc_pdf_error"] = up.error.message;
    else { await supabase.from("invoices").update({ cc_pdf_path: ccPath }).eq("id", inv.id); delete trace["cc_pdf_error"]; }
  } catch (e) { trace["cc_pdf_error"] = e instanceof Error ? e.message : String(e); }

  // ---------- 4. Observaciones en Siigo (solo si sigue sin enviar a la DIAN) ----------
  const obs = `Cuenta de cobro N° ${full} – Fecha de la operación ${fecOp}`;
  const base = trace["siigo_request"] as Record<string, unknown> | undefined;
  if (trace["observaciones_siigo"] == null) {
    if (dianTransmitted(dian)) trace["observaciones_siigo"] = { ok: false, motivo: "El documento ya fue enviado a la DIAN; no se modifica." };
    else if (!base) trace["observaciones_siigo"] = { ok: false, motivo: "No se conserva el JSON de creación; no se modifica." };
    else {
      const payload = { ...base, observations: obs, stamp: { send: false }, mail: { send: false } };
      delete (payload as Record<string, unknown>)["number"];
      try {
        await siigoPut(`${DS_PATH}/${siigoId}`, payload);
        trace["observaciones_siigo"] = { ok: true, texto: obs, at: new Date().toISOString() };
      } catch (e) {
        // No se reintenta: el número queda en la app y en el PDF.
        trace["observaciones_siigo"] = { ok: false, texto: obs, error: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  await supabase.from("invoices").update({ siigo_trace: trace as Json }).eq("id", inv.id);
  return { full, trace, dian };
}
