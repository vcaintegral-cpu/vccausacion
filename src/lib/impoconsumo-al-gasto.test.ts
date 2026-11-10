import { describe, expect, it } from "vitest";

import { funcionActiva } from "@/empresas/registro";
import { buildJournal, type Line, type Retenciones } from "./accounting";
import { adaptPurchaseItems } from "./siigo-purchase-validation";

const sinRet: Retenciones = { retefuente: 0, reteiva: 0, reteica: 0, autorretencion: 0, detalle: [] };
const linea = (p: Partial<Line>): Line => ({
  description: "x",
  quantity: 1,
  unit_value: 0,
  discount: 0,
  iva: 0,
  retention: 0,
  impoconsumo: 0,
  total: 0,
  ...p,
});

describe("función impoconsumo_al_gasto (alcance: LED LIGHTS)", () => {
  it("encendida solo para LED LIGHTS (900.470.166-4); las demás empresas no cambian", () => {
    expect(funcionActiva("900470166", "impoconsumo_al_gasto")).toBe(true);
    expect(funcionActiva("900.470.166-4", "impoconsumo_al_gasto")).toBe(true);
    expect(funcionActiva("9004701664", "impoconsumo_al_gasto")).toBe(true);
    expect(funcionActiva("901458021", "impoconsumo_al_gasto")).toBe(false);
    expect(funcionActiva(null, "impoconsumo_al_gasto")).toBe(false);
  });

  // Restaurante: alimentación 100.000 + INC 8 % 8.000 = 108.000.
  const lineas = [linea({ subtotal: 100000, impoconsumo: 8000, account_code: "51953001", account_name: "Restaurante" })];

  it("sin la función: INC en su propia cuenta (comportamiento de todas las demás empresas)", () => {
    const j = buildJournal({
      lines: lineas,
      iva: 0,
      impoconsumo: 8000,
      retenciones: sinRet,
      impoconsumoAccount: { code: "51159501", name: "Impoconsumo" },
    });
    expect(j.filter((l) => l.debit > 0).map((l) => [l.account_code, l.debit])).toEqual([
      ["51953001", 100000],
      ["51159501", 8000],
    ]);
  });

  it("con la función: el INC del renglón se suma a su cuenta de gasto y no hay línea de INC", () => {
    const j = buildJournal({
      lines: lineas,
      iva: 0,
      impoconsumo: 8000,
      retenciones: sinRet,
      impoconsumoAccount: { code: "51159501", name: "Impoconsumo" },
      impoconsumoAlGasto: true,
    });
    expect(j.filter((l) => l.debit > 0).map((l) => [l.account_code, l.debit])).toEqual([["51953001", 108000]]);
    expect(j.find((l) => l.credit > 0)?.credit).toBe(108000);
  });

  it("varias cuentas: cada INC va a la cuenta de su renglón; el INC solo del encabezado, a la de mayor valor", () => {
    const j = buildJournal({
      lines: [
        linea({ subtotal: 50000, impoconsumo: 4000, account_code: "51953001" }),
        linea({ subtotal: 200000, iva: 38000, account_code: "61350501" }),
      ],
      iva: 38000,
      impoconsumo: 6000, // 4.000 de renglón + 2.000 solo en el encabezado
      retenciones: sinRet,
      ivaDetalle: [{ account_code: "24080501", amount: 38000 }],
      impoconsumoAlGasto: true,
    });
    const debitos = Object.fromEntries(j.filter((l) => l.debit > 0).map((l) => [l.account_code, l.debit]));
    expect(debitos).toEqual({ "51953001": 54000, "61350501": 202000, "24080501": 38000 });
    expect(j.find((l) => l.credit > 0)?.credit).toBe(294000);
  });

  it("Siigo: sin el impuesto INC en el renglón, se envía como mayor costo en la misma cuenta", () => {
    const r = adaptPurchaseItems(
      [{ type: "Product", code: "P1", account_code: "51953001", description: "Almuerzo", quantity: 1, price: 100000, discount: 0, tax_ids: [], item_type: "servicio" }],
      [{ iva: 0, impoconsumo: 8000 }],
      [{ id: 77, name: "INC 8%", type: "IMPOCONSUMO", percentage: 8, active: true }] as never,
      { subtotal: 100000, iva: 0, impoconsumo: 8000, total: 108000 },
      "42958101",
    );
    expect(r.incAsCost).toBe(8000);
    expect(r.items.map((i) => [i.account_code, i.price, i.tax_ids])).toEqual([
      ["51953001", 100000, []],
      ["51953001", 8000, []],
    ]);
  });
});
