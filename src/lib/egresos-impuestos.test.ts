import { describe, expect, it } from "vitest";

import {
  cuentasConImpuesto,
  impuestoParaCuenta,
  type ImpuestoSiigo,
  type Propuesta,
} from "./egresos";

// Catálogo ficticio de impuestos de Siigo.
const catalogo: ImpuestoSiigo[] = [
  { id: 11, name: "Retención en la fuente compras 1%", type: "Retefuente", percentage: 1 },
  { id: 12, name: "Retención en la fuente tarjetas 1,5%", type: "Retefuente", percentage: 1.5 },
  { id: 13, name: "ReteIVA 15%", type: "ReteIVA", percentage: 15 },
  { id: 14, name: "ReteICA 11,04", type: "ReteICA", percentage: 11.04 },
  { id: 15, name: "Inactivo 2%", type: "Retefuente", percentage: 2, active: false },
  { id: 16, name: "Con cuenta", type: "Retefuente", percentage: 4, account: { code: "13551503" } },
];

describe("impuesto de Siigo para cuentas de retención sin vínculo", () => {
  it("por la cuenta del impuesto, o por tipo y tarifa del nombre de la cuenta", () => {
    expect(impuestoParaCuenta("13551503", "Anticipo Retención en la fuente 4%", catalogo)).toBe(16);
    expect(impuestoParaCuenta("13551517", "Anticipo Retención en la fuente 1%", catalogo)).toBe(11);
    expect(impuestoParaCuenta("13551520", "Anticipo retención tarjetas 1,5%", catalogo)).toBe(12);
    expect(impuestoParaCuenta("13551701", "Impuesto a las ventas retenido 15%", catalogo)).toBe(13);
    expect(impuestoParaCuenta("13551801", "Rete ICA 11,04 (1,104%)", catalogo)).toBe(14);
    // Sin tarifa en el nombre, o tarifa sin impuesto activo: no se adivina.
    expect(
      impuestoParaCuenta("13551815", "Impuesto de industria y comercio retenido", catalogo),
    ).toBeNull();
    expect(impuestoParaCuenta("13551515", "Anticipo Retefuente Servicios 2%", catalogo)).toBeNull();
    expect(impuestoParaCuenta("11100501", "Bancos 1%", catalogo)).toBeNull();
  });

  it("cuentas del recibo que pueden exigir impuesto", () => {
    const p = {
      cuentas: [{ code: "51350501", movimiento: "Debit", valor: 1, descripcion: "" }],
      lineas: [{ code: "13551517", movimiento: "Debit", valor: 1, descripcion: "" }],
      ajuste: { valor: 1, cuenta: "53958101" },
    } as unknown as Propuesta;
    expect(cuentasConImpuesto(p)).toEqual(["13551517"]);
  });
});
