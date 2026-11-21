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

describe("subtotal ya neto con descuento informativo (Excel recibidos)", () => {
  const linea = (subtotal: number, iva: number) => ({ subtotal, iva, impoconsumo: 0, iva_base: null, iva_rate: null });
  const s: SourceValues = {
    source: "excel", subtotal: 4276457, iva: 812528, impoconsumo: 0, discount: 1169129, surcharge: 0, total: 5088985,
    lines: [linea(1089987, 207098), linea(1089987, 207098), linea(1089987, 207098), linea(359071, 68223), linea(647426, 123011)],
  };
  it("no marca diferencia: el total cuadra sin restar el descuento", () => {
    expect(sourceErrors(s)).toEqual([]);
  });
  it("marca si el total no cuadra de ninguna forma", () => {
    expect(sourceErrors({ ...s, total: 9999999 }).length).toBeGreaterThan(0);
  });
});

import { adaptPurchaseItems } from "./siigo-purchase-validation";
describe("sin renglones diminutos por redondeo de IVA", () => {
  const taxes = [{ id: 1, name: "IVA 19%", type: "IVA", percentage: 19, active: true }];
  const item = (price: number) => ({ type: "Account" as const, code: "621025", account_code: "621025", description: "Cerámica", quantity: 1, price, discount: 0, tax_ids: [1], item_type: "gasto" });
  it("resto no gravado de pocos pesos: no divide el renglón", () => {
    const r = adaptPurchaseItems([item(136068.42)], [{ iva: 25852, impoconsumo: 0 }], taxes as never, { subtotal: 136068.42, iva: 25852, impoconsumo: 0, total: 161920.42 }, "53958101");
    expect(r.items.length).toBe(1);
  });
  it("base parcial real (resto grande): sí divide", () => {
    const r = adaptPurchaseItems([item(100000)], [{ iva: 1900, impoconsumo: 0 }], taxes as never, { subtotal: 100000, iva: 1900, impoconsumo: 0, total: 101900 }, "53958101");
    expect(r.items.length).toBe(2);
  });
});

import { resolveImpoconsumoAccount } from "./tax-selection";
describe("cuenta del impuesto al consumo por perfil de empresa", () => {
  const taxes = [{ id: "i1", kind: "impoconsumo", name: "INC 8%", rate: 8, account_code: "24950103", active: true }];
  it("sin cuenta fija usa la del impuesto configurado", () => {
    expect(resolveImpoconsumoAccount(taxes as never, []).code).toBe("24950103");
  });
  it("con cuenta fija del perfil manda sobre el impuesto", () => {
    const puc = [{ code: "51157101", name: "Impuesto al consumo", level: "Auxiliar", is_movement: true, active: true }];
    expect(resolveImpoconsumoAccount(taxes as never, puc as never, undefined, "51157101").code).toBe("51157101");
    expect(resolveImpoconsumoAccount(taxes as never, [], undefined, "51157101").code).toBe("51157101");
  });
});

import { elegirIvaSiigoPorNombre } from "./siigo-purchase-validation";
describe("IVA local sin id de Siigo", () => {
  const cat = [
    { id: 1, name: "IVA 19% Compras de bienes", type: "IVA", percentage: 19, active: true },
    { id: 2, name: "IVA 19% Servicios y Gastos", type: "IVA", percentage: 19, active: true },
    { id: 3, name: "IVA 5%", type: "IVA", percentage: 5, active: true },
    { id: 4, name: "Retefuente 19", type: "Retefuente", percentage: 19, active: true },
  ];
  it("único del porcentaje", () => {
    expect(elegirIvaSiigoPorNombre(cat, "IVA 5% compras", 5)).toMatchObject({ ok: true, id: 3 });
  });
  it("varios: elige por nombre", () => {
    expect(elegirIvaSiigoPorNombre(cat, "IVA 19% Servicios y Gasto", 19)).toMatchObject({ ok: true, id: 2 });
  });
  it("ambiguo sin coincidencia: no adivina", () => {
    const r = elegirIvaSiigoPorNombre(cat, "IVA 19%", 19);
    expect(r.ok).toBe(false);
  });
  it("sin porcentaje en Siigo", () => {
    expect(elegirIvaSiigoPorNombre(cat, "IVA 8%", 8).ok).toBe(false);
  });
});
