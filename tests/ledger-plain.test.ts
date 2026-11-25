import { describe, expect, it } from "vitest";
import { plainAccountName, plainEntry, sourceLabel } from "@/lib/ledger-plain";

const dr = (code: string, name: string, cents: number) => ({ code, name, debitCents: cents, creditCents: 0 });
const cr = (code: string, name: string, cents: number) => ({ code, name, debitCents: 0, creditCents: cents });
const CASH = "Cash (LLC operating account)";

describe("the owner's ledger in plain words", () => {
  it("names accounts without the accountant's suffixes", () => {
    expect(plainAccountName("Repairs and Maintenance Expense")).toBe("Repairs and maintenance");
    expect(plainAccountName("HOA Dues Expense")).toBe("HOA dues");
    expect(plainAccountName(CASH)).toBe("Cash");
    expect(sourceLabel("plaid")).toBe("From the bank feed");
    expect(sourceLabel("something-new")).toBe("Entry");
  });

  it("an expense the LLC paid", () => {
    const p = plainEntry({ source: "expense", lines: [dr("6400", "Repairs and Maintenance Expense", 10003), cr("1000", CASH, 10003)] });
    expect(p).toMatchObject({ title: "Repairs and maintenance paid", amountCents: 10003, cash: "out", yours: false });
  });

  it("the owner's share of that expense moves no cash", () => {
    const p = plainEntry({ source: "expense", lines: [dr("3200", "Member Capital Account (control)", 1251), cr("6400", "Repairs and Maintenance Expense", 1251)] });
    expect(p).toMatchObject({ title: "Your share of repairs and maintenance", amountCents: 1251, cash: "none", yours: true });
  });

  it("a contribution and a distribution on the owner's own account", () => {
    expect(plainEntry({ source: "capital_call", lines: [dr("1000", CASH, 62500), cr("3000", "Member Capital Contributions", 62500)] })).toMatchObject({ title: "Your contribution received", amountCents: 62500, cash: "in", yours: true });
    expect(plainEntry({ source: "distribution", lines: [dr("3100", "Member Distributions", 18750), cr("1000", CASH, 18750)] })).toMatchObject({ title: "Distribution paid to you", amountCents: 18750, cash: "out", yours: true });
  });

  it("money in, a recategorization, and anything else", () => {
    expect(plainEntry({ source: "plaid", lines: [dr("1000", CASH, 500), cr("4000", "Other Income (incidental LLC income only)", 500)] })).toMatchObject({ title: "Money received: other income", cash: "in" });
    expect(plainEntry({ source: "manual", lines: [dr("6300", "Utilities Expense", 900), cr("6400", "Repairs and Maintenance Expense", 900)] })).toMatchObject({ title: "Moved from repairs and maintenance to utilities", cash: "none", amountCents: 900 });
    expect(plainEntry({ source: "system", lines: [dr("6100", "Hazard Insurance Expense", 100), cr("1100", "Prepaid and Other Assets", 100)] })).toMatchObject({ title: "Automatic bookkeeping entry", cash: "none" });
  });
});
