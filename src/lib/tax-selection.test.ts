import { describe, expect, it } from "vitest";
import { buildIvaGroups, findSourceIvaTax, type TaxRecord } from "./tax-selection";

const iva: TaxRecord = { id: "iva19", kind: "iva", name: "IVA 19%", rate: 19, account_code: "24081013" };
describe("source IVA selection", () => {
  it("assigns the exact unique source-declared rate without changing UNE IVA", () => {
    const source = { iva: 3224792, iva_rate: 19 };
    const tax = findSourceIvaTax([iva], source);
    const result = buildIvaGroups([{ tax, amount: 32247.92 }, { tax, amount: 210.57 }], []);
    expect(tax?.id).toBe("iva19");
    expect(result.errors).toEqual([]);
    expect(result.groups[0]?.amount).toBeCloseTo(32458.49, 2);
    expect(source.iva).toBe(3224792);
  });
  it("never guesses among multiple IVA records with the same rate", () => {
    expect(findSourceIvaTax([iva, { ...iva, id: "other", account_code: "51157001" }], { iva: 1900, iva_rate: 19 })).toBeNull();
  });
  it("never derives a rate from IVA amounts or assigns tax to zero IVA", () => {
    expect(findSourceIvaTax([iva], { iva: 1900, iva_rate: null })).toBeNull();
    expect(findSourceIvaTax([iva], { iva: 0, iva_rate: 19 })).toBeNull();
  });
});