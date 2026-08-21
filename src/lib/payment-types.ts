// Formas de pago sincronizadas desde Siigo.
//
// IMPORTANTE: la FORMA DE PAGO y la CUENTA POR PAGAR (CxP) son conceptos
// independientes. Cambiar la forma de pago NUNCA cambia la cuenta CxP de la
// causación, y cambiar la cuenta CxP NUNCA cambia la forma de pago enviada a
// Siigo. Aquí solo se leen y clasifican las formas de pago reales de la empresa;
// jamás se inventan opciones.
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

export type MetodoPago = "contado" | "credito";

export const METODO_LABEL: Record<MetodoPago, string> = {
  contado: "Contado",
  credito: "Crédito",
};

export type FormaPago = {
  id: string;
  siigo_id: string;
  name: string;
  method: MetodoPago;
  type: string | null;
  account_code: string | null;
  account_name: string | null;
  active: boolean;
  due_date_required: boolean;
};

const norm = (v: string | null | undefined) =>
  String(v ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/** Deduce el método (contado/crédito) a partir del nombre o tipo de la forma de pago. */
export function metodoDeFormaPago(nombre: string | null | undefined, tipo?: string | null): MetodoPago {
  const texto = `${norm(nombre)} ${norm(tipo)}`;
  if (/contado|efectivo|caja|inmediat|cash/.test(texto)) return "contado";
  if (/credito|cartera|dias|plazo|cuota/.test(texto)) return "credito";
  return "credito";
}

/** ¿La forma de pago exige fecha de vencimiento? Solo el crédito la requiere. */
export const exigeVencimiento = (forma: FormaPago | null | undefined) =>
  !!forma && (forma.due_date_required || forma.method === "credito");

/** Formas de pago activas de la empresa, tal como fueron sincronizadas desde Siigo. */
export async function fetchPaymentTypes(companyId: string): Promise<FormaPago[]> {
  const { data, error } = await supabase
    .from("siigo_payment_types")
    .select("id, siigo_id, name, method, type, account_code, account_name, active, due_date_required")
    .eq("company_id", companyId)
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id,
    siigo_id: String(r.siigo_id),
    name: r.name,
    method: (r.method === "contado" ? "contado" : "credito") as MetodoPago,
    type: r.type ?? null,
    account_code: r.account_code ?? null,
    account_name: r.account_name ?? null,
    active: r.active !== false,
    due_date_required: !!r.due_date_required,
  }));
}

export function usePaymentTypes(companyId: string | null | undefined) {
  return useQuery({
    queryKey: ["siigo-payment-types", companyId],
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchPaymentTypes(companyId!),
  });
}

export type PagoFactura = {
  payment_method: string | null;
  payment_type_id: string | null;
  payment_type_name: string | null;
  payment_form: string | null;
  due_date?: string | null;
};

/** Validación previa a Siigo de la forma de pago seleccionada por el usuario. */
export function validarFormaPago(
  inv: PagoFactura,
  formas: FormaPago[],
): { ok: boolean; message: string | null; forma: FormaPago | null } {
  const id = String(inv.payment_type_id ?? "").trim();
  if (!id)
    return {
      ok: false,
      forma: null,
      message: "La factura no puede enviarse a Siigo porque falta completar la forma de pago.",
    };
  const forma = formas.find((f) => f.siigo_id === id) ?? null;
  if (!forma)
    return {
      ok: false,
      forma: null,
      message: "La forma de pago seleccionada ya no existe en Siigo. Sincroniza las formas de pago y vuelve a elegirla.",
    };
  if (!forma.active)
    return { ok: false, forma, message: `La forma de pago "${forma.name}" está inactiva en Siigo.` };
  const metodo = (inv.payment_method === "contado" ? "contado" : "credito") as MetodoPago;
  if (metodo !== forma.method)
    return {
      ok: false,
      forma,
      message: `El método de pago (${METODO_LABEL[metodo]}) no corresponde con la forma de pago "${forma.name}".`,
    };
  if (metodo === "credito" && exigeVencimiento(forma) && !String(inv.due_date ?? "").trim())
    return { ok: false, forma, message: "La forma de pago a crédito requiere una fecha de vencimiento válida." };
  return { ok: true, forma, message: null };
}
