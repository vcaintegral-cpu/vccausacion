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
  correoDecisionesHtml,
  nocheDe,
  registrarPaso,
  reporteHtml,
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
};

/** Ejecuta un paso del día. Devuelve su registro (hecho, omitido o error). */
async function ejecutarPaso(
  db: Db,
  companyId: string,
  paso: PasoId,
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
    const { count } = await db
      .from("bulk_upload_items")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("status", "pending");
    return {
      id: paso,
      estado: "omitido",
      detalle: `${count ?? 0} documento(s) en la cola esperan causación. La causación automática en el servidor se activa en la siguiente etapa; mientras tanto se causan al abrir la aplicación.`,
      cifras: { en_cola: count ?? 0 },
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
 * Avanza el piloto de las empresas activas. `forzar`: ejecuta aunque sea de día (botón
 * «Ejecutar ahora»), con la noche de hoy.
 */
export async function avanzarPiloto(
  db: Db,
  opciones: { base: string; companyId?: string; forzar?: boolean; ahora?: Date },
): Promise<ResultadoPiloto[]> {
  const ahora = opciones.ahora ?? new Date();
  let q = db
    .from("piloto_config")
    .select("company_id, activo, correo, hora_inicio")
    .eq("activo", true);
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
  }>) {
    const { data: empresa } = await db
      .from("companies")
      .select("name, nit")
      .eq("id", cfg.company_id)
      .single();
    const emp = empresa as { name: string; nit: string | null } | null;
    if (!emp || !funcionActiva(emp.nit, "piloto_automatico")) continue;
    const noche = opciones.forzar ? horaColombia(ahora).fecha : nocheDe(ahora, cfg.hora_inicio);
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
          });
          const r = await enviarCorreo({ para: cfg.correo, asunto: rep.asunto, html: rep.html });
          if (!r.ok) throw new Error(r.error ?? "No se pudo enviar el reporte.");
          detalle = `Reporte enviado a ${cfg.correo}.`;
        }
        registro = { id: paso, estado: "hecho", inicio, fin: new Date().toISOString(), detalle };
      } else {
        const r = await ejecutarPaso(db, cfg.company_id, paso);
        registro = { ...r, inicio, fin: new Date().toISOString() };
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
    const nuevos = registrarPaso(pasos, registro);
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
    });
  }
  return salida;
}
