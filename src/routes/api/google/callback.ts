import { createFileRoute } from "@tanstack/react-router";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Regreso de Google tras autorizar la lectura de Drive: guarda el refresh token de la empresa. */
export const Route = createFileRoute("/api/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const volver = (estado: string, detalle?: string) => {
          const destino = new URL("/integraciones", url.origin);
          destino.searchParams.set("drive", estado);
          if (detalle) destino.searchParams.set("detalle", detalle.slice(0, 200));
          return Response.redirect(destino.toString(), 302);
        };
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const googleError = url.searchParams.get("error");
        if (googleError) return volver("error", `Google: ${googleError}`);
        if (!state || !code) return volver("error", "Respuesta incompleta de Google.");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as unknown as SupabaseClient;
        const { data: row } = await admin
          .from("google_oauth_states")
          .select("company_id, user_id, redirect_uri, created_at")
          .eq("state", state)
          .maybeSingle();
        // El estado se usa una sola vez.
        await admin.from("google_oauth_states").delete().eq("state", state);
        const pendiente = row as {
          company_id: string;
          user_id: string;
          redirect_uri: string;
          created_at: string;
        } | null;
        if (!pendiente) return volver("error", "La autorización no es válida o ya se usó.");
        if (Date.now() - new Date(pendiente.created_at).getTime() > 15 * 60 * 1000) {
          return volver("error", "La autorización venció; inténtalo de nuevo.");
        }

        try {
          const { exchangeCode } = await import("@/lib/google-drive.server");
          const tok = await exchangeCode(code, pendiente.redirect_uri);
          if (!tok.refresh_token)
            return volver("error", "Google no entregó acceso permanente; vuelve a conectar.");
          const { error } = await admin.from("google_drive_connections").upsert(
            {
              company_id: pendiente.company_id,
              google_email: tok.email,
              refresh_token: tok.refresh_token,
              scopes: tok.scope ?? null,
              connected_by: pendiente.user_id,
              connected_at: new Date().toISOString(),
            },
            { onConflict: "company_id" },
          );
          if (error) return volver("error", error.message);
          return volver("ok");
        } catch (e) {
          return volver("error", e instanceof Error ? e.message : String(e));
        }
      },
    },
  },
});
