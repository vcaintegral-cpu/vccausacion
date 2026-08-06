import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ExtractedLine = {
  code: string | null;
  description: string;
  quantity: number;
  unit_value: number;
  discount: number;
  iva: number;
  retention: number;
  impoconsumo: number;
  total: number;
};

export type ExtractedInvoice = {
  prefix: string | null;
  number: string | null;
  issue_date: string | null;
  due_date: string | null;
  provider_nit: string | null;
  provider_name: string | null;
  provider_address: string | null;
  provider_city: string | null;
  provider_phone: string | null;
  provider_email: string | null;
  cufe: string | null;
  payment_form: string | null;
  payment_method: string | null;
  currency: string | null;
  cost_center: string | null;
  notes: string | null;
  subtotal: number;
  discount: number;
  iva: number;
  impoconsumo: number;
  total: number;
  lines: ExtractedLine[];
};

const SYSTEM = `Eres un asistente contable colombiano experto en facturas electrónicas DIAN.
Extraes datos de facturas de compra (PDF, XML UBL DIAN o imagen) y devuelves SOLO un objeto JSON válido, sin texto adicional ni markdown.
Estructura exacta:
{"prefix":string|null,"number":string|null,"issue_date":"YYYY-MM-DD"|null,"due_date":"YYYY-MM-DD"|null,
"provider_nit":string|null,"provider_name":string|null,"provider_address":string|null,"provider_city":string|null,
"provider_phone":string|null,"provider_email":string|null,"cufe":string|null,"payment_form":string|null,
"payment_method":string|null,"currency":string|null,"cost_center":string|null,"notes":string|null,
"subtotal":number,"discount":number,"iva":number,"impoconsumo":number,"total":number,
"lines":[{"code":string|null,"description":string,"quantity":number,"unit_value":number,"discount":number,"iva":number,"retention":number,"impoconsumo":number,"total":number}]}
Reglas: los importes son números sin separadores ni símbolos. El NIT va sin dígito de verificación separado por guion (usa solo el número base). Si un dato no aparece, usa null o 0. Nunca inventes valores.`;

function normalizeDataUrl(fileName: string, mimeType: string, dataUrl: string) {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  const byExt: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
  };
  const mime = byExt[ext] ?? (mimeType && mimeType !== "application/octet-stream" ? mimeType : "application/pdf");
  // Reconstruye el data URL con el MIME real: FileReader puede devolver
  // "data:;base64,..." o "data:application/octet-stream;base64,..." y el proveedor lo rechaza.
  const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
  const clean = base64.replace(/\s/g, "");
  const safeName = /\.[a-z0-9]+$/i.test(fileName) ? fileName : `${fileName}.pdf`;
  return { mime, url: `data:${mime};base64,${clean}`, safeName };
}

export const extractInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { fileName: string; mimeType: string; dataUrl?: string | null; text?: string | null }) => {
    if (!data?.fileName) throw new Error("Archivo requerido");
    return data;
  })
  .handler(async ({ data }) => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("Falta la configuración de IA (LOVABLE_API_KEY)");

    const content: unknown[] = [
      {
        type: "input_text",
        text: `Extrae la información contable de esta factura de compra (archivo: ${data.fileName}). Responde solo con un objeto JSON válido.`,
      },
    ];

    if (data.text) {
      content.push({ type: "input_text", text: `Contenido XML/texto de la factura:\n${data.text.slice(0, 120000)}` });
    } else if (data.dataUrl) {
      const { mime, url, safeName } = normalizeDataUrl(data.fileName, data.mimeType, data.dataUrl);
      console.log("extractInvoice archivo", { fileName: safeName, mime, bytes: url.length });
      if (mime.startsWith("image/")) {
        content.push({ type: "input_image", image_url: url });
      } else {
        content.push({ type: "input_file", filename: safeName, file_data: url });
      }
    } else {
      throw new Error("No se recibió contenido del archivo");
    }

    const res = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "fetch" },
      body: JSON.stringify({
        model: "openai/gpt-5.6-sol",
        stream: true,
        instructions: SYSTEM,
        input: [
          { role: "user", content },
        ],
        text: { format: { type: "json_object" } },
      }),
    });

    if (res.status === 429) throw new Error("Límite de solicitudes de IA alcanzado. Intenta de nuevo en unos minutos.");
    if (res.status === 402) throw new Error("Créditos de IA agotados. Recarga créditos para seguir procesando facturas.");
    if (!res.ok || !res.body) {
      const detail = await res.text();
      console.error("AI gateway error", res.status, detail);
      throw new Error(`No fue posible leer la factura con IA (${res.status}): ${detail.slice(0, 500)}`);
    }

    // SSE: acumulamos los deltas de texto de salida.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let raw = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload) as {
            type?: string;
            delta?: string;
            response?: { output_text?: string };
          };
          if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") raw += evt.delta;
          else if (evt.type === "response.completed" && !raw && evt.response?.output_text) raw = evt.response.output_text;
        } catch {
          // ignorar eventos no JSON
        }
      }
    }
    const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let parsed: ExtractedInvoice;
    try {
      parsed = JSON.parse(cleaned) as ExtractedInvoice;
    } catch {
      console.error("Respuesta IA no parseable", raw.slice(0, 500));
      throw new Error("La IA devolvió una respuesta inesperada. Intenta nuevamente.");
    }
    parsed.lines = Array.isArray(parsed.lines) ? parsed.lines : [];
    return parsed;
  });