import { describe, expect, it } from "vitest";

import { funcionActiva } from "@/empresas/registro";

import { esFormaPorPagar, formaPagoPorPagar, type FormaPagoLocal } from "./compras-por-pagar";
import { compraPorPagar } from "./egresos-diferencias";

// Formas de pago ficticias como las sincroniza Siigo.
const f = (
  siigo_id: string,
  name: string,
  extra: Partial<FormaPagoLocal> = {},
): FormaPagoLocal => ({
  siigo_id,
  name,
  method: "contado",
  account_code: null,
  active: true,
  due_date_required: false,
  ...extra,
});
const formas = [
  f("1", "Pago tarjeta de crédito 0000"),
  f("2", "Efectivo"),
  f("3", "Cuenta Cte"),
  f("4", "Crédito", { method: "credito", due_date_required: true }),
];

describe("compras siempre por pagar", () => {
  it("la tarjeta de crédito, el efectivo y los bancos NO dejan la compra por pagar", () => {
    expect(esFormaPorPagar(formas[0]!)).toBe(false);
    expect(esFormaPorPagar(formas[1]!)).toBe(false);
    expect(esFormaPorPagar(formas[2]!)).toBe(false);
    expect(esFormaPorPagar(formas[3]!)).toBe(true);
    expect(esFormaPorPagar(f("6", "Cuenta Aho"))).toBe(false);
    expect(esFormaPorPagar(f("7", "Aho Davivienda"))).toBe(false);
    expect(esFormaPorPagar(f("8", "Caja"))).toBe(false);
  });
  it("elige la forma a crédito: por la cuenta CxP si se conoce; si no, la única de crédito", () => {
    expect(formaPagoPorPagar(formas, "22050501")).toEqual({ id: "4", name: "Crédito" });
    const dos = [
      ...formas,
      f("5", "Crédito proveedores", { method: "credito", account_code: "22050501" }),
    ];
    expect(formaPagoPorPagar(dos, "22050501")).toEqual({ id: "5", name: "Crédito proveedores" });
    expect(formaPagoPorPagar(formas.slice(0, 3), "22050501")).toHaveProperty("error");
  });
  it("solo LED LIGHTS tiene la regla", () => {
    expect(funcionActiva("900470166", "compras_por_pagar")).toBe(true);
    expect(funcionActiva("800212838", "compras_por_pagar")).toBe(false);
  });
  it("la compra pagada con tarjeta pasa a una sola forma por pagar por el mismo valor, sin tocar renglones ni retenciones", () => {
    const doc = {
      document: { id: 25 },
      number: 1234,
      date: "2026-10-01",
      supplier: { identification: "900111222", branch_office: 0 },
      provider_invoice: { prefix: "FE", number: "1001" },
      observations: "Factura",
      items: [
        {
          type: "Product",
          code: "PRD-1",
          description: "Producto de prueba",
          quantity: 2,
          price: 493827.16,
          taxes: [{ id: 13156 }],
        },
      ],
      retentions: [{ id: 301 }],
      payments: [{ id: 1, name: "Pago tarjeta de crédito 0000", value: 987654.32 }],
    };
    const cuerpo = compraPorPagar(doc, 4, "2026-10-31") as {
      items: Array<{ code: string; quantity: number; price: number; taxes: Array<{ id: number }> }>;
      retentions: Array<{ id: number }>;
      payments: unknown;
      number: number;
    };
    expect(cuerpo.payments).toEqual([{ id: 4, value: 987654.32, due_date: "2026-10-31" }]);
    expect(cuerpo.items).toEqual([
      {
        type: "Product",
        code: "PRD-1",
        description: "Producto de prueba",
        quantity: 2,
        price: 493827.16,
        taxes: [{ id: 13156 }],
      },
    ]);
    expect(cuerpo.retentions).toEqual([{ id: 301 }]);
    expect(cuerpo.number).toBeUndefined(); // Siigo no acepta el número en la edición
  });
});
