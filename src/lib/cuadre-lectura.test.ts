import { describe, expect, it } from "vitest";
import { cuadrarIvaDeLineas } from "./cuadre-lectura";

const factura = (
  lines: Array<{ total: number; iva: number; iva_rate?: number | null }>,
  iva: number,
  total: number,
) => ({
  subtotal: lines.reduce((s, l) => s + l.total, 0),
  discount: 0,
  surcharge: 0,
  iva,
  impoconsumo: 0,
  total,
  lines,
});

describe("cuadrarIvaDeLineas", () => {
  it("corrige el IVA de los renglones cuando el encabezado cuadra y solo una combinación de tarifas lo explica", () => {
    // 100.000 al 19 % + 50.000 exento: la IA dejó el IVA del primer renglón en 0.
    const d = factura(
      [
        { total: 100000, iva: 0 },
        { total: 50000, iva: 0, iva_rate: 0 },
      ],
      19000,
      169000,
    );
    const r = cuadrarIvaDeLineas(d)!;
    expect(r.data.lines.map((l) => l.iva)).toEqual([19000, 0]);
    expect(r.data.lines[0]!.iva_rate).toBe(19);
    expect(r.motivo).toContain("19.000");
  });

  it("no hace nada si el IVA de los renglones ya cuadra o el encabezado no cuadra", () => {
    expect(cuadrarIvaDeLineas(factura([{ total: 100000, iva: 19000 }], 19000, 119000))).toBeNull();
    expect(cuadrarIvaDeLineas(factura([{ total: 100000, iva: 0 }], 19000, 150000))).toBeNull();
  });

  it("no adivina si varias combinaciones de tarifas explican el IVA", () => {
    // Dos renglones iguales: el IVA de 19.000 puede estar en cualquiera de los dos.
    const d = factura(
      [
        { total: 100000, iva: 0 },
        { total: 100000, iva: 0 },
      ],
      19000,
      219000,
    );
    expect(cuadrarIvaDeLineas(d)).toBeNull();
  });
});
