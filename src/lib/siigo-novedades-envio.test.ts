import { describe, expect, it } from "vitest";

import { tarifaPorcentaje } from "./money";
import { nombreProductoSiigo } from "./producto-coincidencia";
import { valorTarifa } from "./retenciones";
import { retencionCalculadaPorSiigo } from "./siigo-payment";
import { ajusteAlPesoSiigo, purchasePayloadErrors } from "./siigo-purchase-validation";

const IVA19 = { id: 1, type: "IVA", percentage: 19, active: true };
const item = (p: Record<string, unknown>) => ({
  type: "Account" as const,
  code: "51350501",
  account_code: "51350501",
  description: "Servicio",
  quantity: 1,
  price: 0,
  discount: 0,
  tax_ids: [1] as Array<string | number>,
  item_type: "gasto",
  ...p,
});

describe("ReteICA por mil (invalid_total_payments: Siigo aplicaba el 40 %)", () => {
  it("una tarifa de ReteICA de 2 o más es por mil; los demás impuestos no cambian", () => {
    expect(tarifaPorcentaje("reteica", 8)).toBe(0.8);
    expect(tarifaPorcentaje("reteica", 13.8)).toBeCloseTo(1.38);
    expect(tarifaPorcentaje("reteica", 0.966)).toBe(0.966); // ya en porcentaje
    expect(tarifaPorcentaje("retefuente", 4)).toBe(4);
    expect(tarifaPorcentaje("reteiva", 15)).toBe(15);
  });
  it("FE-3661: base 150.000 → Retefuente 4 % = 6.000 + ReteICA 8 x mil = 1.200 = 7.200, lo que calcula Siigo", () => {
    const rf = valorTarifa({ kind: "retefuente", name: "Servicios 4%", rate: 4 } as never, 150000, 28500);
    const ica = valorTarifa({ kind: "reteica", name: "ReteICA 8", rate: 8 } as never, 150000, 28500);
    expect(rf + ica).toBe(7200);
    expect(
      retencionCalculadaPorSiigo({ retencion: { id: 1, kind: "reteica", value: 1200, porcentaje: 8, enRenglon: false } as never, renglones: [], subtotal: 150000, iva: 28500 }),
    ).toBe(1200);
  });
});

describe("redondeo del proveedor de hasta $1: ajuste al peso en Siigo", () => {
  it("CBV-594: IVA de la factura 2.076 y Siigo 2.075,63 → renglón de ajuste al peso de 0,37", () => {
    const items = [item({ price: 10924.37 })];
    const esperado = { subtotal: 10924.37, iva: 2076, impoconsumo: 0 };
    expect(purchasePayloadErrors(items, [IVA19], esperado).length).toBeGreaterThan(0);
    const aj = ajusteAlPesoSiigo(items, [IVA19], esperado, "53958101")!;
    expect(aj.items.at(-1)).toMatchObject({ code: "53958101", price: 0.37, tax_ids: [] });
    expect(aj.ivaSiigo).toBe(2075.63);
    // Total en Siigo = total de la factura.
    expect(aj.subtotalSiigo + aj.ivaSiigo).toBeCloseTo(10924.37 + 2076, 2);
    expect(purchasePayloadErrors(aj.items, [IVA19], { subtotal: aj.subtotalSiigo, iva: aj.ivaSiigo, impoconsumo: 0 })).toEqual([]);
  });
  it("más de $1 de diferencia no se ajusta (se revisa la lectura)", () => {
    expect(ajusteAlPesoSiigo([item({ price: 10000 })], [IVA19], { subtotal: 10000, iva: 1905, impoconsumo: 0 }, "53958101")).toBeNull();
  });
});

describe("nombres de producto para Siigo (invalid_name)", () => {
  it("las comillas de pulgadas y los caracteres especiales se reemplazan", () => {
    expect(nombreProductoSiigo('PLATINA LISA 1/2"X1/8" CRUDO')).toBe("PLATINA LISA 1/2 PULG X1/8 PULG CRUDO");
    expect(nombreProductoSiigo('RECTANGULAR 2"X1" NATURAL X 6 MTS')).toBe("RECTANGULAR 2 PULG X1 PULG NATURAL X 6 MTS");
    expect(nombreProductoSiigo("  ")).toBe("PRODUCTO");
  });
});
