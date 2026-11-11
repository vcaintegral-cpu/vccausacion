import { describe, expect, it } from "vitest";

import { vencimientoDeComprobante } from "./siigo-pagos.functions";

describe("vencimiento de la compra para el recibo de pago", () => {
  it("toma prefijo y consecutivo del comprobante de Siigo", () => {
    expect(vencimientoDeComprobante("FC-1-757")).toEqual({ prefix: "FC-1", consecutive: 757 });
    expect(vencimientoDeComprobante(" ds-1-12 ")).toEqual({ prefix: "DS-1", consecutive: 12 });
  });
  it("sin consecutivo de Siigo no hay a qué aplicar el pago", () => {
    expect(vencimientoDeComprobante(null)).toBeNull();
    expect(vencimientoDeComprobante("FECT272708")).toBeNull();
  });
});
