// Tratamiento contable del IVA en compras.
//
// NO reemplaza el módulo de impuestos: el IVA (tarifa, impuesto seleccionado,
// IDs de Siigo, cálculo) se sigue determinando exactamente igual. Aquí solo se
// decide CÓMO se contabiliza ese IVA en cada factura:
//   - descontable  -> cuenta de IVA del módulo de impuestos (por ejemplo 2408)
//   - gasto        -> mayor valor del gasto, en una LÍNEA INDEPENDIENTE
//   - costo        -> mayor valor del costo, en una LÍNEA INDEPENDIENTE
//
// La decisión se toma factura por factura con el histórico real de la empresa
// (proveedor + cuenta de gasto/costo + concepto) y con las correcciones que el
// usuario ya aprobó. Nunca se aplica una regla única para toda la empresa ni
// únicamente por proveedor.
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { resolveOperationalAccount, type PucAccount } from "@/lib/puc-hierarchy";
import type { IvaJournalGroup } from "@/lib/tax-selection";

export type IvaTreatment = "descontable" | "gasto" | "costo";

export const IVA_TREATMENT_LABEL: Record<IvaTreatment, string> = {
  descontable: "IVA descontable",
  gasto: "IVA mayor valor del gasto",
  costo: "IVA mayor valor del costo",
};

export type IvaCompanyConfig = {
  mode: "mixto" | IvaTreatment;
  descontable: string | null;
  gasto: string | null;
  costo: string | null;
};

export const defaultIvaConfig = (): IvaCompanyConfig => ({ mode: "mixto", descontable: null, gasto: null, costo: null });

export type IvaTreatmentOrigin = "CORRECCION" | "HISTORIAL" | "CONFIGURACION" | "SIN_EVIDENCIA";

export type IvaTreatmentDecision = {
  treatment: IvaTreatment;
  /** Cuenta a usar cuando el tratamiento es gasto o costo. Vacía = usar la cuenta del módulo de impuestos. */
  account: string;
  accountName: string;
  origin: IvaTreatmentOrigin;
  reason: string;
  /** 0 a 1 */
  confidence: number;
  warning: string | null;
};

export const SIN_EVIDENCIA =
  "Revisión requerida: no existe suficiente evidencia histórica para determinar el tratamiento del IVA.";

const norm = (s?: string | null) =>
  (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

const tokens = (s?: string | null) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length > 3);

function similar(a?: string | null, b?: string | null) {
  const ta = tokens(a);
  const tb = new Set(tokens(b));
  if (ta.length === 0) return 0;
  return ta.filter((t) => tb.has(t)).length / ta.length;
}

const clean = (s?: string | null) => String(s ?? "").trim();

/** Clasifica una cuenta de IVA por su código: 24xx descontable, 5x gasto, 6x/7x costo. */
export function treatmentForAccount(code?: string | null): IvaTreatment {
  const c = clean(code);
  if (c.startsWith("24")) return "descontable";
  if (c.startsWith("6") || c.startsWith("7")) return "costo";
  if (c.startsWith("5")) return "gasto";
  return "descontable";
}

// ---------------------------------------------------------------- configuración

const configCache = new Map<string, Promise<IvaCompanyConfig>>();

export function clearIvaConfigCache(companyId?: string) {
  if (companyId) configCache.delete(companyId);
  else configCache.clear();
}

export function fetchIvaConfig(companyId: string | null | undefined): Promise<IvaCompanyConfig> {
  if (!companyId) return Promise.resolve(defaultIvaConfig());
  const hit = configCache.get(companyId);
  if (hit) return hit;
  const run = (async (): Promise<IvaCompanyConfig> => {
    const { data } = await supabase
      .from("companies")
      .select("iva_treatment_mode, iva_account_descontable, iva_account_gasto, iva_account_costo")
      .eq("id", companyId)
      .maybeSingle();
    const row = (data ?? null) as null | {
      iva_treatment_mode?: string | null;
      iva_account_descontable?: string | null;
      iva_account_gasto?: string | null;
      iva_account_costo?: string | null;
    };
    const mode = clean(row?.iva_treatment_mode) || "mixto";
    return {
      mode: (["descontable", "gasto", "costo"].includes(mode) ? mode : "mixto") as IvaCompanyConfig["mode"],
      descontable: clean(row?.iva_account_descontable) || null,
      gasto: clean(row?.iva_account_gasto) || null,
      costo: clean(row?.iva_account_costo) || null,
    };
  })();
  configCache.set(companyId, run);
  return run;
}

export function useIvaConfig(companyId: string | null | undefined) {
  return useQuery({
    queryKey: ["iva-config", companyId],
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchIvaConfig(companyId),
  });
}

// ---------------------------------------------------------------- evidencia

type HistoryRow = { provider_nit: string | null; expense_account: string; iva_account: string; uses: number };

type LearnedRule = {
  id: string;
  provider_nit: string | null;
  concept: string | null;
  expense_account: string | null;
  treatment: string;
  iva_account: string | null;
  times_used: number;
};

const rpc = supabase.rpc.bind(supabase) as unknown as (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: HistoryRow[] | null; error: { message: string } | null }>;

export type IvaEvidence = { history: HistoryRow[]; rules: LearnedRule[] };

const evidenceCache = new Map<string, Promise<IvaEvidence>>();

export function clearIvaEvidenceCache(companyId?: string) {
  if (!companyId) evidenceCache.clear();
  else for (const k of [...evidenceCache.keys()]) if (k.startsWith(`${companyId}|`)) evidenceCache.delete(k);
}

/** Evidencia de la empresa para ese proveedor: correcciones aprobadas + histórico contable real. */
export function fetchIvaEvidence(companyId: string, providerNit?: string | null): Promise<IvaEvidence> {
  const nit = clean(providerNit);
  const key = `${companyId}|${nit}`;
  const hit = evidenceCache.get(key);
  if (hit) return hit;
  const run = (async (): Promise<IvaEvidence> => {
    const [history, rules] = await Promise.all([
      (async () => {
        try {
          const { data, error } = await rpc("history_iva_treatment", {
            _company_id: companyId,
            _nits: nit ? [nit] : null,
            _limit: 500,
          });
          if (error) throw new Error(error.message);
          const rows = data ?? [];
          if (rows.length > 0 || !nit) return rows;
          // Sin histórico del proveedor: se mira el comportamiento general de la empresa.
          const global = await rpc("history_iva_treatment", { _company_id: companyId, _nits: null, _limit: 500 });
          return global.data ?? [];
        } catch {
          return [] as HistoryRow[];
        }
      })(),
      (async () => {
        const q = supabase
          .from("iva_treatment_rules")
          .select("id, provider_nit, concept, expense_account, treatment, iva_account, times_used")
          .eq("company_id", companyId)
          .order("times_used", { ascending: false })
          .limit(500);
        const { data } = await q;
        return ((data ?? []) as unknown as LearnedRule[]);
      })(),
    ]);
    return { history, rules };
  })();
  evidenceCache.set(key, run);
  return run;
}

// ---------------------------------------------------------------- decisión

export type ResolveIvaParams = {
  config: IvaCompanyConfig;
  evidence: IvaEvidence;
  providerNit?: string | null;
  /** Cuentas de gasto/costo de la factura (las que ya resolvió el motor de causación). */
  expenseAccounts: string[];
  /** Conceptos/descripciones de los renglones. */
  concepts?: string[];
  puc: PucAccount[];
  /** Cuenta de IVA que trae el módulo de impuestos (no se modifica; solo se usa como base). */
  taxAccount?: string | null;
};

const nombrePuc = (puc: PucAccount[], code: string) => puc.find((p) => p.code === code)?.name ?? "";

function validar(puc: PucAccount[], code: string): { code: string; name: string; warning: string | null } {
  const c = clean(code);
  if (!c) return { code: "", name: "", warning: null };
  if (puc.length === 0) return { code: c, name: "", warning: null };
  const existe = puc.some((p) => p.code === c);
  if (!existe)
    return {
      code: c,
      name: "",
      warning: `La cuenta de IVA ${c} usada en el histórico no existe en el PUC de la empresa. Selecciónela manualmente.`,
    };
  const r = resolveOperationalAccount(puc, c);
  if (!r.valid || !r.operationalAccount)
    return { code: c, name: nombrePuc(puc, c), warning: r.message ?? `La cuenta ${c} no es operativa.` };
  return { code: r.operationalAccount, name: r.operational?.name ?? nombrePuc(puc, r.operationalAccount), warning: null };
}

/** Determina el tratamiento del IVA de UNA factura con el contexto de la operación. */
export function resolveIvaTreatment(params: ResolveIvaParams): IvaTreatmentDecision {
  const { config, evidence, providerNit, expenseAccounts, concepts = [], puc, taxAccount } = params;
  const nit = norm(providerNit);
  const cuentas = expenseAccounts.map(clean).filter(Boolean);

  const decidir = (
    treatment: IvaTreatment,
    code: string,
    origin: IvaTreatmentOrigin,
    reason: string,
    confidence: number,
  ): IvaTreatmentDecision => {
    if (treatment === "descontable" && !code) {
      return { treatment, account: "", accountName: "", origin, reason, confidence, warning: null };
    }
    const v = validar(puc, code);
    return {
      treatment,
      account: v.code,
      accountName: v.name,
      origin,
      reason,
      confidence,
      warning: v.warning,
    };
  };

  // Empresa con un tratamiento fijo configurado: se respeta siempre.
  if (config.mode !== "mixto") {
    const code =
      config.mode === "descontable" ? config.descontable ?? clean(taxAccount) : config.mode === "gasto" ? config.gasto ?? "" : config.costo ?? "";
    return decidir(
      config.mode,
      code ?? "",
      "CONFIGURACION",
      `La empresa está configurada para tratar el IVA de compras como ${IVA_TREATMENT_LABEL[config.mode].toLowerCase()}.`,
      0.9,
    );
  }

  // 1) Correcciones aprobadas por el usuario (mayor prioridad que cualquier predicción).
  const reglas = evidence.rules.filter((r) => ["descontable", "gasto", "costo"].includes(r.treatment));
  const puntuadas = reglas
    .map((r) => {
      let score = 0;
      if (nit && norm(r.provider_nit) === nit) score += 0.4;
      else if (r.provider_nit) return null;
      const cuenta = clean(r.expense_account);
      if (cuenta && cuentas.some((c) => c === cuenta || c.startsWith(cuenta.slice(0, 4)))) score += 0.35;
      const s = Math.max(0, ...concepts.map((c) => similar(c, r.concept)));
      if (r.concept && s >= 0.5) score += 0.25 * s;
      return score > 0 ? { r, score } : null;
    })
    .filter((x): x is { r: LearnedRule; score: number } => !!x)
    .sort((a, b) => b.score - a.score || b.r.times_used - a.r.times_used);
  const mejorRegla = puntuadas[0];
  if (mejorRegla && mejorRegla.score >= 0.35) {
    const t = mejorRegla.r.treatment as IvaTreatment;
    const code = clean(mejorRegla.r.iva_account) || (t === "descontable" ? clean(config.descontable) || clean(taxAccount) : t === "gasto" ? clean(config.gasto) : clean(config.costo));
    return decidir(
      t,
      code,
      "CORRECCION",
      `Corrección aprobada anteriormente para operaciones similares de este proveedor (usada ${mejorRegla.r.times_used} vez/veces).`,
      Math.min(0.97, 0.75 + mejorRegla.score * 0.2 + Math.min(mejorRegla.r.times_used, 5) * 0.01),
    );
  }

  // 2) Histórico contable real: qué cuenta de IVA acompañó a estas cuentas de gasto/costo.
  const relevantes = evidence.history.filter((h) => {
    if (nit && norm(h.provider_nit) !== nit) return false;
    return cuentas.length === 0 || cuentas.some((c) => c === clean(h.expense_account) || clean(h.expense_account).startsWith(c.slice(0, 4)));
  });
  const fuente = relevantes.length > 0 ? relevantes : nit ? evidence.history.filter((h) => norm(h.provider_nit) === nit) : [];
  if (fuente.length > 0) {
    const conteo = new Map<string, number>();
    for (const h of fuente) conteo.set(clean(h.iva_account), (conteo.get(clean(h.iva_account)) ?? 0) + Number(h.uses || 1));
    const total = [...conteo.values()].reduce((s, n) => s + n, 0);
    const [code, uses] = [...conteo.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const frecuencia = uses / Math.max(1, total);
    const t = treatmentForAccount(code);
    return decidir(
      t,
      t === "descontable" ? clean(config.descontable) || code : code,
      "HISTORIAL",
      `El histórico de la empresa registra la cuenta ${code} para el IVA en ${uses} de ${total} operación(es) equivalentes (${IVA_TREATMENT_LABEL[t].toLowerCase()}).`,
      Math.min(0.96, 0.55 + frecuencia * 0.3 + Math.min(uses, 10) * 0.01),
    );
  }

  // 3) Sin evidencia: se mantiene la lógica actual del módulo de impuestos (IVA descontable).
  const configurada = clean(config.descontable);
  return {
    treatment: "descontable",
    account: configurada && clean(taxAccount) === "" ? configurada : "",
    accountName: configurada ? nombrePuc(puc, configurada) : "",
    origin: "SIN_EVIDENCIA",
    reason: SIN_EVIDENCIA,
    confidence: 0.4,
    warning: SIN_EVIDENCIA,
  };
}

/**
 * Aplica el tratamiento a los grupos de IVA del módulo de impuestos.
 * Con IVA de gasto o costo se genera UNA sola línea independiente por el valor TOTAL del IVA;
 * el IVA nunca se suma a la cuenta de gasto/costo.
 */
export function applyIvaTreatment(
  groups: IvaJournalGroup[],
  decision: IvaTreatmentDecision | null | undefined,
): IvaJournalGroup[] {
  if (!decision) return groups;
  if (decision.treatment === "descontable") {
    if (!decision.account) return groups;
    // Solo se reemplaza cuando el módulo de impuestos no trajo cuenta.
    return groups.map((g) => (g.account_code ? g : { ...g, account_code: decision.account, account_name: decision.accountName || g.account_name }));
  }
  if (!decision.account) return groups;
  const total = groups.reduce((s, g) => s + Number(g.amount || 0), 0);
  if (!total) return groups;
  return [{ account_code: decision.account, account_name: decision.accountName || IVA_TREATMENT_LABEL[decision.treatment], amount: total }];
}

// ---------------------------------------------------------------- aprendizaje

/**
 * Guarda la decisión final del IVA (la de la IA aceptada o la corregida por el usuario)
 * como aprendizaje de ESA empresa, conservando el contexto de la operación.
 */
export async function learnIvaTreatment(params: {
  companyId: string;
  userId?: string | null;
  providerNit?: string | null;
  concept?: string | null;
  expenseAccount?: string | null;
  ivaAccount?: string | null;
  treatment: IvaTreatment;
}) {
  const { companyId, userId, treatment } = params;
  const ivaAccount = clean(params.ivaAccount);
  const providerNit = clean(params.providerNit) || null;
  const expenseAccount = clean(params.expenseAccount) || null;
  const concept = clean(params.concept) || null;
  if (!companyId || !ivaAccount) return;
  const q = supabase
    .from("iva_treatment_rules")
    .select("id, times_used")
    .eq("company_id", companyId)
    .eq("treatment", treatment)
    .eq("iva_account", ivaAccount)
    .limit(1);
  const conNit = providerNit ? q.eq("provider_nit", providerNit) : q.is("provider_nit", null);
  const { data } = expenseAccount ? await conNit.eq("expense_account", expenseAccount) : await conNit.is("expense_account", null);
  const existente = data?.[0] as { id: string; times_used: number } | undefined;
  if (existente) {
    await supabase
      .from("iva_treatment_rules")
      .update({ times_used: Number(existente.times_used ?? 0) + 1, concept })
      .eq("id", existente.id);
  } else {
    await supabase.from("iva_treatment_rules").insert({
      company_id: companyId,
      provider_nit: providerNit,
      concept,
      expense_account: expenseAccount,
      treatment,
      iva_account: ivaAccount,
      created_by: userId ?? null,
    } as never);
  }
  clearIvaEvidenceCache(companyId);
}
