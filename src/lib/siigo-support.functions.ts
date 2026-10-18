// DOCUMENTOS SOPORTE EN SIIGO
// Método oficial (developers.siigo.com, "Crear Documento soporte"):
//   POST /v1/purchase-support-documents  · tipo de comprobante: GET /v1/document-types?type=DS
//   supplier_receipt_number: prefijo (≤ 6) + número de 11 enteros · stamp.send = true → Siigo transmite a la DIAN.
// Lovable no transmite a la DIAN: solo crea el tercero y el documento en Siigo.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Json } from "@/integrations/supabase/types";
import { purchaseLineErrors, purchaseReadbackComparison } from "@/lib/siigo-purchase-validation";
import { missingIdentity, splitPersonName, supplierReceiptNumber, dsSendDate, resolutionExpiry, DS_PREFIX } from "@/lib/support-docs";
import { roundCOP, toCents } from "@/lib/money";

export const DS_PATH = "/v1/purchase-support-documents";

type SiigoTax = { id?: number | string; name?: string; type?: string; percentage?: number; active?: boolean };
type DocType = { id?: number; code?: string | number; name?: string; active?: boolean; automatic_number?: boolean; consecutive?: number; cost_center?: boolean };

export const siigoListDsTypes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { companyId: string }) => { if (!i?.companyId) throw new Error("companyId requerido"); return i; })
  .handler(async ({ data }) => {
    const { siigoGet, siigoUseCompany } = await import("./siigo.server");
    await siigoUseCompany(data.companyId);
    const res = await siigoGet<DocType[] | { results?: DocType[] }>("/v1/document-types?type=DS");
    const list = Array.isArray(res) ? res : (res.results ?? []);
    return list.filter((d) => d.id != null && d.active !== false).map((d) => ({ id: Number(d.id), code: String(d.code ?? ""), name: String(d.name ?? "") }));
  });

export type DsSyncResult = { ok: boolean; status: string; message: string; siigoNumber?: string | null; proposedDate?: string | null; duplicadoDe?: string | null };

export const siigoSyncSupportDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { invoiceId: string; confirmDate?: string; confirmDuplicate?: boolean }) => { if (!i?.invoiceId) throw new Error("invoiceId requerido"); return i; })
  .handler(async ({ data, context }): Promise<DsSyncResult> => {
    const supabase = context.supabase;
    const { data: inv, error } = await supabase.from("invoices").select("*").eq("id", data.invoiceId).maybeSingle();
    if (error || !inv) throw new Error(error?.message ?? "Documento no encontrado.");
    if (inv.doc_kind !== "soporte") throw new Error("Este documento no es un documento soporte.");
    const label = [inv.prefix, inv.number].filter(Boolean).join("-");
    if (inv.siigo_id || inv.siigo_number) return { ok: false, status: "error", message: `${label}: ya existe en Siigo (${inv.siigo_number ?? inv.siigo_id}); no se reenvía.` };
    if (inv.siigo_status === "sincronizando") return { ok: false, status: "sincronizando", message: `${label}: ya se está enviando.` };
    const permitido = inv.status === "aprobado" || (inv.siigo_status === "error" && inv.siigo_error_kind !== "interrumpido");
    if (!permitido) return { ok: false, status: inv.status, message: `${label}: solo se crean documentos aprobados.` };

    const { siigoGet, siigoPost, siigoUseCompany, siigoPurchasePaymentTypeId, siigoCostCenterId } = await import("./siigo.server");
    await siigoUseCompany(inv.company_id);
    await supabase.from("invoices").update({ siigo_status: "sincronizando", siigo_last_attempt_at: new Date().toISOString(), siigo_attempts: (inv.siigo_attempts ?? 0) + 1 }).eq("id", inv.id);

    let trace: Record<string, unknown> = { documento: "soporte", endpoint: DS_PATH, intento_at: new Date().toISOString() };
    let fechaIntentada: string | null = null;
    try {
      // ---------- Validaciones ----------
      const faltan = missingIdentity({ idNumber: inv.provider_nit, idType: inv.vendor_id_type, name: inv.provider_name });
      if (faltan.length) throw new Error(`Vendedor incompleto: falta ${faltan.join(", ")}. No se envió el documento.`);
      // El número de la cuenta de cobro NO se exige: lo asigna Siigo (consecutivo DSEB) al crear el documento.
      if (toCents(inv.iva) > 0 && !inv.iva_confirmed) throw new Error("Revisar: documento soporte con IVA. Confírmelo antes de crear en Siigo.");
      const [{ data: lines }, { data: journal }, { data: params }] = await Promise.all([
        supabase.from("invoice_lines").select("*").eq("invoice_id", inv.id).order("position"),
        supabase.from("journal_lines").select("*").eq("invoice_id", inv.id).order("position"),
        supabase.from("company_parameters").select("*").eq("company_id", inv.company_id).maybeSingle(),
      ]);
      const ls = lines ?? [];
      const lineErr = purchaseLineErrors(ls);
      if (lineErr.length) throw new Error(lineErr.join(" "));
      const deb = (journal ?? []).reduce((a, l) => a + toCents(l.debit), 0);
      const cre = (journal ?? []).reduce((a, l) => a + toCents(l.credit), 0);
      if (!journal?.length || deb !== cre) throw new Error(`El comprobante no cuadra: débitos ${deb / 100} vs créditos ${cre / 100}.`);
      // Tipo de comprobante DS: se toma de la configuración; si falta, se busca en Siigo y se guarda.
      const tiposRes = await siigoGet<DocType[] | { results?: DocType[] }>("/v1/document-types?type=DS");
      const tiposDs = (Array.isArray(tiposRes) ? tiposRes : (tiposRes.results ?? [])).filter((d) => d.id != null && d.active !== false);
      let dsDocumentId = params?.ds_document_id ? Number(params.ds_document_id) : null;
      if (!dsDocumentId) {
        if (!tiposDs.length) throw new Error('Siigo no tiene un tipo de comprobante "Documento soporte" (DS) activo. Créelo en Siigo y reintente.');
        const elegido = tiposDs.find((d) => /soporte/i.test(String(d.name ?? ""))) ?? tiposDs[0]!;
        dsDocumentId = Number(elegido.id);
        await supabase.from("company_parameters").upsert({
          company_id: inv.company_id, ds_document_id: dsDocumentId, ds_document_code: String(elegido.code ?? ""), updated_at: new Date().toISOString(),
        }, { onConflict: "company_id" });
        trace = { ...trace, tipo_comprobante: { id: dsDocumentId, code: elegido.code, name: elegido.name, origen: "siigo_auto" } };
      }
      // Numeración: la app NUNCA calcula ni reserva el consecutivo; Siigo lo asigna al crear
      // y ese consecutivo (ej.: DSEB-1153) queda como número de la cuenta de cobro.

      // ---------- Resolución de numeración (vigencia y rango) ----------
      const { data: resoluciones } = await supabase.from("ds_resolutions").select("*").eq("company_id", inv.company_id).eq("active", true);
      const resolucion = (resoluciones ?? [])[0];
      if (resolucion) {
        const vence = resolutionExpiry(String(resolucion.approval_date), Number(resolucion.validity_months));
        if (inv.issue_date && inv.issue_date > vence)
          throw new Error(`La resolución ${resolucion.prefix} venció el ${vence.split("-").reverse().join("/")}; la fecha del documento es posterior. Registre una nueva resolución en Configuración.`);
        const { data: creados } = await supabase.from("invoices").select("siigo_number").eq("company_id", inv.company_id).eq("doc_kind", "soporte").not("siigo_number", "is", null);
        const maxConsec = (creados ?? []).reduce((a, r) => { const n = Number(String(r.siigo_number ?? "").replace(/\D/g, "")); return Number.isFinite(n) ? Math.max(a, n) : a; }, 0);
        if (maxConsec >= Number(resolucion.to_number))
          throw new Error(`La resolución ${resolucion.prefix} llegó a su consecutivo máximo (${resolucion.to_number}). Registre una nueva resolución en Configuración.`);
        trace = { ...trace, resolucion: { prefix: resolucion.prefix, rango: `${resolucion.from_number}-${resolucion.to_number}`, vence } };
      }

      // Duplicado local (sin número de cuenta de cobro): mismo vendedor + fecha de la operación + valor total
      // ya creado en Siigo. Se muestra "Posible duplicado" y no se crea sin confirmación del usuario.
      if (!data.confirmDuplicate) {
        const { data: dup } = await supabase.from("invoices").select("id, siigo_number").eq("company_id", inv.company_id).eq("doc_kind", "soporte")
          .eq("provider_nit", inv.provider_nit!).eq("issue_date", inv.issue_date!).eq("total", inv.total).not("siigo_id", "is", null).neq("id", inv.id).limit(1);
        if (dup?.length) {
          await supabase.from("invoices").update({ siigo_status: "pendiente", siigo_error: null }).eq("id", inv.id);
          return { ok: false, status: "posible_duplicado", duplicadoDe: dup[0]!.siigo_number, message: `${label}: posible duplicado de ${dup[0]!.siigo_number} (mismo vendedor, fecha y valor). Confirme para crearlo de todas formas.` };
        }
      }

      // ---------- Tercero ----------
      const { siigoEnsureCustomer } = await import("./siigo-customers.server");
      const natural = inv.vendor_is_natural ?? inv.vendor_id_type !== "31";
      const tercero = await siigoEnsureCustomer({
        nit: inv.provider_nit, name: inv.provider_name, address: inv.provider_address, city: inv.provider_city,
        phone: inv.provider_phone, email: inv.provider_email, idType: inv.vendor_id_type,
        person: natural ? splitPersonName(inv.provider_name ?? "") : null,
      });
      trace = { ...trace, tercero: { id: tercero.id, accion: tercero.action } };

      // Duplicado en Siigo (sin número de cuenta de cobro): mismo vendedor + fecha + valor total.
      const nit = String(inv.provider_nit ?? "").replace(/\D/g, "");
      type Listed = { id?: string; name?: string; total?: number; supplier?: { identification?: string } };
      if (inv.issue_date && !data.confirmDuplicate) {
        try {
          const res = await siigoGet<{ results?: Listed[] }>(`${DS_PATH}?date_start=${inv.issue_date}&date_end=${inv.issue_date}&page_size=100`);
          const found = (res.results ?? []).find((d) => String(d.supplier?.identification ?? "").replace(/\D/g, "") === nit
            && Math.abs(Number(d.total ?? 0) - Number(inv.total)) < 0.005);
          if (found?.id) {
            await supabase.from("invoices").update({ siigo_status: "pendiente", siigo_error: null }).eq("id", inv.id);
            return { ok: false, status: "posible_duplicado", duplicadoDe: found.name ?? String(found.id), message: `${label}: posible duplicado de ${found.name ?? found.id} en Siigo (mismo vendedor, fecha y valor). Confirme para crearlo de todas formas.` };
          }
        } catch (e) { trace = { ...trace, consulta_duplicado: e instanceof Error ? e.message : String(e) }; }
      }

      // ---------- Retenciones (ID real de Siigo) ----------
      const taxRes = await siigoGet<SiigoTax[] | { results?: SiigoTax[] }>("/v1/taxes");
      const taxes = (Array.isArray(taxRes) ? taxRes : (taxRes.results ?? [])).filter((t) => t.id != null && t.active !== false);
      const { data: rates } = await supabase.from("tax_rates").select("id, kind, rate, siigo_id, active").eq("company_id", inv.company_id).eq("active", true);
      const pctOf = (id: string | number) => Number(taxes.find((t) => String(t.id) === String(id))?.percentage ?? 0);
      const items = ls.map((l) => {
        const retId = Number(l.retention) > 0 ? (l.ret_siigo_id ?? rates?.find((r) => r.id === l.ret_tax_id)?.siigo_id ?? null) : null;
        return { type: "Account", code: String(l.account_code), description: String(l.description ?? l.account_name ?? "Servicio").slice(0, 500), quantity: Number(l.quantity) || 1, price: roundCOP(Number(l.unit_value)), retId };
      });
      const retFuente = toCents(inv.retefuente);
      const enLineas = ls.reduce((a, l) => a + toCents(l.retention), 0);
      if (retFuente > 0 && enLineas === 0) {
        // Retención solo en el encabezado: se usa la tarifa configurada que explica el valor exacto.
        const base = ls.reduce((a, l) => a + toCents(Number(l.quantity) * Number(l.unit_value)), 0);
        const rate = (rates ?? []).find((r) => /fuente/i.test(r.kind) && r.siigo_id && Math.round(base * Number(r.rate) / 100) === retFuente);
        if (!rate?.siigo_id) throw new Error("La retención en la fuente no corresponde a una tarifa configurada con su ID de Siigo. Sincronice los impuestos.");
        items.forEach((it) => { it.retId = rate.siigo_id; });
      }
      if (items.some((it) => it.retId != null && !taxes.some((t) => String(t.id) === String(it.retId))))
        throw new Error("Una retención seleccionada no está activa en Siigo. Sincronice los impuestos.");

      // Ajuste al peso ≤ $1 entre líneas y total.
      const sumLines = items.reduce((a, it) => a + toCents(it.quantity * it.price), 0);
      const diff = toCents(inv.total) - sumLines;
      if (Math.abs(diff) > 100) throw new Error(`La suma de las líneas (${sumLines / 100}) no coincide con el total (${inv.total}).`);
      if (diff > 0) items.push({ type: "Account", code: "42958101", description: "Ajuste al peso", quantity: 1, price: diff / 100, retId: null });
      else if (diff < 0) { const last = items[items.length - 1]!; last.price = roundCOP((toCents(last.quantity * last.price) + diff) / 100); last.quantity = 1; }

      // ---------- Simulación del cálculo de Siigo ----------
      const retSimulada = items.reduce((a, it) => a + (it.retId != null ? Math.round(toCents(it.quantity * it.price) * pctOf(it.retId) / 100) : 0), 0);
      const retFuenteDoc = toCents(inv.retefuente) + toCents(inv.reteiva) + toCents(inv.reteica);
      if (retSimulada !== retFuenteDoc) throw new Error(`Diferencia con la fuente: retenciones, origen ${retFuenteDoc / 100}, Siigo calcularía ${retSimulada / 100}. No se envió el documento.`);
      const neto = (toCents(inv.total) - retFuenteDoc) / 100;
      const cxp = (journal ?? []).filter((l) => /^2(2|3)/.test(l.account_code) && !/^236/.test(l.account_code)).reduce((a, l) => a + toCents(l.credit), 0);
      if (cxp && cxp !== toCents(neto)) throw new Error(`La CxP del comprobante (${cxp / 100}) no es total − retenciones (${neto}).`);

      const paymentId = inv.payment_type_id ? Number(inv.payment_type_id) : await siigoPurchasePaymentTypeId(inv.payment_type_name ?? "crédito");
      if (!paymentId) throw new Error("No se encontró la forma de pago de compras en Siigo.");
      const costCenterId = inv.cost_center ? await siigoCostCenterId(inv.cost_center) : null;
      // ---------- Ventana de fechas de Siigo (configurable) ----------
      // Se aceptan documentos del mes desde (referencia − N días) hasta la referencia.
      // Si la fecha de la operación está fuera, se PROPONE la fecha mínima y se pide confirmación; nunca se cambia sola.
      const hoy = new Date().toISOString().slice(0, 10);
      const fecOp = inv.issue_date ? inv.issue_date.split("-").reverse().join("/") : "";
      const windowDays = Number(params?.ds_window_days ?? 10) || 10;
      const ref = params?.ds_date_ref === "hoy" ? "hoy" : "fin_mes";
      const ventana = dsSendDate(String(inv.issue_date ?? hoy), hoy, windowDays, ref);
      let fechaEnvio: string;
      if (inv.siigo_error_kind === "fecha_invalida" && data.confirmDate) {
        // Reintento confirmado por el usuario tras un invalid_date (ej.: último día del mes).
        if (data.confirmDate > ventana.lastDay || data.confirmDate > hoy)
          throw new Error("La fecha de reintento no puede ser posterior al último día del mes del documento ni a hoy.");
        fechaEnvio = data.confirmDate;
      } else {
        fechaEnvio = ventana.sendDate;
        if (ventana.changed && data.confirmDate !== ventana.sendDate) {
          await supabase.from("invoices").update({ siigo_status: "pendiente", siigo_error: null }).eq("id", inv.id);
          return {
            ok: false, status: "confirmar_fecha", proposedDate: ventana.sendDate,
            message: `${label}: la fecha ${fecOp} está fuera de la ventana de Siigo; se enviará con ${ventana.sendDate.split("-").reverse().join("/")}. Confirme para continuar.`,
          };
        }
      }
      fechaIntentada = fechaEnvio;
      const intentosPrevios = Array.isArray((inv.siigo_trace as Record<string, unknown> | null)?.["fechas_intentadas"]) ? (inv.siigo_trace as Record<string, unknown>)["fechas_intentadas"] as unknown[] : [];
      trace = { ...trace, fechas_intentadas: [...intentosPrevios, { fecha: fechaEnvio, at: new Date().toISOString() }] };
      const vencimiento = inv.due_date && inv.due_date >= fechaEnvio && inv.due_date <= ventana.lastDay ? inv.due_date : fechaEnvio;
      // Observaciones: el número de la cuenta de cobro solo se conoce DESPUÉS de crear (lo asigna Siigo),
      // y la API no permite actualizar observaciones; se escribe solo la fecha de la operación.
      const obsBase = `Fecha de la operación: ${fecOp}. `;
      const payload: Record<string, unknown> = {
        document: { id: dsDocumentId },
        date: fechaEnvio,
        supplier: { identification: nit, branch_office: 0 },
        ...(String(inv.number ?? "").trim() ? { supplier_receipt_number: { prefix: (inv.prefix || DS_PREFIX).slice(0, 6), number: supplierReceiptNumber(inv.number) } } : {}),
        discount_type: "Value",
        stamp: { send: true },
        observations: `${obsBase}Documento soporte · ${inv.provider_name ?? ""}`.slice(0, 4000),
        items: items.map((it) => ({ type: it.type, code: it.code, description: it.description, quantity: it.quantity, price: it.price, discount: 0, ...(it.retId != null ? { taxes: [{ id: Number(it.retId) }] } : {}) })),
        payments: [{ id: paymentId, value: neto, due_date: vencimiento }],
        ...(costCenterId ? { cost_center: costCenterId } : {}),
      };
      trace = { ...trace, siigo_request: payload };

      const res = await siigoPost<{ id?: string; name?: string; number?: number }>(DS_PATH, payload);
      trace = { ...trace, siigo_respuesta: res };
      if (!res.id) throw new Error("Siigo respondió sin el ID del documento soporte.");
      const siigoNumber = String(res.name ?? res.number ?? res.id);
      // El consecutivo que asigna Siigo (ej.: DSEB-1153) queda como número de la cuenta de cobro y del documento.
      const m = /^([A-Za-z]+)[- ]?(\d+)$/.exec(siigoNumber);
      const prefixSiigo = m ? m[1]!.toUpperCase() : null;
      const numeroSiigo = m ? m[2]! : null;
      // La identidad remota se guarda ANTES de verificar: nunca se reenvía.
      await supabase.from("invoices").update({
        siigo_id: String(res.id), siigo_number: siigoNumber, siigo_status: "error", siigo_error_kind: "creado_diferencia",
        siigo_error: "Documento creado, pendiente de verificar.", siigo_trace: trace as Json, ds_sent_date: fechaEnvio,
        ...(prefixSiigo && numeroSiigo ? { prefix: prefixSiigo, number: numeroSiigo } : {}),
      }).eq("id", inv.id);

      const doc = await siigoGet<Record<string, unknown> & { total?: number; payments?: Array<{ value?: number }>; retentions?: Array<{ value?: number }>; items?: Array<{ taxes?: Array<{ id?: string | number; type?: string; value?: number }> }>; stamp?: { status?: string }; metadata?: Record<string, unknown> }>(`${DS_PATH}/${res.id}`);
      const retDevueltas = ((doc.retentions ?? []).reduce((a, r) => a + toCents(r.value), 0)
        + (doc.items ?? []).flatMap((i) => i.taxes ?? []).filter((t) => /rete|fuente|withhold/i.test(t.type ?? "") || items.some((it) => String(it.retId) === String(t.id))).reduce((a, t) => a + toCents(t.value), 0)) / 100;
      const comparacion = purchaseReadbackComparison(doc, { total: Number(inv.total), iva: 0, impoconsumo: 0, retentions: retFuenteDoc / 100, returnedRetentions: retDevueltas, payable: neto, ivaIds: [] });
      const diferencias = comparacion.filter((c) => !c.ok);
      const dian = String(doc.stamp?.status ?? (doc.metadata?.["stamp_status"] as string | undefined) ?? "") || null;
      trace = { ...trace, siigo_verificacion: doc as Json, comparacion, resultado: diferencias.length ? "Diferencia Siigo" : "sincronizada" };
      if (diferencias.length) {
        const msg = "Diferencia Siigo: " + diferencias.map((d) => `${d.campo}: origen ${d.origen}, Siigo ${d.siigo ?? "no informado"}`).join("; ") + ". No reenvíe el documento creado.";
        await supabase.from("invoices").update({ siigo_error: msg, siigo_trace: trace as Json, ds_dian_status: dian }).eq("id", inv.id);
        return { ok: false, status: "error", message: `${label}: ${msg}`, siigoNumber };
      }
      await supabase.from("invoices").update({
        siigo_status: "sincronizada", status: "historico", siigo_error: null, siigo_error_kind: null,
        siigo_synced_at: new Date().toISOString(), siigo_synced_by: context.userId, siigo_trace: trace as Json, ds_dian_status: dian,
      }).eq("id", inv.id);
      return { ok: true, status: "sincronizada", message: `${label}: creado en Siigo como ${siigoNumber}.`, siigoNumber };
    } catch (e) {
      let message = e instanceof Error ? e.message : String(e);
      const { data: cur } = await supabase.from("invoices").select("siigo_id, siigo_number, siigo_trace").eq("id", inv.id).maybeSingle();
      const creado = !!(cur?.siigo_id || cur?.siigo_number);
      const esFecha = /invalid_date/i.test(message);
      if (esFecha && fechaIntentada)
        message = `Siigo no acepta la fecha ${fechaIntentada.split("-").reverse().join("/")} enviada (periodo cerrado, fecha anterior al límite permitido o fuera de la resolución). Puede reintentar con el último día del mes. Respuesta de Siigo: ${message}`;
      await supabase.from("invoices").update({
        siigo_status: "error", siigo_error: message, siigo_error_kind: esFecha && !creado ? "fecha_invalida" : creado ? "creado_diferencia" : "sin_crear",
        siigo_trace: { ...((cur?.siigo_trace as object) ?? {}), ...trace, resultado: "rechazado", error: message, fallo_at: new Date().toISOString() } as Json,
      }).eq("id", inv.id);
      return { ok: false, status: "error", message: `${label}: ${message}` };
    }
  });
