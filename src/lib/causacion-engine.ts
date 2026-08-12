// Motor central de causación inteligente.
// Orden de resolución de la cuenta contable de un renglón:
// 1) cuenta del producto del catálogo, 2) cuenta de su categoría,
// 3) regla aprendida proveedor + concepto, 4) regla aprendida del proveedor,
// 5) historial de causaciones (proveedor / conceptos similares),
// 6) reglas contables del usuario y PUC operativo.
// Todo es SIEMPRE por empresa: nunca se comparten datos entre empresas.
import { supabase } from "@/integrations/supabase/client";
import { suggestSmart, bySourcePriority, type HistoryEvent, type LearningRule } from "@/lib/learning";
import { resolveProductAccount, type CategoryRef, type ProductRef } from "@/lib/product-account";
import { resolveOperationalAccount, type PucAccount } from "@/lib/puc-hierarchy";
import type { Line, ProviderConfig, Rule } from "@/lib/accounting";

const PAGE = 1000;

const norm = (s?: string | null) =>
  (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

const tokens = (s?: string | null) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length > 3);

function similar(a?: string | null, b?: string | null) {
  const ta = tokens(a);
  const tb = new Set(tokens(b));
  if (ta.length === 0) return 0;
  return ta.filter((t) => tb.has(t)).length / ta.length;
}

/** Lee filas paginadas (sin el límite de 1000 de la API), con tope opcional para no demorar la carga. */
async function fetchAll<T>(
  run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  maxRows = Infinity,
) {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await run(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    out.push(...page);
    if (page.length < PAGE || out.length >= maxRows) break;
  }
  return out;
}

/** Tope de eventos recientes usados para sugerir cuentas (suficiente para la frecuencia). */
const MAX_HISTORY = 5000;

export type CompanyKnowledge = {
  learning: LearningRule[];
  history: HistoryEvent[];
};

export const emptyKnowledge = (): CompanyKnowledge => ({ learning: [], history: [] });

/** Conocimiento contable acumulado de la empresa: reglas aprendidas + historial real de causaciones. */
export async function fetchCompanyKnowledge(companyId: string): Promise<CompanyKnowledge> {
  if (!companyId) return emptyKnowledge();
  const [learning, eventos, historico] = await Promise.all([
    fetchAll<LearningRule>((from, to) =>
      supabase.from("learning_rules").select("*").eq("company_id", companyId).eq("active", true).range(from, to),
    ),
    fetchAll<{ provider_nit: string | null; concept: string | null; account_code: string }>(
      (from, to) =>
        supabase
          .from("learning_events")
          .select("provider_nit, concept, account_code")
          .eq("company_id", companyId)
          .order("created_at", { ascending: false })
          .range(from, to),
      MAX_HISTORY,
    ),
    fetchAll<{ provider_nit: string | null; description: string | null; detail: string | null; account_code: string | null }>(
      (from, to) =>
        supabase
          .from("accounting_history")
          .select("provider_nit, description, detail, account_code")
          .eq("company_id", companyId)
          .not("account_code", "is", null)
          .order("imported_at", { ascending: false })
          .range(from, to),
      MAX_HISTORY,
    ),
  ]);

  const history: HistoryEvent[] = [
    ...eventos.map((e) => ({ provider_nit: e.provider_nit, concept: e.concept, account_code: e.account_code })),
    ...historico
      .filter((h) => String(h.account_code ?? "").trim())
      .map((h) => ({
        provider_nit: h.provider_nit,
        concept: h.detail || h.description,
        account_code: String(h.account_code).trim(),
      })),
  ];
  return { learning, history };
}

export type Confianza = "ALTA" | "MEDIA" | "BAJA";

export type AccountDecision = {
  code: string;
  name: string;
  /** Fuente real de la decisión. */
  origin: "PRODUCTO" | "CATEGORIA" | "APRENDIZAJE" | "HISTORIAL" | "REGLA" | "NINGUNA";
  reason: string;
  confidence: Confianza;
  /** 0 a 1 */
  score: number;
  ruleId?: string | undefined;
  itemType?: string | undefined;
  costCenter?: string | null | undefined;
  error: string | null;
};

const nivel = (score: number): Confianza => (score >= 0.85 ? "ALTA" : score >= 0.6 ? "MEDIA" : "BAJA");

export type ResolveParams = {
  line: Pick<Line, "code" | "description" | "item_type">;
  providerNit?: string | null;
  knowledge: CompanyKnowledge;
  products: ProductRef[];
  categories: CategoryRef[];
  rules: Rule[];
  puc: PucAccount[];
  provider?: ProviderConfig | null;
};

/** Resuelve la cuenta contable de un renglón con toda la inteligencia disponible de la empresa. */
export function resolveLineAccount(params: ResolveParams): AccountDecision {
  const { line, providerNit, knowledge, products, categories, rules, puc, provider } = params;
  const nombrePuc = (code: string) => puc.find((p) => p.code === code)?.name ?? "";
  const operativa = (code: string) => (puc.length === 0 ? true : resolveOperationalAccount(puc, code).valid);

  // 1) y 2) catálogo: producto y categoría.
  const prod =
    products.find((p) => line.code && norm(p.code) === norm(String(line.code))) ??
    products.find((p) => norm(p.name) === norm(line.description));
  if (prod) {
    const r = resolveProductAccount(prod, categories, rules);
    if (r.code && (r.origin === "producto" || r.origin === "categoria")) {
      const score = r.origin === "producto" ? 0.98 : 0.9;
      return {
        code: r.code,
        name: r.name || nombrePuc(r.code),
        origin: r.origin === "producto" ? "PRODUCTO" : "CATEGORIA",
        reason:
          r.origin === "producto"
            ? `Cuenta ${r.code} tomada del producto "${prod.name}" del catálogo.`
            : `Cuenta ${r.code} tomada de la categoría del producto "${prod.name}".`,
        confidence: nivel(score),
        score,
        itemType: prod.kind ?? undefined,
        error: null,
      };
    }
  }

  const nit = providerNit ? norm(providerNit) : null;
  const activas = knowledge.learning.filter((r) => r.active && operativa(r.account_code));

  // 3) regla aprendida: mismo proveedor + concepto parecido.
  if (nit) {
    const mismos = activas.filter((r) => norm(r.provider_nit) === nit);
    const conConcepto = mismos
      .map((r) => ({ r, s: similar(line.description, r.concept) }))
      .filter((x) => x.s >= 0.5)
      .sort((a, b) => b.s - a.s || bySourcePriority(a.r, b.r))[0];
    if (conConcepto) {
      const score = Math.min(0.99, 0.85 + conConcepto.s * 0.1);
      return {
        code: conConcepto.r.account_code,
        name: conConcepto.r.account_name ?? nombrePuc(conConcepto.r.account_code),
        origin: "APRENDIZAJE",
        reason: `Cuenta ${conConcepto.r.account_code} aprendida de este proveedor con el concepto "${conConcepto.r.concept}" (usada ${conConcepto.r.times_used} vez/veces).`,
        confidence: nivel(score),
        score,
        ruleId: conConcepto.r.id,
        itemType: conConcepto.r.item_type,
        costCenter: conConcepto.r.cost_center,
        error: null,
      };
    }
    // 4) regla aprendida del proveedor.
    const mejor = [...mismos].sort(bySourcePriority)[0];
    if (mejor) {
      const score = Math.min(0.88, 0.7 + mejor.times_used * 0.02);
      return {
        code: mejor.account_code,
        name: mejor.account_name ?? nombrePuc(mejor.account_code),
        origin: "APRENDIZAJE",
        reason: `Cuenta ${mejor.account_code} aprendida para este proveedor (usada ${mejor.times_used} vez/veces).`,
        confidence: nivel(score),
        score,
        ruleId: mejor.id,
        itemType: mejor.item_type,
        costCenter: mejor.cost_center,
        error: null,
      };
    }
  }

  // 5) historial real de causaciones: proveedor y conceptos similares.
  const historial = knowledge.history.filter((h) => operativa(h.account_code));
  const cuentaMasUsada = (items: HistoryEvent[]) => {
    if (items.length === 0) return null;
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.account_code, (counts.get(i.account_code) ?? 0) + 1);
    const [code, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    return { code, count, total: items.length };
  };

  if (nit) {
    const delProveedor = historial.filter((h) => norm(h.provider_nit) === nit);
    const conConcepto = cuentaMasUsada(delProveedor.filter((h) => similar(line.description, h.concept) >= 0.5));
    const top = conConcepto ?? cuentaMasUsada(delProveedor);
    if (top) {
      const frecuencia = top.count / Math.max(1, top.total);
      const score = Math.min(0.92, 0.5 + frecuencia * 0.3 + Math.min(top.count, 10) * 0.015);
      return {
        code: top.code,
        name: nombrePuc(top.code),
        origin: "HISTORIAL",
        reason: `Cuenta ${top.code} usada en ${top.count} de ${top.total} movimiento(s) anteriores de este proveedor${conConcepto ? " con conceptos similares" : ""}.`,
        confidence: nivel(score),
        score,
        error: null,
      };
    }
  }

  const similares = cuentaMasUsada(historial.filter((h) => similar(line.description, h.concept) >= 0.6));
  if (similares) {
    const score = Math.min(0.8, 0.45 + Math.min(similares.count, 10) * 0.03);
    return {
      code: similares.code,
      name: nombrePuc(similares.code),
      origin: "HISTORIAL",
      reason: `Cuenta ${similares.code} usada en ${similares.count} movimiento(s) con conceptos similares.`,
      confidence: nivel(score),
      score,
      error: null,
    };
  }

  // 6) reglas contables del usuario, cuenta del tercero y PUC operativo.
  const s = suggestSmart({
    description: line.description ?? "",
    providerNit: providerNit ?? null,
    learning: [],
    history: [],
    rules,
    puc,
    provider: provider ?? null,
  });
  if (!s.code)
    return {
      code: "",
      name: "",
      origin: "NINGUNA",
      reason: s.reason,
      confidence: "BAJA",
      score: 0,
      error: s.reason,
    };
  return {
    code: s.code,
    name: s.name ?? nombrePuc(s.code),
    origin: "REGLA",
    reason: s.reason,
    confidence: "BAJA",
    score: 0.4,
    error: null,
  };
}

export type LineDecisions = Record<number, AccountDecision>;

/** Aplica el motor a todos los renglones y devuelve la trazabilidad de cada decisión. */
export function applyEngineToLines(
  lines: Line[],
  params: Omit<ResolveParams, "line">,
): { lines: Line[]; decisions: LineDecisions } {
  const decisions: LineDecisions = {};
  const out = lines.map((l, i) => {
    if (l.account_code) return l;
    const d = resolveLineAccount({ ...params, line: l });
    decisions[i] = d;
    return {
      ...l,
      account_code: d.code,
      account_name: l.account_name || d.name,
      item_type: l.item_type || d.itemType || "gasto",
    };
  });
  return { lines: out, decisions };
}

/**
 * Registra el aprendizaje SOLO cuando la causación queda aprobada:
 * guarda el historial, compara lo propuesto contra lo finalmente usado y
 * actualiza las reglas aprendidas de la empresa.
 */
export async function registrarAprendizaje(params: {
  companyId: string;
  invoiceId: string;
  userId: string | null | undefined;
  providerNit?: string | null;
  providerName?: string | null;
  costCenter?: string | null;
  lines: Line[];
  decisions: LineDecisions;
  puc: PucAccount[];
  autoLearning: boolean;
}) {
  const { companyId, invoiceId, userId, providerNit, providerName, costCenter, lines, decisions, puc, autoLearning } = params;
  if (!companyId || !userId) return;
  const operacional = (code: string) =>
    puc.length === 0 ? code : resolveOperationalAccount(puc, code).operationalAccount ?? code;

  const eventos: { company_id: string; provider_nit: string | null; concept: string | null; account_code: string; created_by: string }[] = [];
  const resoluciones: {
    company_id: string; invoice_id: string; suggested_code: string; used_code: string; reason: string; created_by: string;
  }[] = [];
  const reglas: Record<string, unknown>[] = [];

  lines.forEach((l, i) => {
    const code = String(l.account_code ?? "").trim();
    if (!code) return;
    const final = operacional(code);
    eventos.push({
      company_id: companyId,
      provider_nit: providerNit || null,
      concept: l.description || null,
      account_code: final,
      created_by: userId,
    });
    const d = decisions[i];
    resoluciones.push({
      company_id: companyId,
      invoice_id: invoiceId,
      suggested_code: d?.code || final,
      used_code: final,
      reason: d
        ? d.code === final
          ? `Sugerencia aceptada (${d.origin}, confianza ${d.confidence}). ${d.reason}`
          : `Sugerencia corregida por el usuario: se propuso ${d.code || "ninguna"} (${d.origin}) y se usó ${final}. ${d.reason}`
        : `Cuenta ${final} asignada manualmente por el usuario.`,
      created_by: userId,
    });
    if (autoLearning) {
      reglas.push({
        company_id: companyId,
        provider_nit: providerNit || null,
        provider_name: providerName || null,
        concept: l.description || null,
        account_code: final,
        account_name: l.account_name || null,
        cost_center: costCenter || null,
        iva: Number(l.iva ?? 0),
        item_type: l.item_type ?? "gasto",
        source: "manual",
        created_by: userId,
      });
    }
  });

  await Promise.all([
    eventos.length ? supabase.from("learning_events").insert(eventos) : Promise.resolve(),
    resoluciones.length ? supabase.from("account_resolutions").insert(resoluciones) : Promise.resolve(),
    ...reglas.map(async (r) => {
      // Una regla por proveedor + concepto: si ya existe, se refuerza su uso.
      const q = supabase
        .from("learning_rules")
        .select("id, times_used")
        .eq("company_id", companyId)
        .eq("concept", String(r["concept"] ?? ""))
        .eq("account_code", String(r["account_code"]))
        .limit(1);
      const { data } = r["provider_nit"] ? await q.eq("provider_nit", String(r["provider_nit"])) : await q.is("provider_nit", null);
      const existente = data?.[0];
      if (existente)
        await supabase
          .from("learning_rules")
          .update({ times_used: Number(existente.times_used ?? 0) + 1, last_used_at: new Date().toISOString(), active: true })
          .eq("id", existente.id);
      else await supabase.from("learning_rules").insert(r as never);
    }),
  ]);
}
