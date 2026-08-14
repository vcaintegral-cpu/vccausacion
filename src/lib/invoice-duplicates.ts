import { supabase } from "@/integrations/supabase/client";

export type DuplicateInvoice = {
  id: string;
  prefix: string | null;
  number: string | null;
  issue_date: string | null;
  provider_nit: string | null;
  provider_name: string | null;
  cufe: string | null;
  total: number;
  status: string;
  siigo_status: string;
  siigo_number: string | null;
  siigo_synced_at: string | null;
};

const COLS =
  "id, prefix, number, issue_date, provider_nit, provider_name, cufe, total, status, siigo_status, siigo_number, siigo_synced_at";

export type InvoiceKey = {
  cufe?: string | null;
  provider_nit?: string | null;
  prefix?: string | null;
  number?: string | null;
};

/**
 * Busca una factura ya registrada en la misma empresa.
 * Prioridad 1: CUFE. Prioridad 2: NIT + prefijo + número.
 */
export async function findExistingInvoice(
  companyId: string,
  key: InvoiceKey,
  excludeId?: string | null,
): Promise<DuplicateInvoice | null> {
  const cufe = (key.cufe ?? "").trim();
  if (cufe) {
    let q = supabase.from("invoices").select(COLS).eq("company_id", companyId).eq("cufe", cufe);
    if (excludeId) q = q.neq("id", excludeId);
    const { data } = await q.limit(1).maybeSingle();
    if (data) return data as DuplicateInvoice;
  }
  const nit = (key.provider_nit ?? "").trim();
  const numero = (key.number ?? "").trim();
  if (!nit || !numero) return null;
  let q = supabase
    .from("invoices")
    .select(COLS)
    .eq("company_id", companyId)
    .eq("provider_nit", nit)
    .eq("number", numero);
  const prefix = (key.prefix ?? "").trim();
  q = prefix ? q.eq("prefix", prefix) : q.or("prefix.is.null,prefix.eq.");
  if (excludeId) q = q.neq("id", excludeId);
  const { data } = await q.limit(1).maybeSingle();
  return (data as DuplicateInvoice | null) ?? null;
}

/**
 * Flujo obligatorio: BORRADOR → APROBADO → CAUSADO → SINCRONIZADO → HISTÓRICO.
 * El estado histórico ("sincronizada") SOLO se asigna cuando Siigo confirmó el documento.
 */
export type EstadoFactura =
  | "borrador"
  | "aprobado"
  | "causada"
  | "sincronizando"
  | "sincronizada"
  | "error_siigo"
  | "error";

/** Estado único de la factura, derivado del estado interno y del estado en Siigo. */
export function estadoUnico(inv: { status: string; siigo_status?: string | null }): EstadoFactura {
  // Histórico: confirmación real de Siigo.
  if (inv.siigo_status === "sincronizada" || inv.status === "sincronizada" || inv.status === "historico")
    return "sincronizada";
  // Envío en curso: no permite reintentos ni acciones simultáneas.
  if (inv.siigo_status === "sincronizando") return "sincronizando";
  // Siigo rechazó el documento: la factura sigue causada y puede reintentarse.
  if (inv.siigo_status === "error") return "error_siigo";
  // Causada = comprobante contable generado, pendiente de enviar a Siigo.
  if (inv.status === "causada") return "causada";
  // Una factura re-aprobada tras corregirla vuelve a estar "Aprobada" aunque conserve
  // el rastro de un envío fallido anterior.
  if (inv.status === "aprobado") return "aprobado";
  if (inv.status === "error") return "error";
  return "borrador";
}

export const ESTADO_LABEL: Record<string, string> = {
  borrador: "Borrador",
  aprobado: "Aprobada",
  causada: "Causada",
  sincronizando: "Sincronizando",
  sincronizada: "Histórico",
  error_siigo: "Error Siigo",
  error: "Error de causación",
};

/** Orden del flujo, para ordenar y comparar etapas. */
export const ORDEN_ESTADO: Record<string, number> = {
  borrador: 0,
  error: 0,
  aprobado: 1,
  causada: 2,
  error_siigo: 2,
  sincronizando: 3,
  sincronizada: 4,
};

/** Mensaje para el usuario cuando la factura ya existe en la empresa. */
export function mensajeDuplicado(inv: DuplicateInvoice): string {
  const estado = estadoUnico(inv);
  if (estado === "sincronizada") return "Esta factura ya fue causada y sincronizada con Siigo. No se puede volver a causar.";
  if (estado === "causada" || estado === "sincronizando") return "Esta factura ya fue causada y está pendiente de sincronizar con Siigo.";
  if (estado === "aprobado") return "Esta factura ya fue aprobada y está pendiente de sincronización.";
  if (estado === "error_siigo") return "Esta factura ya existe y su último envío a Siigo terminó con error.";
  return "Esta factura ya tiene un borrador.";
}
