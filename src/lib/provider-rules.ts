// Motor de REGLAS POR PROVEEDOR (prioridades P1 y P2 de la causación).
//
// Una regla por proveedor define toda la estructura contable de sus compras:
// cuenta de gasto, tratamiento y cuenta del IVA, cuenta del INC, retención en
// la fuente (cuenta, tarifa y base) y cuenta por pagar.
//
// Prioridades de la cuenta de gasto por línea:
//   P1. Regla del proveedor con palabra clave contenida en la descripción.
//   P2. Regla del proveedor con palabra clave "(todas)".
//   P3/P4. Historial aprendido (motor existente de aprendizaje e historial).
//   P5. "Pendiente de cuenta" (nunca dejar una línea sin estado).
//
// Validación obligatoria: la cuenta de gasto SOLO puede empezar por 5, 6, 7,
// 15, 16 o 17. Una sugerencia en 11, 13, 22, 23 o 24 se descarta y pasa a la
// siguiente prioridad.
import { supabase } from "@/integrations/supabase/client";
import { roundCOP } from "@/lib/money";
import type { Line } from "@/lib/accounting";

export type IvaTreatmentRule = "descontable" | "asumido" | "capitalizado" | "na";
export type RetentionBase = "Subtotal" | "AIU";

export type ProviderRule = {
  id: string;
  company_id: string;
  provider_nit: string;
  provider_name: string | null;
  /** Palabra clave buscada en la descripción; "(todas)" aplica a todo el proveedor. */
  keyword: string;
  expense_account: string | null;
  expense_account_name: string | null;
  iva_treatment: IvaTreatmentRule;
  iva_account: string | null;
  inc_account: string | null;
  retention_account: string | null;
  retention_rate: number | null;
  retention_base: RetentionBase | null;
  payable_account: string | null;
  source: string;
  times_used: number;
  last_used_at: string | null;
  active: boolean;
};

// Cuentas fijas del motor (PUC de la empresa puede tener auxiliares equivalentes).
export const CTA_IVA_DESCONTABLE = "24081013";
export const CTA_IVA_ASUMIDO = "51157001";
export const CTA_INC_DEFAULT = "51158101";
export const CTA_AJUSTE_PESO = "42958101";
export const CTA_ANTICIPOS = "13300501";

const norm = (s?: string | null) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();

/** ¿La cuenta es un gasto/costo/activo válido? Solo grupos 5, 6, 7, 15, 16 o 17. */
export function isValidExpenseAccount(code?: string | null): boolean {
  const c = String(code ?? "").trim();
  return /^\d+$/.test(c) && /^(5|6|7|15|16|17)/.test(c);
}

/** ¿La descripción corresponde a AIU (administración, utilidad, imprevistos)? */
export function esLineaAIU(description?: string | null): boolean {
  const d = norm(description);
  return (
    d.includes("administracion") ||
    d.includes("utilidad") ||
    d.includes("imprevistos") ||
    /\baiu\b/.test(d)
  );
}

/** Subtotal de una línea: cantidad × valor unitario − descuento (ya neto). */
const subtotalLinea = (l: Pick<Line, "quantity" | "unit_value" | "discount">) =>
  roundCOP(Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0));

/** Todas las reglas activas de la empresa. */
export async function fetchProviderRules(companyId: string): Promise<ProviderRule[]> {
  if (!companyId) return [];
  const { data, error } = await supabase
    .from("provider_rules")
    .select("*")
    .eq("company_id", companyId)
    .eq("active", true)
    .order("provider_nit")
    .order("keyword");
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ProviderRule[];
}

const esTodas = (kw: string) => {
  const k = norm(kw).replace(/[()]/g, "");
  return k === "todas" || k === "todo" || k === "";
};

/**
 * Regla del proveedor que aplica a una descripción:
 * primero la palabra clave específica contenida en la descripción (la más larga
 * gana si hay varias), después la regla "(todas)".
 */
export function matchProviderRule(
  rules: ProviderRule[],
  providerNit?: string | null,
  description?: string | null,
): ProviderRule | null {
  const nit = norm(providerNit);
  if (!nit) return null;
  const delProveedor = rules.filter((r) => r.active && norm(r.provider_nit) === nit);
  if (delProveedor.length === 0) return null;
  const desc = norm(description);
  const especificas = delProveedor
    .filter((r) => !esTodas(r.keyword) && desc.includes(norm(r.keyword)))
    .sort((a, b) => norm(b.keyword).length - norm(a.keyword).length);
  return especificas[0] ?? delProveedor.find((r) => esTodas(r.keyword)) ?? null;
}

/**
 * P1/P2: asigna la cuenta de gasto de la regla del proveedor a las líneas sin
 * cuenta. Una cuenta fuera de los grupos válidos se descarta (la línea sigue
 * a la siguiente prioridad del motor). Devuelve las líneas y la regla usada.
 */
export function applyProviderRuleToLines(
  lines: Line[],
  rules: ProviderRule[],
  providerNit?: string | null,
): { lines: Line[]; rule: ProviderRule | null } {
  let reglaUsada: ProviderRule | null = null;
  const out = lines.map((l) => {
    if (l.account_code) return l;
    const rule = matchProviderRule(rules, providerNit, l.description);
    if (!rule) return l;
    if (!isValidExpenseAccount(rule.expense_account)) return l;
    reglaUsada = rule;
    return {
      ...l,
      account_code: String(rule.expense_account).trim(),
      account_name: l.account_name || rule.expense_account_name || null,
    };
  });
  return { lines: out, rule: reglaUsada };
}

/** Regla de encabezado del proveedor (para IVA, INC, retención y CxP): la "(todas)" o la más usada. */
export function headerRule(rules: ProviderRule[], providerNit?: string | null): ProviderRule | null {
  const nit = norm(providerNit);
  if (!nit) return null;
  const delProveedor = rules.filter((r) => r.active && norm(r.provider_nit) === nit);
  if (delProveedor.length === 0) return null;
  return (
    delProveedor.find((r) => esTodas(r.keyword)) ??
    [...delProveedor].sort((a, b) => b.times_used - a.times_used)[0] ??
    null
  );
}

export type RetencionRegla = {
  account_code: string;
  name: string;
  rate: number;
  base: number;
  amount: number;
};

/**
 * Retención en la fuente según la regla del proveedor.
 * Base "Subtotal" = suma de las líneas sin IVA. Base "AIU" = suma de las líneas
 * cuya descripción contiene ADMINISTRACION, UTILIDAD, IMPREVISTOS o AIU.
 * Valor = base × tarifa, a 2 decimales. Sin valor positivo no hay retención.
 */
export function retencionDesdeRegla(rule: ProviderRule | null, lines: Line[]): RetencionRegla | null {
  if (!rule?.retention_account || !rule.retention_rate) return null;
  const base =
    rule.retention_base === "AIU"
      ? roundCOP(lines.filter((l) => esLineaAIU(l.description)).reduce((s, l) => s + subtotalLinea(l), 0))
      : roundCOP(lines.reduce((s, l) => s + subtotalLinea(l), 0));
  const amount = roundCOP((base * Number(rule.retention_rate)) / 100);
  if (amount <= 0) return null;
  return {
    account_code: rule.retention_account,
    name: `Retefuente ${rule.retention_rate}%`,
    rate: Number(rule.retention_rate),
    base,
    amount,
  };
}

/**
 * Detalle del IVA según el tratamiento de la regla del proveedor:
 * - descontable: débito a la cuenta de la regla o 24081013.
 * - asumido: débito a 51157001 (o la cuenta de la regla).
 * - capitalizado: el IVA se suma a la MISMA cuenta de cada línea, en proporción.
 * - na: sin línea de IVA.
 */
export function ivaDetalleDesdeRegla(
  rule: ProviderRule | null,
  lines: Line[],
  ivaTotal: number,
): { account_code: string; account_name?: string | null; amount: number }[] | null {
  if (!rule || ivaTotal <= 0) return null;
  const total = roundCOP(ivaTotal);
  if (rule.iva_treatment === "na") return [];
  if (rule.iva_treatment === "capitalizado") {
    // Reparte el IVA entre las cuentas de las líneas en proporción a su subtotal.
    const porCuenta = new Map<string, number>();
    const baseTotal = roundCOP(lines.reduce((s, l) => s + subtotalLinea(l), 0));
    let repartido = 0;
    const conIva = lines.filter((l) => roundCOP(l.iva) > 0 && l.account_code);
    for (const l of conIva) {
      const code = String(l.account_code);
      const valor = roundCOP(l.iva);
      porCuenta.set(code, roundCOP((porCuenta.get(code) ?? 0) + valor));
      repartido = roundCOP(repartido + valor);
    }
    // Diferencia de centavos contra el IVA total: se suma a la cuenta mayor.
    const diff = roundCOP(total - repartido);
    if (diff !== 0 && porCuenta.size > 0) {
      const mayor = [...porCuenta.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      porCuenta.set(mayor, roundCOP(porCuenta.get(mayor)! + diff));
    }
    if (porCuenta.size === 0 && baseTotal >= 0) return null;
    return [...porCuenta.entries()].map(([account_code, amount]) => ({
      account_code,
      account_name: "IVA capitalizado",
      amount,
    }));
  }
  const cuenta =
    rule.iva_treatment === "asumido"
      ? rule.iva_account || CTA_IVA_ASUMIDO
      : rule.iva_account || CTA_IVA_DESCONTABLE;
  return [{ account_code: cuenta, account_name: "IVA", amount: total }];
}

/** Cuenta del INC: la de la regla del proveedor o 51158101. */
export function incAccountDesdeRegla(rule: ProviderRule | null): { code: string; name: string } {
  return { code: rule?.inc_account || CTA_INC_DEFAULT, name: "Impuesto al consumo" };
}

/**
 * Ajuste al peso del comprobante: diferencias de $1 o menos (centavos del XML o
 * recargo global) van a 42958101. Devuelve la línea de ajuste o null si cuadra;
 * si la diferencia es mayor a $1 devuelve `descuadre` con el valor.
 */
export function ajusteAlPeso(
  debito: number,
  credito: number,
): { linea: { account_code: string; account_name: string; debit: number; credit: number } | null; descuadre: number } {
  const diff = roundCOP(debito - credito);
  if (Math.abs(diff) < 0.005) return { linea: null, descuadre: 0 };
  if (Math.abs(diff) > 1) return { linea: null, descuadre: diff };
  return {
    linea: {
      account_code: CTA_AJUSTE_PESO,
      account_name: "Ajuste al peso",
      debit: diff < 0 ? Math.abs(diff) : 0,
      credit: diff > 0 ? diff : 0,
    },
    descuadre: 0,
  };
}

/** Marca el uso de la regla (frecuencia y último uso), sin bloquear la causación. */
export async function marcarUsoRegla(ruleId: string): Promise<void> {
  const { data } = await supabase.from("provider_rules").select("times_used").eq("id", ruleId).maybeSingle();
  await supabase
    .from("provider_rules")
    .update({
      times_used: Number((data as { times_used?: number } | null)?.times_used ?? 0) + 1,
      last_used_at: new Date().toISOString(),
    })
    .eq("id", ruleId);
}

/**
 * Aprendizaje P1: cuando el usuario corrige y aprueba un borrador de un
 * proveedor sin regla, se crea la regla para ese NIT y esa descripción.
 */
export async function aprenderReglaProveedor(params: {
  companyId: string;
  userId?: string | null;
  providerNit: string;
  providerName?: string | null;
  keyword: string;
  expenseAccount: string;
  expenseAccountName?: string | null;
}): Promise<void> {
  const nit = (params.providerNit ?? "").trim();
  if (!params.companyId || !nit || !isValidExpenseAccount(params.expenseAccount)) return;
  await supabase.from("provider_rules").upsert(
    {
      company_id: params.companyId,
      provider_nit: nit,
      provider_name: params.providerName ?? null,
      keyword: params.keyword.trim() || "(todas)",
      expense_account: params.expenseAccount.trim(),
      expense_account_name: params.expenseAccountName ?? null,
      source: "aprendida",
      active: true,
      created_by: params.userId ?? null,
    } as never,
    { onConflict: "company_id,provider_nit,keyword" },
  );
}
