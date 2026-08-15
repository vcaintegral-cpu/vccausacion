// Retenciones MÚLTIPLES por factura.
//
// Una factura puede tener simultáneamente Retefuente, ReteIVA y ReteICA.
// Cada una es independiente: tiene su propia base, tarifa, valor y cuenta
// contable, y ninguna sobrescribe a las otras. Este módulo es la fuente única
// de las retenciones de UNA factura en las pantallas de causación y revisión.

import type { Retenciones } from "@/lib/accounting";
import { roundCOP, sumCOP } from "@/lib/money";
import { resolveTaxAccount, type TaxRecord } from "@/lib/tax-selection";
import type { PucAccount } from "@/lib/puc-hierarchy";
import { RETENCION_KINDS, tarifaDeRetencion, type RetencionKind } from "@/lib/retenciones";

export type { RetencionKind };
export { RETENCION_KINDS };

export const RET_LABEL: Record<RetencionKind, string> = {
  retefuente: "Retención en la fuente",
  reteiva: "ReteIVA",
  reteica: "ReteICA",
};

export const RET_SHORT: Record<RetencionKind, string> = {
  retefuente: "Retefuente",
  reteiva: "ReteIVA",
  reteica: "ReteICA",
};

export type RetBlock = {
  /** Aplicar: Sí/No. Una retención no aplicada no genera línea ni cuenta. */
  apply: boolean;
  /** Impuesto configurado de la empresa (concepto/tipo de retención). */
  taxId: string;
  taxName: string;
  base: number;
  rate: number;
  amount: number;
  account_code: string;
  account_name: string | null;
  /** Concepto (Retefuente) o municipio (ReteICA); informativo. */
  concept: string;
};

export type RetBlocks = Record<RetencionKind, RetBlock>;

export type TaxLike = {
  id?: string | number | null;
  kind: string;
  name: string;
  rate: number;
  account_code?: string | null;
  siigo_id?: string | null;
  siigo_name?: string | null;
  active?: boolean;
};

const blankBlock = (): RetBlock => ({
  apply: false,
  taxId: "",
  taxName: "",
  base: 0,
  rate: 0,
  amount: 0,
  account_code: "",
  account_name: null,
  concept: "",
});

export const emptyRetBlocks = (): RetBlocks => ({
  retefuente: blankBlock(),
  reteiva: blankBlock(),
  reteica: blankBlock(),
});

const asRecord = (t: TaxLike): TaxRecord => ({
  id: String(t.id ?? ""),
  kind: String(t.kind),
  name: t.name,
  rate: Number(t.rate ?? 0),
  account_code: t.account_code ?? null,
  siigo_id: t.siigo_id ?? null,
  siigo_name: t.siigo_name ?? null,
  active: t.active !== false,
});

/** Base que corresponde a cada tipo de retención. */
export const baseDeKind = (kind: RetencionKind, baseGravable: number, ivaTotal: number) =>
  roundCOP(kind === "reteiva" ? ivaTotal : baseGravable);

/** Cuenta contable del impuesto configurado, resuelta al auxiliar operativo del PUC. */
export function cuentaDeImpuesto(tax: TaxLike | null, puc: PucAccount[]): { code: string; name: string | null } {
  if (!tax) return { code: "", name: null };
  const r = resolveTaxAccount(asRecord(tax), puc);
  if (r.error) return { code: "", name: null };
  return { code: r.code, name: r.name ?? tax.name };
}

/**
 * Construye las tres retenciones a partir de lo que reporta el documento.
 * Los tipos con valor 0 quedan sin aplicar: no tocan ninguna cuenta.
 */
export function seedRetBlocks(params: {
  reportado: Partial<Record<RetencionKind, number>>;
  baseGravable: number;
  ivaTotal: number;
  taxes: TaxLike[];
  puc: PucAccount[];
}): RetBlocks {
  const out = emptyRetBlocks();
  for (const kind of RETENCION_KINDS) {
    const amount = roundCOP(params.reportado[kind] ?? 0);
    const base = baseDeKind(kind, params.baseGravable, params.ivaTotal);
    out[kind].base = base;
    if (!(amount > 0)) continue;
    const { tax } = tarifaDeRetencion({
      kind,
      amount,
      baseGravable: params.baseGravable,
      ivaTotal: params.ivaTotal,
      taxes: params.taxes as never,
    });
    const cuenta = cuentaDeImpuesto((tax as TaxLike | null) ?? null, params.puc);
    out[kind] = {
      apply: true,
      taxId: tax ? String((tax as TaxLike).id ?? "") : "",
      taxName: tax ? String((tax as TaxLike).name) : "",
      base,
      rate: tax ? Number((tax as TaxLike).rate ?? 0) : base > 0 ? roundCOP((amount / base) * 100) : 0,
      amount,
      account_code: cuenta.code,
      account_name: cuenta.name,
      concept: "",
    };
  }
  return out;
}

/** Recalcula el valor de una retención con su base y su tarifa. */
export const valorDeBloque = (block: RetBlock) => roundCOP((Number(block.base || 0) * Number(block.rate || 0)) / 100);

/** Aplica un impuesto configurado a un bloque, sin tocar los demás bloques. */
export function aplicarImpuesto(
  block: RetBlock,
  tax: TaxLike | null,
  puc: PucAccount[],
): RetBlock {
  if (!tax) return { ...block, taxId: "", taxName: "", rate: 0, amount: 0, account_code: "", account_name: null };
  const cuenta = cuentaDeImpuesto(tax, puc);
  const rate = Number(tax.rate ?? 0);
  const next: RetBlock = {
    ...block,
    apply: true,
    taxId: String(tax.id ?? ""),
    taxName: tax.name,
    rate,
    account_code: cuenta.code,
    account_name: cuenta.name,
  };
  return { ...next, amount: valorDeBloque(next) };
}

/** Retenciones reales del asiento: solo las aplicadas y con valor > 0. */
export function buildRetenciones(blocks: RetBlocks): Retenciones {
  const out: Retenciones = { retefuente: 0, reteiva: 0, reteica: 0, autorretencion: 0, detalle: [] };
  for (const kind of RETENCION_KINDS) {
    const b = blocks[kind];
    const amount = roundCOP(b.amount);
    if (!b.apply || !(amount > 0)) continue;
    out[kind] += amount;
    out.detalle.push({
      kind,
      name: b.taxName || RET_SHORT[kind],
      rate: Number(b.rate || 0),
      base: roundCOP(b.base),
      amount,
      account_code: b.account_code || null,
    });
  }
  return out;
}

/** Total retenido: solo suma las retenciones realmente aplicadas. */
export const totalRetenciones = (blocks: RetBlocks) =>
  sumCOP(...RETENCION_KINDS.map((k) => (blocks[k].apply ? blocks[k].amount : 0)));

/** Validaciones: una retención aplicada necesita valor y cuenta contable propia. */
export function erroresRetenciones(blocks: RetBlocks): string[] {
  const out: string[] = [];
  for (const kind of RETENCION_KINDS) {
    const b = blocks[kind];
    if (!b.apply) continue;
    if (!(roundCOP(b.amount) > 0)) {
      out.push(`${RET_SHORT[kind]}: está marcada como aplicada pero su valor es 0. Retírala o corrige el valor.`);
      continue;
    }
    if (!String(b.account_code ?? "").trim())
      out.push(`${RET_SHORT[kind]}: falta la cuenta contable. Selecciónala o configura el impuesto en Administración → Retenciones.`);
  }
  const codes = RETENCION_KINDS.filter((k) => blocks[k].apply && blocks[k].account_code).map((k) => blocks[k].account_code);
  if (new Set(codes).size !== codes.length)
    out.push("Dos retenciones distintas están usando la misma cuenta contable. Cada retención debe tener su propia cuenta.");
  return out;
}

/** ¿Hay al menos una retención aplicada? */
export const hayRetenciones = (blocks: RetBlocks) => RETENCION_KINDS.some((k) => blocks[k].apply && blocks[k].amount > 0);
