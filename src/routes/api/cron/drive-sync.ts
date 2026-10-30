import { createFileRoute } from "@tanstack/react-router";
import type { SupabaseClient } from "@supabase/supabase-js";

function mismoSecreto(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Ejecución programada del importador de Drive (pg_cron → pg_net).
 * Protegida con el encabezado x-cron-secret = DRIVE_SYNC_CRON_SECRET.
 */
export const Route = createFileRoute("/api/cron/drive-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secreto = process.env["DRIVE_SYNC_CRON_SECRET"] ?? "";
        if (!secreto || !mismoSecreto(request.headers.get("x-cron-secret") ?? "", secreto)) {
          return new Response("No autorizado", { status: 401 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { syncDriveCompany } = await import("@/lib/drive-sync.server");
        const admin = supabaseAdmin as unknown as SupabaseClient;
        const { data, error } = await admin
          .from("drive_sync_sources")
          .select("company_id")
          .eq("enabled", true);
        if (error) return Response.json({ error: error.message }, { status: 500 });
        const resultados = [];
        for (const { company_id } of (data ?? []) as Array<{ company_id: string }>) {
          try {
            resultados.push(await syncDriveCompany(admin, company_id));
          } catch (e) {
            resultados.push({
              companyId: company_id,
              errores: [e instanceof Error ? e.message : String(e)],
            });
          }
        }
        return Response.json({ ok: true, resultados });
      },
    },
  },
});
