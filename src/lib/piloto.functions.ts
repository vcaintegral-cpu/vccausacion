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
      db
        .from("piloto_config")
        .select("activo, correo, tope_valor, hora_inicio")
        .eq("company_id", data.companyId)
        .maybeSingle(),
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
            ...(cfg.data as EstadoPiloto["config"] & object),
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
    }) => {
      if (!input?.companyId) throw new Error("companyId requerido");
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
    const { error } = await db.from("piloto_config").upsert(
      {
        company_id: data.companyId,
        activo: !!data.activo,
        correo: data.correo?.trim() || null,
        tope_valor: Math.round(Number(data.tope_valor)),
        hora_inicio: Math.round(Number(data.hora_inicio)),
        updated_by: u.user?.id ?? null,
      },
      { onConflict: "company_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
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
