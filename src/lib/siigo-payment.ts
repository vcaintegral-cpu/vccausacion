// Forma de pago y cuenta por pagar enviadas a Siigo.
//
// Regla única e innegociable de este módulo:
//   TOTAL FACTURA − RETENCIONES = NETO A PAGAR = VALOR DE LA CUENTA POR PAGAR
//
// Aquí NO se toca la causación contable (cuentas de gasto, IVA, retenciones,
// proveedor, centro de costo ni CxP). Solo se construye y valida el objeto de
// pago que viaja a Siigo y su fecha de vencimiento.

import { roundCOP, EPS_COP } from "@/lib/money";
import { cop } from "@/lib/format";

/** Días de crédito según la condición de pago registrada en la factura. */
export function diasDeCredito(paymentForm: string | null | undefined): number | null {
  const texto = String(paymentForm ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!texto.trim()) return null;
  if (/contado|efectivo|inmediato/.test(texto)) return 0;
  const dias = /(\d{1,3})\s*d(i|í)?as?/.exec(texto)?.[1];
  if (dias) return Number(dias);
  if (/credito/.test(texto)) return 30;
  return null;
}

/** ¿La factura es de contado? */
export const esContado = (paymentForm: string | null | undefined) => diasDeCredito(paymentForm) === 0;

/** Normaliza cualquier fecha soportada al formato YYYY-MM-DD exigido por Siigo. */
export function fechaSiigo(valor: string | null | undefined): string | null {
  const texto = String(valor ?? "").trim();
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(texto)?.[1];
  if (iso) return iso;
  const dmy = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(texto);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return null;
}

const sumarDias = (fecha: string, dias: number) => {
  const base = new Date(`${fecha}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return fecha;
  base.setUTCDate(base.getUTCDate() + dias);
  return base.toISOString().slice(0, 10);
};

/**
 * Fecha de vencimiento real del documento.
 * 1) La fecha de vencimiento de la factura, si existe y no es anterior a la emisión.
 * 2) Fecha de la factura + días de crédito de la condición de pago.
 * 3) Fecha de la factura (contado).
 * NUNCA la fecha de creación del registro en el aplicativo.
 */
export function vencimientoDeFactura(params: {
  issueDate: string | null | undefined;
  dueDate: string | null | undefined;
  paymentForm: string | null | undefined;
  hoy?: string;
}): { dueDate: string; issueDate: string; dias: number; origen: string } {
  const issueDate =
    fechaSiigo(params.issueDate) ?? params.hoy ?? new Date().toISOString().slice(0, 10);
  const declarada = fechaSiigo(params.dueDate);
  const dias = diasDeCredito(params.paymentForm);
  if (declarada && declarada >= issueDate) {
    const delta = Math.round(
      (new Date(`${declarada}T00:00:00Z`).getTime() - new Date(`${issueDate}T00:00:00Z`).getTime()) / 86_400_000,
    );
    return { dueDate: declarada, issueDate, dias: delta, origen: "vencimiento de la factura" };
  }
  if (dias != null && dias > 0)
    return {
      dueDate: sumarDias(issueDate, dias),
      issueDate,
      dias,
      origen: "fecha de la factura + días de crédito",
    };
  return { dueDate: issueDate, issueDate, dias: 0, origen: "contado (vence el mismo día)" };
}

export type RetencionSiigo = {
  id: number | string;
  kind: string;
  tipo: string;
  /** Valor calculado por la aplicación a partir del documento. */
  value: number;
  /** Porcentaje oficial del impuesto en Siigo. */
  porcentaje: number;
  /** true cuando viaja en items[].taxes (Siigo la calcula renglón por renglón). */
  enRenglon: boolean;
};

export type BaseRenglon = { base: number };

/**
 * Valor que Siigo calculará para cada retención.
 *
 * Siigo NUNCA usa el valor que enviamos: recalcula con su porcentaje oficial.
 * - Retención de renglón (items[].taxes): la aplica renglón por renglón y
 *   redondea cada renglón. Sumar bases y calcular una sola vez produce
 *   diferencias de centavos que Siigo rechaza con invalid_total_payments.
 * - Retención de documento (retentions[]): la aplica sobre la base total
 *   (IVA para ReteIVA, base gravable para las demás).
 */
export function retencionCalculadaPorSiigo(params: {
  retencion: RetencionSiigo;
  renglones: BaseRenglon[];
  subtotal: number;
  iva: number;
}): number {
  const { retencion } = params;
  const pct = Number(retencion.porcentaje ?? 0);
  if (!(pct > 0)) return roundCOP(retencion.value);
  if (retencion.enRenglon) {
    return roundCOP(
      params.renglones.reduce((acc, r) => acc + roundCOP((Number(r.base ?? 0) * pct) / 100), 0),
    );
  }
  const base = retencion.kind === "reteiva" ? params.iva : params.subtotal;
  return roundCOP((base * pct) / 100);
}

export type ValidacionPago = {
  ok: boolean;
  totalFactura: number;
  totalRetenciones: number;
  netoAPagar: number;
  valorCxP: number;
  valorPago: number;
  diferencia: number;
  formaPago: string;
  vencimiento: string;
  fechaFactura: string;
  diasCredito: number;
  mensaje: string | null;
};

/**
 * Validación bloqueante previa al POST a Siigo.
 * Si el valor de la cuenta por pagar no es exactamente el neto a pagar,
 * la factura NO se envía.
 */
export function validarFormaPago(params: {
  subtotal: number;
  iva: number;
  otrosImpuestos?: number;
  descuentos?: number;
  totalRetenciones: number;
  /** Crédito de la cuenta por pagar en el asiento contable. */
  valorCxP: number;
  /** Valor que se enviará en payments[0].value. */
  valorPago: number;
  formaPago: string;
  fechaFactura: string;
  vencimiento: string;
  diasCredito: number;
}): ValidacionPago {
  const totalFactura = roundCOP(
    roundCOP(params.subtotal) + roundCOP(params.iva) + roundCOP(params.otrosImpuestos ?? 0) - roundCOP(params.descuentos ?? 0),
  );
  const totalRetenciones = roundCOP(params.totalRetenciones);
  const netoAPagar = roundCOP(totalFactura - totalRetenciones);
  const valorCxP = roundCOP(params.valorCxP);
  const diferencia = roundCOP(netoAPagar - valorCxP);
  const base: Omit<ValidacionPago, "ok" | "mensaje"> = {
    totalFactura,
    totalRetenciones,
    netoAPagar,
    valorCxP,
    valorPago: roundCOP(params.valorPago),
    diferencia,
    formaPago: params.formaPago,
    vencimiento: params.vencimiento,
    fechaFactura: params.fechaFactura,
    diasCredito: params.diasCredito,
  };
  if (Math.abs(diferencia) >= EPS_COP) {
    return {
      ...base,
      ok: false,
      mensaje: [
        "Factura no enviada a Siigo porque el valor de la cuenta por pagar no coincide con el neto a pagar.",
        `Total factura: ${cop(totalFactura)}`,
        `Total retenciones: ${cop(totalRetenciones)}`,
        `Neto a pagar: ${cop(netoAPagar)}`,
        `Valor CxP: ${cop(valorCxP)}`,
        `Diferencia: ${cop(diferencia)}`,
      ].join("\n"),
    };
  }
  if (params.vencimiento < params.fechaFactura) {
    return {
      ...base,
      ok: false,
      mensaje: [
        "Factura no enviada a Siigo porque la fecha de vencimiento es anterior a la fecha de la factura.",
        `Fecha factura: ${params.fechaFactura}`,
        `Fecha vencimiento: ${params.vencimiento}`,
        `Forma de pago: ${params.formaPago}`,
      ].join("\n"),
    };
  }
  return { ...base, ok: true, mensaje: null };
}

/** Mensaje al usuario cuando Siigo rechaza la conciliación de la forma de pago. */
export function mensajeDiferenciaPagos(v: ValidacionPago, detalleTecnico?: string): string {
  const lineas = [
    "Factura no causada en Siigo: diferencia en forma de pago.",
    `Total factura: ${cop(v.totalFactura)}`,
    `Retenciones: ${cop(v.totalRetenciones)}`,
    `Neto a pagar: ${cop(v.netoAPagar)}`,
    `Valor CxP enviado: ${cop(v.valorPago)}`,
    `Diferencia: ${cop(roundCOP(v.netoAPagar - v.valorPago))}`,
    `Forma de pago: ${v.formaPago}`,
    `Vencimiento: ${v.vencimiento}`,
  ];
  if (detalleTecnico) lineas.push("", "Ver detalle técnico", detalleTecnico);
  return lineas.join("\n");
}

/**
 * Conciliable exacto que Siigo informa en el propio error
 * ("The total purchase calculated is 4935450.96").
 */
export function conciliableInformadoPorSiigo(raw: string): number | null {
  const patrones = [
    /total purchase calculated is\s*(-?\d+(?:[.,]\d+)?)/i,
    /total (?:calculated|expected)[^\d-]*(-?\d+(?:[.,]\d+)?)/i,
    /payments?[^\d-]{0,40}?(?:must be|should be|debe ser)[^\d-]*(-?\d+(?:[.,]\d+)?)/i,
  ];
  for (const p of patrones) {
    const m = p.exec(raw)?.[1];
    if (m) {
      const n = Number(m.replace(",", "."));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}