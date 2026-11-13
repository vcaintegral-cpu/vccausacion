import { createFileRoute } from "@tanstack/react-router";
import type { SupabaseClient } from "@supabase/supabase-js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pagina = (titulo: string, cuerpo: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)}</title></head><body style="font-family:Arial,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#222"><h2>${esc(titulo)}</h2><p>${cuerpo}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

/**
 * Respuesta a una pregunta del piloto automático desde el correo: el enlace lleva el token
 * secreto de la decisión y la opción elegida. Solo responde decisiones pendientes y solo con
 * una de sus opciones; el piloto la aplica en su siguiente paso.
 */
export const Route = createFileRoute("/api/piloto/decision")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const token = url.searchParams.get("t") ?? "";
        const opcion = url.searchParams.get("o") ?? "";
        if (!/^[a-f0-9]{32,128}$/i.test(token) || !opcion)
          return pagina("Enlace inválido", "El enlace no es válido.", 400);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const db = supabaseAdmin as unknown as SupabaseClient;
        const { data } = await db
          .from("piloto_decisiones")
          .select("id, titulo, estado, opciones, respuesta")
          .eq("token", token)
          .maybeSingle();
        const d = data as {
          id: string;
          titulo: string;
          estado: string;
          opciones: Array<{ id: string; etiqueta: string }>;
          respuesta: string | null;
        } | null;
        if (!d) return pagina("Pregunta no encontrada", "La pregunta ya no existe.", 404);
        const elegida = d.opciones.find((o) => o.id === opcion);
        if (!elegida)
          return pagina("Opción inválida", "Esa opción no corresponde a la pregunta.", 400);
        if (d.estado !== "pendiente") {
          const previa =
            d.opciones.find((o) => o.id === d.respuesta)?.etiqueta ?? d.respuesta ?? "";
          return pagina(
            "Ya estaba respondida",
            `«${esc(d.titulo)}» ya tenía respuesta: <b>${esc(previa)}</b>.`,
          );
        }
        const { error } = await db
          .from("piloto_decisiones")
          .update({
            estado: "respondida",
            respuesta: elegida.id,
            respondida_at: new Date().toISOString(),
          })
          .eq("id", d.id)
          .eq("estado", "pendiente");
        if (error) return pagina("No se pudo guardar", esc(error.message), 500);
        return pagina(
          "Respuesta registrada",
          `«${esc(d.titulo)}»: <b>${esc(elegida.etiqueta)}</b>. El piloto automático la aplica en su siguiente paso. Puede cerrar esta ventana.`,
        );
      },
    },
  },
});
