// Egresos y recibos de pago (RP) en Siigo — funciones de servidor (núcleo global).
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { erroresAntesDeEnviar, nitSinDv, payloadRecibo, type Propuesta } from "@/lib/egresos";

type Resumen = { message: string };

/** Lee las cuentas por pagar de Siigo (saldos por factura) y vuelve a proponer el mes. */
export const egresosSincronizarCxP = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; periodo?: string | null }) => {
    if (!input?.companyId) throw new Error("companyId requerido");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { sincronizarCxP, proponerPeriodo } = await import("./egresos.server");
    const r = await sincronizarCxP(context.supabase, data.companyId);
    const p = data.periodo
      ? await proponerPeriodo(context.supabase, data.companyId, data.periodo)
      : null;
    return { ...r, propuesta: p };
  });

/** Carga manual del reporte de pagos (mismo lector que la revisión automática de Drive). */
export const egresosImportarReporte = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; nombre: string; base64: string }) => {
    if (!input?.companyId || !input.base64) throw new Error("Falta el archivo.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { funcionActiva } = await import("@/empresas/registro");
    const { data: empresa } = await context.supabase
      .from("companies")
      .select("nit")
      .eq("id", data.companyId)
      .single();
    if (!funcionActiva(empresa?.nit, "lector_consolidado_pagos"))
      throw new Error(
        "Esta empresa aún no tiene configurado el lector de su reporte de pagos; hay que validarlo con su formato.",
      );
    const { leerConsolidadoPagos } = await import("./lector-consolidado-pagos");
    const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
    const lectura = leerConsolidadoPagos(bytes, data.nombre);
    const { guardarLectura, proponerPeriodo, sugerirBancos } = await import("./egresos.server");
    const g = await guardarLectura(context.supabase, data.companyId, lectura, data.nombre);
    const bancos = await sugerirBancos(
      context.supabase,
      data.companyId,
      lectura.egresos.map((e) => e.cuenta ?? ""),
    );
    const p = await proponerPeriodo(context.supabase, data.companyId, g.periodo!);
    return {
      ...g,
      ...p,
      bancosSugeridos: bancos,
      advertencias: lectura.advertencias,
      ingresosOmitidos: lectura.ingresos,
    };
  });

/** Vuelve a proponer los egresos del mes (después de enseñar una regla o sincronizar CxP). */
export const egresosProponer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; periodo: string }) => {
    if (!input?.companyId || !input.periodo) throw new Error("companyId y periodo requeridos");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { proponerPeriodo } = await import("./egresos.server");
    return proponerPeriodo(context.supabase, data.companyId, data.periodo);
  });

/** Origen de pago (CORRIENTE, AHORROS, EFECTIVO…) → forma de pago de Siigo y cuenta de banco/caja. */
export const egresosGuardarBanco = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      etiqueta: string;
      paymentTypeId: string | null;
      cuentaBanco: string | null;
      periodo?: string | null;
    }) => {
      if (!input?.companyId || !input.etiqueta?.trim())
        throw new Error("Falta el origen del pago.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const patron = data.etiqueta.trim().toUpperCase();
    const { error } = await context.supabase.from("egreso_reglas").upsert(
      {
        company_id: data.companyId,
        clase: "banco",
        patron,
        payment_type_id: data.paymentTypeId,
        cuenta_banco: data.cuentaBanco,
        notas: null,
      },
      { onConflict: "company_id,clase,patron" },
    );
    if (error) throw new Error(error.message);
    if (data.periodo) {
      const { proponerPeriodo } = await import("./egresos.server");
      return proponerPeriodo(context.supabase, data.companyId, data.periodo);
    }
    return null;
  });

/**
 * Corrección de la usuaria en un egreso: tipo, tercero, facturas o cuenta. Queda «aprobado»
 * si está completo. Con `aprender`, el concepto del pago se recuerda y los demás pagos del
 * mes con el mismo concepto se vuelven a proponer.
 */
export const egresosGuardarEdicion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { egresoId: string; propuesta: Propuesta; aprender?: boolean }) => {
    if (!input?.egresoId || !input.propuesta?.tipo) throw new Error("Datos incompletos.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const { data: f, error } = await db
      .from("egresos")
      .select("*")
      .eq("id", data.egresoId)
      .single();
    if (error || !f) throw new Error(error?.message ?? "Egreso no encontrado.");
    if (f.siigo_id)
      throw new Error(
        `Este egreso ya está en Siigo (${f.siigo_nombre ?? f.siigo_id}); no se modifica.`,
      );
    const p: Propuesta = {
      ...data.propuesta,
      terceroNit: data.propuesta.terceroNit ? nitSinDv(data.propuesta.terceroNit) : null,
    };
    if (p.tipo === "detallado" && p.cuentas.length === 0) {
      // La usuaria eligió la cuenta débito: se arma el par débito/banco.
      throw new Error("Elige la cuenta débito del recibo detallado.");
    }
    const errores =
      p.tipo === "omitir"
        ? []
        : erroresAntesDeEnviar({ valor: Number(f.valor), fecha: String(f.fecha).slice(0, 10) }, p);
    const estado = p.tipo === "omitir" ? "omitido" : errores.length ? "por_revisar" : "aprobado";
    const { error: e2 } = await db
      .from("egresos")
      .update({
        tipo: p.tipo,
        propuesta: { ...p, listo: errores.length === 0, motivos: errores },
        estado,
        motivos: errores,
        tercero_nit: p.terceroNit,
        editado_por_usuaria: true,
      })
      .eq("id", f.id)
      .is("siigo_id", null);
    if (e2) throw new Error(e2.message);
    let reprop: { total: number; listos: number; porRevisar: number } | null = null;
    if (data.aprender) {
      const { aprenderDeEdicion, proponerPeriodo } = await import("./egresos.server");
      const patron = await aprenderDeEdicion(db, f.company_id, f as never, p);
      if (patron) reprop = await proponerPeriodo(db, f.company_id, f.period);
    }
    return { estado, errores, repropuestos: reprop };
  });

/** Aprueba (o devuelve a revisión) varios egresos listos. */
export const egresosAprobar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { ids: string[]; aprobar: boolean }) => {
    if (!input?.ids?.length) throw new Error("No hay egresos seleccionados.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: filas, error } = await context.supabase
      .from("egresos")
      .update({ estado: data.aprobar ? "aprobado" : "listo" })
      .in("id", data.ids)
      .in("estado", data.aprobar ? ["listo"] : ["aprobado"])
      .is("siigo_id", null)
      .select("id");
    if (error) throw new Error(error.message);
    return { cambiados: (filas ?? []).length };
  });

type ResultadoEnvio = { ok: boolean; siigoNombre: string | null; message: string };

/**
 * Crea en Siigo el recibo de pago/egreso de un egreso aprobado. Una sola vez: bloqueo
 * contra doble envío y un egreso con identidad de Siigo nunca se reenvía (trigger).
 */
export const egresosEnviar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { egresoId: string; documentId?: number | null }) => {
    if (!input?.egresoId) throw new Error("egresoId requerido");
    return input;
  })
  .handler(async ({ data, context }): Promise<ResultadoEnvio> => {
    const db = context.supabase;
    const { data: f, error } = await db
      .from("egresos")
      .select("*")
      .eq("id", data.egresoId)
      .single();
    if (error || !f) throw new Error(error?.message ?? "Egreso no encontrado.");
    if (f.siigo_id)
      return {
        ok: true,
        siigoNombre: f.siigo_nombre,
        message: `Ya está en Siigo (${f.siigo_nombre ?? f.siigo_id}); no se reenvía.`,
      };
    if (f.estado !== "aprobado") throw new Error("Solo se envían egresos aprobados.");
    const p = f.propuesta as unknown as Propuesta;
    const movimiento = {
      fecha: String(f.fecha).slice(0, 10),
      descripcion: f.descripcion,
      relacion: f.relacion,
      valor: Number(f.valor),
    };
    const errores = erroresAntesDeEnviar(movimiento, p);
    if (errores.length) {
      await db
        .from("egresos")
        .update({ estado: "por_revisar", motivos: errores })
        .eq("id", f.id)
        .is("siigo_id", null);
      return { ok: false, siigoNombre: null, message: errores.join(" ") };
    }

    const { siigoGet, siigoPost, siigoUseCompany } = await import("./siigo.server");
    await siigoUseCompany(f.company_id);
    let documentId = data.documentId ?? null;
    if (!documentId) {
      type Doc = { id?: number; active?: boolean };
      const docs = await siigoGet<Doc[] | { results?: Doc[] }>("/v1/document-types?type=RP");
      const activos = (Array.isArray(docs) ? docs : (docs.results ?? [])).filter(
        (d) => d.id && d.active !== false,
      );
      if (activos.length !== 1)
        throw new Error(
          activos.length
            ? "La empresa tiene varios tipos de recibo de pago en Siigo: elige cuál usar."
            : "La empresa no tiene un tipo de recibo de pago (RP) activo en Siigo.",
        );
      documentId = Number(activos[0]!.id);
    }
    const payload = payloadRecibo(movimiento, p, documentId);

    // Bloqueo contra doble envío.
    const { data: bloqueado } = await db
      .from("egresos")
      .update({ estado: "enviando", siigo_error: null, siigo_payload: payload as never })
      .eq("id", f.id)
      .eq("estado", "aprobado")
      .is("siigo_id", null)
      .select("id");
    if (!bloqueado?.length) throw new Error("Este egreso ya se está enviando a Siigo.");

    try {
      const res = await siigoPost<{ id?: string; name?: string }>("/v1/payment-receipts", payload);
      if (!res?.id) throw new Error("Siigo no devolvió el identificador del recibo.");
      let nombre = res.name ?? null;
      try {
        const leido = await siigoGet<{ name?: string }>(
          `/v1/payment-receipts/${encodeURIComponent(res.id)}`,
        );
        nombre = leido?.name ?? nombre;
      } catch {
        /* la lectura de verificación es opcional */
      }
      await db
        .from("egresos")
        .update({
          estado: "enviado",
          siigo_id: String(res.id),
          siigo_nombre: nombre,
          enviado_at: new Date().toISOString(),
          siigo_error: null,
        })
        .eq("id", f.id);
      // Saldo local de las CxP pagadas (se confirma en la próxima sincronización).
      if (p.tipo === "pago_facturas")
        for (const i of p.items) {
          const nuevo = Math.round((i.saldo - i.valor) * 100) / 100;
          if (nuevo <= 0.009)
            await db
              .from("siigo_cuentas_por_pagar")
              .delete()
              .eq("company_id", f.company_id)
              .eq("prefix", i.prefix)
              .eq("consecutive", i.consecutive)
              .eq("quote", i.quote);
          else
            await db
              .from("siigo_cuentas_por_pagar")
              .update({ balance: nuevo })
              .eq("company_id", f.company_id)
              .eq("prefix", i.prefix)
              .eq("consecutive", i.consecutive)
              .eq("quote", i.quote);
        }
      return {
        ok: true,
        siigoNombre: nombre,
        message: `Recibo ${nombre ?? res.id} creado en Siigo.`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Respuesta perdida (red): el recibo pudo crearse; no se reintenta solo.
      const incierto = !/\b(400|401|403|404|409|422)\b/.test(msg);
      await db
        .from("egresos")
        .update({
          estado: "error",
          siigo_error:
            (incierto
              ? "Respuesta de Siigo incierta: verifica en Siigo si el recibo se creó antes de reintentar. "
              : "") + msg.slice(0, 1800),
        })
        .eq("id", f.id)
        .is("siigo_id", null);
      return { ok: false, siigoNombre: null, message: msg };
    }
  });

/** Devuelve a «aprobado» un egreso con error de Siigo, para reintentarlo después de revisar. */
export const egresosReintentar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { egresoId: string }) => {
    if (!input?.egresoId) throw new Error("egresoId requerido");
    return input;
  })
  .handler(async ({ data, context }): Promise<Resumen> => {
    const { error } = await context.supabase
      .from("egresos")
      .update({ estado: "aprobado" })
      .eq("id", data.egresoId)
      .eq("estado", "error")
      .is("siigo_id", null);
    if (error) throw new Error(error.message);
    return { message: "Listo para reintentar." };
  });
