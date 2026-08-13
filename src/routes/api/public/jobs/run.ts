// Endpoint del worker de segundo plano. Lo invoca pg_cron cada minuto y también
// la interfaz al terminar de subir un ZIP, para que arranque de inmediato.
import { createFileRoute } from "@tanstack/react-router";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function handle(request: Request) {
  const apikey = request.headers.get("apikey") ?? request.headers.get("authorization")?.replace("Bearer ", "");
  const esperado = process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["SUPABASE_ANON_KEY"];
  if (!apikey || !esperado || apikey !== esperado) {
    return json({ error: "No autorizado" }, 401);
  }
  let limit = 3;
  try {
    const body = (await request.json()) as { limit?: number };
    if (typeof body?.limit === "number") limit = body.limit;
  } catch {
    // Sin cuerpo: se usa la concurrencia por defecto.
  }
  try {
    const { runQueue } = await import("@/lib/jobs.server");
    const result = await runQueue({ limit });
    return json({ ok: true, ...result });
  } catch (error) {
    console.error("jobs/run", error);
    return json({ ok: false, error: error instanceof Error ? error.message : "Error del worker" }, 500);
  }
}

export const Route = createFileRoute("/api/public/jobs/run")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
      GET: ({ request }) => handle(request),
    },
  },
});
