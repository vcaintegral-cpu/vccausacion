import { describe, expect, it } from "vitest";

import {
  compraDeSiigo,
  compraEditada,
  explicarDiferencia,
  valorRetencionSiigo,
  type ImpuestoRetencion,
} from "./egresos-diferencias";

// Catálogo y compras ficticias.
const catalogo: ImpuestoRetencion[] = [
  { siigoId: "101", kind: "retefuente", name: "Compras 2.5%", rate: 2.5 },
  { siigoId: "102", kind: "retefuente", name: "Servicios 4%", rate: 4 },
  { siigoId: "201", kind: "reteiva", name: "ReteIVA 15%", rate: 15 },
  { siigoId: "301", kind: "reteica", name: "ReteICA 8 x mil", rate: 8 },
];
const compra = (
  retenciones: Array<{
    siigoId: string;
    kind: "retefuente" | "reteiva" | "reteica";
    name: string;
    valor: number;
  }> = [],
) => ({
  nombre: "FC-1-500",
  subtotal: 1000000,
  iva: 190000,
  renglones: [600000, 400000],
  retenciones,
});

describe("a qué se debe la diferencia entre el pago y la CxP", () => {
  it("valor de cada retención como la calcula Siigo", () => {
    expect(valorRetencionSiigo(catalogo[0]!, compra())).toBe(25000);
    expect(valorRetencionSiigo(catalogo[2]!, compra())).toBe(28500); // 15 % del IVA
    expect(valorRetencionSiigo(catalogo[3]!, compra())).toBe(8000); // 8 por mil
  });
  it("pagó menos: el pago descontó una Retefuente que no está causada → agregarla", () => {
    const r = explicarDiferencia({ saldo: 1190000, pagado: 1165000, compra: compra(), catalogo });
    expect(r.diferencia).toBe(25000);
    expect(r.causas[0]).toMatchObject({
      causa: "retencion_no_causada",
      exacta: true,
      accion: { tipo: "agregar", impuestos: [{ siigoId: "101", valor: 25000 }] },
    });
  });
  it("pagó menos: Retefuente + ReteICA no causadas", () => {
    const r = explicarDiferencia({
      saldo: 1190000,
      pagado: 1190000 - 25000 - 8000,
      compra: compra(),
      catalogo,
    });
    expect(r.causas[0]?.accion?.impuestos.map((t) => t.siigoId).sort()).toEqual(["101", "301"]);
    expect(r.causas[0]?.exacta).toBe(true);
  });
  it("pagó más: la compra tiene Retefuente causada que el pago no descontó → quitarla", () => {
    const c = compra([{ siigoId: "102", kind: "retefuente", name: "Servicios 4%", valor: 40000 }]);
    const r = explicarDiferencia({ saldo: 1150000, pagado: 1190000, compra: c, catalogo });
    expect(r.diferencia).toBe(-40000);
    expect(r.causas[0]).toMatchObject({
      causa: "retencion_no_descontada",
      exacta: true,
      accion: { tipo: "quitar", impuestos: [{ siigoId: "102" }] },
    });
    expect(r.causas.some((x) => x.causa === "excedente")).toBe(true);
  });
  it("retención con diferencia de redondeo: aproximada con ajuste al peso", () => {
    const r = explicarDiferencia({
      saldo: 1190000,
      pagado: 1165000 - 300,
      compra: compra(),
      catalogo,
    });
    expect(r.causas.find((x) => x.causa === "retencion_no_causada")).toMatchObject({
      exacta: false,
    });
    expect(r.causas.find((x) => x.causa === "retencion_no_causada")?.descripcion).toMatch(
      /ajuste al peso/,
    );
  });
  it("descuento por pronto pago, gasto bancario, anticipo y ajuste al peso", () => {
    expect(
      explicarDiferencia({ saldo: 1000000, pagado: 980000, compra: null, catalogo }).causas[0],
    ).toMatchObject({ causa: "descuento_pronto_pago" });
    expect(
      explicarDiferencia({
        saldo: 1000000,
        pagado: 996000,
        compra: null,
        catalogo,
        gastosBancariosMismoDia: [3900, 741],
      }).causas.some((c) => c.causa === "gasto_bancario"),
    ).toBe(false);
    expect(
      explicarDiferencia({
        saldo: 1000000,
        pagado: 995359,
        compra: null,
        catalogo,
        gastosBancariosMismoDia: [3900, 741],
      }).causas.some((c) => c.causa === "gasto_bancario"),
    ).toBe(true);
    expect(
      explicarDiferencia({
        saldo: 1000000,
        pagado: 700000,
        compra: null,
        catalogo,
        anticipos: [300000],
      }).causas[0],
    ).toMatchObject({ causa: "anticipo", exacta: true });
    expect(
      explicarDiferencia({ saldo: 1000000, pagado: 999400, compra: null, catalogo }).causas[0],
    ).toMatchObject({ causa: "ajuste_peso" });
  });
});

describe("edición de la compra en Siigo", () => {
  const doc = {
    id: "abc",
    name: "FC-1-500",
    number: 500,
    date: "2026-10-05",
    document: { id: 25 },
    supplier: { identification: "900111222", branch_office: 0 },
    provider_invoice: { prefix: "FE", number: "7003" },
    observations: "Compra",
    items: [
      {
        type: "Account",
        code: "51350501",
        description: "Servicio",
        quantity: 1,
        price: 600000,
        taxes: [{ id: 13156, type: "IVA", value: 114000 }],
      },
      {
        type: "Account",
        code: "51350501",
        description: "Servicio 2",
        quantity: 1,
        price: 400000,
        taxes: [{ id: 13156, type: "IVA", value: 76000 }],
      },
    ],
    payments: [{ id: 7, value: 1190000, due_date: "2026-11-05" }],
    balance: 1190000,
  };
  it("lee la compra: bases por renglón, IVA y retenciones", () => {
    expect(compraDeSiigo(doc, catalogo)).toMatchObject({
      subtotal: 1000000,
      iva: 190000,
      renglones: [600000, 400000],
      retenciones: [],
    });
  });
  it("agregar Retefuente (renglones) y ReteICA (documento) baja la CxP en su valor", () => {
    const cuerpo = compraEditada(doc, {
      tipo: "agregar",
      impuestos: [
        { siigoId: "101", kind: "retefuente", name: "Compras 2.5%", valor: 25000 },
        { siigoId: "301", kind: "reteica", name: "ReteICA 8 x mil", valor: 8000 },
      ],
    }) as {
      items: Array<{ taxes: Array<{ id: number }> }>;
      retentions: Array<{ id: number }>;
      payments: Array<{ value: number }>;
      document: { id: number };
      number: number;
    };
    expect(cuerpo.items.map((i) => i.taxes.map((t) => t.id))).toEqual([
      [13156, 101],
      [13156, 101],
    ]);
    expect(cuerpo.retentions).toEqual([{ id: 301 }]);
    expect(cuerpo.payments).toEqual([{ id: 7, value: 1157000, due_date: "2026-11-05" }]);
    expect(cuerpo.document).toEqual({ id: 25 });
    expect(cuerpo.number).toBeUndefined(); // Siigo no acepta el número en la edición
  });
  it("quitar una Retefuente causada sube la CxP en su valor", () => {
    const conRet = {
      ...doc,
      items: doc.items.map((i) => ({
        ...i,
        taxes: [...i.taxes, { id: 102, type: "Retefuente", value: i.price * 0.04 }],
      })),
      payments: [{ id: 7, value: 1150000, due_date: "2026-11-05" }],
    };
    const cuerpo = compraEditada(conRet, {
      tipo: "quitar",
      impuestos: [{ siigoId: "102", kind: "retefuente", name: "Servicios 4%", valor: 40000 }],
    }) as {
      items: Array<{ taxes: Array<{ id: number }> }>;
      payments: Array<{ value: number }>;
    };
    expect(cuerpo.items.map((i) => i.taxes.map((t) => t.id))).toEqual([[13156], [13156]]);
    expect(cuerpo.payments[0]!.value).toBe(1190000);
  });
});
