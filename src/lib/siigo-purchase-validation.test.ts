import { describe, expect, it } from "vitest";
import { purchaseLineErrors, purchaseReadbackErrors } from "./siigo-purchase-validation";

describe("shared PDF and RECIBIDOS purchase gates", () => {
  it("allows ATILA expense 51350501 without an origin restriction", () => {
    expect(purchaseLineErrors([{ account_code: "51350501" }])).toEqual([]);
  });
  for (const document of ["FE-123394 SAYCO", "FE-84496 EXTINTORES", "FE-150 ZULUAGA"]) {
    it(`blocks ${document} while its expense account is pending`, () => {
      expect(purchaseLineErrors([{ account_code: null }])).toHaveLength(1);
    });
  }
  it("blocks banks and CxP as purchase expenses", () => {
    expect(purchaseLineErrors([{ account_code: "11200502" }, { account_code: "22050501" }])).toHaveLength(2);
  });
  it("checks VC INTEGRAL total 2083576.55 and IVA 332671.95 across exact tax IDs", () => {
    const expected = { total: 2083576.55, iva: 332671.95, impoconsumo: 0, retentions: 0, returnedRetentions: 0, payable: 2083576.55, ivaIds: [1, 2] };
    const remote = { total: 2083576.55, payments: [{ value: 2083576.55 }], items: [{ taxes: [{ id: 1, value: 300000 }, { id: 2, value: 32671.95 }] }] };
    expect(purchaseReadbackErrors(remote, expected)).toEqual([]);
    expect(purchaseReadbackErrors({ ...remote, total: 2083576.54 }, expected)[0]).toContain("Total");
  });
  it("checks ATILA IVA 87694.12, total 5164724.12 and the actual payable", () => {
    const expected = { total: 5164724.12, iva: 87694.12, impoconsumo: 0, retentions: 10000, returnedRetentions: 10000, payable: 5154724.12, ivaIds: [1] };
    const remote = { total: 5164724.12, payments: [{ value: 5154724.12 }], items: [{ taxes: [{ id: 1, value: 87694.12 }] }] };
    expect(purchaseReadbackErrors(remote, expected)).toEqual([]);
    expect(purchaseReadbackErrors({ ...remote, payments: [{ value: 5154724.11 }] }, expected)).toHaveLength(1);
    expect(purchaseReadbackErrors({ ...remote, items: [] }, expected)[0]).toContain("IVA");
  });
});