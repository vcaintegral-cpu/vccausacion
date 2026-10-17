/**
 * Precisión monetaria ÚNICA de la aplicación (pesos colombianos).
 *
 * Regla: los valores contables y tributarios CONSERVAN sus decimales reales.
 * `roundCOP` no redondea a pesos enteros: normaliza a 2 decimales exactos para
 * evitar los errores de coma flotante de JavaScript (0.1 + 0.2). Así el valor en
 * pantalla, el asiento contable y el JSON de Siigo son idénticos y exactos.
 */
export function roundCOP(value: unknown): number {
  return toCents(value) / 100;
}

/** Convierte importes colombianos o números JSON a centavos sin sumar flotantes. */
export function toCents(value: unknown): number {
  let text = String(value ?? 0).trim().replace(/[$\s]/g, "");
  if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".");
  else if (typeof value === "string" && /^-?\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, "");
  if (/e/i.test(text)) text = Number(text).toFixed(8);
  const match = text.match(/^(-?)(\d+)(?:\.(\d*))?$/);
  if (!match) return 0;
  const fraction = (match[3] ?? "").padEnd(3, "0");
  const cents = Number(match[2]) * 100 + Number(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1 : 0);
  if (!Number.isSafeInteger(cents)) throw new Error("Importe fuera del rango permitido.");
  return match[1] ? -cents : cents;
}

export const sumCents = (values: unknown[]) => values.reduce<number>((sum, value) => sum + toCents(value), 0);

/** Tolerancia de comparación: medio centavo. Por debajo de esto los valores son iguales. */
export const EPS_COP = 0.005;

/** ¿Dos valores monetarios son iguales con precisión de centavos? */
export const igualCOP = (a: unknown, b: unknown) => Math.abs(roundCOP(a) - roundCOP(b)) < EPS_COP;

/** ¿El valor es cero con precisión de centavos? */
export const esCeroCOP = (v: unknown) => Math.abs(roundCOP(v)) < EPS_COP;

/** Suma de valores monetarios, redondeando cada componente antes de sumar. */
export const sumCOP = (...values: unknown[]) => sumCents(values) / 100;

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
  (toCents(totalFactura) - toCents(retenciones)) / 100;
