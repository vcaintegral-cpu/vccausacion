import { describe, expect, it } from "vitest";
import { normalizarCentavos } from "./normalizar-centavos";

const linea = (subtotal: number, quantity = 1) => ({ subtotal, total: subtotal, quantity, unit_value: subtotal / quantity, discount: 0 });
const madecentro = (extra: Record<string, number> = {}) => ({
  subtotal: 42764.57,
  iva: 8125.28,
  impoconsumo: 0,
  discount: 11691.29,
  surcharge: 0,
  total: 50889.85,
  ...extra,
  lines: [linea(10899.87, 5), linea(10899.87, 5), linea(10899.87, 5), linea(3590.71), linea(6474.26)],
});

describe("normalizarCentavos", () => {
  it("lleva el centavo al renglón de mayor valor y anula el descuento informativo", () => {
    const r = normalizarCentavos(madecentro())!;
    expect(r.data.subtotal).toBe(42764.57);
    expect(r.data.discount).toBe(0);
    const suma = r.data.lines.reduce((s, l) => s + (l.subtotal ?? 0), 0);
    expect(Math.round(suma * 100)).toBe(4276457);
    expect(r.nota).toContain("Normalización de centavos");
  });
  it("subtotal bruto leído del PDF: usa el que implica el total", () => {
    const r = normalizarCentavos(madecentro({ subtotal: 54455.86, discount: 11691.28 }))!;
    expect(r.data.subtotal).toBe(42764.57);
    expect(r.data.discount).toBe(0);
  });
  it("no toca un descuento global real con renglones brutos", () => {
    const d = { subtotal: 1000, iva: 171, impoconsumo: 0, discount: 100, surcharge: 0, total: 1071, lines: [linea(1000)] };
    expect(normalizarCentavos(d)).toBeNull();
  });
  it("documento ya consistente: no cambia nada", () => {
    const d = { subtotal: 100, iva: 19, impoconsumo: 0, discount: 0, surcharge: 0, total: 119, lines: [linea(100)] };
    expect(normalizarCentavos(d)).toBeNull();
  });
  it("diferencia mayor al tope no se normaliza", () => {
    const d = { subtotal: 100, iva: 19, impoconsumo: 0, discount: 0, surcharge: 0, total: 119, lines: [linea(98)] };
    expect(normalizarCentavos(d)).toBeNull();
  });
});

describe("valores con más de 2 decimales (Excel de recibidos)", () => {
  it("normaliza usando los renglones ya redondeados a centavos", () => {
    const l = (v: number, q = 1) => ({ subtotal: v, total: v, quantity: q, unit_value: v / q, discount: 0 });
    const d = {
      subtotal: 42764.5666, iva: 8125.28, impoconsumo: 0, discount: 0, surcharge: 0, total: 50889.8466,
      lines: [l(10899.865, 5), l(10899.865, 5), l(10899.865, 5), l(3590.7083), l(6474.2566)],
    };
    const r = normalizarCentavos(d)!;
    expect(r).not.toBeNull();
    const suma = r.data.lines.reduce((s, x) => s + Math.round(Number(x.subtotal) * 100), 0);
    expect(suma).toBe(4276457);
    expect(r.data.subtotal).toBe(42764.57);
  });
});

describe("descuento por renglón ya incluido en el valor unitario", () => {
  it("anula el descuento del renglón si cantidad × unitario ya es el subtotal (Siigo lo restaría dos veces)", () => {
    const d = {
      subtotal: 200, iva: 38, impoconsumo: 0, discount: 0, surcharge: 0, total: 238,
      lines: [
        { subtotal: 100, total: 100, quantity: 1, unit_value: 100, discount: 20 },
        { subtotal: 100, total: 100, quantity: 2, unit_value: 50, discount: 0 },
      ],
    };
    const r = normalizarCentavos(d)!;
    expect(r.data.lines[0]!.discount).toBe(0);
    expect(r.nota).toContain("descuentos de renglón 20.00");
  });
  it("respeta el descuento cuando unitario bruto − descuento = subtotal", () => {
    const d = {
      subtotal: 100, iva: 19, impoconsumo: 0, discount: 0, surcharge: 0, total: 119,
      lines: [{ subtotal: 100, total: 100, quantity: 1, unit_value: 120, discount: 20 }],
    };
    expect(normalizarCentavos(d)).toBeNull();
  });
});
