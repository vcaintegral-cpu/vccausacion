import { roundCOP } from "@/lib/money";

export type Rule = {
  id?: string;
  match_type: string; // 'keyword' | 'nit'
  match_value: string;
  account_code: string;
  account_name?: string | null;
  priority: number;
};

export type TaxRate = {
  id?: string;
  kind: string; // iva | retefuente | reteiva | reteica | autorretencion
  name: string;
  rate: number;
  min_base: number;
  account_code?: string | null;
  active: boolean;
};

export type Line = {
  code?: string | null;
  description: string;
  quantity: number;
  unit_value: number;
  discount: number;
  iva: number;
  retention: number;
  impoconsumo: number;
  total: number;
  account_code?: string | null;
  account_name?: string | null;
  /** producto | servicio | gasto | activo (tipo de Siigo) */
  item_type?: string;
};

export type ProviderConfig = {
  nit?: string | null;
  default_expense_account?: string | null;
  default_payable_account?: string | null;
  default_iva_account?: string | null;
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/** Cuenta sugerida: 1) regla por NIT del proveedor, 2) regla por palabra clave, 3) cuenta por defecto del tercero. */
export function suggestAccount(
  description: string,
  rules: Rule[],
  provider?: ProviderConfig | null,
): { code: string; name: string | null; source: string } {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);
  const nit = provider?.nit ? norm(provider.nit) : null;

  if (nit) {
    const byNit = ordered.find((r) => r.match_type === "nit" && norm(r.match_value) === nit);
    if (byNit) return { code: byNit.account_code, name: byNit.account_name ?? null, source: "regla por proveedor" };
  }
  const text = norm(description || "");
  const byWord = ordered.find((r) => r.match_type === "keyword" && text.includes(norm(r.match_value)));
  if (byWord) return { code: byWord.account_code, name: byWord.account_name ?? null, source: "regla por palabra clave" };

  if (provider?.default_expense_account)
    return { code: provider.default_expense_account, name: null, source: "cuenta del tercero" };

  return { code: "519595", name: "Gastos diversos", source: "cuenta por defecto" };
}

export function applyRulesToLines(lines: Line[], rules: Rule[], provider?: ProviderConfig | null): Line[] {
  return lines.map((l) => {
    if (l.account_code) return l;
    const s = suggestAccount(l.description ?? "", rules, provider);
    return { ...l, account_code: s.code, account_name: l.account_name ?? s.name };
  });
}

/** Prefijos que NUNCA pueden ser la contrapartida de la obligación (retenciones e impuestos). */
const PAYABLE_PROHIBIDOS = ["2365", "2367", "2368", "2404", "2408"];

/** ¿El código es una cuenta por pagar válida (proveedores 22 u otros pasivos 23)? */
export function isPayableCode(code?: string | null): boolean {
  const c = String(code ?? "").trim();
  if (!/^\d+$/.test(c)) return false;
  if (!(c.startsWith("22") || c.startsWith("23"))) return false;
  return !PAYABLE_PROHIBIDOS.some((p) => c.startsWith(p));
}

export type Retenciones = {
  retefuente: number;
  reteiva: number;
  reteica: number;
  autorretencion: number;
  detalle: { kind: string; name: string; rate: number; base: number; amount: number; account_code: string | null }[];
};

/** Redondeo único de la aplicación: pesos colombianos sin decimales. */
const round = roundCOP;

// Las retenciones de una factura se resuelven en src/lib/retenciones.ts:
// solo existen si el documento las reporta con valor > 0 y su cuenta proviene
// del impuesto configurado de ese tipo, nunca de una cuenta mayor genérica.

export type JournalLine = {
  account_code: string;
  account_name: string | null;
  debit: number;
  credit: number;
  cost_center?: string | null;
};

export function buildJournal(params: {
  lines: Line[];
  iva: number;
  impoconsumo?: number;
  retenciones: Retenciones;
  provider?: ProviderConfig | null;
  costCenter?: string | null;
  /** Detalle del IVA por cuenta del impuesto seleccionado (fuente: Administración → Retenciones). */
  ivaDetalle?: { account_code: string; account_name?: string | null; amount: number }[];
  /**
   * Cuenta de la obligación por pagar (grupos 22 o 23) resuelta por empresa y proveedor.
   * Una factura de compra NUNCA se causa contra bancos, caja ni cuentas de pago.
   */
  payableAccount?: { code: string; name?: string | null } | null;
}): JournalLine[] {
  const { lines, iva, retenciones, provider, costCenter, ivaDetalle } = params;
  const impoconsumo = params.impoconsumo ?? 0;
  const out: JournalLine[] = [];

  const grouped = new Map<string, { name: string | null; value: number }>();
  for (const l of lines) {
    const code = l.account_code || "519595";
    const prev = grouped.get(code);
    const value = Number(l.quantity ?? 0) * Number(l.unit_value ?? 0) - Number(l.discount ?? 0);
    grouped.set(code, { name: l.account_name ?? prev?.name ?? null, value: (prev?.value ?? 0) + value });
  }
  for (const [code, g] of grouped)
    out.push({ account_code: code, account_name: g.name, debit: round(g.value), credit: 0, cost_center: costCenter ?? null });

  // El IVA usa EXCLUSIVAMENTE la cuenta del impuesto seleccionado; nunca una cuenta por defecto.
  if (ivaDetalle && ivaDetalle.length > 0) {
    for (const d of ivaDetalle) {
      if (!d.amount) continue;
      out.push({
        account_code: d.account_code,
        account_name: d.account_name ?? null,
        debit: round(d.amount),
        credit: 0,
        cost_center: costCenter ?? null,
      });
    }
  } else if (iva > 0) {
    out.push({ account_code: "", account_name: "IVA sin impuesto seleccionado", debit: round(iva), credit: 0, cost_center: costCenter ?? null });
  }

  if (impoconsumo > 0)
    out.push({
      // El impoconsumo usa la cuenta operativa (auxiliar) configurada, nunca una cuenta mayor.
      account_code: params.impoconsumoAccount?.code || "521595",
      account_name: params.impoconsumoAccount?.name ?? "Impoconsumo",
      debit: round(impoconsumo),
      credit: 0,
      cost_center: costCenter ?? null,
    });

  const totalDebito = out.reduce((s, l) => s + l.debit, 0);
  const totalRet = retenciones.retefuente + retenciones.reteiva + retenciones.reteica;

  for (const d of retenciones.detalle) {
    if (d.kind === "autorretencion") continue;
    // Una retención en cero no existe contablemente: no genera línea ni cuenta.
    if (round(d.amount) <= 0) continue;
    out.push({
      // La cuenta sale del registro exacto de la retención seleccionada.
      account_code: d.account_code ?? "",
      account_name: d.name,
      debit: 0,
      credit: d.amount,
      cost_center: costCenter ?? null,
    });
  }

  const payable = [
    params.payableAccount?.code,
    provider?.default_payable_account,
  ].find((c) => isPayableCode(c));
  out.push({
    account_code: payable ?? "220505",
    account_name:
      (payable && payable === params.payableAccount?.code ? params.payableAccount?.name : null) ||
      "Cuentas por pagar",
    debit: 0,
    credit: round(totalDebito - totalRet),
    cost_center: costCenter ?? null,
  });

  return out;
}

export const totals = (j: JournalLine[]) => {
  const debito = j.reduce((s, l) => s + Number(l.debit || 0), 0);
  const credito = j.reduce((s, l) => s + Number(l.credit || 0), 0);
  return { debito, credito, diferencia: debito - credito };
};