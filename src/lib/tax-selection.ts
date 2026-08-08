// Fuente única de verdad para impuestos: la cuenta contable SIEMPRE proviene del
// registro exacto seleccionado en Administración → Retenciones (por ID),
// nunca de la tarifa, ni de coincidencias parciales, ni de cuentas por defecto.
import { resolveOperationalAccount, type PucAccount } from "@/lib/puc-hierarchy";

export type TaxRecord = {
  id: string;
  kind: string;
  name: string;
  rate: number;
  account_code?: string | null;
  siigo_id?: string | null;
  siigo_name?: string | null;
  active?: boolean;
};

export type TaxTrace = {
  tax_id: string;
  tax_type: string;
  tax_name: string;
  tax_rate: number;
  account_code: string | null;
  operational_account: string | null;
  siigo_id: string | null;
  siigo_name: string | null;
};

export const TAX_SIN_CUENTA =
  "El impuesto seleccionado no tiene una cuenta contable configurada. Configure la cuenta en Administración → Retenciones antes de continuar.";

/** Busca el impuesto por su identificador exacto. Nunca por tarifa ni por nombre. */
export function findTaxById<T extends { id?: string | number }>(taxes: T[], id?: string | null): T | null {
  if (!id) return null;
  return taxes.find((t) => String(t.id) === String(id)) ?? null;
}

export type TaxAccountResolution = {
  code: string;
  name: string | null;
  error: string | null;
};

/** Cuenta del impuesto: la configurada en su registro, validada contra el PUC de la empresa. */
export function resolveTaxAccount(tax: TaxRecord | null, puc: PucAccount[]): TaxAccountResolution {
  if (!tax) return { code: "", name: null, error: "No se seleccionó un impuesto." };
  const configurada = String(tax.account_code ?? "").trim();
  if (!configurada) return { code: "", name: null, error: `${tax.name}: ${TAX_SIN_CUENTA}` };
  if (puc.length === 0) return { code: configurada, name: tax.name, error: null };
  const r = resolveOperationalAccount(puc, configurada);
  if (!r.valid || !r.operationalAccount)
    return {
      code: configurada,
      name: tax.name,
      error: `${tax.name} (cuenta ${configurada}): ${r.message ?? "la cuenta no es operativa en Siigo."}`,
    };
  return { code: r.operationalAccount, name: r.operational?.name ?? tax.name, error: null };
}

export function taxTrace(tax: TaxRecord, operational: string | null): TaxTrace {
  return {
    tax_id: String(tax.id),
    tax_type: tax.kind,
    tax_name: tax.name,
    tax_rate: Number(tax.rate ?? 0),
    account_code: tax.account_code ?? null,
    operational_account: operational,
    siigo_id: tax.siigo_id ?? null,
    siigo_name: tax.siigo_name ?? null,
  };
}

export type IvaEntry = { tax: TaxRecord | null; amount: number };
export type IvaJournalGroup = { account_code: string; account_name: string | null; amount: number };

/**
 * Agrupa el IVA por la cuenta del impuesto realmente seleccionado en cada renglón.
 * Dos IVA del 19% con cuentas distintas generan dos renglones contables distintos.
 */
export function buildIvaGroups(entries: IvaEntry[], puc: PucAccount[]): { groups: IvaJournalGroup[]; errors: string[] } {
  const map = new Map<string, IvaJournalGroup>();
  const errors: string[] = [];
  for (const { tax, amount } of entries) {
    if (!amount) continue;
    if (!tax) {
      errors.push("Hay renglones con IVA sin impuesto seleccionado. Elija el impuesto exacto en el renglón.");
      const prev = map.get("");
      map.set("", { account_code: "", account_name: null, amount: (prev?.amount ?? 0) + amount });
      continue;
    }
    const r = resolveTaxAccount(tax, puc);
    if (r.error && !errors.includes(r.error)) errors.push(r.error);
    const key = r.code;
    const prev = map.get(key);
    map.set(key, { account_code: key, account_name: r.name ?? prev?.account_name ?? null, amount: (prev?.amount ?? 0) + amount });
  }
  return { groups: [...map.values()], errors };
}
