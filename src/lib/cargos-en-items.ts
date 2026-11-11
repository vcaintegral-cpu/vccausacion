// Cargos del documento repartidos en los ítems (función por empresa "cargos_en_items").
//
// Lo que la usuaria hacía a mano en "Corregir valores con motivo": el INC del documento
// (y el de cada renglón), el recargo global y el descuento global se reparten en los
// ítems ya facturados, en proporción a su valor, y el subtotal queda igual a la suma de
// los ítems. Así subtotal + IVA = total, sin cuadros de INC, recargo ni descuento.
// - Lo que suma (INC, recargo) aumenta el valor unitario del ítem.
// - Lo que resta (descuento global) disminuye el valor unitario del ítem (valor neto):
//   Siigo no descuenta items[].discount del total de la compra, así que el descuento no
//   puede viajar en la casilla de descuento sin descuadrar el documento.
// Solo se reparte lo que el documento explica (INC + recargo − descuento, con $1 de
// tolerancia); una diferencia que no corresponde a esos valores se deja para revisión.
// El IVA de cada ítem no cambia.
import { roundCOP } from "@/lib/money";

export type LineaValores = { subtotal: number; iva: number; impoconsumo: number; quantity?: number };
export type EncabezadoValores = {
  subtotal: number;
  iva: number;
  impoconsumo: number;
  discount: number;
  surcharge: number;
  total: number;
};

export type Reparto = {
  /** Valor sumado (positivo) o restado (negativo) a cada ítem, en pesos. */
  ajustes: number[];
  /** Nuevos subtotales de los ítems (pesos). */
  subtotales: number[];
  /** Encabezado normalizado: INC, recargo y descuento en 0; subtotal = suma de los ítems. */
  encabezado: EncabezadoValores;
  detalle: { inc: number; recargo: number; descuento: number };
};

/**
 * Reparte INC, recargo y descuento global en los ítems. Devuelve null si no hay nada que
 * repartir o si la diferencia del documento no corresponde a esos valores.
 */
export function repartirCargos(h: EncabezadoValores, lineas: LineaValores[]): Reparto | null {
  if (!lineas.length) return null;
  const incLineas = lineas.reduce((s, l) => s + Number(l.impoconsumo || 0), 0);
  const subLineas = lineas.reduce((s, l) => s + Number(l.subtotal || 0), 0);
  const ivaLineas = lineas.reduce((s, l) => s + Number(l.iva || 0), 0);
  // Lo que falta para que ítems + IVA = total (incluye el INC de los renglones, que se suma al ítem).
  const faltante = roundCOP(Number(h.total) - Number(h.iva) - subLineas);
  if (Math.abs(faltante) < 0.005 && Number(h.impoconsumo || 0) === 0 && !h.discount && !h.surcharge) return null;
  // Debe corresponder a lo que el documento declara: INC (renglones + documento) + recargo − descuento.
  const esperado = roundCOP(Number(h.impoconsumo || 0) + Number(h.surcharge || 0) - Number(h.discount || 0));
  if (Math.abs(faltante - esperado) > 1) return null;
  // El IVA debe ser el de los renglones (si el IVA no cuadra, se revisa aparte).
  if (Math.abs(roundCOP(ivaLineas) - roundCOP(h.iva)) > 1 && ivaLineas !== 0) return null;
  const base = subLineas > 0 ? subLineas : lineas.length;
  const ajustes = lineas.map((l) => roundCOP((faltante * (subLineas > 0 ? Number(l.subtotal || 0) : 1)) / base));
  // Centavos de diferencia al ítem de mayor valor.
  const resto = roundCOP(faltante - ajustes.reduce((s, a) => s + a, 0));
  if (resto !== 0) {
    let mayor = 0;
    lineas.forEach((l, i) => {
      if (Number(l.subtotal || 0) > Number(lineas[mayor]!.subtotal || 0)) mayor = i;
    });
    ajustes[mayor] = roundCOP(ajustes[mayor]! + resto);
  }
  const subtotales = lineas.map((l, i) => roundCOP(Number(l.subtotal || 0) + ajustes[i]!));
  if (subtotales.some((s) => s < 0)) return null; // un descuento mayor que el ítem no se reparte
  return {
    ajustes,
    subtotales,
    encabezado: {
      subtotal: roundCOP(subtotales.reduce((s, v) => s + v, 0)),
      iva: roundCOP(h.iva),
      impoconsumo: 0,
      discount: 0,
      surcharge: 0,
      total: roundCOP(h.total),
    },
    detalle: {
      inc: roundCOP(Number(h.impoconsumo || 0) || incLineas),
      recargo: roundCOP(h.surcharge || 0),
      descuento: roundCOP(h.discount || 0),
    },
  };
}

/** Texto para el motivo de la corrección y las alertas del borrador. */
export function motivoReparto(r: Reparto): string {
  const partes: string[] = [];
  if (r.detalle.inc) partes.push(`INC ${r.detalle.inc.toLocaleString("es-CO")}`);
  if (r.detalle.recargo) partes.push(`recargo ${r.detalle.recargo.toLocaleString("es-CO")}`);
  if (r.detalle.descuento) partes.push(`descuento global ${r.detalle.descuento.toLocaleString("es-CO")}`);
  return `Normalización automática (cargos en los ítems): ${partes.join(", ") || "diferencia del documento"} repartidos en los ítems en proporción a su valor; subtotal = suma de los ítems.`;
}

type LineaExtraida = { subtotal?: number; total: number; iva: number; impoconsumo: number; quantity: number; unit_value: number; discount: number };

/** Aplica el reparto a la factura leída (PDF o Excel): ítems con su nuevo valor, encabezado normalizado. */
export function aplicarRepartoExtraido<T extends EncabezadoValores & { lines: LineaExtraida[] }>(data: T, r: Reparto): T {
  return {
    ...data,
    ...r.encabezado,
    lines: data.lines.map((l, i) => {
      const subtotal = r.subtotales[i]!;
      const cantidad = Number(l.quantity || 0) || 1;
      return { ...l, subtotal, total: subtotal, impoconsumo: 0, unit_value: (subtotal + Number(l.discount || 0)) / cantidad };
    }),
  };
}

type Fuente = {
  subtotal: number; iva: number; impoconsumo: number; discount: number; surcharge: number; total: number;
  lines: Array<{ subtotal: number; iva: number; impoconsumo: number; iva_base: number | null; iva_rate: number | null }>;
};

/** Reparto sobre los valores de origen (en centavos), para corregir un borrador ya creado. */
export function repartoDeFuente<F extends Fuente>(s: F): { valores: F; reparto: Reparto } | null {
  const c = (v: number) => v / 100;
  const r = repartirCargos(
    { subtotal: c(s.subtotal), iva: c(s.iva), impoconsumo: c(s.impoconsumo), discount: c(s.discount), surcharge: c(s.surcharge ?? 0), total: c(s.total) },
    s.lines.map((l) => ({ subtotal: c(l.subtotal), iva: c(l.iva), impoconsumo: c(l.impoconsumo) })),
  );
  if (!r) return null;
  const cent = (v: number) => Math.round(v * 100);
  return {
    reparto: r,
    valores: {
      ...s,
      subtotal: cent(r.encabezado.subtotal),
      impoconsumo: 0,
      discount: 0,
      surcharge: 0,
      lines: s.lines.map((l, i) => ({ ...l, subtotal: cent(r.subtotales[i]!), impoconsumo: 0 })),
    },
  };
}
