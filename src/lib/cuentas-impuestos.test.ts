import { describe, expect, it } from "vitest";

import { cuentaParaImpuesto, usoHistoricoDeImpuestos } from "./cuentas-impuestos";

// PUC ficticio con la estructura típica de Siigo.
const puc = [
  { code: "621008", name: "IVA del costo" },
  { code: "2408", name: "Impuesto sobre las ventas por pagar" },
  { code: "240810", name: "IVA descontable" },
  { code: "24081001", name: "IVA descontable compras 19%" },
  { code: "24081002", name: "IVA descontable servicios 19%" },
  { code: "24081003", name: "IVA descontable compras 5%" },
  { code: "24081004", name: "IVA descontable gastos 19%" },
  { code: "2365", name: "Retención en la fuente" },
  { code: "23652503", name: "Retefuente servicios 4%" },
  { code: "23654001", name: "Retención por compras 2,5%" },
  { code: "23653001", name: "Retención arrendamientos 3,5%" },
  { code: "23654002", name: "Retención combustibles 0,1%" },
  { code: "23670101", name: "ReteIVA 15%" },
];
const sinHistorial = usoHistoricoDeImpuestos([]);

describe("cuenta contable de los impuestos importados de Siigo", () => {
  it("cada IVA va a su 2408 por concepto y tarifa, nunca a la 621008", () => {
    const c = (name: string, percentage: number) => cuentaParaImpuesto({ type: "IVA", name, percentage }, puc, sinHistorial).code;
    expect(c("IVA compras 19%", 19)).toBe("24081001");
    expect(c("IVA Servicios 19%", 19)).toBe("24081002");
    expect(c("IVA compras 5%", 5)).toBe("24081003");
    expect(c("IVA Gastos 19%", 19)).toBe("24081004");
    // Sin concepto que distinga entre varias 2408 del 19 %: queda para elegir.
    expect(c("IVA general 19%", 19)).toBeNull();
  });
  it("cada retención va a la 2365 de su concepto y tarifa", () => {
    const c = (name: string, percentage: number) => cuentaParaImpuesto({ type: "Retefuente", name, percentage }, puc, sinHistorial).code;
    expect(c("Compras 2.5%", 2.5)).toBe("23654001");
    expect(c("Arrendamientos 3.5%", 3.5)).toBe("23653001");
    expect(c("Combustibles 0.1%", 0.1)).toBe("23654002");
    expect(c("Servicios 4%", 4)).toBe("23652503");
    expect(c("Honorarios 11%", 11)).toBeNull();
    expect(cuentaParaImpuesto({ type: "ReteIVA", name: "ReteIVA 15%", percentage: 15 }, puc, sinHistorial).code).toBe("23670101");
  });
  it("el auxiliar histórico de la empresa manda sobre el nombre de la cuenta", () => {
    const hist = usoHistoricoDeImpuestos([
      { account_code: "24081002", description: "IVA general 19%" },
      { account_code: "24081002", description: "IVA general 19%" },
      { account_code: "24081001", description: "IVA general 19%" },
      { account_code: "51959501", description: "IVA general 19%" }, // no es de impuestos: se ignora
    ]);
    const r = cuentaParaImpuesto({ type: "IVA", name: "IVA General 19%", percentage: 19 }, puc, hist);
    expect(r).toMatchObject({ code: "24081002", origen: "historial" });
  });
});
