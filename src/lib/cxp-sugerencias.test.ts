import { describe, expect, it } from "vitest";

import { sugerirFacturas, type CxpAbierta } from "./cxp-sugerencias";

// Datos ficticios.
const c = (p: Partial<CxpAbierta>): CxpAbierta => ({
  prefix: "FC",
  consecutive: 1,
  quote: 1,
  balance: 0,
  dueDate: "2026-10-30",
  providerNit: "900111222",
  providerName: "METALES DEL SUR S.A.S.",
  factura: null,
  ...p,
});
const cxp = [
  c({ consecutive: 10, balance: 1500000, factura: "MS41700" }),
  c({ consecutive: 11, balance: 600000, factura: "MS41792" }),
  c({ consecutive: 12, balance: 200000, factura: "MS41800" }),
  c({
    consecutive: 20,
    balance: 300000,
    providerNit: "800333444",
    providerName: "SEGUROS EJEMPLO S.A.",
    factura: "SE1",
  }),
];

describe("egresos sin RP contra CxP vivas", () => {
  it("por la factura citada en el extracto", () => {
    const s = sugerirFacturas(
      { descripcion: "TRANSFERENCIA CTA SUC VIRTUAL MS41700", valor: -1500000 },
      cxp,
    );
    expect(s).toMatchObject({
      terceroNit: "900111222",
      items: [{ consecutive: 10, valor: 1500000 }],
    });
  });
  it("por el nombre del proveedor y varias facturas que suman el pago", () => {
    const s = sugerirFacturas({ descripcion: "PAGO A PROVE METALES DEL SUR", valor: -800000 }, cxp);
    expect(s?.items.map((i) => [i.consecutive, i.valor])).toEqual([
      [11, 600000],
      [12, 200000],
    ]);
  });
  it("sin valor que cuadre o sin proveedor, no sugiere", () => {
    expect(
      sugerirFacturas({ descripcion: "PAGO A PROVE METALES DEL SUR", valor: -123456 }, cxp),
    ).toBeNull();
    expect(
      sugerirFacturas({ descripcion: "PAGO PSE MERCADOPAGO", valor: -300000 }, cxp),
    ).toBeNull();
    expect(
      sugerirFacturas({ descripcion: "PAGO PSE SEGUROS EJEMPLO", valor: 300000 }, cxp),
    ).toBeNull();
  });
  it("por el tercero de la relación del reporte", () => {
    const s = sugerirFacturas(
      { descripcion: "PAGO PSE", tercero: "SEGUROS EJEMPLO S.A.", valor: -300000 },
      cxp,
    );
    expect(s?.terceroNit).toBe("800333444");
  });
});
