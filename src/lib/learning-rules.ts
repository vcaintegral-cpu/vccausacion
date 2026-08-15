// Motor de REGLAS CONTABLES aprendidas.
//
// Una regla ya no guarda solo "proveedor + concepto -> cuenta de gasto": guarda
// toda la estructura contable aprobada por el usuario (tipo de ítem, cuenta de
// gasto/costo, centro de costo, IVA y su tratamiento, Retefuente, ReteIVA,
// ReteICA, otras retenciones, cuenta por pagar y forma de pago).
//
// Principios:
//  - SIEMPRE por empresa: una regla nunca se comparte entre empresas.
//  - Solo se aprende de una causación APROBADA (nunca de una sugerencia).
//  - Nunca se pregunta: si el aprendizaje automático está activo, se guarda.
//  - Nunca se borra información válida: solo se actualiza el campo que cambió.
//  - Nunca se duplica: misma empresa + proveedor + concepto + tipo => se actualiza.
import { supabase } from "@/integrations/supabase/client";
import { normalizeItemType } from "@/lib/item-type";
import type { RetBlocks, RetencionKind } from "@/lib/retenciones-multi";

export type Confianza = "ALTA" | "MEDIA" | "BAJA";

/** La confianza crece con el uso consistente de la regla. */
export function confianzaRegla(timesUsed?: number | null): Confianza {
  const n = Number(timesUsed ?? 0);
  if (n >= 5) return "ALTA";
  if (n >= 3) return "MEDIA";
  return "BAJA";
}

export const CONFIANZA_LABEL: Record<Confianza, string> = { ALTA: "Alta", MEDIA: "Media", BAJA: "Baja" };

/** Estructura contable completa que puede memorizar una regla. */
export type RuleShape = {
  id: string;
  company_id: string;
  provider_nit: string | null;
  provider_name: string | null;
  concept: string | null;
  item_type: string;
  account_code: string;
  account_name: string | null;
  cost_center: string | null;
  iva: number;
  iva_aplica: boolean;
  iva_rate: number | null;
  iva_treatment: string | null;
  iva_account: string | null;
  retefuente_aplica: boolean;
  retefuente_rate: number | null;
  retefuente_account: string | null;
  reteiva_aplica: boolean;
  reteiva_rate: number | null;
  reteiva_account: string | null;
  reteica_aplica: boolean;
  reteica_rate: number | null;
  reteica_account: string | null;
  otras_aplica: boolean;
  otras_rate: number | null;
  otras_account: string | null;
  payable_account: string | null;
  payment_form: string | null;
  active: boolean;
  times_used: number;
  source?: string | null;
  created_at?: string;
  updated_at?: string;
  last_used_at?: string | null;
};

export type RuleChange = {
  id: string;
  rule_id: string;
  field: string;
  field_label: string | null;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  created_at: string;
};

/** Etiquetas legibles de cada campo aprendido (para el historial de cambios). */
export const FIELD_LABEL: Record<string, string> = {
  account_code: "Cuenta gasto/costo",
  account_name: "Nombre de la cuenta",
  item_type: "Tipo de ítem",
  cost_center: "Centro de costo",
  iva: "IVA %",
  iva_aplica: "Aplica IVA",
  iva_rate: "Tarifa IVA",
  iva_treatment: "Tratamiento IVA",
  iva_account: "Cuenta IVA",
  retefuente_aplica: "Aplica Retefuente",
  retefuente_rate: "Tarifa Retefuente",
  retefuente_account: "Cuenta Retefuente",
  reteiva_aplica: "Aplica ReteIVA",
  reteiva_rate: "Tarifa ReteIVA",
  reteiva_account: "Cuenta ReteIVA",
  reteica_aplica: "Aplica ReteICA",
  reteica_rate: "Tarifa ReteICA",
  reteica_account: "Cuenta ReteICA",
  otras_aplica: "Aplica otras retenciones",
  otras_rate: "Tarifa otras retenciones",
  otras_account: "Cuenta otras retenciones",
  payable_account: "Cuenta por pagar",
  payment_form: "Forma de pago",
  provider_name: "Proveedor",
};

const norm = (s?: string | null) =>
  (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

const tokens = (s?: string | null) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length > 3);

function similar(a?: string | null, b?: string | null) {
  const ta = tokens(a);
  const tb = new Set(tokens(b));
  if (ta.length === 0) return 0;
  return ta.filter((t) => tb.has(t)).length / ta.length;
}

const txt = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const vacio = (v: unknown) => txt(v).trim() === "";

// ---------------------------------------------------------------------------
// Consulta de reglas (prioridad de niveles)
// ---------------------------------------------------------------------------

export type RuleMatch = {
  rule: RuleShape;
  /** 1 = proveedor + concepto + tipo + impuestos ... 4 = solo proveedor. */
  level: 1 | 2 | 3 | 4;
  confidence: Confianza;
  reason: string;
};

export type MatchInput = {
  providerNit?: string | null;
  concept?: string | null;
  itemType?: string | null;
  /** Retenciones que reporta el documento actual; refina el nivel 1. */
  retenciones?: Partial<Record<RetencionKind, boolean>>;
};

const mismasRetenciones = (r: RuleShape, ret?: Partial<Record<RetencionKind, boolean>>) =>
  !!ret &&
  r.retefuente_aplica === !!ret.retefuente &&
  r.reteiva_aplica === !!ret.reteiva &&
  r.reteica_aplica === !!ret.reteica;

/** Regla activa más reciente y consistente entre varias candidatas. */
const mejor = (rules: RuleShape[]) =>
  [...rules].sort(
    (a, b) =>
      b.times_used - a.times_used ||
      (b.updated_at ?? b.created_at ?? "").localeCompare(a.updated_at ?? a.created_at ?? ""),
  )[0];

/**
 * Busca la mejor regla aprendida siguiendo la prioridad exigida:
 * 1) proveedor + concepto + tipo + retenciones, 2) proveedor + concepto + tipo,
 * 3) proveedor + concepto, 4) proveedor.
 */
export function buscarRegla(rules: RuleShape[], input: MatchInput): RuleMatch | null {
  const nit = norm(input.providerNit);
  if (!nit) return null;
  const tipo = input.itemType ? normalizeItemType(input.itemType) : null;
  const activas = rules.filter((r) => r.active && norm(r.provider_nit) === nit);
  if (activas.length === 0) return null;

  const conConcepto = activas.filter((r) => similar(input.concept, r.concept) >= 0.5);
  const mismoTipo = conConcepto.filter((r) => !tipo || normalizeItemType(r.item_type) === tipo);

  const n1 = mejor(mismoTipo.filter((r) => mismasRetenciones(r, input.retenciones)));
  if (n1)
    return {
      rule: n1,
      level: 1,
      confidence: confianzaRegla(n1.times_used),
      reason: `Regla aprendida para este proveedor, concepto, tipo de ítem y la misma combinación de retenciones (usada ${n1.times_used} vez/veces).`,
    };
  const n2 = mejor(mismoTipo);
  if (n2)
    return {
      rule: n2,
      level: 2,
      confidence: confianzaRegla(n2.times_used),
      reason: `Regla aprendida para este proveedor, concepto y tipo de ítem (usada ${n2.times_used} vez/veces).`,
    };
  const n3 = mejor(conConcepto);
  if (n3)
    return {
      rule: n3,
      level: 3,
      confidence: confianzaRegla(n3.times_used),
      reason: `Regla aprendida para este proveedor y un concepto similar (usada ${n3.times_used} vez/veces).`,
    };
  const n4 = mejor(activas);
  if (n4)
    return {
      rule: n4,
      level: 4,
      confidence: confianzaRegla(n4.times_used),
      reason: `Regla aprendida para este proveedor (usada ${n4.times_used} vez/veces).`,
    };
  return null;
}

/** Todas las reglas de la empresa (activas o no) para el panel y el motor. */
export async function fetchCompanyRules(companyId: string): Promise<RuleShape[]> {
  const { data, error } = await supabase
    .from("learning_rules")
    .select("*")
    .eq("company_id", companyId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as RuleShape[];
}

export async function fetchRuleChanges(ruleId: string): Promise<RuleChange[]> {
  const { data, error } = await supabase
    .from("learning_rule_changes")
    .select("id, rule_id, field, field_label, old_value, new_value, changed_by, created_at")
    .eq("rule_id", ruleId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as RuleChange[];
}

// ---------------------------------------------------------------------------
// Aprendizaje automático desde una causación aprobada
// ---------------------------------------------------------------------------

export type AprenderLinea = {
  description?: string | null;
  item_type?: string | null;
  account_code?: string | null;
  account_name?: string | null;
  iva?: number | null;
};

export type AprenderParams = {
  companyId: string;
  invoiceId: string;
  userId: string | null | undefined;
  providerNit?: string | null;
  providerName?: string | null;
  costCenter?: string | null;
  lines: AprenderLinea[];
  /** Retenciones REALES de la causación aprobada. */
  retBlocks?: RetBlocks | null;
  ivaTreatment?: string | null;
  ivaAccount?: string | null;
  ivaRate?: number | null;
  payableAccount?: string | null;
  paymentForm?: string | null;
};

type Patch = Record<string, string | number | boolean | null>;

/** Estructura contable observada en la causación aprobada, por renglón. */
function estructuraDeLinea(p: AprenderParams, line: AprenderLinea): Patch {
  const ret = p.retBlocks;
  const bloque = (k: RetencionKind) => ret?.[k];
  const out: Patch = {
    account_code: String(line.account_code ?? "").trim(),
    account_name: line.account_name ?? null,
    item_type: normalizeItemType(line.item_type),
    cost_center: p.costCenter ?? null,
    iva: Number(line.iva ?? 0),
    iva_aplica: Number(line.iva ?? 0) > 0 || !!p.ivaAccount,
    iva_rate: Number(line.iva ?? 0) > 0 ? Number(line.iva) : (p.ivaRate ?? null),
    iva_treatment: p.ivaTreatment ?? null,
    iva_account: p.ivaAccount ?? null,
    payable_account: p.payableAccount ?? null,
    payment_form: p.paymentForm ?? null,
    provider_name: p.providerName ?? null,
  };
  if (ret) {
    for (const k of ["retefuente", "reteiva", "reteica"] as RetencionKind[]) {
      const b = bloque(k);
      const aplica = !!b?.apply && Number(b?.amount ?? 0) > 0;
      out[`${k}_aplica`] = aplica;
      // La cuenta solo se escribe cuando la retención realmente se aplicó:
      // así nunca se borra una cuenta válida aprendida antes.
      if (aplica) {
        out[`${k}_rate`] = Number(b?.rate ?? 0) || null;
        out[`${k}_account`] = String(b?.account_code ?? "").trim() || null;
      }
    }
  }
  return out;
}

/** Solo los campos con información: nunca se sobrescribe un valor válido con vacío. */
function cambiosReales(actual: RuleShape | null, patch: Patch) {
  const cambios: { field: string; old: string | null; next: string | number | boolean | null }[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (typeof value !== "boolean" && vacio(value)) continue; // no borrar información válida
    const previo = actual ? (actual as unknown as Record<string, unknown>)[field] : undefined;
    if (actual && txt(previo) === txt(value)) continue;
    cambios.push({ field, old: actual ? (vacio(previo) ? null : txt(previo)) : null, next: value });
  }
  return cambios;
}

/**
 * Guarda automáticamente lo aprendido de una causación APROBADA.
 * No pregunta nada, no duplica reglas y deja historial de cada campo modificado.
 */
export async function aprenderDeCausacion(p: AprenderParams): Promise<void> {
  if (!p.companyId || !p.userId) return;
  const nit = (p.providerNit ?? "").trim() || null;

  for (const line of p.lines) {
    const cuenta = String(line.account_code ?? "").trim();
    if (!cuenta) continue;
    const concepto = (line.description ?? "").trim() || null;
    const tipo = normalizeItemType(line.item_type);

    // Regla única por empresa + proveedor + concepto + tipo de ítem.
    let q = supabase
      .from("learning_rules")
      .select("*")
      .eq("company_id", p.companyId)
      .eq("item_type", tipo)
      .limit(1);
    q = nit ? q.eq("provider_nit", nit) : q.is("provider_nit", null);
    q = concepto ? q.eq("concept", concepto) : q.is("concept", null);
    const { data } = await q;
    const actual = (data?.[0] ?? null) as unknown as RuleShape | null;

    const patch = estructuraDeLinea(p, line);
    const cambios = cambiosReales(actual, patch);

    if (!actual) {
      const insert: Record<string, unknown> = {
        company_id: p.companyId,
        provider_nit: nit,
        concept: concepto,
        source: "manual",
        active: true,
        times_used: 1,
        created_by: p.userId,
        updated_by: p.userId,
        last_used_at: new Date().toISOString(),
      };
      for (const c of cambios) insert[c.field] = c.next;
      insert["account_code"] = cuenta;
      const { data: creada } = await supabase.from("learning_rules").insert(insert as never).select("id").single();
      const ruleId = (creada as { id: string } | null)?.id;
      if (ruleId && cambios.length > 0) await registrarCambios(p, ruleId, cambios);
      continue;
    }

    const update: Record<string, unknown> = {
      times_used: Number(actual.times_used ?? 0) + 1,
      last_used_at: new Date().toISOString(),
      updated_by: p.userId,
      active: true,
    };
    for (const c of cambios) update[c.field] = c.next;
    await supabase.from("learning_rules").update(update as never).eq("id", actual.id);
    if (cambios.length > 0) await registrarCambios(p, actual.id, cambios);
  }
}

async function registrarCambios(
  p: AprenderParams,
  ruleId: string,
  cambios: { field: string; old: string | null; next: string | number | boolean | null }[],
) {
  await supabase.from("learning_rule_changes").insert(
    cambios.map((c) => ({
      company_id: p.companyId,
      rule_id: ruleId,
      invoice_id: p.invoiceId || null,
      field: c.field,
      field_label: FIELD_LABEL[c.field] ?? c.field,
      old_value: c.old,
      new_value: txt(c.next),
      changed_by: p.userId ?? null,
    })) as never,
  );
}
