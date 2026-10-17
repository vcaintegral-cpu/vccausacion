import { describe, expect, it } from "vitest";
import { capitalizedIvaRow, retentionRowsExcluding } from "./siigo-purchase-validation";
import { adaptPurchaseItems, retefuenteRows, isInterruptedSend, purchaseLineErrors, purchaseReadbackComparison, purchaseReadbackErrors, purchasePayloadErrors, readbackExpectedFromDoc, resolvePurchaseInc, siigoErrorKind } from "./siigo-purchase-validation";

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

const item = (price: number, tax_ids: Array<string | number> = []) => ({ type: "Account" as const, code: "51350501", account_code: "51350501", description: "x", quantity: 1, price, discount: 0, tax_ids, item_type: "gasto" });
const TAXES = [{ id: 2845, type: "IVA", name: "IVA 19%", percentage: 19 }, { id: 2846, type: "IVA", name: "IVA 5%", percentage: 5 }];

describe("Siigo representation without changing source values", () => {
  it("TELEVIGIA F-105382: IVA 994 + 3974 on partial base keeps IVA 4968 and total 266440", () => {
    const r = adaptPurchaseItems([item(52294, [2845]), item(209178, [2845])], [{ iva: 994, impoconsumo: 0 }, { iva: 3974, impoconsumo: 0 }], TAXES,
      { subtotal: 261472, iva: 4968, impoconsumo: 0, total: 266440 }, "42958101");
    expect(purchasePayloadErrors(r.items, TAXES, { subtotal: 261472, iva: 4968, impoconsumo: 0 })).toEqual([]);
    expect(r.items).toHaveLength(4);
  });

  it("COMCEL E-6103023639: INC 249.36 without Siigo tax is sent as cost, total unchanged", () => {
    const r = adaptPurchaseItems([item(124679.92, [2845])], [{ iva: 23689.18, impoconsumo: 249.36 }], TAXES,
      { subtotal: 124679.92, iva: 23689.18, impoconsumo: 249.36, total: 148618.46 }, "42958101");
    expect(r.incAsCost).toBe(249.36);
    expect(purchasePayloadErrors(r.items, TAXES, { subtotal: 124929.28, iva: 23689.18, impoconsumo: 0 })).toEqual([]);
  });

  it("UNE FOPU-235005: +0.27 document adjustment becomes an adjustment row", () => {
    const r = adaptPurchaseItems([item(169725.91, [2845]), item(1108.24, [2845]), item(1056.09), item(13961)],
      [{ iva: 32247.92, impoconsumo: 0 }, { iva: 210.57, impoconsumo: 0 }, { iva: 0, impoconsumo: 0 }, { iva: 0, impoconsumo: 0 }], TAXES,
      { subtotal: 185851.24, iva: 32458.49, impoconsumo: 0, total: 218310 }, "42958101");
    expect(r.adjustment).toBe(0.27);
    expect(purchasePayloadErrors(r.items, TAXES, { subtotal: 185851.51, iva: 32458.49, impoconsumo: 0 })).toEqual([]);
  });

  it("EPM DEE-61768892: -0.42 adjustment is subtracted from the price of an untaxed row", () => {
    const r = adaptPurchaseItems([item(69696.06), item(713554.8)], [{ iva: 0, impoconsumo: 0 }, { iva: 0, impoconsumo: 0 }], TAXES,
      { subtotal: 783250.86, iva: 0, impoconsumo: 0, total: 783250.44 }, "42958101");
    expect(r.items[0]!.price).toBe(69695.64);
    expect(r.items.every((i) => !i.discount)).toBe(true);
    expect(purchasePayloadErrors(r.items, TAXES, { subtotal: 783250.44, iva: 0, impoconsumo: 0 })).toEqual([]);
  });

  it("VC INTEGRAL FE-2992: -0.40 with only a taxed row is sent as calculated and left pending at payment", () => {
    const r = adaptPurchaseItems([item(1750905, [2845])], [{ iva: 332671.95, impoconsumo: 0 }], TAXES,
      { subtotal: 1750905, iva: 332671.95, impoconsumo: 0, total: 2083576.55 }, "42958101");
    expect(r.providerRounding).toBe(-0.4);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.price).toBe(1750905);
  });

  it("FE-2992 readback accepts exactly the registered rounding difference", () => {
    const exp = readbackExpectedFromDoc({ items: [] }, { total: 2083576.55, iva: 332671.95, impoconsumo: 0, retefuente: 192599.55, reteiva: 0, reteica: 0 }, 0, { providerRounding: -0.4 });
    expect(exp.total).toBe(2083576.95);
    expect(exp.payable).toBe(1890977.4);
  });

  it("BUF-1277: capitalized IVA row never carries the 2% retention (base 2.127.314)", () => {
    const rows = retentionRowsExcluding([2006900, 120414, 22878.66], 2, 42546.28, new Set([2]));
    expect(rows).toEqual([0, 1]);
    const cap = capitalizedIvaRow(item(2006900, []), "15160501", 22878.66);
    expect(cap.tax_ids).toEqual([]);
    expect(cap.price).toBe(22878.66);
    expect(cap.account_code).toBe("15160501");
  });

  it("ATILA AT-7796: retefuente 9230.96 applies only to the AIU row (2% of 461548)", () => {
    expect(retefuenteRows([4615482, 461548], 2, 9230.96)).toEqual([1]);
    expect(retefuenteRows([2006900, 120414], 2, 42546.28)).toEqual([0, 1]);
  });
});

describe("Histórico rule", () => {
  it("a document that already exists in Siigo is Histórico, not Error Siigo", async () => {
    const { estadoUnico } = await import("./invoice-duplicates");
    expect(estadoUnico({ status: "causada", siigo_status: "error", siigo_id: "x", siigo_number: "FC-1-684" })).toBe("sincronizada");
    expect(estadoUnico({ status: "causada", siigo_status: "error", siigo_id: null, siigo_number: null })).toBe("error_siigo");
  });
});
