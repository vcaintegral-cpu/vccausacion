// Piloto automático — orquestador del servidor. Lo llama el programador de la base de datos
// cada pocos minutos (/api/cron/piloto). Por empresa activa (piloto_config.activo y función
// «piloto_automatico» en su perfil), dentro de la ventana nocturna:
//   1. crea o retoma la ejecución de la noche (la memoria),
//   2. hace UN paso (para no pasar el límite de subpeticiones del servidor),
//   3. avisa por correo las preguntas nuevas,
//   4. cuando no quedan pasos, envía el reporte una sola vez.
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PASOS,
  pasosParaReintentar,
  correoDecisionesHtml,
  nocheDe,
  registrarPaso,
  reporteHtml,
  mesDeTrabajo,
  etiquetaMes,
  siguientePaso,
  type PasoId,
  type PasoRegistro,
} from "@/lib/piloto";

type Db = SupabaseClient;

export type ResultadoPiloto = {
  companyId: string;
  noche: string | null;
  paso: PasoId | null;
  detalle: string;
  /** Resultado del paso ejecutado (para que la prueba completa sepa cuándo detenerse). */
  estado?: PasoRegistro["estado"];
};

/** Ejecuta un paso del día. Devuelve su registro (hecho, omitido o error). */
async function ejecutarPaso(
  db: Db,
  companyId: string,
  paso: PasoId,
  previo?: PasoRegistro,
  mes?: string,
  envio?: { tope: number; enviar: boolean },
): Promise<Omit<PasoRegistro, "inicio" | "fin">> {
  if (paso === "drive") {
    const { revisarFuente } = await import("./document-sources.server");
    const partes: string[] = [];
    const cifras: Record<string, number> = {};
    for (const proposito of ["compras", "egresos"] as const) {
      try {
        const r = await revisarFuente(db, companyId, proposito);
        cifras[`${proposito}_encontrados`] = r.encontrados;
        cifras[`${proposito}_facturas`] = r.facturasEncoladas;
        cifras[`${proposito}_excel`] = r.documentosExcel;
        cifras[`${proposito}_egresos`] = r.egresosRecibidos;
        partes.push(
          proposito === "compras"
            ? `Facturas: ${r.facturasEncoladas} PDF y ${r.documentosExcel} Excel nuevos en la cola${r.pendientesProximaEjecucion ? ` (${r.pendientesProximaEjecucion} quedan para la siguiente vuelta)` : ""}`
            : `Egresos: ${r.egresosRecibidos} archivos nuevos`,
        );
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (/no tiene carpeta/i.test(m)) partes.push(`${proposito}: sin carpeta configurada`);
        else throw e;
      }
    }
    return { id: paso, estado: "hecho", detalle: partes.join(" · "), cifras };
  }
  if (paso === "borradores") {
    const { causarCola } = await import("./bulk-servidor.server");
    const { rangoDelMes, etiquetaMes } = await import("./piloto");
    const rango = mes ? { ...rangoDelMes(mes), etiqueta: etiquetaMes(mes) } : undefined;
    const r = await causarCola(db, companyId, {
      limiteExcel: 3,
      limitePdf: 2,
      ...(rango ? { mes: rango } : {}),
    });
    // Cada llamada del programador hace una pasada: las cifras de la noche se acumulan.
    const antes = previo?.cifras ?? {};
    const suma = (k: string, n: number) => (antes[k] ?? 0) + n;
    const cifras = {
      causadas: suma("causadas", r.procesadas),
      verdes: suma("verdes", r.verdes),
      amarillas: suma("amarillas", r.amarillas),
      con_error: suma("con_error", r.conError),
      excel_pendientes: r.pendientes,
      pdf_pendientes: r.pdfPendientes,
      fuera_de_mes: suma("fuera_de_mes", r.fueraDeMes),
    };
    const cola = r.pendientes + r.pdfPendientes;
    // Si hay cola pero no se avanzó nada, es un error (se reintenta 3 veces y se reporta).
    if (cola > 0 && r.procesadas === 0)
      return {
        id: paso,
        estado: "error",
        detalle: `La cola no avanza: ${r.pendientes} del Excel y ${r.pdfPendientes} PDF sin causar`,
        cifras,
      };
    return {
      id: paso,
      // Sigue «pendiente» mientras haya documentos en la cola; la siguiente llamada continúa.
      estado: cola > 0 ? "pendiente" : "hecho",
      detalle: `Causadas ${cifras.causadas} esta noche (${cifras.verdes} en verde, ${cifras.amarillas} por revisar, ${cifras.con_error} con error${
        cifras.fuera_de_mes
          ? `, ${cifras.fuera_de_mes} fuera de ${mes ? etiquetaMes(mes) : "el mes de trabajo"}`
          : ""
      })${
        cola > 0
          ? `; quedan ${r.pendientes} del Excel y ${r.pdfPendientes} PDF`
          : "; la cola quedó vacía"
      }`,
      cifras,
    };
  }
  if (paso === "siigo_compras") {
    const { rangoDelMes, etiquetaMes } = await import("./piloto");
    if (!mes) throw new Error("No hay mes de trabajo para enviar a Siigo.");
    const { enviarVerdesASiigo } = await import("./piloto-siigo.server");
    const enviar = envio?.enviar === true;
    const r = await enviarVerdesASiigo(db, companyId, {
      mes: rangoDelMes(mes),
      tope: envio?.tope ?? 5_000_000,
      enviar,
      limite: 2,
    });
    const antes = previo?.cifras ?? {};
    const cifras = {
      evaluadas: r.candidatas,
      verdes: r.verdes,
      por_revisar: r.porRevisar.length,
      enviadas: (antes["enviadas"] ?? 0) + r.enviadas,
      con_error: (antes["con_error"] ?? 0) + r.conError,
      verdes_pendientes: r.verdesPendientes,
    };
    // Motivos agrupados (los más frecuentes), para que el reporte diga POR QUÉ no se envió.
    const frecuencia = new Map<string, number>();
    for (const x of r.porRevisar)
      for (const m of x.motivos)
        frecuencia.set(m.slice(0, 90), (frecuencia.get(m.slice(0, 90)) ?? 0) + 1);
    const motivos = [...frecuencia]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([m, n]) => `${n}× ${m}`)
      .join("; ");
    const mesTxt = etiquetaMes(mes);
    if (!enviar)
      return {
        id: paso,
        estado: "hecho",
        detalle: `MODO PRUEBA (no se envió nada a Siigo): de ${r.candidatas} borrador(es) de ${mesTxt}, ${r.verdes} están en verde y se enviarían; ${r.porRevisar.length} por revisar${motivos ? ` — ${motivos}` : ""}. Active «Enviar a Siigo lo que quede en verde» en Piloto automático para enviarlas.`,
        cifras,
      };
    // Si hay verdes pendientes pero esta pasada no envió nada ni falló, algo no avanza.
    if (r.verdesPendientes > 0 && r.enviadas === 0 && r.conError === 0)
      return {
        id: paso,
        estado: "error",
        detalle: `El envío a Siigo no avanza: ${r.verdesPendientes} en verde sin enviar`,
        cifras,
      };
    // Si TODAS las de esta pasada fallaron de forma inesperada, es un error del paso (se reintenta y se reporta).
    if (
      r.enviadas === 0 &&
      r.conError > 0 &&
      r.primerError &&
      r.verdes > 0 &&
      r.verdesPendientes === Math.max(0, r.verdes - r.conError)
    )
      return {
        id: paso,
        estado: "error",
        detalle: `Falló el envío a Siigo: ${r.primerError}`,
        cifras,
      };
    return {
      id: paso,
      estado: r.verdesPendientes > 0 ? "pendiente" : "hecho",
      detalle: `Enviadas ${cifras.enviadas} a Siigo esta noche (${cifras.con_error} con error); ${r.porRevisar.length} por revisar${motivos ? ` — ${motivos}` : ""}${r.verdesPendientes > 0 ? `; quedan ${r.verdesPendientes} en verde` : ""}`,
      cifras,
    };
  }
  if (paso === "egresos") {
    const { etiquetaMes } = await import("./piloto");
    if (!mes) throw new Error("No hay mes de trabajo para los egresos.");
    const { procesarEgresos } = await import("./piloto-egresos.server");
    const enviar = envio?.enviar === true;
    const antes = previo?.cifras ?? {};
    const r = await procesarEgresos(db, companyId, {
      periodo: mes.slice(0, 7),
      tope: envio?.tope ?? 5_000_000,
      enviar,
      // Las CxP de Siigo se leen y el mes se vuelve a proponer una sola vez por noche.
      preparar: !antes["preparado"],
      limite: 2,
    });
    const cifras = {
      preparado: 1,
      evaluados: r.evaluados,
      verdes: r.verdes,
      por_revisar: r.porRevisar.length,
      enviados: (antes["enviados"] ?? 0) + r.enviados,
      con_error: (antes["con_error"] ?? 0) + r.conError,
      verdes_pendientes: r.verdesPendientes,
    };
    const frecuencia = new Map<string, number>();
    for (const x of r.porRevisar)
      for (const m of x.motivos)
        frecuencia.set(m.slice(0, 90), (frecuencia.get(m.slice(0, 90)) ?? 0) + 1);
    const motivos = [...frecuencia]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([m, n]) => `${n}× ${m}`)
      .join("; ");
    const mesTxt = etiquetaMes(mes);
    if (!enviar)
      return {
        id: paso,
        estado: "hecho",
        detalle: `MODO PRUEBA (no se creó ningún recibo en Siigo): de ${r.evaluados} pago(s) de ${mesTxt}, ${r.verdes} están en verde y se enviarían; ${r.porRevisar.length} por revisar${motivos ? ` — ${motivos}` : ""}.`,
        cifras,
      };
    if (r.verdesPendientes > 0 && r.enviados === 0 && r.conError === 0)
      return {
        id: paso,
        estado: "error",
        detalle: `Los egresos no avanzan: ${r.verdesPendientes} en verde sin enviar`,
        cifras,
      };
    return {
      id: paso,
      estado: r.verdesPendientes > 0 ? "pendiente" : "hecho",
      detalle: `Recibos de pago enviados ${cifras.enviados} esta noche (${cifras.con_error} con error); ${r.porRevisar.length} por revisar${motivos ? ` — ${motivos}` : ""}${r.verdesPendientes > 0 ? `; quedan ${r.verdesPendientes} en verde` : ""}`,
      cifras,
    };
  }
  if (paso === "reporte") return { id: paso, estado: "hecho", detalle: "Reporte enviado." };
  return {
    id: paso,
    estado: "omitido",
    detalle: "Se activa en una próxima etapa del piloto automático.",
  };
}

/** Envía por correo las preguntas nuevas (aún no notificadas) de la empresa. */
async function notificarDecisiones(
  db: Db,
  companyId: string,
  empresa: string,
  correo: string,
  base: string,
) {
  const { data } = await db
    .from("piloto_decisiones")
    .select("id, titulo, pregunta, opciones, token")
    .eq("company_id", companyId)
    .eq("estado", "pendiente")
    .is("notificada_at", null)
    .limit(20);
  const lista = (data ?? []) as Array<{
    id: string;
    titulo: string;
    pregunta: string;
    opciones: Array<{ id: string; etiqueta: string }>;
    token: string;
  }>;
  if (!lista.length) return 0;
  const { enviarCorreo } = await import("./correo.server");
  const c = correoDecisionesHtml({ empresa, base, decisiones: lista });
  const r = await enviarCorreo({ para: correo, asunto: c.asunto, html: c.html });
  if (r.ok)
    await db
      .from("piloto_decisiones")
      .update({ notificada_at: new Date().toISOString() })
      .in(
        "id",
        lista.map((d) => d.id),
      );
  return r.ok ? lista.length : 0;
}

/**
 * Ciclo de correcciones: (1) correcciones ya fusionadas por la revisión automática → una
 * pregunta «Ya publiqué en Lovable» (sale por correo); (2) cuando la usuaria confirma, la
 * última noche vuelve a «en curso» sin sus pasos con error, que se reintentan enseguida
 * aunque sea de día, y al final se envía otra vez el reporte. Devuelve la noche a reintentar.
 */
async function cicloCorrecciones(db: Db, companyId: string): Promise<string | null> {
  const { alertasConfiguradas, correccionesPorAvisar, agregarEtiqueta, comentar } =
    await import("./alertas.server");
  if (alertasConfiguradas()) {
    try {
      const listas = await correccionesPorAvisar();
      if (listas.length) {
        const clave = `publicar|${listas
          .map((i) => i.number)
          .sort((a, b) => a - b)
          .join(",")}`;
        await db.from("piloto_decisiones").upsert(
          {
            company_id: companyId,
            clave,
            tipo: "publicar",
            titulo: "Correcciones listas para publicar",
            pregunta: `Se corrigieron ${listas.length} error(es) del piloto automático y ya están en la aplicación: ${listas.map((i) => `«${i.title}»`).join("; ")}. Abra Lovable, pulse Publish → Update y luego confirme aquí para que el piloto reintente los pasos con error.`,
            opciones: [{ id: "publicado", etiqueta: "Ya publiqué en Lovable" }] as never,
          },
          { onConflict: "company_id,clave", ignoreDuplicates: true },
        );
        for (const i of listas) await agregarEtiqueta(i.number, "aviso-enviado");
      }
    } catch {
      // Las alertas no detienen el piloto.
    }
  }
  const { data: confirmadas } = await db
    .from("piloto_decisiones")
    .select("id, clave")
    .eq("company_id", companyId)
    .eq("tipo", "publicar")
    .eq("estado", "respondida")
    .is("aplicada_at", null);
  const lista = (confirmadas ?? []) as Array<{ id: string; clave: string }>;
  if (lista.length) {
    const { data: ultima } = await db
      .from("piloto_ejecuciones")
      .select("id, noche, pasos")
      .eq("company_id", companyId)
      .order("noche", { ascending: false })
      .limit(1)
      .maybeSingle();
    const u = ultima as { id: string; noche: string; pasos: PasoRegistro[] } | null;
    if (u)
      await db
        .from("piloto_ejecuciones")
        .update({
          estado: "en_curso",
          pasos: pasosParaReintentar(u.pasos ?? []) as never,
          reporte_enviado_at: null,
          resumen: { reintento: true } as never,
        })
        .eq("id", u.id);
    await db
      .from("piloto_decisiones")
      .update({ estado: "aplicada", aplicada_at: new Date().toISOString() })
      .in(
        "id",
        lista.map((d) => d.id),
      );
    if (alertasConfiguradas())
      for (const d of lista)
        for (const n of d.clave.replace("publicar|", "").split(",").map(Number))
          if (Number.isFinite(n))
            await comentar(
              n,
              "La usuaria confirmó la publicación; el piloto reintenta los pasos con error.",
            ).catch(() => undefined);
  }
  // Reintento en curso (aunque sea de día).
  const { data: enCurso } = await db
    .from("piloto_ejecuciones")
    .select("noche, resumen")
    .eq("company_id", companyId)
    .eq("estado", "en_curso")
    .order("noche", { ascending: false })
    .limit(1)
    .maybeSingle();
  const e = enCurso as { noche: string; resumen: { reintento?: boolean } | null } | null;
  return e?.resumen?.reintento ? e.noche : null;
}

/**
 * Mes de trabajo. El piloto solo causa documentos del mes en curso; pasa al siguiente únicamente
 * cuando la usuaria respondió «cerrar» a la pregunta del cierre (facturas, egresos y conciliación del
 * mes completos). Al cambiar de mes retoma los documentos apartados por ser de ese mes.
 */
async function cicloMes(db: Db, companyId: string, mesActual: string): Promise<string> {
  const { siguienteMes, rangoDelMes } = await import("./piloto");
  const { data } = await db
    .from("piloto_decisiones")
    .select("id, clave, respuesta")
    .eq("company_id", companyId)
    .eq("tipo", "cerrar_mes")
    .eq("estado", "respondida")
    .is("aplicada_at", null);
  let mes = mesActual;
  for (const d of (data ?? []) as Array<{ id: string; clave: string; respuesta: string | null }>) {
    const delMes = d.clave.split("|")[1];
    if (d.respuesta === "cerrar" && delMes === mes) {
      const nuevo = siguienteMes(mes);
      const { error } = await db
        .from("piloto_config")
        .update({ mes_trabajo: nuevo })
        .eq("company_id", companyId);
      if (error) throw new Error(`No se pudo pasar al mes siguiente: ${error.message}`);
      const { desde, hasta } = rangoDelMes(nuevo);
      await db
        .from("bulk_upload_items")
        .update({ status: "pending", stage: null, user_message: null })
        .eq("company_id", companyId)
        .eq("status", "cancelled")
        .eq("stage", "fuera_de_mes")
        .gte("issue_date", desde)
        .lte("issue_date", hasta);
      mes = nuevo;
    }
    await db
      .from("piloto_decisiones")
      .update({ estado: "aplicada", aplicada_at: new Date().toISOString() })
      .eq("id", d.id);
  }
  return mes;
}

/**
 * Al terminar la noche, si la cola del mes quedó vacía y sin documentos con error, pregunta (una sola
 * pregunta abierta a la vez) si se cierra el mes. Egresos y conciliación todavía no los evalúa el
 * piloto: por eso la confirmación de la usuaria es la que manda.
 */
async function proponerCierreDeMes(
  db: Db,
  companyId: string,
  mes: string,
  noche: string,
  pasos: PasoRegistro[],
) {
  const borradores = pasos.find((p) => p.id === "borradores");
  if (!borradores || borradores.estado !== "hecho") return;
  const { rangoDelMes, etiquetaMes, siguienteMes } = await import("./piloto");
  const { count: abierta } = await db
    .from("piloto_decisiones")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("tipo", "cerrar_mes")
    .eq("estado", "pendiente");
  if ((abierta ?? 0) > 0) return;
  const { desde, hasta } = rangoDelMes(mes);
  const [{ count: errores }, { count: sinEnviar }] = await Promise.all([
    db
      .from("bulk_upload_items")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("status", "error"),
    db
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .in("status", ["borrador", "error"])
      .gte("issue_date", desde)
      .lte("issue_date", hasta),
  ]);
  if ((errores ?? 0) > 0) return;
  const etiqueta = etiquetaMes(mes);
  await db.from("piloto_decisiones").upsert(
    {
      company_id: companyId,
      clave: `cerrar-mes|${mes}|${noche}`,
      tipo: "cerrar_mes",
      titulo: `¿Cerramos ${etiqueta}?`,
      pregunta: `La cola de facturas de ${etiqueta} quedó vacía y no hay documentos con error. Hay ${sinEnviar ?? 0} borrador(es) de ese mes sin enviar a Siigo. Para pasar a ${etiquetaMes(siguienteMes(mes))}, confirme que las facturas, los egresos y la conciliación bancaria de ${etiqueta} ya están completos. Mientras no confirme, el piloto sigue trabajando solo en ${etiqueta}.`,
      opciones: [
        { id: "cerrar", etiqueta: `Sí, cerrar ${etiqueta} y pasar al siguiente mes` },
        { id: "seguir", etiqueta: `No, seguir en ${etiqueta}` },
      ] as never,
    },
    { onConflict: "company_id,clave", ignoreDuplicates: true },
  );
}

/**
 * Avanza el piloto de las empresas activas. `forzar`: ejecuta aunque sea de día (botón
 * «Ejecutar ahora»), con la noche de hoy.
 */
export async function avanzarPiloto(
  db: Db,
  opciones: {
    base: string;
    companyId?: string;
    forzar?: boolean;
    reiniciar?: boolean;
    prueba?: boolean;
    ahora?: Date;
  },
): Promise<ResultadoPiloto[]> {
  const ahora = opciones.ahora ?? new Date();
  let q = db.from("piloto_config").select("*").eq("activo", true);
  if (opciones.companyId) q = q.eq("company_id", opciones.companyId);
  const { data: configs, error } = await q;
  if (error) throw new Error(error.message);
  const { funcionActiva } = await import("@/empresas/registro");
  const { horaColombia } = await import("./piloto");
  const salida: ResultadoPiloto[] = [];
  for (const cfg of (configs ?? []) as Array<{
    company_id: string;
    correo: string | null;
    hora_inicio: number;
    mes_trabajo?: string | null;
    tope_valor?: number | string | null;
    enviar_a_siigo?: boolean | null;
  }>) {
    const { data: empresa } = await db
      .from("companies")
      .select("name, nit")
      .eq("id", cfg.company_id)
      .single();
    const emp = empresa as { name: string; nit: string | null } | null;
    if (!emp || !funcionActiva(emp.nit, "piloto_automatico")) continue;
    const reintento = await cicloCorrecciones(db, cfg.company_id);
    // Mes de trabajo: solo se pasa al siguiente cuando la usuaria confirma que el mes quedó completo.
    const mes = await cicloMes(db, cfg.company_id, mesDeTrabajo(cfg.mes_trabajo ?? null, ahora));
    const noche = opciones.forzar
      ? horaColombia(ahora).fecha
      : (nocheDe(ahora, cfg.hora_inicio) ?? reintento);
    if (!noche) {
      salida.push({
        companyId: cfg.company_id,
        noche: null,
        paso: null,
        detalle: "Fuera del horario nocturno.",
      });
      continue;
    }
    // Ejecución de la noche (memoria).
    const { data: previa } = await db
      .from("piloto_ejecuciones")
      .select("id, estado, pasos, reporte_enviado_at")
      .eq("company_id", cfg.company_id)
      .eq("noche", noche)
      .maybeSingle();
    type Ejecucion = {
      id: string;
      estado: string;
      pasos: PasoRegistro[];
      reporte_enviado_at: string | null;
    };
    let ej = previa as unknown as Ejecucion | null;
    // Prueba completa desde la pantalla: se reinicia la noche de hoy para repasar todos los pasos otra vez.
    if (ej && opciones.forzar && opciones.reiniciar) {
      await db
        .from("piloto_ejecuciones")
        .update({
          estado: "en_curso",
          pasos: [] as never,
          reporte_enviado_at: null,
          resumen: { prueba: true } as never,
        })
        .eq("id", ej.id);
      ej = { ...ej, estado: "en_curso", pasos: [], reporte_enviado_at: null };
    }
    if (!ej) {
      const { data: nueva, error: e2 } = await db
        .from("piloto_ejecuciones")
        .insert({ company_id: cfg.company_id, noche })
        .select("id, estado, pasos, reporte_enviado_at")
        .single();
      if (e2 || !nueva) throw new Error(e2?.message ?? "No se pudo crear la ejecución.");
      ej = nueva as unknown as Ejecucion;
    }
    if (!ej) continue;
    const pasos = (ej.pasos ?? []) as PasoRegistro[];
    const paso = siguientePaso(pasos);
    if (!paso) {
      salida.push({
        companyId: cfg.company_id,
        noche,
        paso: null,
        detalle: "La noche ya terminó.",
      });
      continue;
    }
    const inicio = new Date().toISOString();
    let registro: PasoRegistro;
    try {
      if (paso === "reporte") {
        await proponerCierreDeMes(db, cfg.company_id, mes, noche, pasos);
        const { count } = await db
          .from("piloto_decisiones")
          .select("id", { count: "exact", head: true })
          .eq("company_id", cfg.company_id)
          .eq("estado", "pendiente");
        let detalle = "Sin correo configurado: el reporte queda en la aplicación.";
        if (cfg.correo && !ej.reporte_enviado_at) {
          const { enviarCorreo } = await import("./correo.server");
          const rep = reporteHtml({
            empresa: emp.name,
            noche,
            pasos,
            pendientes: count ?? 0,
            base: opciones.base,
            mes: etiquetaMes(mes),
          });
          const r = await enviarCorreo({ para: cfg.correo, asunto: rep.asunto, html: rep.html });
          if (!r.ok) throw new Error(r.error ?? "No se pudo enviar el reporte.");
          detalle = `Reporte enviado a ${cfg.correo}.`;
        }
        registro = { id: paso, estado: "hecho", inicio, fin: new Date().toISOString(), detalle };
      } else {
        const r = await ejecutarPaso(
          db,
          cfg.company_id,
          paso,
          pasos.find((x) => x.id === paso),
          mes,
          { tope: Number(cfg.tope_valor ?? 5_000_000), enviar: cfg.enviar_a_siigo === true },
        );
        registro = { ...r, inicio, fin: new Date().toISOString() };
        // Prueba desde la pantalla: una sola pasada por paso; lo que quede en cola lo hace la noche real.
        if (opciones.prueba && registro.estado === "pendiente")
          registro = {
            ...registro,
            estado: "hecho",
            detalle: `${registro.detalle} (prueba: una sola pasada; el resto se hace de noche)`,
          };
      }
    } catch (e) {
      registro = {
        id: paso,
        estado: "error",
        inicio,
        fin: new Date().toISOString(),
        detalle: e instanceof Error ? e.message.slice(0, 500) : String(e),
      };
    }
    let nuevos = registrarPaso(pasos, registro);
    // Tercer intento fallido: caso en el repositorio privado de alertas para corregirlo.
    const final = nuevos.find((x) => x.id === paso);
    if (final?.estado === "error" && (final.intentos ?? 0) >= 3 && !final.alerta) {
      const { alertasConfiguradas, crearAlerta } = await import("./alertas.server");
      if (alertasConfiguradas())
        try {
          const n = await crearAlerta({
            titulo: `[${emp.name}] ${PASOS.find((x) => x.id === paso)?.nombre}: ${final.detalle.slice(0, 90)}`,
            cuerpo: [
              `**Empresa:** ${emp.name} (${emp.nit ?? "sin NIT"})`,
              `**Noche:** ${noche}`,
              `**Paso:** ${paso} — ${PASOS.find((x) => x.id === paso)?.nombre}`,
              `**Intentos:** ${final.intentos}`,
              "",
              "**Error:**",
              "```",
              final.detalle,
              "```",
            ].join("\n"),
          });
          nuevos = nuevos.map((x) => (x.id === paso ? { ...x, alerta: n } : x));
        } catch {
          // Si GitHub no responde, el error queda en la memoria y en el reporte.
        }
    }
    const terminada = siguientePaso(nuevos) == null;
    await db
      .from("piloto_ejecuciones")
      .update({
        pasos: nuevos as never,
        ...(terminada
          ? { estado: nuevos.some((x) => x.estado === "error") ? "error" : "terminada" }
          : {}),
        ...(paso === "reporte" && registro.estado === "hecho"
          ? { reporte_enviado_at: new Date().toISOString() }
          : {}),
      })
      .eq("id", ej.id);
    // Preguntas nuevas: un correo con todas (no bloquean los demás pasos).
    if (cfg.correo)
      await notificarDecisiones(db, cfg.company_id, emp.name, cfg.correo, opciones.base);
    salida.push({
      companyId: cfg.company_id,
      noche,
      paso,
      detalle: `${PASOS.find((x) => x.id === paso)?.nombre}: ${registro.detalle}`,
      estado: registro.estado,
    });
  }
  return salida;
}
