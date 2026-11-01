import { createFileRoute } from "@tanstack/react-router";
import type { SupabaseClient } from "@supabase/supabase-js";

function mismoSecreto(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Revisión programada de todas las fuentes activas (pg_cron → pg_net).
 * Protegida con el encabezado x-cron-secret = DOCUMENT_SYNC_CRON_SECRET.
 */
export const Route = createFileRoute("/api/cron/document-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secreto = process.env["DOCUMENT_SYNC_CRON_SECRET"] ?? "";
        if (!secreto || !mismoSecreto(request.headers.get("x-cron-secret") ?? "", secreto)) {
          return new Response("No autorizado", { status: 401 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { revisarTodas } = await import("@/lib/document-sources.server");
        try {
          const resultados = await revisarTodas(supabaseAdmin as unknown as SupabaseClient);
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
