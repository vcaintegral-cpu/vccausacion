import { describe, expect, it } from "vitest";
import { evaluarCuenta, partitionSelectableAccounts, type PucAccount } from "./puc-hierarchy";

describe("indexed account selector", () => {
  it("preserves existing movement checks including inactive and indirect descendants", () => {
    const accounts: PucAccount[] = [
      { code: "5", name: "Gastos" },
      { code: "51", name: "Administración", parent_code: "5", active: false },
      { code: "51350501", name: "Vigilancia", parent_code: "51", is_movement: true },
      { code: "51350502", name: "Inactiva", parent_code: "51", active: false },
      { code: "2365", name: "Retenciones", is_movement: false },
      { code: "2408", name: "IVA", active: true, is_movement: true },
      { code: "7", name: "Costos", is_movement: true },
      { code: "71", name: "Desactivada en Siigo", parent_code: "7", siigo_active: false },
    ];
    const indexed = partitionSelectableAccounts(accounts);
    expect(indexed.mov.map((a) => a.code)).toEqual(accounts.filter((a) => evaluarCuenta(accounts, a.code).permiteMovimiento).map((a) => a.code));
    expect(indexed.padres.map((a) => a.code)).toEqual(accounts.filter((a) => !evaluarCuenta(accounts, a.code).permiteMovimiento).map((a) => a.code));
    expect(indexed.mov.some((a) => a.code === "5")).toBe(false);
    expect(indexed.mov.some((a) => a.code === "51350501")).toBe(true);
  });

  it("shares the index across selectors and rebuilds for a refreshed catalog", () => {
    const accounts: PucAccount[] = [{ code: "51", name: "Gastos" }];
    expect(partitionSelectableAccounts(accounts)).toBe(partitionSelectableAccounts(accounts));
    const refreshed = [...accounts, { code: "5101", name: "Auxiliar", parent_code: "51" }];
    expect(partitionSelectableAccounts(refreshed).mov.map((a) => a.code)).toEqual(["5101"]);
  });
});