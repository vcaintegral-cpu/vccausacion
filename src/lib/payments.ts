// Recibos de pago de las cuentas por pagar.
//
// Este módulo es INDEPENDIENTE de la causación: no toca totales, impuestos,
// retenciones ni cuentas contables de la factura. Solo registra el pago
// posterior de la cuenta por pagar y su asiento (débito CxP / crédito caja-banco).

import { supabase } from "@/integrations/supabase/client";
import { roundCOP } from "@/lib/money";
import type { PucAccount } from "@/lib/puc-hierarchy";
import { evaluarCuenta } from "@/lib/puc-hierarchy";

export type MedioPago = "caja" | "banco" | "cheque" | "otro";

export const MEDIO_LABEL: Record<MedioPago, string> = {
  caja: "Caja",
  banco: "Banco",
  cheque: "Cheque",
  otro: "Otro",
};

export const MEDIOS: MedioPago[] = ["caja", "banco", "cheque", "otro"];

export type EstadoPago = "pendiente" | "parcial" | "pagada" | "error_pago";

export const ESTADO_PAGO_LABEL: Record<EstadoPago, string> = {
  pendiente: "Pago pendiente",
  parcial: "Pago parcial",
  pagada: "Pagada",
  error_pago: "Error de pago",
};

/** Configuración del recibo de pago de una factura (aún no generado). */
export type ConfigPago = {
  fecha: string;
  medio: MedioPago;
  cuenta: string;
  cuentaNombre?: string | null;
  cheque?: string;
  valor: number;
  observaciones?: string;
};

export type Recibo = {
  id: string;
  invoice_id: string;
  receipt_number: string;
  payment_date: string;
  method: string;
  account_code: string;
  account_name: string | null;
  amount: number;
  balance_after: number;
  check_number: string | null;
  notes: string | null;
  created_at: string;
};

/** Prefijos PUC por medio de pago. Caja 1105, bancos 1110/1120 (y cheques). */
const PREFIJOS: Record<MedioPago, string[] | null> = {
  caja: ["1105"],
  banco: ["1110", "1120"],
  cheque: ["1110", "1120"],
  otro: null,
};

/** Cuentas del PUC de la empresa habilitadas para el medio de pago elegido. */
export function cuentasDePago(puc: PucAccount[], medio: MedioPago): PucAccount[] {
  const prefijos = PREFIJOS[medio];
  return puc.filter((a) => {
    if (a.active === false) return false;
    if (!evaluarCuenta(puc, a.code).permiteMovimiento) return false;
    if (!prefijos) return true;
    return prefijos.some((p) => a.code.startsWith(p));
  });
}

/** Saldo pendiente de la cuenta por pagar de una factura. */
export function saldoPendiente(params: { cxp: number; pagado: number }): number {
  return Math.max(0, roundCOP(roundCOP(params.cxp) - roundCOP(params.pagado)));
}

export type ResultadoPago = { id: string; etiqueta: string; ok: boolean; omitida?: boolean; message: string };

/** Genera el recibo de pago de una factura. Nunca modifica la causación. */
export async function generarRecibo(params: {
  invoiceId: string;
  etiqueta: string;
  config: ConfigPago;
}): Promise<ResultadoPago> {
  const { config } = params;
  if (!config.cuenta) {
    return { id: params.invoiceId, etiqueta: params.etiqueta, ok: false, message: "Falta la cuenta de caja o banco del pago." };
  }
  if (config.medio === "cheque" && !String(config.cheque ?? "").trim()) {
    return { id: params.invoiceId, etiqueta: params.etiqueta, ok: false, message: "Indique el número del cheque." };
  }
  const { data, error } = await supabase.rpc("create_payment_receipt", {
    _invoice_id: params.invoiceId,
    _payment_date: config.fecha,
    _method: config.medio,
    _account_code: config.cuenta,
    _account_name: config.cuentaNombre ?? undefined,
    _amount: roundCOP(config.valor),
    _check_number: config.cheque ? config.cheque.trim() : undefined,
    _notes: config.observaciones ? config.observaciones.trim() : undefined,
  });
  if (error) return { id: params.invoiceId, etiqueta: params.etiqueta, ok: false, message: error.message };
  const res = (data ?? {}) as { ok?: boolean; code?: string; message?: string; receipt_number?: string; balance_after?: number };
  if (!res.ok) {
    return {
      id: params.invoiceId,
      etiqueta: params.etiqueta,
      ok: false,
      omitida: res.code === "PAGADA",
      message: res.message ?? "No fue posible generar el recibo de pago.",
    };
  }
  return {
    id: params.invoiceId,
    etiqueta: params.etiqueta,
    ok: true,
    message: `Recibo ${res.receipt_number} generado · saldo restante ${res.balance_after ?? 0}`,
  };
}

/** Recibos ya generados para un conjunto de facturas. */
export async function fetchRecibos(companyId: string, invoiceIds: string[]): Promise<Map<string, Recibo[]>> {
  const out = new Map<string, Recibo[]>();
  if (!companyId || invoiceIds.length === 0) return out;
  for (let i = 0; i < invoiceIds.length; i += 200) {
    const { data, error } = await supabase
      .from("payment_receipts")
      .select("id, invoice_id, receipt_number, payment_date, method, account_code, account_name, amount, balance_after, check_number, notes, created_at")
      .eq("company_id", companyId)
      .in("invoice_id", invoiceIds.slice(i, i + 200))
      .order("created_at", { ascending: false });
    if (error) throw error;
    for (const r of (data ?? []) as unknown as Recibo[]) {
      const list = out.get(r.invoice_id) ?? [];
      list.push(r);
      out.set(r.invoice_id, list);
    }
  }
  return out;
}

/**
 * Aprendizaje de pago por proveedor: sugiere el medio y la cuenta usados con
 * mayor frecuencia históricamente. Nunca modifica la causación y siempre es
 * modificable por el usuario.
 */
export async function sugerenciaPagoProveedor(
  companyId: string,
  nits: string[],
): Promise<Map<string, { medio: MedioPago; cuenta: string; cuentaNombre: string | null }>> {
  const out = new Map<string, { medio: MedioPago; cuenta: string; cuentaNombre: string | null }>();
  const limpios = [...new Set(nits.filter(Boolean))];
  if (!companyId || limpios.length === 0) return out;
  const { data, error } = await supabase
    .from("payment_receipts")
    .select("method, account_code, account_name, created_at, invoices!inner(provider_nit)")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return out;
  const conteo = new Map<string, { n: number; medio: MedioPago; cuenta: string; cuentaNombre: string | null; nit: string }>();
  for (const row of (data ?? []) as unknown as Array<{ method: string; account_code: string; account_name: string | null; invoices: { provider_nit: string | null } }>) {
    const nit = row.invoices?.provider_nit ?? "";
    if (!nit || !limpios.includes(nit)) continue;
    const key = `${nit}|${row.method}|${row.account_code}`;
    const prev = conteo.get(key);
    conteo.set(key, {
      n: (prev?.n ?? 0) + 1,
      medio: row.method as MedioPago,
      cuenta: row.account_code,
      cuentaNombre: row.account_name,
      nit,
    });
  }
  const mejores = new Map<string, number>();
  for (const v of conteo.values()) {
    if ((mejores.get(v.nit) ?? 0) >= v.n) continue;
    mejores.set(v.nit, v.n);
    out.set(v.nit, { medio: v.medio, cuenta: v.cuenta, cuentaNombre: v.cuentaNombre });
  }
  return out;
}
