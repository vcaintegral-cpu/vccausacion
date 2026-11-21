import { describe, expect, it } from "vitest";
import { clasificarFactura, nitNormalizado, verificarLineas } from "./cuenta-proveedor";

const f = (o: Partial<Parameters<typeof clasificarFactura>[0]> = {}) =>
  clasificarFactura({ id: "1", prefix: "FEVP", number: "47267", status: "borrador", siigo_status: null, siigo_id: null, voucher_number: null, ...o });

describe("clasificarFactura", () => {
  it("un borrador limpio se puede modificar", () => {
    expect(f()).toMatchObject({ label: "FEVP-47267", modificable: true, motivo: null });
  });
  it("con error y sin Siigo también", () => {
    expect(f({ status: "error" }).modificable).toBe(true);
  });
  it("aprobada, causada, histórico o con Siigo NO se tocan y dicen por qué", () => {
    expect(f({ status: "aprobado" })).toMatchObject({ modificable: false, motivo: "está aprobada" });
    expect(f({ status: "causada", voucher_number: "CP-1" })).toMatchObject({ modificable: false, motivo: "ya tiene comprobante contable" });
    expect(f({ status: "historico", siigo_id: "abc" })).toMatchObject({ modificable: false, motivo: "ya está en Siigo" });
    expect(f({ status: "borrador", siigo_status: "sincronizada" }).modificable).toBe(false);
    expect(f({ status: "historico" })).toMatchObject({ modificable: false, motivo: "está en el histórico" });
  });
});

describe("nitNormalizado", () => {
  it("quita dígito de verificación y separadores", () => {
    expect(nitNormalizado("900.888.827-1")).toBe("900888827");
    expect(nitNormalizado("900888827")).toBe("900888827");
    expect(nitNormalizado(null)).toBe("");
  });
});

describe("verificarLineas (lo que de verdad quedó guardado)", () => {
  const lineas = [
    { invoice_id: "a", account_code: "621029" },
    { invoice_id: "a", account_code: "621029" },
    { invoice_id: "b", account_code: "621029" },
    { invoice_id: "c", account_code: "621029" },
    { invoice_id: "c", account_code: "621008" },
  ];
  it("separa las que quedaron bien de las que no", () => {
    const r = verificarLineas(lineas, ["a", "b", "c", "d"], "621029");
    expect(r.verificadas).toEqual(["a", "b"]);
    expect(r.fallidas.map((x) => x.id)).toEqual(["c", "d"]);
    expect(r.fallidas[0]!.motivo).toContain("621008");
    expect(r.fallidas[1]!.motivo).toContain("no tiene renglones");
  });
});
