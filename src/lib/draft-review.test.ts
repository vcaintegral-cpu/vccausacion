import { describe, expect, it } from "vitest";
import { classifyJournal, type JournalRow } from "./draft-review";

const row = (code: string, name: string, debit: number, credit = 0): JournalRow => ({ invoice_id: "une", account_code: code, account_name: name, debit, credit, cost_center: null });
describe("document adjustment classification", () => {
  it("keeps UNE 0.27 adjustment in totals, not expenses", () => {
    const result = classifyJournal([row("51353503", "Internet", 185851.24), row("51157001", "IVA asumido", 32458.49), row("42958101", "Ajuste por redondeo del documento", 0.27), row("22050501", "Proveedor", 0, 218310)]);
    expect(result.gastos.map((a) => a.code)).toEqual(["51353503"]);
    expect(result.gastoDebit).toBe(185851.24);
    expect(result.debit).toBeCloseTo(218310, 2);
    expect(result.credit).toBe(218310);
  });
  it("does not exempt oversized, mislabeled adjustments or banks", () => {
    const result = classifyJournal([row("42958101", "Ajuste por redondeo del documento", 1.01), row("42958101", "Gasto", 0.27), row("11200502", "Banco", 20)]);
    expect(result.gastos.map((a) => a.code)).toEqual(["42958101", "11200502"]);
  });
});