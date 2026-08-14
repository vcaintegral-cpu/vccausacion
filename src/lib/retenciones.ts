// Motor único de retenciones de la causación.
//
// Reglas invariables:
// 1. Una retención SOLO existe si la factura la reporta con valor > 0.
// 2. La cuenta contable de cada retención proviene EXCLUSIVAMENTE del impuesto
//    configurado de ese tipo (Administración → Retenciones) y se resuelve al
//    auxiliar operativo del PUC de la empresa.
// 3. Nunca se usa una cuenta mayor (2365, 2367, 2368) como cuenta final ni se
//    elige un auxiliar al azar: si es ambiguo, la línea queda sin cuenta y se
//    reporta el motivo para revisión manual.
// 4. Cada factura resuelve sus retenciones desde cero: no se comparte estado
//    entre facturas del mismo lote.

import type { Retenciones, TaxRate } from "@/lib/accounting";
import { roundCOP } from "@/lib/money";
import { resolveTaxAccount, type TaxRecord } from "@/lib/tax-selection";
import type { PucAccount } from "@/lib/puc-hierarchy";

export type RetencionKind = "retefuente" | "reteiva" | "reteica";
export const RETENCION_KINDS: RetencionKind[] = ["retefuente", "reteiva", "reteica"];

export type RetencionesReportadas = Record<RetencionKind, number>;

export const sinRetencionesReportadas = (): RetencionesReportadas => ({
  retefuente: 0,
  reteiva: 0,
  reteica: 0,
});

const etiqueta: Record<RetencionKind, string> = {
  retefuente: "Retefuente",
  reteiva: "ReteIVA",
  reteica: "ReteICA",
};

type TaxLike = TaxRate & { id?: string | number | null; siigo_id?: string | null; siigo_name?: string | null };

const asRecord = (t: TaxLike): TaxRecord => ({
  id: String(t.id ?? ""),
  kind: String(t.kind),
  name: t.name,
  rate: Number(t.rate ?? 0),
  account_code: t.account_code ?? null,
  siigo_id: t.siigo_id ?? null,
  siigo_name: t.siigo_name ?? null,
  active: t.active,
});

/** Valor teórico de una tarifa sobre la base que le corresponde. */
export function valorTarifa(tax: TaxLike, baseGravable: number, ivaTotal: number): number {
  const base = String(tax.kind) === "reteiva" ? ivaTotal : baseGravable;
  return roundCOP((base * Number(tax.rate ?? 0)) / 100);
}

/** Impuesto configurado que corresponde a un valor retenido concreto. */
export function tarifaDeRetencion(params: {
  kind: RetencionKind;
  amount: number;
  baseGravable: number;
  ivaTotal: number;
  taxes: TaxLike[];
}): { tax: TaxLike | null; error: string | null } {
  const candidatos = params.taxes.filter((t) => t.active !== false && String(t.kind) === params.kind);
  if (candidatos.length === 0)
    return {
      tax: null,
      error: `${etiqueta[params.kind]}: la empresa no tiene configurado ningún impuesto de este tipo. Configúralo en Administración → Retenciones.`,
    };
  const exacto = candidatos.find(
    (t) => Math.abs(valorTarifa(t, params.baseGravable, params.ivaTotal) - params.amount) <= 1,
  );
  if (exacto) return { tax: exacto, error: null };
  if (candidatos.length === 1) return { tax: candidatos[0]!, error: null };
  return {
    tax: null,
    error: `${etiqueta[params.kind]}: la factura retuvo ${params.amount} y ninguna tarifa configurada coincide. Selecciona el impuesto correcto en la revisión.`,
  };
}

/**
 * Construye las retenciones REALES de UNA factura.
 * Los tipos con valor 0 no generan línea, no resuelven cuenta y no se validan.
 */
export function resolverRetenciones(params: {
  reportado: RetencionesReportadas;
  baseGravable: number;
  ivaTotal: number;
  taxes: TaxLike[];
  puc?: PucAccount[];
}): { retenciones: Retenciones; errores: string[] } {
  const retenciones: Retenciones = {
    retefuente: 0,
    reteiva: 0,
    reteica: 0,
    autorretencion: 0,
    detalle: [],
  };
  const errores: string[] = [];
  const puc = params.puc ?? [];

  for (const kind of RETENCION_KINDS) {
    const amount = roundCOP(Number(params.reportado[kind] ?? 0));
    // Sin valor retenido no hay hecho económico: no se toca ninguna cuenta.
    if (!(amount > 0)) continue;

    const { tax, error } = tarifaDeRetencion({
      kind,
      amount,
      baseGravable: params.baseGravable,
      ivaTotal: params.ivaTotal,
      taxes: params.taxes,
    });
    if (error) errores.push(error);

    let cuenta = "";
    let nombre = tax?.name ?? `${etiqueta[kind]} según factura (revisar tarifa)`;
    if (tax) {
      const resolucion = resolveTaxAccount(asRecord(tax), puc);
      if (resolucion.error) errores.push(resolucion.error);
      else {
        cuenta = resolucion.code;
        nombre = resolucion.name ?? tax.name;
      }
    }

    retenciones[kind] += amount;
    retenciones.detalle.push({
      kind,
      name: nombre,
      rate: Number(tax?.rate ?? 0),
      base: kind === "reteiva" ? params.ivaTotal : params.baseGravable,
      amount,
      account_code: cuenta || null,
    });
  }

  return { retenciones, errores };
}

/**
 * Lee del documento cuánto se retuvo por cada tipo.
 * Prioridad: valores del encabezado leídos de la factura; si no vienen, el total
 * retenido en los renglones, clasificado por la tarifa que coincida exactamente.
 */
export function retencionesReportadas(params: {
  header: { retefuente?: number | null; reteiva?: number | null; reteica?: number | null };
  lineRetention: number;
  baseGravable: number;
  ivaTotal: number;
  taxes: TaxLike[];
}): RetencionesReportadas {
  const out = sinRetencionesReportadas();
  for (const kind of RETENCION_KINDS) out[kind] = roundCOP(Number(params.header[kind] ?? 0));
  if (out.retefuente > 0 || out.reteiva > 0 || out.reteica > 0) return out;

  const total = roundCOP(params.lineRetention);
  if (!(total > 0)) return out;

  const candidato = params.taxes.find(
    (t) =>
      t.active !== false &&
      RETENCION_KINDS.includes(String(t.kind) as RetencionKind) &&
      Math.abs(valorTarifa(t, params.baseGravable, params.ivaTotal) - total) <= 1,
  );
  const kind = (candidato ? String(candidato.kind) : "retefuente") as RetencionKind;
  out[kind] = total;
  return out;
}
