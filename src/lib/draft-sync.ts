// SINCRONIZACIÓN CONTABLE ENTRE BORRADORES DEL MISMO PROVEEDOR.
//
// Reglas del módulo:
//  - Solo sincroniza CONFIGURACIÓN CONTABLE (cuentas y centro de costo).
//    Nunca toca valores monetarios, fechas, números, proveedor ni NIT.
//  - Identifica al proveedor por empresa + NIT normalizado, nunca por nombre.
//  - Solo alcanza facturas en estado BORRADOR (sin comprobante ni Siigo).
//  - Sincroniza únicamente los campos que el usuario cambió realmente.
//  - Toda la escritura masiva ocurre en una sola operación del servidor
//    (`sync_provider_drafts`), que valida, registra historial y es idempotente.
import { supabase } from "@/integrations/supabase/client";
import { FIELD_LABEL } from "@/lib/learning-rules";

export type SyncKind =
  | "gasto"
  | "iva"
  | "retefuente"
  | "reteiva"
  | "reteica"
  | "otras"
  | "payable"
  | "cost_center";

export const SYNC_LABEL: Record<SyncKind, string> = {
  gasto: "Cuenta de gasto/costo",
  iva: "Cuenta de IVA",
  retefuente: "Cuenta de Retefuente",
  reteiva: "Cuenta de ReteIVA",
  reteica: "Cuenta de ReteICA",
  otras: "Cuenta de otras retenciones",
  payable: "Cuenta por pagar",
  cost_center: "Centro de costo",
};

export type SyncChange = {
  kind: SyncKind;
  label: string;
  old: string;
  new: string;
  /** Nombre de la cuenta nueva, informativo. */
  name?: string | null;
};

/** Configuración contable de una factura: lo único que puede sincronizarse. */
export type DraftSnapshot = {
  gastos: string[];
  iva: string[];
  retefuente: string[];
  reteiva: string[];
  reteica: string[];
  otras: string[];
  payable: string[];
  cost_center: string[];
};

const empty = (): DraftSnapshot => ({
  gastos: [], iva: [], retefuente: [], reteiva: [], reteica: [], otras: [], payable: [], cost_center: [],
});

const clean = (v: unknown) => String(v ?? "").trim();
const push = (list: string[], v: unknown) => {
  const s = clean(v);
  if (s && !list.includes(s)) list.push(s);
};

/** NIT comparable: sin dígito de verificación ni separadores. */
export const nitNormalizado = (nit?: string | null) => clean(nit).split("-")[0]!.replace(/\D/g, "");

type LineaSnapshot = {
  account_code?: string | null;
  iva_account_code?: string | null;
  iva_operational_account?: string | null;
  ret_account_code?: string | null;
  ret_operational_account?: string | null;
  ret_tax_kind?: string | null;
};

/** Lee de la base la configuración contable actual de un borrador. */
export async function fetchDraftSnapshot(invoiceId: string): Promise<DraftSnapshot> {
  const out = empty();
  const [inv, lines] = await Promise.all([
    supabase.from("invoices").select("payable_account, cost_center").eq("id", invoiceId).maybeSingle(),
    supabase
      .from("invoice_lines")
      .select("account_code, iva_account_code, iva_operational_account, ret_account_code, ret_operational_account, ret_tax_kind")
      .eq("invoice_id", invoiceId)
      .order("position"),
  ]);
  const cabecera = (inv.data ?? null) as { payable_account?: string | null; cost_center?: string | null } | null;
  push(out.payable, cabecera?.payable_account);
  push(out.cost_center, cabecera?.cost_center);
  for (const l of ((lines.data ?? []) as unknown as LineaSnapshot[])) {
    push(out.gastos, l.account_code);
    push(out.iva, l.iva_operational_account || l.iva_account_code);
    const cuentaRet = l.ret_operational_account || l.ret_account_code;
    const kind = clean(l.ret_tax_kind).toLowerCase();
    if (kind === "retefuente") push(out.retefuente, cuentaRet);
    else if (kind === "reteiva") push(out.reteiva, cuentaRet);
    else if (kind === "reteica") push(out.reteica, cuentaRet);
    else push(out.otras, cuentaRet);
  }
  return out;
}

/** Empareja lo retirado con lo agregado: así se detecta "513595 → 513505". */
function cambiosDeCampo(kind: SyncKind, antes: string[], despues: string[]): SyncChange[] {
  const quitados = antes.filter((c) => !despues.includes(c));
  const agregados = despues.filter((c) => !antes.includes(c));
  const out: SyncChange[] = [];
  for (let i = 0; i < Math.min(quitados.length, agregados.length); i += 1) {
    out.push({ kind, label: SYNC_LABEL[kind], old: quitados[i]!, new: agregados[i]! });
  }
  return out;
}

/** Campos de configuración contable que el usuario cambió realmente. */
export function diffSnapshots(antes: DraftSnapshot, despues: DraftSnapshot): SyncChange[] {
  const kinds: [SyncKind, keyof DraftSnapshot][] = [
    ["gasto", "gastos"],
    ["iva", "iva"],
    ["retefuente", "retefuente"],
    ["reteiva", "reteiva"],
    ["reteica", "reteica"],
    ["otras", "otras"],
    ["payable", "payable"],
    ["cost_center", "cost_center"],
  ];
  const out: SyncChange[] = [];
  for (const [kind, key] of kinds) out.push(...cambiosDeCampo(kind, antes[key], despues[key]));
  return out;
}

export type BorradorRelacionado = { id: string; label: string; updated_at: string };

/**
 * Otros borradores del MISMO proveedor dentro de la MISMA empresa.
 * Nunca incluye facturas aprobadas, causadas, sincronizadas ni históricas.
 */
export async function fetchBorradoresDelProveedor(params: {
  companyId: string;
  providerNit?: string | null;
  excludeInvoiceId: string;
}): Promise<BorradorRelacionado[]> {
  const nit = nitNormalizado(params.providerNit);
  if (!nit) return [];
  const { data, error } = await supabase
    .from("invoices")
    .select("id, prefix, number, provider_nit, status, siigo_status, siigo_id, voucher_number, updated_at")
    .eq("company_id", params.companyId)
    .eq("status", "borrador")
    .is("voucher_number", null)
    .is("siigo_id", null);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as Record<string, unknown>[])
    .filter((r) => String(r["id"]) !== params.excludeInvoiceId)
    .filter((r) => String(r["siigo_status"] ?? "") !== "sincronizada")
    .filter((r) => nitNormalizado(r["provider_nit"] as string | null) === nit)
    .map((r) => ({
      id: String(r["id"]),
      label: [r["prefix"], r["number"]].filter(Boolean).join("-") || "Sin número",
      updated_at: String(r["updated_at"] ?? ""),
    }));
}

export type SyncResultado = {
  ok: boolean;
  already?: boolean;
  event_id?: string;
  updated?: number;
  conflicts?: { invoice_id: string; label: string; message: string }[];
  message?: string;
};

const rpc = (fn: string, args: Record<string, unknown>) =>
  (supabase.rpc.bind(supabase) as unknown as (
    name: string,
    params: Record<string, unknown>,
  ) => PromiseLike<{ data: SyncResultado | null; error: { message: string } | null }>)(fn, args);

/** Aplica la sincronización en el servidor: una sola llamada para todos los borradores. */
export async function aplicarSincronizacion(params: {
  sourceInvoiceId: string;
  changes: SyncChange[];
  known: BorradorRelacionado[];
  eventKey: string;
}): Promise<SyncResultado> {
  const { data, error } = await rpc("sync_provider_drafts", {
    _source_invoice_id: params.sourceInvoiceId,
    _changes: params.changes.map((c) => ({ kind: c.kind, old: c.old, new: c.new, name: c.name ?? null })),
    _event_key: params.eventKey,
    _known: params.known.map((k) => ({ id: k.id, updated_at: k.updated_at })),
  });
  if (error) return { ok: false, message: error.message };
  return data ?? { ok: false, message: "Sin respuesta del servidor." };
}

/** Deshace una sincronización restaurando solo lo que ella cambió. */
export async function deshacerSincronizacion(eventId: string): Promise<SyncResultado & { restored?: number }> {
  const { data, error } = await rpc("undo_provider_draft_sync", { _event_id: eventId });
  if (error) return { ok: false, message: error.message };
  return (data as (SyncResultado & { restored?: number }) | null) ?? { ok: false, message: "Sin respuesta del servidor." };
}

export type SyncEvento = {
  id: string;
  provider_nit: string | null;
  provider_name: string | null;
  source_label: string | null;
  action: string;
  changes: SyncChange[];
  affected: { invoice_id: string; label: string }[];
  conflicts: { label: string; message: string }[];
  invoice_count: number;
  result: string | null;
  undone_at: string | null;
  created_at: string;
  created_by: string | null;
};

/** Historial de sincronizaciones de la empresa. */
export async function fetchSyncHistory(companyId: string, limit = 50): Promise<SyncEvento[]> {
  const { data, error } = await supabase
    .from("draft_sync_events" as never)
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as SyncEvento[];
}

// ---------------------------------------------------------------------------
// Aprendizaje contable: la decisión manual confirmada se vuelve regla del proveedor
// ---------------------------------------------------------------------------

/** Campo de `learning_rules` que memoriza cada tipo de cuenta sincronizada. */
const CAMPO_REGLA: Partial<Record<SyncKind, string>> = {
  gasto: "account_code",
  iva: "iva_account",
  retefuente: "retefuente_account",
  reteiva: "reteiva_account",
  reteica: "reteica_account",
  otras: "otras_account",
  payable: "payable_account",
  cost_center: "cost_center",
};

/**
 * Registra la decisión manual como regla del proveedor. Nunca borra reglas
 * existentes: solo actualiza el campo que el usuario cambió, y siempre queda
 * por debajo de una modificación manual posterior.
 */
export async function aprenderDeSincronizacion(params: {
  companyId: string;
  providerNit?: string | null;
  providerName?: string | null;
  invoiceId: string;
  userId: string | null;
  changes: SyncChange[];
}): Promise<void> {
  const nit = clean(params.providerNit);
  if (!params.companyId || !nit || !params.userId || params.changes.length === 0) return;

  const { data } = await supabase
    .from("learning_rules")
    .select("*")
    .eq("company_id", params.companyId)
    .eq("provider_nit", nit);
  const reglas = (data ?? []) as unknown as Record<string, unknown>[];
  if (reglas.length === 0) return; // el aprendizaje base se crea al aprobar la causación

  for (const regla of reglas) {
    const update: Record<string, unknown> = {};
    const historial: { field: string; old: string | null; next: string }[] = [];
    for (const c of params.changes) {
      const campo = CAMPO_REGLA[c.kind];
      if (!campo) continue;
      const actual = clean(regla[campo]);
      // Solo se corrige la regla que realmente usaba la cuenta anterior.
      if (actual !== c.old) continue;
      update[campo] = c.new;
      historial.push({ field: campo, old: actual || null, next: c.new });
    }
    if (historial.length === 0) continue;
    update["updated_by"] = params.userId;
    update["provider_name"] = regla["provider_name"] ?? params.providerName ?? null;
    await supabase.from("learning_rules").update(update as never).eq("id", String(regla["id"]));
    await supabase.from("learning_rule_changes").insert(
      historial.map((h) => ({
        company_id: params.companyId,
        rule_id: String(regla["id"]),
        invoice_id: params.invoiceId,
        field: h.field,
        field_label: FIELD_LABEL[h.field] ?? h.field,
        old_value: h.old,
        new_value: h.next,
        changed_by: params.userId,
      })) as never,
    );
  }
}
