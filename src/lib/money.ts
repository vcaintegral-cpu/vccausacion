/**
 * Precisión monetaria ÚNICA de la aplicación (pesos colombianos).
 *
 * Regla: los valores contables y tributarios CONSERVAN sus decimales reales.
 * `roundCOP` no redondea a pesos enteros: normaliza a 2 decimales exactos para
 * evitar los errores de coma flotante de JavaScript (0.1 + 0.2). Así el valor en
 * pantalla, el asiento contable y el JSON de Siigo son idénticos y exactos.
 */
export function roundCOP(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  // Normalización a 2 decimales exactos. Nunca a pesos enteros, nunca truncar.
  const rounded = (Math.sign(n) * Math.round(Math.abs(n) * 100 + Number.EPSILON)) / 100;
  return rounded === 0 ? 0 : rounded;
}

/** Tolerancia de comparación: medio centavo. Por debajo de esto los valores son iguales. */
export const EPS_COP = 0.005;

/** ¿Dos valores monetarios son iguales con precisión de centavos? */
export const igualCOP = (a: unknown, b: unknown) => Math.abs(roundCOP(a) - roundCOP(b)) < EPS_COP;

/** ¿El valor es cero con precisión de centavos? */
export const esCeroCOP = (v: unknown) => Math.abs(roundCOP(v)) < EPS_COP;

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
