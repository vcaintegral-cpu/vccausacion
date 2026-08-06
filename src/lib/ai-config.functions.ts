import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type TestInput = { provider: string; model: string; apiKey?: string | null };

export const testAiConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: TestInput) => {
    if (!data?.provider) throw new Error("Proveedor requerido");
    if (!data?.model) throw new Error("Modelo requerido");
    return data;
  })
  .handler(async ({ data }) => {
    const started = Date.now();
    const body = {
      model: data.model,
      messages: [{ role: "user", content: "Responde solo con: OK" }],
    } as Record<string, unknown>;

    let url = "https://ai.gateway.lovable.dev/v1/chat/completions";
    let headers: Record<string, string> = { "Content-Type": "application/json" };

    if (data.provider === "lovable") {
      const key = process.env["LOVABLE_API_KEY"];
      if (!key) throw new Error("Falta LOVABLE_API_KEY en el servidor");
      headers["Lovable-API-Key"] = key;
      if (data.model.startsWith("openai/gpt-5.6")) body["reasoning_effort"] = "none";
    } else {
      const key = (data.apiKey ?? "").trim();
      if (!key) throw new Error("Ingresa la clave API del proveedor seleccionado");
      headers["Authorization"] = `Bearer ${key}`;
      if (data.provider === "openai") {
        url = "https://api.openai.com/v1/chat/completions";
      } else if (data.provider === "google") {
        url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
      } else if (data.provider === "anthropic") {
        url = "https://api.anthropic.com/v1/messages";
        headers = { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
        body["max_tokens"] = 16;
      } else {
        throw new Error("Proveedor no soportado");
      }
    }

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) {
      console.error("Prueba de conexión IA falló", res.status, text.slice(0, 800));
      return { ok: false as const, status: res.status, ms: Date.now() - started, detail: text.slice(0, 600) };
    }
    return { ok: true as const, status: res.status, ms: Date.now() - started, detail: text.slice(0, 300) };
  });
