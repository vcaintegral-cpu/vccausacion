// Piloto automático — funciones de la pantalla (empresas con la función «piloto_automatico»).
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { PasoRegistro } from "@/lib/piloto";

export type EstadoPiloto = {
  config: {
    activo: boolean;
    correo: string | null;
    tope_valor: number;
    hora_inicio: number;
    /** Mes de trabajo (AAAA-MM-01); null = el mes actual. */
    mes_trabajo: string | null;
    /** false = modo prueba: evalúa y reporta, sin enviar nada a Siigo. */
    enviar_a_siigo: boolean;
  } | null;
  ejecuciones: Array<{
    id: string;
    noche: string;
    estado: string;
    pasos: PasoRegistro[];
    reporte_enviado_at: string | null;
  }>;
  decisiones: Array<{
    id: string;
    titulo: string;
    pregunta: string;
    opciones: Array<{ id: string; etiqueta: string }>;
    estado: string;
    respuesta: string | null;
    instruccion: string | null;
    created_at: string;
    respondida_at: string | null;
  }>;
  correoConfigurado: boolean;
  /** Casos de error al repositorio privado de alertas (secreto GITHUB_ALERTAS_TOKEN). */
  alertasConfiguradas: boolean;
};

async function verificarEmpresa(
  db: import("@supabase/supabase-js").SupabaseClient,
  companyId: string,
): Promise<{ nit: string | null; name: string }> {
  const { data, error } = await db
    .from("companies")
    .select("nit, name")
    .eq("id", companyId)
    .single();
  if (error || !data) throw new Error("Empresa no encontrada.");
  const { funcionActiva } = await import("@/empresas/registro");
  const e = data as { nit: string | null; name: string };
  if (!funcionActiva(e.nit, "piloto_automatico"))
    throw new Error("El piloto automático no está habilitado para esta empresa.");
  return e;
}

export const pilotoEstado = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => {
    if (!input?.companyId) throw new Error("companyId requerido");
    return input;
  })
  .handler(async ({ data, context }): Promise<EstadoPiloto> => {
    const db = context.supabase;
    await verificarEmpresa(db, data.companyId);
    const [cfg, ej, dec] = await Promise.all([
      db.from("piloto_config").select("*").eq("company_id", data.companyId).maybeSingle(),
      db
        .from("piloto_ejecuciones")
        .select("id, noche, estado, pasos, reporte_enviado_at")
        .eq("company_id", data.companyId)
        .order("noche", { ascending: false })
        .limit(15),
      db
        .from("piloto_decisiones")
        .select(
          "id, titulo, pregunta, opciones, estado, respuesta, instruccion, created_at, respondida_at",
        )
        .eq("company_id", data.companyId)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    return {
      config: cfg.data
        ? {
            activo: (cfg.data as { activo: boolean }).activo,
            correo: (cfg.data as { correo: string | null }).correo,
            hora_inicio: (cfg.data as { hora_inicio: number }).hora_inicio,
            mes_trabajo: (cfg.data as { mes_trabajo?: string | null }).mes_trabajo ?? null,
            enviar_a_siigo: (cfg.data as { enviar_a_siigo?: boolean }).enviar_a_siigo === true,
            tope_valor: Number((cfg.data as { tope_valor: number }).tope_valor),
          }
        : null,
      ejecuciones: (ej.data ?? []) as unknown as EstadoPiloto["ejecuciones"],
      decisiones: (dec.data ?? []) as unknown as EstadoPiloto["decisiones"],
      correoConfigurado: !!process.env["RESEND_API_KEY"],
      alertasConfiguradas: !!process.env["GITHUB_ALERTAS_TOKEN"],
    };
  });

export const pilotoGuardarConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      activo: boolean;
      correo: string | null;
      tope_valor: number;
      hora_inicio: number;
      /** Mes de trabajo (AAAA-MM o AAAA-MM-DD). Si no viene, no se cambia. */
      mes_trabajo?: string | null;
      enviar_a_siigo?: boolean;
    }) => {
      if (!input?.companyId) throw new Error("companyId requerido");
      if (input.mes_trabajo && !/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(input.mes_trabajo))
        throw new Error("Mes de trabajo inválido.");
      if (input.correo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.correo))
        throw new Error("Correo inválido.");
      if (!(Number(input.tope_valor) >= 0)) throw new Error("Tope inválido.");
      if (!(Number(input.hora_inicio) >= 0 && Number(input.hora_inicio) <= 23))
        throw new Error("Hora inválida.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    await verificarEmpresa(db, data.companyId);
    const { data: u } = await db.auth.getUser();
    const base = {
      company_id: data.companyId,
      activo: !!data.activo,
      correo: data.correo?.trim() || null,
      tope_valor: Math.round(Number(data.tope_valor)),
      hora_inicio: Math.round(Number(data.hora_inicio)),
      updated_by: u.user?.id ?? null,
    };
    const extras = {
      ...(data.mes_trabajo ? { mes_trabajo: `${data.mes_trabajo.slice(0, 7)}-01` } : {}),
      ...(data.enviar_a_siigo !== undefined ? { enviar_a_siigo: data.enviar_a_siigo } : {}),
    };
    let aviso: string | null = null;
    let { error } = await db
      .from("piloto_config")
      .upsert({ ...base, ...extras }, { onConflict: "company_id" });
    // Si faltan las columnas nuevas (migraciones 0038/0039 sin aplicar), se guarda lo demás y se avisa.
    if (error && /mes_trabajo|enviar_a_siigo/.test(error.message) && Object.keys(extras).length) {
      aviso =
        "Se guardó la configuración, pero el mes de trabajo y el envío a Siigo necesitan que Lovable aplique las migraciones 0038 y 0039.";
      ({ error } = await db.from("piloto_config").upsert(base, { onConflict: "company_id" }));
    }
    if (error) throw new Error(error.message);
    if (data.mes_trabajo) {
      // Al cambiar el mes a mano, los documentos apartados por ser de ese mes vuelven a la cola.
      const { rangoDelMes } = await import("./piloto");
      const { desde, hasta } = rangoDelMes(`${data.mes_trabajo.slice(0, 7)}-01`);
      await db
        .from("bulk_upload_items")
        .update({ status: "pending", stage: null, user_message: null })
        .eq("company_id", data.companyId)
        .eq("status", "cancelled")
        .eq("stage", "fuera_de_mes")
        .gte("issue_date", desde)
        .lte("issue_date", hasta);
    }
    return { ok: true, aviso };
  });

/** Responde una pregunta desde la bandeja (opción y, si quiere, una instrucción adicional). */
export const pilotoResponder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { decisionId: string; respuesta: string | null; instruccion: string | null }) => {
      if (!input?.decisionId || (!input.respuesta && !input.instruccion?.trim()))
        throw new Error("Elige una opción o escribe una instrucción.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const { data: d, error } = await db
      .from("piloto_decisiones")
      .select("id, opciones, estado")
      .eq("id", data.decisionId)
      .single();
    if (error || !d) throw new Error("Pregunta no encontrada.");
    const dec = d as { id: string; opciones: Array<{ id: string }>; estado: string };
    if (dec.estado !== "pendiente") throw new Error("La pregunta ya fue respondida.");
    if (data.respuesta && !dec.opciones.some((o) => o.id === data.respuesta))
      throw new Error("Opción inválida.");
    const { error: e2 } = await db
      .from("piloto_decisiones")
      .update({
        estado: "respondida",
        respuesta: data.respuesta,
        instruccion: data.instruccion?.trim() || null,
        respondida_at: new Date().toISOString(),
      })
      .eq("id", dec.id)
      .eq("estado", "pendiente");
    if (e2) throw new Error(e2.message);
    return { ok: true };
  });

/** Ejecuta ahora un paso del piloto (aunque sea de día) para revisar que funciona. */
export const pilotoEjecutarAhora = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; base: string }) => {
    if (!input?.companyId) throw new Error("companyId requerido");
    return input;
  })
  .handler(async ({ data, context }) => {
    await verificarEmpresa(context.supabase, data.companyId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { avanzarPiloto } = await import("./piloto.server");
    const base = process.env["APP_URL"] || data.base;
    return avanzarPiloto(
      supabaseAdmin as unknown as import("@supabase/supabase-js").SupabaseClient,
      {
        base,
        companyId: data.companyId,
        forzar: true,
      },
    );
  });
