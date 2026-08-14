import type { ExtractedInvoice } from "./extract.functions";

const SYSTEM = `Eres un asistente contable colombiano experto en facturas electrónicas DIAN.
Extraes datos de facturas de compra (PDF, XML UBL DIAN o imagen) y devuelves SOLO un objeto JSON válido, sin texto adicional ni markdown.
Estructura exacta:
{"prefix":string|null,"number":string|null,"issue_date":"YYYY-MM-DD"|null,"due_date":"YYYY-MM-DD"|null,
"provider_nit":string|null,"provider_name":string|null,"provider_address":string|null,"provider_city":string|null,
"provider_phone":string|null,"provider_email":string|null,"cufe":string|null,"payment_form":string|null,
"buyer_nit":string|null,"buyer_name":string|null,
"payment_method":string|null,"currency":string|null,"cost_center":string|null,"notes":string|null,
"subtotal":number,"discount":number,"iva":number,"impoconsumo":number,
"retefuente":number,"reteiva":number,"reteica":number,"total":number,
"lines":[{"code":string|null,"description":string,"quantity":number,"unit_value":number,"discount":number,"iva":number,"retention":number,"impoconsumo":number,"total":number}]}
Reglas: los importes son números sin separadores ni símbolos. El NIT va sin dígito de verificación separado por guion (usa solo el número base).
"provider_*" es el EMISOR/VENDEDOR de la factura (quien la expide, normalmente en el encabezado junto al logo y la resolución DIAN).
"buyer_nit" y "buyer_name" son el NIT y la razón social del ADQUIRIENTE/COMPRADOR/CLIENTE (bloque "Adquiriente", "Cliente", "Señores", "Facturar a", "Datos del receptor"). Nunca uses el mismo NIT para proveedor y comprador: son dos empresas distintas. Si dudas, el emisor es quien cobra y el adquiriente es quien paga.
No supongas impuestos: si la factura no muestra IVA, "iva" es 0. Usa exclusivamente los valores impresos en el documento.
"retefuente", "reteiva" y "reteica" son las retenciones practicadas que aparecen impresas en la factura. Si la factura no muestra una retención, ese campo es 0. Nunca calcules ni estimes retenciones: solo transcribe las que estén impresas.
Si un dato no aparece, usa null o 0. Nunca inventes valores.`;

export type ExtractInvoiceInput = {
  fileName: string;
  mimeType: string;
  dataUrl?: string | null;
  images?: Array<{ dataUrl: string; mimeType: string }> | null;
  text?: string | null;
};

function normalizedImageUrl(mimeType: string, dataUrl: string) {
  const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
  const clean = base64.replace(/\s/g, "");
  const bytes = Buffer.from(clean, "base64");
  if (bytes.length === 0) throw new Error("Una página de la factura llegó vacía.");
  const mime = mimeType === "image/png" ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${clean}`;
}

export async function extractInvoiceWithAi(data: ExtractInvoiceInput, apiKey: string) {
  const content: Array<Record<string, unknown>> = [{
    type: "input_text",
    text: `Extrae toda la información contable de esta factura de compra (${data.fileName}). Las imágenes están en orden de página. Responde solo con un objeto JSON válido.`,
  }];

  if (data.text) {
    content.push({ type: "input_text", text: `Contenido XML/texto de la factura:\n${data.text.slice(0, 120000)}` });
  } else if (data.images?.length) {
    for (const image of data.images.slice(0, 8)) {
      content.push({ type: "input_image", image_url: normalizedImageUrl(image.mimeType, image.dataUrl) });
    }
  } else if (data.dataUrl && data.mimeType.startsWith("image/")) {
    content.push({ type: "input_image", image_url: normalizedImageUrl(data.mimeType, data.dataUrl) });
  } else if (data.mimeType === "application/pdf") {
    throw new Error("No fue posible preparar el PDF. Selecciónalo nuevamente para convertir sus páginas antes de leerlo.");
  } else {
    throw new Error("No se recibió contenido legible de la factura.");
  }

  const response = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "fetch" },
    body: JSON.stringify({
      model: "openai/gpt-5.6-sol",
      stream: true,
      instructions: SYSTEM,
      input: [{ role: "user", content }],
      text: { format: { type: "json_object" } },
    }),
  });

  if (response.status === 429) throw new Error("Límite de solicitudes de IA alcanzado. Intenta de nuevo en unos minutos.");
  if (response.status === 402) throw new Error("Créditos de IA agotados. Recarga créditos para seguir procesando facturas.");
  if (!response.ok || !response.body) {
    const detail = await response.text();
    console.error("AI gateway invoice extraction error", response.status, detail);
    throw new Error(`No fue posible leer la factura con IA (${response.status}): ${detail.slice(0, 500)}`);
  }

  const reader = response.body.getReader();
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
        const event = JSON.parse(payload) as { type?: string; delta?: string; response?: { output_text?: string } };
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") raw += event.delta;
        else if (event.type === "response.completed" && !raw && event.response?.output_text) raw = event.response.output_text;
      } catch {
        // Otros eventos SSE no contienen texto de salida.
      }
    }
  }

  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as ExtractedInvoice;
    parsed.lines = Array.isArray(parsed.lines) ? parsed.lines : [];
    return parsed;
  } catch {
    console.error("Respuesta IA de factura no parseable", raw.slice(0, 500));
    throw new Error("La IA no pudo estructurar esta factura. Intenta nuevamente o usa una imagen más nítida.");
  }
}