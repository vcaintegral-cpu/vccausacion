import { describe, expect, it } from "vitest";

import { buildJournal, type Line } from "./accounting";
import { funcionActiva } from "@/empresas/registro";
import { buscarProducto, codigoProductoNuevo, especificaciones, palabras } from "./producto-coincidencia";
import { isValidPurchaseAccount } from "./provider-rules";
import { purchaseLineErrors } from "./siigo-purchase-validation";

const catalogo = [
  { code: "BP1W30", name: "BALA PISO LED MINI 1W 3000K", kind: "producto" },
  { code: "BP3W30", name: "BALA PISO LED 3W 3000K", kind: "producto" },
  { code: "BP1W65", name: "BALA PISO LED MINI 1W 6500K", kind: "producto" },
  { code: "LRS7524", name: "FUENTE DE PODER 24V 3.2A MEANWELL LRS-75-24", kind: "producto" },
  { code: "FP24-2", name: "FUENTE PLASTICA 24V 2A", kind: "producto" },
  { code: "REF1K", name: "REFLECTOR LED 1000W 5000K IP65", kind: "producto" },
  { code: "PE01", name: "PINTURA ELECTROSTATICA", kind: "servicio" },
  { code: "OLD", name: "BALA PISO LED MINI 1W 3000K VIEJA", kind: "producto", active: false },
];

describe("especificaciones y palabras", () => {
  it("normaliza potencia, voltaje, color, corriente, medidas e IP", () => {
    expect(especificaciones("Panel LED 18W 6500K 110-220V IP65 1,5mts")).toEqual([
      { tipo: "voltaje", valor: 110 },
      { tipo: "voltaje", valor: 220 },
      { tipo: "potencia", valor: 18 },
      { tipo: "color", valor: 6500 },
      { tipo: "medida", valor: 1500 },
      { tipo: "ip", valor: 65 },
    ]);
    // kilovatios = 1000 W; "3000 k" con espacio.
    expect(especificaciones("Reflector 1kw 3000 k")).toEqual([
      { tipo: "potencia", valor: 1000 },
      { tipo: "color", valor: 3000 },
    ]);
    expect(palabras("Bala de Piso Led Mini 1w 3000k Ecolite")).toEqual(["bala", "piso", "led", "mini", "ecolite"]);
  });
});

describe("buscarProducto", () => {
  it("elige la referencia exacta por especificaciones (no la de otro color o potencia)", () => {
    expect(buscarProducto("Bala de Piso Led Mini 1w 3000k Ecolite", catalogo).elegido?.producto.code).toBe("BP1W30");
    expect(buscarProducto("Bala de piso led mini 1W luz fría 6500K", catalogo).elegido?.producto.code).toBe("BP1W65");
    expect(buscarProducto("Reflector led 1 kw 5000k", catalogo).elegido?.producto.code).toBe("REF1K");
  });
  it("reconoce el código de referencia escrito en la descripción", () => {
    const r = buscarProducto("Fuente de poder 24VDC 3,2 amp caja metálica multivoltaje 100-240VAC Meanwell LRS-75-24", catalogo);
    expect(r.elegido?.producto.code).toBe("LRS7524");
  });
  it("sin la referencia en el catálogo no inventa: no hay coincidencia (se creará el producto)", () => {
    expect(buscarProducto("Bala piso 5W", catalogo).elegido).toBeNull();
  });
  it("servicios de inventario (pintura electrostática) y mismo código del renglón", () => {
    expect(buscarProducto("Servicio de pintura electrostática perfil", catalogo, { tipos: ["producto", "servicio"] }).elegido?.producto.code).toBe("PE01");
    expect(buscarProducto("cualquier texto", catalogo, { codigo: "FP24-2" }).elegido?.producto.code).toBe("FP24-2");
  });
  it("no usa productos inactivos", () => {
    expect(buscarProducto("BALA PISO LED MINI 1W 3000K VIEJA", catalogo).elegido?.producto.code).toBe("BP1W30");
  });
  it("código para un producto nuevo, sin repetir", () => {
    expect(codigoProductoNuevo("Bala piso 5W 3000K", new Set())).toBe("BALA-PISO-5W-3000K");
    expect(codigoProductoNuevo("Bala piso 5W 3000K", new Set(["bala-piso-5w-3000k"]))).toBe("BALA-PISO-5W-3000K-2");
  });
});

describe("cuentas 14 solo con la función productos_inventario (LED LIGHTS)", () => {
  it("encendida solo para LED LIGHTS", () => {
    expect(funcionActiva("900470166", "productos_inventario")).toBe(true);
    expect(funcionActiva("800212838", "productos_inventario")).toBe(false);
  });
  it("validación de cuentas y renglones para Siigo", () => {
    expect(isValidPurchaseAccount("14350101")).toBe(false);
    expect(isValidPurchaseAccount("14350101", true)).toBe(true);
    expect(isValidPurchaseAccount("14980501", true)).toBe(true);
    expect(isValidPurchaseAccount("22050501", true)).toBe(false);
    expect(purchaseLineErrors([{ account_code: "14350101", item_type: "producto" }], true)).toEqual([]);
    // Un renglón de gasto no puede ir a la 14, ni una empresa sin la función.
    expect(purchaseLineErrors([{ account_code: "14350101", item_type: "gasto" }], true)).toHaveLength(1);
    expect(purchaseLineErrors([{ account_code: "14350101", item_type: "producto" }])).toHaveLength(1);
  });
  it("el asiento conserva la cuenta 14 del producto", () => {
    const linea: Line = { description: "Bala", quantity: 22, unit_value: 37000, discount: 0, iva: 0, retention: 0, impoconsumo: 0, total: 814000, subtotal: 814000, account_code: "14350101", account_name: "Mercancías no fabricadas", item_type: "producto" };
    const ret = { retefuente: 0, reteiva: 0, reteica: 0, autorretencion: 0, detalle: [] };
    const sin = buildJournal({ lines: [linea], iva: 0, retenciones: ret });
    expect(sin[0]!.account_code).toBe("");
    const con = buildJournal({ lines: [linea], iva: 0, retenciones: ret, permitirInventario: true });
    expect(con[0]).toMatchObject({ account_code: "14350101", debit: 814000 });
  });
});
