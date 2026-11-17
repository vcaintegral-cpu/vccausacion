// Cuadre del IVA de los renglones de una factura leída (PDF con IA).
//
// La IA a veces lee mal el IVA de un renglón (lo omite, lo duplica o lo pone en otra línea) aunque el
// ENCABEZADO de la factura sí sea correcto y cuadre (subtotal − descuento + recargo + IVA + INC = total).
// Si el IVA del encabezado cuadra con el total y existe UNA sola forma de asignar tarifas (0 %, 5 %, 19 % o
// la tarifa leída) a los renglones que reproduzca ese IVA, se corrigen los IVA de los renglones. Si hay
// varias formas o ninguna, no se toca y el borrador queda por revisión.
import { roundCOP } from "@/lib/money";

export type LineaIvaLeida = {
  subtotal?: number;
  total: number;
  iva: number;
  iva_rate?: number | null;
  iva_base?: number | null;
};

export type EncabezadoIvaLeido = {
  subtotal: number;
  discount: number;
  surcharge?: number;
  iva: number;
  impoconsumo: number;
  total: number;
};

const TARIFAS = [0, 5, 19];
const MAX_RENGLONES = 12;

export function cuadrarIvaDeLineas<T extends EncabezadoIvaLeido & { lines: LineaIvaLeida[] }>(
  d: T,
): { data: T; motivo: string } | null {
  const lineas = d.lines;
  if (!lineas.length || lineas.length > MAX_RENGLONES) return null;
  const sumaActual = roundCOP(lineas.reduce((s, l) => s + Number(l.iva || 0), 0));
  const ivaDoc = roundCOP(d.iva);
  const tarifaLeida = (l: LineaIvaLeida) =>
    l.iva_rate !== null &&
    l.iva_rate !== undefined &&
    Number.isFinite(Number(l.iva_rate)) &&
    Number(l.iva_rate) >= 0
      ? Number(l.iva_rate)
      : null;
  // Con la tarifa leída en TODOS los renglones, también se corrige un IVA bien sumado pero mal repartido
  // (p. ej. IVA en un renglón exento y sin IVA en el gravado): cada renglón lleva base × tarifa.
  const conTarifas = lineas.every((l) => tarifaLeida(l) !== null);
  const repartoCorrecto =
    !conTarifas ||
    lineas.every(
      (l) =>
        Math.abs(
          roundCOP((roundCOP(l.subtotal ?? l.total) * tarifaLeida(l)!) / 100) - roundCOP(l.iva),
        ) <= 1,
    );
  if (Math.abs(sumaActual - ivaDoc) <= 1 && repartoCorrecto) return null;
  // El encabezado debe cuadrar solo: si no, la lectura es dudosa y se revisa a mano.
  const cuadra =
    roundCOP(d.subtotal - d.discount + Number(d.surcharge ?? 0) + ivaDoc + d.impoconsumo) -
    roundCOP(d.total);
  if (Math.abs(cuadra) > 1) return null;

  const bases = lineas.map((l) => roundCOP(l.subtotal ?? l.total));
  const opciones = lineas.map((l) => {
    const leida = Number(l.iva_rate);
    return Number.isFinite(leida) && leida >= 0 && l.iva_rate !== null && l.iva_rate !== undefined
      ? [leida]
      : TARIFAS;
  });
  const soluciones: number[][] = [];
  const actual: number[] = [];
  const buscar = (i: number, suma: number) => {
    if (soluciones.length > 8) return;
    if (i === lineas.length) {
      if (Math.abs(suma - ivaDoc) <= 1) soluciones.push([...actual]);
      return;
    }
    for (const t of opciones[i]!) {
      actual[i] = t;
      buscar(i + 1, suma + roundCOP((bases[i]! * t) / 100));
    }
  };
  buscar(0, 0);
  // Una sola combinación de tarifas explica el IVA del documento: es la correcta. Si hay varias, la de TODOS los
  // renglones gravados a una misma tarifa (la factura sin renglones exentos) es la más probable, solo si es única.
  let elegida = soluciones.length === 1 ? soluciones[0]! : null;
  if (!elegida && soluciones.length > 1) {
    const uniformes = soluciones.filter((t) => t[0]! > 0 && t.every((x) => x === t[0]));
    if (uniformes.length === 1) elegida = uniformes[0]!;
  }
  if (!elegida) return null;
  const tarifas = elegida;
  const ivas = bases.map((b, i) => roundCOP((b * tarifas[i]!) / 100));
  const resto = roundCOP(ivaDoc - ivas.reduce((s, v) => s + v, 0));
  if (resto !== 0) {
    let mayor = 0;
    ivas.forEach((v, i) => {
      if (v > ivas[mayor]!) mayor = i;
    });
    ivas[mayor] = roundCOP(ivas[mayor]! + resto);
  }
  return {
    data: {
      ...d,
      lines: lineas.map((l, i) => ({
        ...l,
        iva: ivas[i]!,
        iva_rate: tarifas[i]!,
        iva_base: bases[i]!,
      })),
    },
    motivo: `IVA de los renglones corregido para cuadrar con el IVA de la factura (${ivaDoc.toLocaleString("es-CO")}): tarifas ${tarifas.join("%, ")}%.`,
  };
}

/**
 * Por qué no se pudo cuadrar el IVA de los renglones con el del encabezado (null si ya cuadra o no aplica).
 * Va en el motivo de revisión del borrador para que la usuaria sepa qué revisar.
 */
export function diagnosticarIva<T extends EncabezadoIvaLeido & { lines: LineaIvaLeida[] }>(
  d: T,
): string | null {
  const lineas = d.lines;
  if (!lineas.length) return null;
  const suma = roundCOP(lineas.reduce((s, l) => s + Number(l.iva || 0), 0));
  const ivaDoc = roundCOP(d.iva);
  if (Math.abs(suma - ivaDoc) <= 1) return null;
  const dif =
    roundCOP(d.subtotal - d.discount + Number(d.surcharge ?? 0) + ivaDoc + d.impoconsumo) -
    roundCOP(d.total);
  const f = (n: number) => Math.abs(n).toLocaleString("es-CO");
  if (Math.abs(dif) > 1)
    return `IVA de los renglones (${f(suma)}) distinto al del encabezado (${f(ivaDoc)}) y el encabezado no cuadra con el total (diferencia ${f(dif)}): revise los valores del PDF.`;
  return `IVA de los renglones (${f(suma)}) distinto al del encabezado (${f(ivaDoc)}) y no hay una única forma de repartirlo entre los renglones gravados: marque con el lápiz cuáles llevan IVA.`;
}
