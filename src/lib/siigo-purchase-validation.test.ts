import { describe, expect, it } from "vitest";
import { purchaseLineErrors, purchaseReadbackErrors, purchasePayloadErrors, resolvePurchaseInc } from "./siigo-purchase-validation";

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
    const remote = { total: 5154724.12, payments: [{ value: 5154724.12 }], items: [{ taxes: [{ id: 1, value: 87694.12 }] }] };
    expect(purchaseReadbackErrors(remote, expected)).toEqual([]);
    expect(purchaseReadbackErrors({ ...remote, payments: [{ value: 5154724.11 }] }, expected)).toHaveLength(1);
    expect(purchaseReadbackErrors({ ...remote, items: [] }, expected)[0]).toContain("IVA");
  });
  it("reconciles FE-3452 gross 1547000 against Siigo net 1404000 and retention 143000", () => {
    expect(purchaseReadbackErrors({ total: 1404000, payments: [{ value: 1404000 }], items: [{ taxes: [{ id: 2845, value: 247000 }] }] }, { total: 1547000, iva: 247000, impoconsumo: 0, retentions: 143000, returnedRetentions: 143000, payable: 1404000, ivaIds: [2845] })).toEqual([]);
  });
  it("maps FEPC-26918 INC 5851.85 to the exact active 8 percent tax", () => {
    const taxes = [{ id: 2860, type: "Impoconsumo", percentage: 8 }];
    expect(resolvePurchaseInc(taxes, 73148.15, 5851.85)).toBe(2860);
    expect(purchasePayloadErrors([{ quantity: 1, price: 73148.15, tax_ids: [2860] }], taxes, { subtotal: 73148.15, iva: 0, impoconsumo: 5851.85 })).toEqual([]);
    expect(purchasePayloadErrors([{ quantity: 1, price: 73148.15 }], taxes, { subtotal: 73148.15, iva: 0, impoconsumo: 5851.85 })).toHaveLength(1);
  });
  it("blocks FE-150 fractional unit price before creating a different subtotal or IVA", () => {
    const errors = purchasePayloadErrors([{ quantity: 12, price: 7563.025, tax_ids: [2845] }], [{ id: 2845, type: "IVA", percentage: 19 }], { subtotal: 90756.3, iva: 17243.7, impoconsumo: 0 });
    expect(errors).toHaveLength(2);
  });
  it("does not invent a tax for E-6103023639 INC 249.36", () => {
    expect(resolvePurchaseInc([{ id: 2860, type: "Impoconsumo", percentage: 8 }], 124679.92, 249.36)).toBeNull();
  });
  it("blocks TELEVIGIA source IVA 4968 when applying 19 percent to whole service values", () => {
    const errors = purchasePayloadErrors([{ quantity: 1, price: 52294, tax_ids: [2845] }, { quantity: 1, price: 209178, tax_ids: [2845] }], [{ id: 2845, type: "IVA", percentage: 19 }], { subtotal: 261472, iva: 4968, impoconsumo: 0 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("49679.68");
  });
});