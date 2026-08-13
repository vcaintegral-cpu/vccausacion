// Revisión masiva de borradores: lee la recomendación REAL almacenada por el motor
// de causación (journal_lines) y ejecuta aprobación y causación por factura,
// sin crear una segunda lógica contable.
import { supabase } from "@/integrations/supabase/client";
import { findExistingInvoice } from "@/lib/invoice-duplicates";

export type DraftInvoice = {
  id: string;
  company_id: string;
  prefix: string | null;
  number: string | null;
  issue_date: string | null;
  provider_nit: string | null;
  provider_name: string | null;
  cufe: string | null;
  cost_center: string | null;
  subtotal: number;
  iva: number;
  retefuente: number;
  reteiva: number;
  reteica: number;
  total: number;
  status: string;
  siigo_status: string;
  siigo_id: string | null;
  siigo_number: string | null;
  siigo_error: string | null;
  voucher_number: string | null;
  posted_at: string | null;
  approved_at: string | null;
  processing_at: string | null;
  posting_error: string | null;
  file_path: string | null;
  file_name: string | null;
};

export type JournalRow = {
  invoice_id: string;
  account_code: string;
  account_name: string | null;
  debit: number;
  credit: number;
  cost_center: string | null;
};

export type Cuenta = { code: string; name: string | null };

export type DraftAccounts = {
  gasto: Cuenta | null;
  iva: Cuenta | null;
  payable: Cuenta | null;
  retenciones: Cuenta[];
  costCenter: string | null;
  debit: number;
  credit: number;
  lines: number;
};

const RET_PREFIX = ["2365", "2367", "2368"];
const esRetencion = (c: string) => RET_PREFIX.some((p) => c.startsWith(p));
const esIva = (c: string) => c.startsWith("24") && !esRetencion(c);
const esPasivo = (c: string) => (c.startsWith("22") || c.startsWith("23")) && !esRetencion(c);

/** Clasifica el comprobante ya almacenado en cuentas de gasto/costo, IVA y por pagar. */
export function classifyJournal(rows: JournalRow[]): DraftAccounts {
  const out: DraftAccounts = {
    gasto: null, iva: null, payable: null, retenciones: [],
    costCenter: null, debit: 0, credit: 0, lines: rows.length,
  };
  let mayorGasto = -1;
  let mayorPasivo = -1;
  let mayorIva = -1;
  for (const r of rows) {
    const code = String(r.account_code ?? "").trim();
    const debit = Number(r.debit || 0);
    const credit = Number(r.credit || 0);
    out.debit += debit;
    out.credit += credit;
    if (!out.costCenter && r.cost_center) out.costCenter = r.cost_center;
    if (esRetencion(code)) {
      if (!out.retenciones.some((x) => x.code === code)) out.retenciones.push({ code, name: r.account_name });
      continue;
    }
    if (debit > 0 && esIva(code)) {
      if (debit > mayorIva) { mayorIva = debit; out.iva = { code, name: r.account_name }; }
      continue;
    }
    if (credit > 0 && esPasivo(code)) {
      if (credit > mayorPasivo) { mayorPasivo = credit; out.payable = { code, name: r.account_name }; }
      continue;
    }
    if (debit > 0) {
      if (debit > mayorGasto) { mayorGasto = debit; out.gasto = { code, name: r.account_name }; }
    }
  }
  return out;
}

export type Alerta = { level: "ok" | "warn" | "error"; message: string };

/** Alertas visuales; no modifican la causación, solo indican qué revisar con el lápiz. */
export function alertasBorrador(inv: DraftInvoice, acc: DraftAccounts | undefined, pucCodes: Set<string>): Alerta[] {
  const a: Alerta[] = [];
  if (!acc || acc.lines === 0) { a.push({ level: "error", message: "Sin comprobante contable generado." }); return a; }
  if (!inv.provider_nit) a.push({ level: "error", message: "Proveedor sin NIT." });
  if (!inv.number) a.push({ level: "error", message: "Sin número de factura." });
  if (!inv.issue_date) a.push({ level: "error", message: "Sin fecha de factura." });
  if (Number(inv.total || 0) <= 0) a.push({ level: "error", message: "Valor total inválido." });
  if (!acc.gasto) a.push({ level: "error", message: "Cuenta de gasto/costo faltante." });
  else if (pucCodes.size && !pucCodes.has(acc.gasto.code)) a.push({ level: "error", message: `Cuenta ${acc.gasto.code} no existe en el PUC.` });
  if (Number(inv.iva || 0) > 0) {
    if (!acc.iva) a.push({ level: "error", message: "IVA sin cuenta." });
    else if (pucCodes.size && !pucCodes.has(acc.iva.code)) a.push({ level: "error", message: `Cuenta de IVA ${acc.iva.code} no existe en el PUC.` });
  }
  if (!acc.payable) a.push({ level: "error", message: "Proveedor sin cuenta por pagar." });
  else if (pucCodes.size && !pucCodes.has(acc.payable.code)) a.push({ level: "error", message: `Cuenta por pagar ${acc.payable.code} no existe en el PUC.` });
  if (Math.abs(acc.debit - acc.credit) > 1) a.push({ level: "error", message: "Débitos y créditos no cuadran." });
  if (inv.processing_at) a.push({ level: "warn", message: "La factura está siendo procesada." });
  if (inv.posting_error) a.push({ level: "warn", message: inv.posting_error });
  if (a.length === 0) a.push({ level: "ok", message: "Recomendación completa." });
  return a;
}

export type ResultadoFactura = { id: string; etiqueta: string; ok: boolean; message: string };

/** Valida y aprueba una factura. Nunca bloquea a las demás del lote. */
export async function aprobarBorrador(
  inv: DraftInvoice,
  acc: DraftAccounts | undefined,
  pucCodes: Set<string>,
  etiqueta: string,
  userId: string | null,
): Promise<ResultadoFactura> {
  const fallas = alertasBorrador(inv, acc, pucCodes).filter((x) => x.level === "error");
  if (inv.status !== "borrador" && inv.status !== "error")
    return { id: inv.id, etiqueta, ok: false, message: "La factura ya no está en borrador." };
  if (inv.processing_at) return { id: inv.id, etiqueta, ok: false, message: "La factura está siendo procesada." };
  if (fallas.length) return { id: inv.id, etiqueta, ok: false, message: fallas[0]!.message };

  const dup = await findExistingInvoice(
    inv.company_id,
    { cufe: inv.cufe, provider_nit: inv.provider_nit, prefix: inv.prefix, number: inv.number },
    inv.id,
  );
  if (dup && (dup.status === "aprobado" || dup.status === "causada" || dup.siigo_status === "sincronizada"))
    return { id: inv.id, etiqueta, ok: false, message: "Posible factura duplicada: ya existe una causación para el mismo proveedor y número." };

  const { data, error } = await supabase
    .from("invoices")
    .update({
      status: "aprobado",
      siigo_status: "pendiente",
      siigo_error: null,
      posting_error: null,
      approved_at: new Date().toISOString(),
      approved_by: userId,
    } as never)
    .eq("id", inv.id)
    .in("status", ["borrador", "error"])
    .neq("siigo_status", "sincronizada")
    .select("id");
  if (error) return { id: inv.id, etiqueta, ok: false, message: error.message };
  if (!data?.length) return { id: inv.id, etiqueta, ok: false, message: "La factura cambió de estado durante el proceso." };
  return { id: inv.id, etiqueta, ok: true, message: "Aprobada." };
}

type PostResult = { ok: boolean; already?: boolean; voucher_number?: string | null; message?: string; code?: string };

/**
 * Causa UNA factura generando su propio comprobante y consecutivo.
 * La función de base de datos valida duplicados y es idempotente.
 */
export async function causarFactura(inv: DraftInvoice, etiqueta: string): Promise<ResultadoFactura> {
  if (inv.voucher_number)
    return { id: inv.id, etiqueta, ok: true, message: `Factura ya causada. Comprobante ${inv.voucher_number}.` };
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: PostResult | null; error: { message: string } | null }>;
  const { data, error } = await rpc("post_invoice", { _invoice_id: inv.id });
  if (error) return { id: inv.id, etiqueta, ok: false, message: error.message };
  const res = data ?? { ok: false, message: "Sin respuesta del servidor." };
  if (!res.ok) return { id: inv.id, etiqueta, ok: false, message: res.message ?? "No fue posible causar la factura." };
  return {
    id: inv.id,
    etiqueta,
    ok: true,
    message: res.already ? `Factura ya causada. Comprobante ${res.voucher_number}.` : `Comprobante ${res.voucher_number}.`,
  };
}
