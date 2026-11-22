import { describe, expect, it } from "vitest";
import { planSyncLines, type SyncLine } from "./draft-sync-lines";
import type { SyncChange } from "./draft-sync";

const line = (id: string, account: string | null, type = "gasto", code: string | null = null): SyncLine => ({
  id, position: Number(id.replace(/\D/g, "")) || 0, account_code: account, account_name: "Account",
  item_type: type, code, description: "Material",
});
const expense: SyncChange = { kind: "gasto", label: "Account", old: "51350501", new: "621033", name: "Expense" };
const source = [line("s1", "621033")];

describe("supplier synchronization eligibility", () => {
  it("preserves inventory and its product when an expense account is synchronized", () => {
    const inventory = line("t1", "14350101", "producto", "INV1");
    expect(planSyncLines([expense], source, [inventory], true, [])).toEqual([]);
    expect(inventory).toMatchObject({ account_code: "14350101", item_type: "producto", code: "INV1" });
  });
  it("does not reinterpret inventory as missing even when the company feature is off", () => {
    expect(planSyncLines([expense], source, [line("t1", "14350101", "producto", "INV1")], false, [])).toEqual([]);
  });
  it("changes the previous expense account and genuinely missing accounts only", () => {
    const result = planSyncLines([expense], source, [line("t1", "51350501"), line("t2", null), line("t3", "51451001")], true, []);
    expect(result.map((p) => [p.id, p.account_code])).toEqual([["t1", "621033"], ["t2", "621033"]]);
  });
  it.each(["cost_center", "retefuente"] as const)("does not assign any account for a %s-only change", (kind) => {
    const change: SyncChange = { kind, label: kind, old: "1", new: "2" };
    expect(planSyncLines([change], [line("s1", "14350101", "producto", "INV1")], [line("t1", null)], true, [])).toEqual([]);
  });
  it("propagates explicit classification only to the matching account and previous type", () => {
    const change: SyncChange = { kind: "tipo", label: "Type", old: "gasto", new: "producto" };
    const result = planSyncLines([change], [line("s1", "621033", "producto", "P1")], [line("t1", "621033"), line("t2", "14350101", "producto", "INV1")], true, []);
    expect(result).toEqual([expect.objectContaining({ id: "t1", account_code: "621033", item_type: "producto", code: "P1" })]);
  });
  it("requires the company's inventory function for a new inventory destination", () => {
    const change = { ...expense, new: "14350101" };
    expect(planSyncLines([change], [line("s1", "14350101", "producto", "P1")], [line("t1", null)], false, [])).toEqual([]);
    expect(planSyncLines([change], [line("s1", "14350101", "producto", "P1")], [line("t1", null)], true, [])).toHaveLength(1);
  });
});