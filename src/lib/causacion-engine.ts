// Motor central de causación inteligente.
// Orden de resolución de la cuenta contable de un renglón:
// 1) cuenta del producto del catálogo, 2) cuenta de su categoría,
// 3) regla aprendida proveedor + concepto, 4) regla aprendida del proveedor,
// 5) historial de causaciones (proveedor / conceptos similares),
// 6) reglas contables del usuario y PUC operativo.
// Todo es SIEMPRE por empresa: nunca se comparten datos entre empresas.
import { supabase } from "@/integrations/supabase/client";
import { bySourcePriority, type HistoryEvent, type LearningRule } from "@/lib/learning";
import { resolveProductAccount, type CategoryRef, type ProductRef } from "@/lib/product-account";
import { resolveOperationalAccount, type PucAccount } from "@/lib/puc-hierarchy";
import { companyUsesCostCenters, costCenterForCompany } from "@/lib/cost-center-config";
import { isValidExpenseAccount } from "@/lib/provider-rules";
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

/** Tope de eventos de aprendizaje propios (tabla pequeña, siempre por empresa). */
const MAX_EVENTS = 5000;

export type CompanyKnowledge = {
  learning: LearningRule[];
  history: HistoryEvent[];
  complete?: boolean;
  profiles?: PurchaseProfile[];
};

export type PurchaseProfile = { provider_nit: string | null; voucher: string | null; entry_date: string | null; payable_account: string | null; iva_account: string | null; retention_account: string | null; retention_rate: string | null; aiu: boolean };

export const emptyKnowledge = (): CompanyKnowledge => ({ learning: [], history: [] });

type HistoryRow = { provider_nit: string | null; concept: string | null; account_code: string; uses: number };

/** Llamada tipada a las funciones de resumen del histórico (no están en los tipos generados). */
const rpc = supabase.rpc.bind(supabase) as unknown as (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: HistoryRow[] | null; error: { message: string } | null }>;

const toEvents = (rows: HistoryRow[]): HistoryEvent[] =>
  rows
    .filter((r) => String(r.account_code ?? "").trim())
    .map((r) => ({
      provider_nit: r.provider_nit,
      concept: r.concept,
      account_code: String(r.account_code).trim(),
      weight: Number(r.uses || 1),
    }));

/**
 * Conocimiento contable base de la empresa: reglas aprendidas + eventos propios.
 * NO lee el histórico contable completo (puede tener cientos de miles de filas y
 * provocaba "canceling statement due to statement timeout"). El histórico se
 * consulta después, resumido y solo para los proveedores de la factura.
 */
export async function fetchCompanyKnowledge(companyId: string): Promise<CompanyKnowledge> {
  if (!companyId) return emptyKnowledge();
  const [learning, purchases] = await Promise.all([
    fetchAll<LearningRule>((from, to) =>
      supabase.from("learning_rules").select("*").eq("company_id", companyId).eq("active", true).range(from, to),
    ),
    supabase.rpc("purchase_company_knowledge", { _company_id: companyId }),
  ]);
  if (purchases.error) throw new Error(`No fue posible leer el historial de compras: ${purchases.error.message}`);
  const data = purchases.data as unknown as { history?: HistoryEvent[]; profiles?: PurchaseProfile[] } | null;
  return { learning, history: data?.history ?? [], profiles: data?.profiles ?? [], complete: true };
}

// Caché en memoria del histórico resumido (por empresa y proveedor), con
// deduplicación de peticiones en curso: 100 facturas del mismo proveedor
// hacen UNA sola consulta.
const historyCache = new Map<string, Promise<HistoryEvent[]>>();

/** Histórico resumido del proveedor (agrupado por concepto y cuenta) más las cuentas más usadas de la empresa. */
export function fetchProviderHistory(companyId: string, providerNit?: string | null): Promise<HistoryEvent[]> {
  const nit = (providerNit ?? "").trim();
  const key = `${companyId}|${nit}`;
  const cached = historyCache.get(key);
  if (cached) return cached;
  const run = (async () => {
    try {
      if (nit) {
        const { data, error } = await rpc("history_provider_accounts", {
          _company_id: companyId,
          _nits: [nit],
          _limit: 500,
        });
        if (error) throw new Error(error.message);
        const rows = toEvents(data ?? []);
        if (rows.length > 0) return rows;
      }
      const { data, error } = await rpc("history_top_accounts", { _company_id: companyId, _limit: 300 });
      if (error) throw new Error(error.message);
      return toEvents(data ?? []);
    } catch {
      // El histórico es una ayuda, no un requisito: si falla, la causación continúa.
      return [];
    }
  })();
  historyCache.set(key, run);
  return run;
}

/** Conocimiento de la empresa enriquecido con el histórico del proveedor de la factura. */
export async function knowledgeForProvider(
  companyId: string,
  providerNit: string | null | undefined,
  base: CompanyKnowledge,
): Promise<CompanyKnowledge> {
  if (base.complete) return base;
  const history = await fetchProviderHistory(companyId, providerNit);
  return { learning: base.learning, history: [...base.history, ...history] };
}

/** Limpia la caché del histórico (por ejemplo tras importar movimientos nuevos). */
export function clearHistoryCache() {
  historyCache.clear();
}

export type Confianza = "ALTA" | "MEDIA" | "BAJA";

export type AccountDecision = {
  code: string;
  name: string;
  /** Fuente real de la decisión. */
  origin: "PRODUCTO" | "CATEGORIA" | "APRENDIZAJE" | "HISTORIAL" | "HISTORIAL_DESCRIPCION" | "IA" | "REGLA" | "NINGUNA";
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
  const operativa = (code: string) => isValidExpenseAccount(code) && (puc.length === 0 ? true : resolveOperationalAccount(puc, code).valid);

  const nit = providerNit ? norm(providerNit) : null;
  const activas = knowledge.learning.filter((r) => r.active && operativa(r.account_code));

  // 5) historial real de causaciones: proveedor y conceptos similares.
  const historial = knowledge.history.filter((h) => operativa(h.account_code));
  const cuentaMasUsada = (items: HistoryEvent[]) => {
    if (items.length === 0) return null;
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.account_code, (counts.get(i.account_code) ?? 0) + (i.weight ?? 1));
    const [code, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const total = items.reduce((s, i) => s + (i.weight ?? 1), 0);
    return { code, count, total };
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
        reason: (() => {
          const evidence = delProveedor.filter((h) => h.account_code === top.code).sort((a, b) => (b.entry_date ?? "").localeCompare(a.entry_date ?? ""))[0];
          return evidence?.voucher ? `Historial NIT (${evidence.voucher}, ${evidence.entry_date ?? "sin fecha"})` : `Historial NIT: cuenta ${top.code} usada en ${top.count} de ${top.total} movimiento(s) anteriores de este proveedor${conConcepto ? " con conceptos similares" : ""}.`;
        })(),
        confidence: nivel(score),
        score,
        error: null,
      };
    }
  }

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

  const similares = cuentaMasUsada(historial.filter((h) => similar(line.description, h.concept) >= 0.6));
  if (similares) {
    const score = Math.min(0.8, 0.45 + Math.min(similares.count, 10) * 0.03);
    return {
      code: similares.code,
      name: nombrePuc(similares.code),
      origin: "HISTORIAL_DESCRIPCION",
      reason: `Cuenta ${similares.code} usada en ${similares.count} movimiento(s) con conceptos similares.`,
      confidence: nivel(score),
      score,
      error: null,
    };
  }

  // Sin evidencia: no inventar una cuenta por defecto ni reutilizar bancos.
  return { code: "", name: "", origin: "NINGUNA", reason: "Pendiente de cuenta: no hay regla ni historial de compra coincidente.", confidence: "BAJA", score: 0, error: "Pendiente de cuenta" };
}

export type LineDecisions = Record<number, AccountDecision>;

/** Aplica el motor a todos los renglones y devuelve la trazabilidad de cada decisión. */
export function applyEngineToLines(
  lines: Line[],
  params: Omit<ResolveParams, "line">,
): { lines: Line[]; decisions: LineDecisions } {
  const decisions: LineDecisions = {};
  const out = lines.map((l, i) => {
    if (isValidExpenseAccount(l.account_code)) {
      decisions[i] = { code: l.account_code ?? "", name: l.account_name ?? "", origin: "REGLA", reason: "Regla por proveedor", confidence: "ALTA", score: 1, error: null };
      return l;
    }
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
  // El centro de costo solo se aprende si la empresa los maneja.
  const centroAprendido = costCenterForCompany(await companyUsesCostCenters(companyId), costCenter);
  const operacional = (code: string) =>
    puc.length === 0 ? code : resolveOperationalAccount(puc, code).operationalAccount ?? code;

  const eventos: { company_id: string; provider_nit: string | null; concept: string | null; account_code: string; created_by: string }[] = [];
  const resoluciones: {
    company_id: string; invoice_id: string; suggested_code: string; used_code: string; reason: string; created_by: string;
  }[] = [];
  // Las reglas aprendidas las escribe el motor integral (src/lib/learning-rules.ts),
  // que guarda toda la estructura contable y su historial de cambios.
  void autoLearning;
  void providerName;
  void centroAprendido;

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
  });

  await Promise.all([
    eventos.length ? supabase.from("learning_events").insert(eventos) : Promise.resolve(),
    resoluciones.length ? supabase.from("account_resolutions").insert(resoluciones) : Promise.resolve(),
  ]);
}
