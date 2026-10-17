import { describe, expect, it } from "vitest";
import { isModuleLoadError } from "./module-load-error";

describe("module load recovery", () => {
  it("requires a document refresh for the reported rejected import", () => {
    expect(isModuleLoadError(new TypeError("Failed to fetch dynamically imported module: /src/routes/_authenticated/route.tsx?tsr-split=component"))).toBe(true);
  });
  it("does not treat ordinary data errors as a rejected import", () => {
    expect(isModuleLoadError(new Error("No fue posible cargar las facturas"))).toBe(false);
  });
});