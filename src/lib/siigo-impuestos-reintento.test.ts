import { describe, expect, it } from "vitest";

import { reintentoImpuesto, type ImpuestoCatalogo } from "./siigo.server";

// Catálogo ficticio.
const catalogo: ImpuestoCatalogo[] = [
  { id: 10, name: "IVA 19%", type: "IVA" },
  { id: 11, name: "Retención compras 1%", type: "Retefuente" },
  { id: 12, name: "Retención tarjetas 1,5%", type: "Retefuente" },
  { id: 13, name: "ReteIVA 15%", type: "ReteIVA" },
  { id: 14, name: "Retención inactiva", type: "Retefuente", active: false },
];
const payload = {
  items: [
    { account: { code: "22050501" }, value: 100 },
    { account: { code: "13551517" }, tax: { id: 11 }, value: 5 },
    { account: { code: "11100501" }, value: 105 },
  ],
};
const error = (n: number, code: string) =>
  `Siigo respondió 400: {"errors":[{"code":"${code}","params":["items[${n}].tax.id"]}]}`;

describe("reintento del impuesto de una línea", () => {
  it("prueba los impuestos activos del tipo de la cuenta que faltan, sin repetir", () => {
    const probados = new Map<string, Set<number>>();
    const r1 = reintentoImpuesto(error(1, "tax_settings"), payload, catalogo, probados);
    expect(r1).toMatchObject({ cuenta: "13551517", taxId: 12 });
    const r2 = reintentoImpuesto(error(1, "tax_settings"), r1!.payload, catalogo, probados);
    expect(r2).toBeNull(); // 11 y 12 ya probados; 14 inactivo; 10 y 13 son de otro tipo.
  });
  it("no aplica a otros errores ni a cuentas sin impuesto", () => {
    expect(reintentoImpuesto("invalid_amount", payload, catalogo, new Map())).toBeNull();
    expect(reintentoImpuesto(error(0, "tax_settings"), payload, catalogo, new Map())).toBeNull();
  });
});
