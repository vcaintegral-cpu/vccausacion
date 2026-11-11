import { describe, expect, it } from "vitest";

import { funcionActiva } from "@/empresas/registro";
import { aplicarRepartoExtraido, repartirCargos, repartoDeFuente } from "./cargos-en-items";
import { sourceErrors } from "./source-values";

describe("cargos del documento repartidos en los ítems (LED LIGHTS)", () => {
  it("función encendida solo para LED LIGHTS", () => {
    expect(funcionActiva("900470166", "cargos_en_items")).toBe(true);
    expect(funcionActiva("800212838", "cargos_en_items")).toBe(false);
  });

  it("INC del documento + recargo − descuento global, proporcional al valor de cada ítem", () => {
    // Ítems 300.000 y 100.000 (IVA 0); INC 32.000, recargo 8.000, descuento global 20.000.
    // Total = 400.000 + 32.000 + 8.000 − 20.000 = 420.000.
    const r = repartirCargos(
      { subtotal: 400000, iva: 0, impoconsumo: 32000, discount: 20000, surcharge: 8000, total: 420000 },
      [
        { subtotal: 300000, iva: 0, impoconsumo: 0 },
        { subtotal: 100000, iva: 0, impoconsumo: 0 },
      ],
    )!;
    expect(r.ajustes).toEqual([15000, 5000]); // 20.000 netos: 75 % y 25 %
    expect(r.subtotales).toEqual([315000, 105000]);
    expect(r.encabezado).toEqual({ subtotal: 420000, iva: 0, impoconsumo: 0, discount: 0, surcharge: 0, total: 420000 });
    expect(r.detalle).toEqual({ inc: 32000, recargo: 8000, descuento: 20000 });
  });

  it("solo descuento global: resta del valor de los ítems; centavos al de mayor valor", () => {
    const r = repartirCargos(
      { subtotal: 100000, iva: 19000, impoconsumo: 0, discount: 10000, surcharge: 0, total: 109000 },
      [
        { subtotal: 33333.33, iva: 6333.33, impoconsumo: 0 },
        { subtotal: 66666.67, iva: 12666.67, impoconsumo: 0 },
      ],
    )!;
    expect(r.subtotales.reduce((s, v) => s + v, 0)).toBeCloseTo(90000, 2);
    expect(r.encabezado.subtotal).toBe(90000);
    // Subtotal + IVA = total: sin cuadros de INC, recargo ni descuento.
    expect(r.encabezado.subtotal + r.encabezado.iva).toBe(109000);
  });

  it("no reparte una diferencia que el documento no explica (lectura dudosa: revisión manual)", () => {
    expect(
      repartirCargos({ subtotal: 100000, iva: 0, impoconsumo: 0, discount: 0, surcharge: 5000, total: 140000 }, [{ subtotal: 100000, iva: 0, impoconsumo: 0 }]),
    ).toBeNull();
    // Nada que repartir.
    expect(repartirCargos({ subtotal: 100, iva: 19, impoconsumo: 0, discount: 0, surcharge: 0, total: 119 }, [{ subtotal: 100, iva: 19, impoconsumo: 0 }])).toBeNull();
  });

  it("factura leída: valor unitario nuevo e INC en 0; los valores de origen cuadran", () => {
    const data = {
      subtotal: 150000, iva: 0, impoconsumo: 12000, discount: 0, surcharge: 15000, total: 177000,
      lines: [
        { subtotal: 100000, total: 100000, iva: 0, impoconsumo: 0, quantity: 2, unit_value: 50000, discount: 0 },
        { subtotal: 50000, total: 50000, iva: 0, impoconsumo: 0, quantity: 1, unit_value: 50000, discount: 0 },
      ],
    };
    const r = repartirCargos(data, data.lines)!;
    const n = aplicarRepartoExtraido(data, r);
    expect(n.lines.map((l) => [l.subtotal, l.unit_value, l.impoconsumo])).toEqual([
      [118000, 59000, 0],
      [59000, 59000, 0],
    ]);
    expect([n.subtotal, n.impoconsumo, n.surcharge, n.discount, n.total]).toEqual([177000, 0, 0, 0, 177000]);
  });

  it("borrador ya creado (centavos): corrección lista para aprobar", () => {
    const fuente = {
      source: "excel" as const,
      subtotal: 45000000, iva: 8550000, impoconsumo: 0, discount: 500000, surcharge: 0, total: 53050000,
      lines: [{ subtotal: 45000000, iva: 8550000, impoconsumo: 0, iva_base: 45000000, iva_rate: 19 }],
    };
    expect(sourceErrors(fuente)).toEqual([]);
    const n = repartoDeFuente(fuente)!;
    expect(n.valores.subtotal).toBe(44500000);
    expect(n.valores.lines[0]!.subtotal).toBe(44500000);
    expect([n.valores.discount, n.valores.surcharge, n.valores.impoconsumo]).toEqual([0, 0, 0]);
    expect(sourceErrors(n.valores)).toEqual([]);
  });
});
