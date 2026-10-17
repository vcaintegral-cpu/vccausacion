import { describe, expect, it } from "vitest";
import { isInterruptedSend, purchaseLineErrors, purchaseReadbackComparison, purchaseReadbackErrors, purchasePayloadErrors, readbackExpectedFromDoc, resolvePurchaseInc, siigoErrorKind } from "./siigo-purchase-validation";

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
describe("Siigo error recovery", () => {
  it("documents with a Siigo consecutive are 'created with difference', never retryable", () => {
    expect(siigoErrorKind({ siigo_status: "error", siigo_id: "x", siigo_number: "FC-1-686", siigo_error_kind: "sin_crear" })).toBe("creado_diferencia");
    expect(siigoErrorKind({ siigo_status: "error", siigo_id: null, siigo_number: null })).toBe("sin_crear");
    expect(siigoErrorKind({ siigo_status: "error", siigo_error_kind: "interrumpido" })).toBe("interrumpido");
    expect(siigoErrorKind({ siigo_status: "sincronizada", siigo_id: "x" })).toBeNull();
  });

  it("a send stuck in 'sincronizando' for more than 5 minutes is interrupted", () => {
    const now = Date.parse("2026-10-17T23:00:00Z");
    expect(isInterruptedSend({ siigo_status: "sincronizando", siigo_last_attempt_at: "2026-10-17T22:54:00Z" }, now)).toBe(true);
    expect(isInterruptedSend({ siigo_status: "sincronizando", siigo_last_attempt_at: "2026-10-17T22:57:00Z" }, now)).toBe(false);
  });

  it("FE-3482 re-check compares gross vs gross and net vs net and matches", () => {
    const doc = {
      total: 1404000,
      payments: [{ value: 1404000 }],
      items: [{ taxes: [{ id: 2845, type: "IVA", value: 247000 }, { id: 2847, type: "Retefuente", value: 143000 }] }],
      retentions: [],
    };
    const inv = { total: 1547000, iva: 247000, impoconsumo: 0, retefuente: 143000, reteiva: 0, reteica: 0 };
    const rows = purchaseReadbackComparison(doc, readbackExpectedFromDoc(doc, inv));
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  it("FEPC-26918 re-check still reports the missing INC", () => {
    const doc = { total: 73148.15, payments: [{ value: 73148.15 }], items: [{ taxes: [] }], retentions: [] };
    const inv = { total: 79000, iva: 0, impoconsumo: 5851.85, retefuente: 0, reteiva: 0, reteica: 0 };
    const bad = purchaseReadbackComparison(doc, readbackExpectedFromDoc(doc, inv)).filter((r) => !r.ok).map((r) => r.campo);
    expect(bad).toContain("INC");
  });
});
