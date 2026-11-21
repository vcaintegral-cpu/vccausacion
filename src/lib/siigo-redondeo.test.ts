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

import { sourceErrors, type SourceValues } from "./source-values";
describe("suma de líneas vs documento", () => {
  const linea = (subtotal: number, iva = 0) => ({ subtotal, iva, impoconsumo: 0, iva_base: null, iva_rate: null });
  const fuente = (lines: SourceValues["lines"], subtotal: number): SourceValues => ({
    source: "excel", subtotal, iva: 0, impoconsumo: 0, discount: 0, surcharge: 0, total: subtotal, lines,
  });
  it("tolera el redondeo de centavos por renglón", () => {
    expect(sourceErrors(fuente([linea(1089987), linea(1089987), linea(1089987), linea(359071), linea(647426)], 4276456))).toEqual([]);
  });
  it("no tolera diferencias grandes", () => {
    expect(sourceErrors(fuente([linea(1000), linea(1000)], 2500)).length).toBe(1);
  });
});

describe("renglones ya netos del descuento", () => {
  const linea = (subtotal: number) => ({ subtotal, iva: 0, impoconsumo: 0, iva_base: null, iva_rate: null });
  const base: SourceValues = { source: "pdf", subtotal: 5445586, iva: 0, impoconsumo: 0, discount: 1169128, surcharge: 0, total: 4276458, lines: [linea(4276458)] };
  it("acepta suma = subtotal − descuento", () => {
    expect(sourceErrors(base)).toEqual([]);
  });
  it("sigue marcando si no cuadra de ninguna forma", () => {
    expect(sourceErrors({ ...base, discount: 100000, total: 9000000 }).length).toBeGreaterThan(0);
  });
});

describe("subtotal impreso que no cuadra pero renglones + IVA = total", () => {
  const linea = (subtotal: number, iva = 0) => ({ subtotal, iva, impoconsumo: 0, iva_base: null, iva_rate: null });
  const s: SourceValues = {
    source: "pdf", subtotal: 5445586, iva: 812528, impoconsumo: 0, discount: 0, surcharge: 0, total: 5088985,
    lines: [linea(1089987, 207098), linea(1089987, 207098), linea(1089987, 207098), linea(359071, 68223), linea(647426, 123011)],
  };
  it("no marca diferencia: los renglones son la base real", () => {
    expect(sourceErrors(s)).toEqual([]);
  });
  it("sí marca si ni los renglones cuadran con el total", () => {
    expect(sourceErrors({ ...s, total: 6000000 }).length).toBeGreaterThan(0);
  });
});

import { cuentaAjustePesoCompra } from "./siigo-purchase-validation";
describe("cuenta del ajuste al peso de compras", () => {
  it("no usa una subcuenta de 6 dígitos: Siigo exige auxiliar", () => {
    expect(cuentaAjustePesoCompra([{ code: "539581", name: "Ajuste al peso" }])).toBe("53958101");
  });
  it("prefiere el auxiliar de 8 dígitos", () => {
    expect(
      cuentaAjustePesoCompra([
        { code: "539581", name: "Ajuste al peso" },
        { code: "53958101", name: "Ajuste al peso" },
      ]),
    ).toBe("53958101");
  });
  it("sin cuenta en el PUC devuelve null", () => {
    expect(cuentaAjustePesoCompra([{ code: "519595", name: "Otros" }])).toBeNull();
  });
});
