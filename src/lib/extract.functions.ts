import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ExtractInvoiceInput } from "./extract.server";

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

export const extractInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: ExtractInvoiceInput) => {
    if (!data?.fileName) throw new Error("Archivo requerido");
    return data;
  })
  .handler(async ({ data }) => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("Falta la configuración de IA (LOVABLE_API_KEY)");
    const { extractInvoiceWithAi } = await import("./extract.server");
    return extractInvoiceWithAi(data, apiKey);
  });