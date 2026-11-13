import { createFileRoute } from "@tanstack/react-router";
import type { SupabaseClient } from "@supabase/supabase-js";

function mismoSecreto(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Piloto automático nocturno (pg_cron → pg_net, cada pocos minutos). Cada llamada avanza un
 * paso por empresa activa dentro de su ventana nocturna. Protegida con x-cron-secret
 * (el mismo DOCUMENT_SYNC_CRON_SECRET de la revisión de Drive).
 */
export const Route = createFileRoute("/api/cron/piloto")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secreto = process.env["DOCUMENT_SYNC_CRON_SECRET"] ?? "";
        if (!secreto || !mismoSecreto(request.headers.get("x-cron-secret") ?? "", secreto)) {
          return new Response("No autorizado", { status: 401 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { avanzarPiloto } = await import("@/lib/piloto.server");
        try {
          const base = process.env["APP_URL"] || new URL(request.url).origin;
          const resultados = await avanzarPiloto(supabaseAdmin as unknown as SupabaseClient, {
            base,
          });
          return Response.json({ ok: true, resultados });
        } catch (e) {
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      },
    },
  },
});
