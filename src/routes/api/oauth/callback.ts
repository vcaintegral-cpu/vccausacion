import { createFileRoute } from "@tanstack/react-router";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Regreso de Google o Microsoft tras autorizar la lectura: guarda el refresh token de la empresa. */
export const Route = createFileRoute("/api/oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const volver = (estado: string, detalle?: string) => {
          const destino = new URL("/fuentes", url.origin);
          destino.searchParams.set("conexion", estado);
          if (detalle) destino.searchParams.set("detalle", detalle.slice(0, 200));
          return Response.redirect(destino.toString(), 302);
        };
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const errorProveedor =
          url.searchParams.get("error_description") ?? url.searchParams.get("error");
        if (errorProveedor) return volver("error", errorProveedor);
        if (!state || !code) return volver("error", "Respuesta incompleta del proveedor.");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as unknown as SupabaseClient;
        const { data: row } = await admin
          .from("oauth_states")
          .select("company_id, provider, user_id, redirect_uri, created_at")
          .eq("state", state)
          .maybeSingle();
        // El estado se usa una sola vez.
        await admin.from("oauth_states").delete().eq("state", state);
        const pendiente = row as {
          company_id: string;
          provider: string;
          user_id: string;
          redirect_uri: string;
          created_at: string;
        } | null;
        if (!pendiente) return volver("error", "La autorización no es válida o ya se usó.");
        if (Date.now() - new Date(pendiente.created_at).getTime() > 15 * 60 * 1000) {
          return volver("error", "La autorización venció; inténtalo de nuevo.");
        }

        try {
          const { canjearCodigo, esProveedor } = await import("@/lib/oauth-connections.server");
          if (!esProveedor(pendiente.provider)) return volver("error", "Proveedor no válido.");
          const tok = await canjearCodigo(pendiente.provider, code, pendiente.redirect_uri);
          if (!tok.refresh_token)
            return volver("error", "El proveedor no entregó acceso permanente; vuelve a conectar.");
          const { error } = await admin.from("document_connections").upsert(
            {
              company_id: pendiente.company_id,
              provider: pendiente.provider,
              account_email: tok.email,
              refresh_token: tok.refresh_token,
              scopes: tok.scope ?? null,
              connected_by: pendiente.user_id,
              connected_at: new Date().toISOString(),
            },
            { onConflict: "company_id,provider" },
          );
          if (error) return volver("error", error.message);
          return volver("ok", pendiente.provider);
        } catch (e) {
          return volver("error", e instanceof Error ? e.message : String(e));
        }
      },
    },
  },
});
