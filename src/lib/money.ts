/**
 * Redondeo monetario ÚNICO de la aplicación (pesos colombianos).
 *
 * Regla: las facturas de compra y gasto en COP NO manejan decimales. Todo valor
 * que se guarde, se contabilice o se envíe a Siigo pasa por `roundCOP`, de modo
 * que el valor en pantalla, el asiento contable y el JSON de Siigo sean idénticos.
 */
export function roundCOP(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  // Redondeo al peso más cercano (0,5 sube). Nunca truncar.
  const rounded = Math.sign(n) * Math.round(Math.abs(n) + Number.EPSILON);
  return rounded === 0 ? 0 : rounded;
}

/** Suma de valores monetarios, redondeando cada componente antes de sumar. */
export const sumCOP = (...values: unknown[]) => values.reduce<number>((acc, v) => acc + roundCOP(v), 0);

/** Total de retenciones ya redondeadas al peso. */
export const totalRetencionesCOP = (r: {
  retefuente?: unknown;
  reteiva?: unknown;
  reteica?: unknown;
  otras?: unknown;
}) => sumCOP(r.retefuente ?? 0, r.reteiva ?? 0, r.reteica ?? 0, r.otras ?? 0);

/**
 * NETO A PAGAR = TOTAL FACTURA − RETENCIONES, calculado SIEMPRE con valores ya
 * redondeados. Este valor es a la vez la cuenta por pagar y la forma de pago.
 */
export const netoAPagarCOP = (totalFactura: unknown, retenciones: unknown) =>
  roundCOP(roundCOP(totalFactura) - roundCOP(retenciones));
