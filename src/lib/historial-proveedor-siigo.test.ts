import { describe, expect, it } from "vitest";
import { mismoProveedor, resumirComprasProveedor, textoResumen, type ImpuestoLocal } from "./historial-proveedor-siigo";

const imp: ImpuestoLocal[] = [
  { id: "t1", kind: "retefuente", name: "Retefuente compras 2,5%", rate: 2.5, siigo_id: "5001" },
  { id: "t2", kind: "reteiva", name: "ReteIVA 15%", rate: 15, siigo_id: "5002" },
];
const compra = (nit: string, retentions: unknown[] = [], date = "2026-10-05") => ({ name: "FC-1-1", date, supplier: { identification: nit }, retentions: retentions as never, items: [] });

describe("mismoProveedor", () => {
  it("compara NIT con y sin dígito de verificación", () => {
    expect(mismoProveedor("860032550", "860032550")).toBe(true);
    expect(mismoProveedor("8600325507", "860032550")).toBe(true);
    expect(mismoProveedor("860032551", "860032550")).toBe(false);
    expect(mismoProveedor("", "860032550")).toBe(false);
  });
});

describe("resumirComprasProveedor", () => {
  it("cuenta compras con retención y las identifica por su id de Siigo", () => {
    const r = resumirComprasProveedor(
      [compra("860032550", [{ id: 5001, value: 1000 }]), compra("860032550", [{ id: 5001, value: 500 }], "2026-11-02"), compra("860032550"), compra("999", [{ id: 5001, value: 9 }])],
      "860032550",
      imp,
    );
    expect(r.compras).toBe(3);
    expect(r.conRetencion).toBe(2);
    expect(r.retenciones).toEqual([{ taxId: "t1", nombre: "Retefuente compras 2,5%", kind: "retefuente", tarifa: 2.5, veces: 2 }]);
    expect(r.ultimaFecha).toBe("2026-11-02");
    expect(textoResumen(r)).toContain("2 con retención y 1 sin retención");
  });
  it("sin compras", () => {
    expect(textoResumen(resumirComprasProveedor([], "1", imp))).toContain("No se encontraron");
  });
  it("retención desconocida en la empresa: la reporta sin impuesto local", () => {
    const r = resumirComprasProveedor([compra("860032550", [{ id: 9999, name: "Retefuente 4%", percentage: 4, value: 40 }])], "860032550", imp);
    expect(r.retenciones[0]).toMatchObject({ taxId: null, kind: "retefuente", tarifa: 4 });
  });
  it("valor 0 no cuenta como retención", () => {
    const r = resumirComprasProveedor([compra("860032550", [{ id: 5001, value: 0 }])], "860032550", imp);
    expect(r.conRetencion).toBe(0);
  });
});
