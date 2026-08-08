// Motor de aprendizaje contable. Siempre por empresa: las reglas nunca se comparten.
import { suggestAccount, type ProviderConfig, type Rule } from "@/lib/accounting";
import { auxiliaresDe, type PucAccount } from "@/lib/puc-hierarchy";

export { ITEM_TYPES, normalizeItemType, isValidItemType } from "@/lib/item-type";
export type { ItemType } from "@/lib/item-type";

export type LearningRule = {
  id: string;
  company_id: string;
  provider_nit: string | null;
  provider_name: string | null;
  concept: string | null;
  account_code: string;
  account_name: string | null;
  cost_center: string | null;
  iva: number;
  retentions: string | null;
  item_type: string;
  active: boolean;
  times_used: number;
  created_at: string;
  /** manual | excel | siigo. Lo importado manualmente tiene prioridad sobre la API. */
  source?: string;
  last_used_at?: string | null;
};

export type HistoryEvent = { provider_nit: string | null; concept: string | null; account_code: string };

export type Suggestion = {
  code: string;
  name: string | null;
  reason: string;
  ruleId?: string;
  cost_center?: string | null;
  item_type?: string;
};

const norm = (s: string) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

const tokens = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length > 3);

/** manual/excel primero; luego más usada; luego la más reciente. */
export function bySourcePriority(a: LearningRule, b: LearningRule) {
  const weight = (r: LearningRule) => (r.source === "siigo" ? 0 : 1);
  if (weight(a) !== weight(b)) return weight(b) - weight(a);
  if (a.times_used !== b.times_used) return b.times_used - a.times_used;
  return (b.last_used_at ?? b.created_at ?? "").localeCompare(a.last_used_at ?? a.created_at ?? "");
}

function similar(a: string, b: string) {
  const ta = tokens(a);
  const tb = new Set(tokens(b));
  if (ta.length === 0) return 0;
  return ta.filter((t) => tb.has(t)).length / ta.length;
}

/**
 * Orden de consulta exigido:
 * 1) reglas aprendidas (proveedor + concepto), 2) reglas aprendidas del proveedor,
 * 3) historial del proveedor, 4) historial de conceptos similares,
 * 5) reglas contables del usuario, 6) PUC importado, 7) reglas generales.
 */
export function suggestSmart(params: {
  description: string;
  providerNit?: string | null;
  learning: LearningRule[];
  history: HistoryEvent[];
  rules: Rule[];
  puc: PucAccount[];
  provider?: ProviderConfig | null;
}): Suggestion {
  const { description, providerNit, learning, history, rules, puc, provider } = params;
  const nit = providerNit ? norm(providerNit) : null;
  // Una cuenta aprendida solo se usa si sigue siendo cuenta de movimiento válida de la empresa.
  const esMovimiento = (code: string) => {
    if (puc.length === 0) return true;
    const cuenta = puc.find((p) => p.code === code);
    if (!cuenta) return false;
    return cuenta.active !== false && !cuenta.has_children && cuenta.is_movement !== false;
  };
  const actives = learning.filter((r) => r.active && esMovimiento(r.account_code));
  const pucName = (code: string) => puc.find((p) => p.code === code)?.name ?? null;

  // 1) regla aprendida: mismo proveedor + concepto parecido
  if (nit) {
    const sameProvider = actives.filter((r) => norm(r.provider_nit ?? "") === nit);
    const byConcept = sameProvider
      .map((r) => ({ r, score: similar(description, r.concept ?? "") }))
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => (b.score - a.score) || bySourcePriority(a.r, b.r))[0];
    if (byConcept)
      return {
        code: byConcept.r.account_code,
        name: byConcept.r.account_name ?? pucName(byConcept.r.account_code),
        reason: `Se sugirió la cuenta ${byConcept.r.account_code} por una regla aprendida para este proveedor con el concepto "${byConcept.r.concept}".`,
        ruleId: byConcept.r.id,
        cost_center: byConcept.r.cost_center,
        item_type: byConcept.r.item_type,
      };
    // 2) regla aprendida del proveedor (la más usada)
    const best = [...sameProvider].sort(bySourcePriority)[0];
    if (best)
      return {
        code: best.account_code,
        name: best.account_name ?? pucName(best.account_code),
        reason: `Se sugirió la cuenta ${best.account_code} porque existe una regla aprendida para este proveedor (usada ${best.times_used} vez/veces).`,
        ruleId: best.id,
        cost_center: best.cost_center,
        item_type: best.item_type,
      };
  }

  // regla aprendida solo por concepto (sin proveedor)
  const generic = actives
    .filter((r) => !r.provider_nit)
    .map((r) => ({ r, score: similar(description, r.concept ?? "") }))
    .filter((x) => x.score >= 0.6)
    .sort((a, b) => (b.score - a.score) || bySourcePriority(a.r, b.r))[0];
  if (generic)
    return {
      code: generic.r.account_code,
      name: generic.r.account_name ?? pucName(generic.r.account_code),
      reason: `Se sugirió la cuenta ${generic.r.account_code} por una regla aprendida para conceptos similares.`,
      ruleId: generic.r.id,
      cost_center: generic.r.cost_center,
      item_type: generic.r.item_type,
    };

  // 3) historial del proveedor
  if (nit) {
    const prev = history.filter((h) => norm(h.provider_nit ?? "") === nit && esMovimiento(h.account_code));
    const top = topAccount(prev);
    if (top)
      return {
        code: top.code,
        name: pucName(top.code),
        reason: `Se sugirió la cuenta ${top.code} porque las últimas ${top.count} factura(s) de este proveedor fueron contabilizadas en esa cuenta.`,
      };
  }

  // 4) historial de conceptos similares
  const similares = history.filter((h) => similar(description, h.concept ?? "") >= 0.6 && esMovimiento(h.account_code));
  const topSim = topAccount(similares);
  if (topSim)
    return {
      code: topSim.code,
      name: pucName(topSim.code),
      reason: `Se sugirió la cuenta ${topSim.code} porque ${topSim.count} factura(s) con conceptos similares se contabilizaron allí.`,
    };

  // 5) reglas contables del usuario + 7) reglas generales / cuenta del tercero
  const base = suggestAccount(description, rules, provider);
  if (!esMovimiento(base.code)) {
    const hijas = auxiliaresDe(puc, base.code);
    return {
      code: hijas.length === 1 ? hijas[0]!.code : "",
      name: hijas.length === 1 ? hijas[0]!.name : null,
      reason:
        hijas.length > 0
          ? `La cuenta sugerida ${base.code} tiene cuentas auxiliares. Seleccione la cuenta de movimiento: ${hijas
              .slice(0, 5)
              .map((h) => `${h.code} - ${h.name}`)
              .join(", ")}.`
          : `La cuenta sugerida ${base.code} no es una cuenta de movimiento válida en Siigo. Seleccione una cuenta auxiliar activa.`,
    };
  }
  const existsInPuc = puc.some((p) => p.code === base.code);
  return {
    code: base.code,
    name: base.name ?? pucName(base.code),
    reason: existsInPuc
      ? `Se sugirió la cuenta ${base.code} por ${base.source} (cuenta existente en el PUC de la empresa).`
      : `Se sugirió la cuenta ${base.code} por ${base.source}.`,
  };
}

function topAccount(items: HistoryEvent[]) {
  if (items.length === 0) return null;
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.account_code, (counts.get(i.account_code) ?? 0) + 1);
  const [code, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return { code, count };
}
