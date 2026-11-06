// Casos de los errores reportados al causar en Siigo (noviembre 2026).
import { describe, expect, it } from "vitest";

import { telefonoSiigo } from "./siigo-telefono";
import {
  ajustarPrecisionRenglones,
  purchasePayloadErrors,
  retefuenteRows,
  retentionRowsExcluding,
  type AdaptableItem,
} from "./siigo-purchase-validation";

describe("telefonoSiigo (ARABESQUE: 'Invalid data type: number' en phones[0].number)", () => {
  it("envía solo los dígitos como número", () => {
    expect(telefonoSiigo("(604) 444 55 66")).toBe(6044445566);
    expect(telefonoSiigo("300-123-4567")).toBe(3001234567);
    expect(telefonoSiigo("+57 300 123 4567")).toBe(3001234567);
    expect(telefonoSiigo("4445566")).toBe(4445566);
    expect(telefonoSiigo(3001234567)).toBe(3001234567);
  });
  it("con varios teléfonos toma el primero", () => {
    expect(telefonoSiigo("4445566 - 3001234567")).toBe(4445566);
    expect(telefonoSiigo("3001234567 / 6044445566")).toBe(3001234567);
  });
  it("sin teléfono usable lo omite", () => {
    expect(telefonoSiigo(null)).toBeNull();
    expect(telefonoSiigo("")).toBeNull();
    expect(telefonoSiigo("N/A")).toBeNull();
    expect(telefonoSiigo("123")).toBeNull();
  });
});

const IVA19 = { id: 1, type: "IVA", name: "IVA 19%", percentage: 19, active: true };
const item = (p: Partial<AdaptableItem>): AdaptableItem => ({
  type: "Account",
  code: "51952501",
  account_code: "51952501",
  description: "Elementos de aseo",
  quantity: 1,
  price: 0,
  discount: 0,
  tax_ids: [1],
  item_type: "gasto",
  ...p,
});

describe("ajustarPrecisionRenglones (centavos de Siigo)", () => {
  it("SODIMAC: cantidad 3 con precio de más de 2 decimales → cantidad 1 por el valor exacto", () => {
    // 3 × 63.781,5133 = 191.344,54 (fuente); con precio a 2 decimales Siigo daría 191.344,53.
    const items = [item({ quantity: 3, price: 63781.51333 })];
    const esperado = { subtotal: 191344.54, iva: 36355.46, impoconsumo: 0 };
    expect(purchasePayloadErrors(items, [IVA19], esperado)[0]).toContain(
      "Subtotal, origen 191344.54, Siigo calcularía 191344.53",
    );
    const r = ajustarPrecisionRenglones(items, [IVA19], esperado, { permitirFusion: true });
    expect(purchasePayloadErrors(r.items, [IVA19], esperado)).toEqual([]);
    expect(r.items[0]).toMatchObject({
      quantity: 1,
      price: 191344.54,
      description: "Elementos de aseo (cant. 3)",
    });
  });

  it("D1: IVA redondeado renglón por renglón difiere 1 centavo → se agrupan renglones de la misma cuenta", () => {
    const items = [
      item({ price: 100.03, description: "Jabón" }),
      item({ price: 100.03, description: "Toallas" }),
    ];
    const esperado = { subtotal: 200.06, iva: 38.01, impoconsumo: 0 };
    expect(purchasePayloadErrors(items, [IVA19], esperado)[0]).toContain(
      "IVA, origen 38.01, Siigo calcularía 38.02",
    );
    const r = ajustarPrecisionRenglones(items, [IVA19], esperado, { permitirFusion: true });
    expect(purchasePayloadErrors(r.items, [IVA19], esperado)).toEqual([]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ price: 200.06, account_code: "51952501", tax_ids: [1] });
    expect(r.notas[0]).toContain("2 renglones de la cuenta 51952501 agrupados");
  });

  it("no agrupa cuentas distintas, productos de inventario ni cuando no está permitido", () => {
    const items = [
      item({ price: 100.03 }),
      item({ price: 100.03, account_code: "51959501", code: "51959501" }),
      item({ type: "Product", code: "P1", price: 100.03 }),
    ];
    const esperado = { subtotal: 300.09, iva: 57.02, impoconsumo: 0 };
    const r = ajustarPrecisionRenglones(items, [IVA19], esperado, { permitirFusion: true });
    expect(r.items).toEqual(items);
    const sinFusion = ajustarPrecisionRenglones(
      [item({ price: 100.03 }), item({ price: 100.03 })],
      [IVA19],
      { subtotal: 200.06, iva: 38.01, impoconsumo: 0 },
      { permitirFusion: false },
    );
    expect(sinFusion.items).toHaveLength(2);
    expect(sinFusion.notas).toEqual([]);
  });

  it("si ya cuadra no cambia nada", () => {
    const items = [item({ price: 133831.93 })];
    const r = ajustarPrecisionRenglones(
      items,
      [IVA19],
      { subtotal: 133831.93, iva: 25428.07, impoconsumo: 0 },
      { permitirFusion: true },
    );
    expect(r).toEqual({ items, notas: [] });
  });
});

describe("retefuenteRows (ATILA: retención 2 % solo sobre el AIU en varios renglones)", () => {
  it("ubica la retención en los renglones de administración, imprevistos y utilidad", () => {
    const bases = [6479333, 323966.5, 129586.6, 194379.9];
    const desc = ["Servicio de vigilancia", "Administración", "Imprevistos", "Utilidad"];
    const objetivo = 0.02 * (323966.5 + 129586.6 + 194379.9);
    expect(retefuenteRows(bases, 2, objetivo, desc)).toEqual([1, 2, 3]);
  });
  it("sin descripciones encuentra la combinación exacta más pequeña", () => {
    expect(retefuenteRows([1000, 200, 300, 500], 2, 10)).toEqual([3]);
    expect(retefuenteRows([1000, 200, 300, 700], 2, 10)).toEqual([1, 2]);
  });
  it("respeta los renglones excluidos (IVA capitalizado)", () => {
    expect(retentionRowsExcluding([1000, 200, 300], 2, 10, new Set([1]), ["a", "b", "c"])).toEqual(
      [0, 1, 2].filter((i) => i !== 1),
    );
  });
  it("comportamiento anterior intacto", () => {
    expect(retefuenteRows([4615482, 461548], 2, 9230.96)).toEqual([1]);
    expect(retefuenteRows([2006900, 120414], 2, 42546.28)).toEqual([0, 1]);
  });
});
