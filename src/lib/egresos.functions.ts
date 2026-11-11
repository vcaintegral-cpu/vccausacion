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
