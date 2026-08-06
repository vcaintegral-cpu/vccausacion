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
      { type: "text", text: `Extrae la información contable de esta factura de compra (archivo: ${data.fileName}).` },
    ];

    if (data.text) {
      content.push({ type: "text", text: `Contenido XML/texto de la factura:\n${data.text.slice(0, 120000)}` });
    } else if (data.dataUrl) {
      if (data.mimeType.startsWith("image/")) {
        content.push({ type: "image_url", image_url: { url: data.dataUrl } });
      } else {
        content.push({ type: "file", file: { filename: data.fileName, file_data: data.dataUrl } });
      }
    } else {
      throw new Error("No se recibió contenido del archivo");
    }

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
      body: JSON.stringify({
        model: "google/gemini-3.6-flash",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (res.status === 429) throw new Error("Límite de solicitudes de IA alcanzado. Intenta de nuevo en unos minutos.");
    if (res.status === 402) throw new Error("Créditos de IA agotados. Recarga créditos para seguir procesando facturas.");
    if (!res.ok) {
      const detail = await res.text();
      console.error("AI gateway error", res.status, detail);
      throw new Error("No fue posible leer la factura con IA.");
    }

    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = json.choices?.[0]?.message?.content ?? "";
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