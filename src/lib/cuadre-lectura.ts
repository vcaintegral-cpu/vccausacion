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
    if (soluciones.length > 1) return;
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
  // Una sola combinación de tarifas explica el IVA del documento: es la correcta.
  if (soluciones.length !== 1) return null;
  const tarifas = soluciones[0]!;
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
