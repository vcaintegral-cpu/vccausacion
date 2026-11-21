import { describe, expect, it } from "vitest";
import { ajusteRedondeoSiigo } from "./siigo-payment";
import { purchaseReadbackErrors } from "./siigo-purchase-validation";
import { productoDelCatalogo } from "./siigo-products-match";

describe("redondeo a pesos enteros de Siigo", () => {
  it("acepta el total de Siigo si difiere hasta $3", () => {
    expect(ajusteRedondeoSiigo(117931, 117931.75)).toBe(-0.75);
    expect(ajusteRedondeoSiigo(500002, 500000.4)).toBe(1.6);
  });
  it("rechaza diferencias grandes o valores inválidos", () => {
    expect(ajusteRedondeoSiigo(117940, 117931.75)).toBeNull();
    expect(ajusteRedondeoSiigo(null, 100)).toBeNull();
    expect(ajusteRedondeoSiigo(0, 1)).toBeNull();
  });
  it("la verificación tolera solo esa diferencia", () => {
    const doc = {
      total: 117931,
      payments: [{ value: 117931 }],
      items: [{ taxes: [{ id: 1, type: "IVA", value: 18830 }] }],
    };
    const esperado = {
      total: 117933.75,
      iva: 18832.75,
      impoconsumo: 0,
      retentions: 0,
      returnedRetentions: 0,
      payable: 117933.75,
      ivaIds: [1],
    };
    expect(purchaseReadbackErrors(doc, esperado).length).toBe(3);
    expect(purchaseReadbackErrors(doc, { ...esperado, toleranciaRedondeoSiigo: 2.75 })).toEqual([]);
    expect(purchaseReadbackErrors(doc, { ...esperado, toleranciaRedondeoSiigo: 2.5 }).length).toBe(3);
  });
});

describe("producto del catálogo para un renglón sin código", () => {
  const cat = [
    { code: "P1", name: "Madera aserrada", active: true, account_code: "14350101" },
    { code: "P2", name: "Pisos cerámica", active: true, account_code: "14350101" },
    { code: "P3", name: "Tubería sanitaria", active: true, account_code: "14350102" },
    { code: "P4", name: "Inactivo", active: false, account_code: "14350103" },
  ];
  it("un único producto de la cuenta", () => {
    expect(productoDelCatalogo(cat, "14350102", "tubo")).toBe("P3");
  });
  it("varios: el de nombre más parecido", () => {
    expect(productoDelCatalogo(cat, "14350101", "Pisos de ceramica blanca")).toBe("P2");
  });
  it("sin ganador claro o inactivo: null", () => {
    expect(productoDelCatalogo(cat, "14350101", "otra cosa")).toBeNull();
    expect(productoDelCatalogo(cat, "14350103", "x")).toBeNull();
    expect(productoDelCatalogo(cat, "", "x")).toBeNull();
  });
});

describe("IVA en pesos enteros de Siigo", () => {
  const base = { total: 100, iva: 6118.14, impoconsumo: 0, retentions: 0, returnedRetentions: 0, payable: 100, ivaIds: [1] };
  it("tolera < $1 cuando Siigo entrega pesos enteros", () => {
    const doc = { total: 100, payments: [{ value: 100 }], items: [{ taxes: [{ id: 1, type: "IVA", value: 6118 }] }] };
    expect(purchaseReadbackErrors(doc, base)).toEqual([]);
  });
  it("no tolera $1 o más", () => {
    const doc = { total: 100, payments: [{ value: 100 }], items: [{ taxes: [{ id: 1, type: "IVA", value: 6117 }] }] };
    expect(purchaseReadbackErrors(doc, base).length).toBe(1);
  });
});
