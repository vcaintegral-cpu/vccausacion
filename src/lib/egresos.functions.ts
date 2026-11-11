// Egresos y recibos de pago (RP) en Siigo — funciones de servidor (núcleo global).
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { erroresAntesDeEnviar, nitSinDv, payloadRecibo, type Propuesta } from "@/lib/egresos";
import { compraEditada, type DocCompra } from "@/lib/egresos-diferencias";

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
      // Solo los RP detallados de gastos bancarios van agrupados por banco.
      grupo: data.propuesta.tipo === "detallado" ? (data.propuesta.grupo ?? null) : null,
    };
    if (p.tipo === "detallado" && p.cuentas.length === 0) {
      // La usuaria eligió la cuenta débito: se arma el par débito/banco.
      throw new Error("Elige la cuenta débito del recibo detallado.");
    }
    // Ajuste al peso del pago de facturas: se recalcula aquí con las cuentas de la empresa.
    if (p.tipo === "pago_facturas") {
      const { cargarAjustes } = await import("./egresos.server");
      const { diferenciaDelPago } = await import("./egresos");
      const ajustes = await cargarAjustes(db, f.company_id);
      const suma = p.items.reduce((s, i) => s + Number(i.valor || 0), 0);
      // Diferencia con el banco: ajuste al peso hasta el tope; si se pagó de más por encima
      // del tope, el excedente queda como anticipo al proveedor (cuenta 1330…).
      const dif = diferenciaDelPago(Number(f.valor), suma, ajustes);
      p.ajuste = dif.ajuste;
      p.anticipo = p.items.length ? dif.anticipo : null;
      p.cuentaCxp = p.ajuste || p.anticipo ? ajustes.cxp : null;
      if ((p.ajuste || p.anticipo) && !p.cuentaBanco) {
        const { data: regla } = await db
          .from("egreso_reglas")
          .select("cuenta_banco")
          .eq("company_id", f.company_id)
          .eq("clase", "banco")
          .eq(
            "patron",
            String(f.cuenta_etiqueta ?? "")
              .toUpperCase()
              .trim(),
          )
          .maybeSingle();
        p.cuentaBanco = regla?.cuenta_banco ?? null;
      }
    } else {
      p.ajuste = null;
      p.anticipo = null;
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
    if ((f.propuesta as { grupo?: string | null } | null)?.grupo)
      throw new Error(
        "Este gasto bancario va en el RP único del banco del mes: envíalo desde «RP de gastos bancarios».",
      );
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

// ---------------------------------------------------------------------------
// Diferencias entre el pago y la CxP (retenciones) — todas las empresas
// ---------------------------------------------------------------------------
export type DiferenciaItem = {
  prefix: string;
  consecutive: number;
  quote: number;
  factura: string | null;
  compraId: string | null;
  compraNombre: string;
  saldo: number;
  pagado: number;
  diferencia: number;
  causas: import("./egresos-diferencias").CausaDiferencia[];
  error?: string;
};

async function catalogoRetenciones(
  db: Parameters<typeof import("./egresos.server").cargarContexto>[0],
  companyId: string,
) {
  const { data } = await db
    .from("tax_rates")
    .select("siigo_id, kind, name, rate, active")
    .eq("company_id", companyId)
    .in("kind", ["retefuente", "reteiva", "reteica"]);
  return (
    (data ?? []) as Array<{
      siigo_id: string | null;
      kind: string;
      name: string;
      rate: number;
      active: boolean;
    }>
  )
    .filter((t) => t.siigo_id && t.active !== false && Number(t.rate) > 0)
    .map((t) => ({
      siigoId: String(t.siigo_id),
      kind: t.kind as "retefuente" | "reteiva" | "reteica",
      name: t.name,
      rate: Number(t.rate),
    }));
}

async function idCompraSiigo(
  db: Parameters<typeof import("./egresos.server").cargarContexto>[0],
  companyId: string,
  item: { prefix: string; consecutive: number; quote: number },
): Promise<string | null> {
  const { data: cxp } = await db
    .from("siigo_cuentas_por_pagar")
    .select("siigo_purchase_id")
    .eq("company_id", companyId)
    .eq("prefix", item.prefix)
    .eq("consecutive", item.consecutive)
    .eq("quote", item.quote)
    .maybeSingle();
  if (cxp?.siigo_purchase_id) return cxp.siigo_purchase_id;
  const { data: inv } = await db
    .from("invoices")
    .select("siigo_id")
    .eq("company_id", companyId)
    .eq("siigo_number", `${item.prefix}-${item.consecutive}`)
    .not("siigo_id", "is", null)
    .limit(1)
    .maybeSingle();
  return inv?.siigo_id ?? null;
}

/** Lee las compras en Siigo de las facturas cuyo pago no cuadra con la CxP y calcula a qué se debe. */
export const egresosAnalizarDiferencia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { egresoId: string }) => {
    if (!input?.egresoId) throw new Error("egresoId requerido");
    return input;
  })
  .handler(async ({ data, context }): Promise<{ diferencias: DiferenciaItem[] }> => {
    const db = context.supabase;
    const { data: f, error } = await db
      .from("egresos")
      .select("*")
      .eq("id", data.egresoId)
      .single();
    if (error || !f) throw new Error(error?.message ?? "Egreso no encontrado.");
    if (f.siigo_id) throw new Error("Este egreso ya está en Siigo.");
    const p = f.propuesta as unknown as Propuesta & { diferencias?: DiferenciaItem[] };
    const items = (p.items ?? []).filter((i) => Math.abs(Number(i.valor) - Number(i.saldo)) > 1);
    if (!items.length) return { diferencias: [] };

    const { explicarDiferencia, compraDeSiigo } = await import("./egresos-diferencias");
    const { conceptoDe } = await import("./egresos");
    const catalogo = await catalogoRetenciones(db, f.company_id);
    // Gastos bancarios del mismo día y origen, y anticipos ya enviados al proveedor.
    const { data: mismoDia } = await db
      .from("egresos")
      .select("valor, relacion, descripcion, aplicacion")
      .eq("company_id", f.company_id)
      .eq("fecha", f.fecha)
      .eq("cuenta_etiqueta", f.cuenta_etiqueta ?? "")
      .neq("id", f.id);
    const gastos = (
      (mismoDia ?? []) as Array<{
        valor: number;
        relacion: string | null;
        descripcion: string | null;
        aplicacion: string | null;
      }>
    )
      .filter((g) => ["gasto_bancario", "iva_bancario", "4x1000"].includes(conceptoDe(g)?.id ?? ""))
      .map((g) => Number(g.valor));
    const { data: ants } = p.terceroNit
      ? await db
          .from("egresos")
          .select("valor")
          .eq("company_id", f.company_id)
          .eq("tipo", "anticipo")
          .eq("tercero_nit", p.terceroNit)
          .not("siigo_id", "is", null)
      : { data: [] };
    const anticipos = ((ants ?? []) as Array<{ valor: number }>).map((a) => Number(a.valor));

    const { siigoGet, siigoUseCompany } = await import("./siigo.server");
    await siigoUseCompany(f.company_id);
    const diferencias: DiferenciaItem[] = [];
    for (const it of items) {
      const compraNombre = `${it.prefix}-${it.consecutive}`;
      const base: DiferenciaItem = {
        prefix: it.prefix,
        consecutive: it.consecutive,
        quote: it.quote,
        factura: it.factura,
        compraId: null,
        compraNombre,
        saldo: Number(it.saldo),
        pagado: Number(it.valor),
        diferencia: 0,
        causas: [],
      };
      try {
        const compraId = await idCompraSiigo(db, f.company_id, it);
        let compra = null;
        if (compraId) {
          const doc = await siigoGet<DocCompra>(`/v1/purchases/${encodeURIComponent(compraId)}`);
          compra = compraDeSiigo(doc, catalogo);
          if (!compra.nombre) compra.nombre = compraNombre;
        }
        const r = explicarDiferencia({
          saldo: Number(it.saldo),
          pagado: Number(it.valor),
          compra,
          catalogo,
          gastosBancariosMismoDia: gastos,
          anticipos,
          instruccion: [f.aplicacion, f.observaciones].filter(Boolean).join(" "),
        });
        diferencias.push({
          ...base,
          compraId,
          diferencia: r.diferencia,
          causas: r.causas,
          ...(compraId
            ? {}
            : {
                error:
                  "No se encontró la compra en Siigo: sincroniza las CxP para traer su identificador.",
              }),
        });
      } catch (e) {
        diferencias.push({
          ...base,
          diferencia: Number(it.saldo) - Number(it.valor),
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    await db
      .from("egresos")
      .update({ propuesta: { ...p, diferencias } as never })
      .eq("id", f.id)
      .is("siigo_id", null);
    return { diferencias };
  });

/**
 * Corrige la retención de la compra en Siigo (con la confirmación de la usuaria), la vuelve
 * a leer para verificarla, actualiza las CxP del proveedor y vuelve a proponer el pago.
 */
export const egresosCorregirCompra = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { egresoId: string; compraId: string; causaIndex: number; confirmado: boolean }) => {
      if (!input?.egresoId || !input.compraId || input.causaIndex == null)
        throw new Error("Datos incompletos.");
      if (input.confirmado !== true)
        throw new Error("La corrección en Siigo requiere tu confirmación.");
      return input;
    },
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean; message: string }> => {
    const db = context.supabase;
    const { data: f, error } = await db
      .from("egresos")
      .select("*")
      .eq("id", data.egresoId)
      .single();
    if (error || !f) throw new Error(error?.message ?? "Egreso no encontrado.");
    if (f.siigo_id) throw new Error("Este egreso ya está en Siigo.");
    const p = f.propuesta as unknown as Propuesta & { diferencias?: DiferenciaItem[] };
    const dif = (p.diferencias ?? []).find((d) => d.compraId === data.compraId);
    const causa = dif?.causas[data.causaIndex];
    if (!dif || !causa?.accion)
      throw new Error(
        "Primero analiza la diferencia; esta causa no tiene una corrección de retención.",
      );

    const { siigoGet, siigoPut, siigoUseCompany } = await import("./siigo.server");
    await siigoUseCompany(f.company_id);
    const doc = await siigoGet<DocCompra>(`/v1/purchases/${encodeURIComponent(data.compraId)}`);
    // La compra no debe haber cambiado desde el análisis (otro pago, otra edición).
    const saldoActual = Number(doc.balance ?? dif.saldo);
    if (Math.abs(saldoActual - dif.saldo) > 1)
      throw new Error(
        `El saldo de ${dif.compraNombre} cambió en Siigo (${saldoActual}); vuelve a sincronizar y analizar.`,
      );
    const cuerpo = compraEditada(doc, causa.accion);
    try {
      await siigoPut(`/v1/purchases/${encodeURIComponent(data.compraId)}`, cuerpo);
    } catch (e) {
      return {
        ok: false,
        message: `Siigo no aceptó la corrección (la compra quedó igual): ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    // Lectura de verificación.
    const { compraDeSiigo } = await import("./egresos-diferencias");
    const catalogo = await catalogoRetenciones(db, f.company_id);
    const leido = compraDeSiigo(
      await siigoGet<DocCompra>(`/v1/purchases/${encodeURIComponent(data.compraId)}`),
      catalogo,
    );
    const presentes = new Set(leido.retenciones.map((r) => r.siigoId));
    const verificado = causa.accion.impuestos.every((t) =>
      causa.accion!.tipo === "agregar" ? presentes.has(t.siigoId) : !presentes.has(t.siigoId),
    );
    const detalle = `${causa.accion.tipo === "agregar" ? "Agregada" : "Quitada"} ${causa.accion.impuestos.map((t) => `${t.name} (${t.valor.toLocaleString("es-CO")})`).join(" + ")} en ${dif.compraNombre}`;

    const { sincronizarCxP, proponerPeriodo } = await import("./egresos.server");
    const nit = p.terceroNit ?? null;
    if (nit) await sincronizarCxP(db, f.company_id, { soloNit: nit });
    await db
      .from("egresos")
      .update({
        editado_por_usuaria: false,
        estado: "por_revisar",
        propuesta: {
          ...p,
          diferencias: [],
          notas: [...(p.notas ?? []), `Corrección en Siigo: ${detalle}.`],
        } as never,
      })
      .eq("id", f.id)
      .is("siigo_id", null);
    await proponerPeriodo(db, f.company_id, f.period);
    return {
      ok: verificado,
      message: verificado
        ? `${detalle}. CxP del proveedor actualizada y el pago vuelto a proponer.`
        : `Siigo aceptó la edición pero la lectura no muestra el cambio esperado en ${dif.compraNombre}; revísala en Siigo.`,
    };
  });

/** Tipo de recibo de pago (RP) activo de la empresa en Siigo (debe ser uno solo). */
async function tipoReciboPago(): Promise<number> {
  const { siigoGet } = await import("./siigo.server");
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
  return Number(activos[0]!.id);
}

/**
 * RP único del mes con los gastos bancarios (comisiones, IVA bancario, 4x1000) de una
 * cuenta bancaria. Todos los movimientos del grupo deben estar listos o aprobados; quedan
 * con la misma identidad de Siigo y no se reenvían.
 */
export const egresosEnviarGrupoBancario = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; periodo: string; grupo: string }) => {
    if (
      !input?.companyId ||
      !/^\d{4}-\d{2}$/.test(input.periodo ?? "") ||
      !input.grupo?.startsWith("bancario|")
    )
      throw new Error("Empresa, mes y banco requeridos.");
    return input;
  })
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: boolean; siigoNombre: string | null; message: string }> => {
      const db = context.supabase;
      const { data: filas, error } = await db
        .from("egresos")
        .select("id, fecha, descripcion, valor, estado, propuesta, siigo_id")
        .eq("company_id", data.companyId)
        .eq("period", data.periodo)
        .eq("propuesta->>grupo", data.grupo)
        .order("fecha");
      if (error) throw new Error(error.message);
      const lista = (filas ?? []) as Array<{
        id: string;
        fecha: string;
        descripcion: string | null;
        valor: number;
        estado: string;
        propuesta: unknown;
        siigo_id: string | null;
      }>;
      const etiqueta = data.grupo.slice("bancario|".length);
      if (!lista.length)
        throw new Error(`No hay gastos bancarios de ${etiqueta} en ${data.periodo}.`);
      if (lista.some((f) => f.siigo_id))
        return {
          ok: true,
          siigoNombre: null,
          message: `Los gastos bancarios de ${etiqueta} de ${data.periodo} ya están en Siigo; no se reenvían.`,
        };
      const pendientes = lista.filter((f) => !["listo", "aprobado"].includes(f.estado));
      if (pendientes.length)
        throw new Error(
          `Faltan ${pendientes.length} gastos bancarios de ${etiqueta} por revisar (cuenta o tercero) antes de enviar el RP del mes.`,
        );

      const { payloadReciboAgrupado } = await import("./egresos");
      const [anio, mes] = data.periodo.split("-").map(Number) as [number, number];
      const finMes = new Date(Date.UTC(anio, mes, 0)).toISOString().slice(0, 10);
      const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
      const fecha = finMes < hoy ? finMes : hoy;
      const { siigoGet, siigoPost, siigoUseCompany } = await import("./siigo.server");
      await siigoUseCompany(data.companyId);
      const documentId = await tipoReciboPago();
      const { payload, total, errores } = payloadReciboAgrupado(
        lista.map((f) => ({
          fecha: String(f.fecha).slice(0, 10),
          descripcion: f.descripcion,
          valor: Number(f.valor),
          propuesta: f.propuesta as Propuesta,
        })),
        documentId,
        fecha,
        etiqueta,
      );
      if (errores.length) throw new Error(errores.join(" "));

      // Bloqueo contra doble envío: todos los movimientos del grupo a la vez.
      const ids = lista.map((f) => f.id);
      const { data: bloqueados } = await db
        .from("egresos")
        .update({ estado: "enviando", siigo_error: null, siigo_payload: payload as never })
        .in("id", ids)
        .in("estado", ["listo", "aprobado"])
        .is("siigo_id", null)
        .select("id");
      if ((bloqueados ?? []).length !== ids.length) {
        await db
          .from("egresos")
          .update({ estado: "aprobado" })
          .in(
            "id",
            (bloqueados ?? []).map((b) => b.id),
          )
          .eq("estado", "enviando")
          .is("siigo_id", null);
        throw new Error("Otro envío está en curso para estos gastos bancarios.");
      }
      try {
        const res = await siigoPost<{ id?: string; name?: string }>(
          "/v1/payment-receipts",
          payload,
        );
        if (!res?.id) throw new Error("Siigo no devolvió el identificador del recibo.");
        let nombre = res.name ?? null;
        try {
          nombre =
            (
              await siigoGet<{ name?: string }>(
                `/v1/payment-receipts/${encodeURIComponent(res.id)}`,
              )
            )?.name ?? nombre;
        } catch {
          /* lectura de verificación opcional */
        }
        await db
          .from("egresos")
          .update({
            estado: "enviado",
            siigo_id: String(res.id),
            siigo_nombre: nombre,
            enviado_at: new Date().toISOString(),
          })
          .in("id", ids);
        return {
          ok: true,
          siigoNombre: nombre,
          message: `RP ${nombre ?? res.id}: ${lista.length} gastos bancarios de ${etiqueta} por ${total.toLocaleString("es-CO")}.`,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
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
          .in("id", ids)
          .is("siigo_id", null);
        return { ok: false, siigoNombre: null, message: msg };
      }
    },
  );

/** Cuentas del ajuste al peso de los recibos y CxP cruzada de la empresa (detectadas o elegidas). */
export const egresosCuentasAjuste = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => {
    if (!input?.companyId) throw new Error("companyId requerido");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { cargarAjustes } = await import("./egresos.server");
    return cargarAjustes(context.supabase, data.companyId);
  });

/** Guarda las cuentas del ajuste al peso y la CxP cruzada, y vuelve a proponer el mes. */
export const egresosGuardarCuentasAjuste = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      debito: string | null;
      credito: string | null;
      cxp: string | null;
      anticipo?: string | null;
      periodo?: string | null;
    }) => {
      if (!input?.companyId) throw new Error("companyId requerido");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const filas = (
      [
        ["cuenta:ajuste_debito", data.debito],
        ["cuenta:ajuste_credito", data.credito],
        ["cuenta:cxp", data.cxp],
        ["cuenta:anticipo", data.anticipo ?? null],
      ] as const
    ).map(([patron, cuenta]) => ({
      company_id: data.companyId,
      clase: "concepto",
      patron,
      tipo: "cuenta",
      cuenta_debito: String(cuenta ?? "").replace(/\D/g, "") || null,
    }));
    const { error } = await db
      .from("egreso_reglas")
      .upsert(filas, { onConflict: "company_id,clase,patron" });
    if (error) throw new Error(error.message);
    if (data.periodo) {
      const { proponerPeriodo } = await import("./egresos.server");
      return proponerPeriodo(db, data.companyId, data.periodo);
    }
    return null;
  });

/**
 * Replica el tratamiento de un egreso revisado en otros pagos del mes elegidos por la
 * usuaria: mismo tipo, tercero y cuentas. En pago de facturas, cada pago se aplica a las
 * facturas con saldo del mismo tercero (la del pago de origen primero, luego de la más
 * antigua a la más nueva) por su propio valor. Lo que no cuadre queda por revisar.
 */
export const egresosReplicar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { origenId: string; destinoIds: string[] }) => {
    if (!input?.origenId || !input.destinoIds?.length)
      throw new Error("Elige los pagos a los que se replica.");
    return input;
  })
  .handler(
    async ({
      data,
      context,
    }): Promise<{ aprobados: number; porRevisar: number; mensajes: string[] }> => {
      const db = context.supabase;
      const { data: origen, error } = await db
        .from("egresos")
        .select("*")
        .eq("id", data.origenId)
        .single();
      if (error || !origen) throw new Error(error?.message ?? "Pago de origen no encontrado.");
      const po = origen.propuesta as unknown as Propuesta;
      if (!po?.tipo || po.tipo === "por_definir")
        throw new Error("Primero guarda el tratamiento del pago de origen.");
      const { data: destinos } = await db
        .from("egresos")
        .select("*")
        .in("id", data.destinoIds)
        .eq("company_id", origen.company_id)
        .is("siigo_id", null)
        .order("fecha");
      const { data: reglasBanco } = await db
        .from("egreso_reglas")
        .select("patron, cuenta_banco, payment_type_id")
        .eq("company_id", origen.company_id)
        .eq("clase", "banco");
      const banco = (etiqueta: string | null) =>
        (
          (reglasBanco ?? []) as Array<{
            patron: string;
            cuenta_banco: string | null;
            payment_type_id: string | null;
          }>
        ).find(
          (r) =>
            r.patron ===
            String(etiqueta ?? "")
              .toUpperCase()
              .trim(),
        );
      const {
        diferenciaDelPago,
        conceptoDe,
        grupoBancario,
        erroresAntesDeEnviar: errores,
      } = await import("./egresos");
      const { cargarAjustes } = await import("./egresos.server");
      const ajustes =
        po.tipo === "pago_facturas" ? await cargarAjustes(db, origen.company_id) : null;

      // Facturas abiertas del tercero (saldo disponible, descontando lo ya aplicado por el origen).
      type Venc = {
        prefix: string;
        consecutive: number;
        quote: number;
        due_date: string | null;
        balance: number;
        factura_proveedor: string | null;
      };
      let abiertas: Array<Venc & { disponible: number }> = [];
      if (po.tipo === "pago_facturas" && po.terceroNit) {
        const { data: cxp } = await db
          .from("siigo_cuentas_por_pagar")
          .select("prefix, consecutive, quote, due_date, balance, factura_proveedor")
          .eq("company_id", origen.company_id)
          .eq("provider_nit", po.terceroNit)
          .gt("balance", 0);
        const clave = (x: { prefix: string; consecutive: number; quote: number }) =>
          `${x.prefix}|${x.consecutive}|${x.quote}`;
        const usadas = new Map(po.items.map((i) => [clave(i), Number(i.valor)]));
        const primero = new Set(po.items.map(clave));
        abiertas = ((cxp ?? []) as Venc[])
          .map((c) => ({
            ...c,
            balance: Number(c.balance),
            disponible: Math.round((Number(c.balance) - (usadas.get(clave(c)) ?? 0)) * 100) / 100,
          }))
          .filter((c) => c.disponible > 0.009)
          .sort(
            (a, b) =>
              Number(primero.has(clave(b))) - Number(primero.has(clave(a))) ||
              String(a.due_date ?? "").localeCompare(String(b.due_date ?? "")),
          );
      }

      const filas: Array<Record<string, unknown>> = [];
      const mensajes: string[] = [];
      let aprobados = 0;
      let porRevisar = 0;
      for (const d of (destinos ?? []) as Array<
        Record<string, unknown> & {
          id: string;
          valor: number;
          fecha: string;
          cuenta_etiqueta: string | null;
          descripcion: string | null;
          relacion: string | null;
          estado: string;
        }
      >) {
        if (["enviando", "enviado"].includes(d.estado)) continue;
        const valor = Number(d.valor);
        const b = banco(d.cuenta_etiqueta);
        const p: Propuesta = {
          ...po,
          items: [],
          cuentas: [],
          paymentTypeId: b?.payment_type_id ?? null,
          cuentaBanco: b?.cuenta_banco ?? null,
          ajuste: null,
          anticipo: null,
          cuentaCxp: null,
          grupo: null,
          listo: false,
          motivos: [],
          notas: [
            `Tratamiento replicado de ${String(origen.fecha).slice(0, 10)} ${origen.descripcion ?? ""}.`,
          ],
        };
        if (po.tipo === "detallado") {
          const debito = po.cuentas.find((c) => c.movimiento === "Debit")?.code;
          if (debito && p.cuentaBanco) {
            const desc = String(d.descripcion ?? "Egreso").slice(0, 100);
            p.cuentas = [
              { code: debito, movimiento: "Debit", valor, descripcion: desc },
              { code: p.cuentaBanco, movimiento: "Credit", valor, descripcion: desc },
            ];
          }
          p.grupo = grupoBancario(
            conceptoDe({ relacion: d.relacion, descripcion: d.descripcion, aplicacion: null })
              ?.id ?? null,
            d.cuenta_etiqueta,
          );
        }
        if (po.tipo === "pago_facturas") {
          let restante = valor;
          for (const c of abiertas) {
            if (restante <= 0.009) break;
            const v = Math.round(Math.min(c.disponible, restante) * 100) / 100;
            if (v <= 0) continue;
            p.items.push({
              prefix: c.prefix,
              consecutive: c.consecutive,
              quote: c.quote,
              valor: v,
              factura: c.factura_proveedor,
              saldo: c.balance,
            });
            c.disponible = Math.round((c.disponible - v) * 100) / 100;
            restante = Math.round((restante - v) * 100) / 100;
          }
          abiertas = abiertas.filter((c) => c.disponible > 0.009);
          // Lo que no cubren las facturas: ajuste al peso (hasta el tope) o anticipo al proveedor.
          if (restante > 0.009 && p.items.length) {
            const dif = diferenciaDelPago(valor, valor - restante, ajustes ?? undefined);
            p.ajuste = dif.ajuste;
            p.anticipo = dif.anticipo;
            if (p.ajuste || p.anticipo) p.cuentaCxp = ajustes?.cxp ?? null;
          }
        }
        const e =
          p.tipo === "omitir" ? [] : errores({ valor, fecha: String(d.fecha).slice(0, 10) }, p);
        if (po.tipo === "pago_facturas" && e.some((x) => x.startsWith("Las facturas suman")))
          e.push("No hay más facturas con saldo de este tercero para cubrir el pago.");
        const estado = p.tipo === "omitir" ? "omitido" : e.length ? "por_revisar" : "aprobado";
        if (estado === "aprobado" || estado === "omitido") aprobados += 1;
        else {
          porRevisar += 1;
          mensajes.push(`${String(d.fecha).slice(0, 10)} ${d.descripcion ?? ""}: ${e.join(" ")}`);
        }
        filas.push({
          ...d,
          tipo: p.tipo,
          propuesta: { ...p, listo: e.length === 0, motivos: e },
          estado,
          motivos: e,
          tercero_nit: p.terceroNit,
          editado_por_usuaria: true,
        });
      }
      for (let i = 0; i < filas.length; i += 300) {
        const { error: e2 } = await db
          .from("egresos")
          .upsert(filas.slice(i, i + 300) as never, { onConflict: "id" });
        if (e2) throw new Error(e2.message);
      }
      return { aprobados, porRevisar, mensajes: mensajes.slice(0, 20) };
    },
  );
