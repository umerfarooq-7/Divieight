/** Month 6, Prompt 8, the app side: the split follows an Operating Agreement override only when one is configured; the Manager enters and retires overrides. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, USERS, IDS } from "./fixtures";
import * as exp from "@/lib/expenses.server";
import * as cap from "@/lib/capital.server";
import { LAUNCH_ITEMS } from "@/lib/launch-readiness";
import { pickOverride, percentsProblem, type AllocationOverride } from "@/lib/expenses";

const db = () => harness.db as any;
const A = IDS.property;
const FAR = new Date(Date.now() + 5000 * 3_600_000).toISOString();
const EXP = "exp-1";
let posted: Array<{ holder_key: string; share_count: number; amount: number }> = [];

const override = (o: Record<string, unknown> = {}) => ({
  id: "ov-1", property_id: A, expense_category: "Structure & roof", expense_id: null, method: "custom_percent",
  parameters: { percents: { [IDS.b1]: 50, [IDS.b2]: 50 } }, source_oa_section: "OA 5.2", approved_by: USERS.admin, effective_from: "2025-01-01", retired_at: null, ...o,
});

beforeEach(() => {
  seedPod(db());
  for (const [id, at] of [[IDS.b1, "2026-01-01T00:00:00Z"], [IDS.b2, "2026-02-01T00:00:00Z"]] as const) {
    const b = db().table("buyer_accounts").find((x: any) => x.id === id)!;
    b.priority_rank = null;
    b.priority_rank_timestamp = at;
  }
  db().seed("cap_table_entries", [
    { property_id: A, share_number: 1, holder_type: "buyer_account", buyer_account_id: IDS.b1, seller_id: null, acquisition_date: FAR, retention_lock_expires_at: FAR },
    { property_id: A, share_number: 2, holder_type: "buyer_account", buyer_account_id: IDS.b2, seller_id: null, acquisition_date: FAR, retention_lock_expires_at: FAR },
  ]);
  db().seed("expenses", [{ id: EXP, property_id: A, description: "Roof repair", category: "Structure & roof", total_amount: 100.01, incurred_on: "2026-10-01", source: "manual", status: "draft", created_at: new Date().toISOString() }]);
  db().seed("allocation_overrides", []);
  posted = [];
  db().rpcResults.post_expense = vi.fn((a: any) => {
    posted = a._allocations;
    return { applied: true };
  });
  db().rpcResults.save_allocation_override = vi.fn(() => "ov-new");
  db().rpcResults.retire_allocation_override = vi.fn(() => null);
});

const postIt = () => exp.postExpense(db(), { adminId: USERS.admin, expenseId: EXP });
const cents = () => posted.map((l) => [l.holder_key, Math.round(l.amount * 100)]);

describe("the split at posting", () => {
  it("is the default pro-rata split when no override is configured, with the leftover cent to rank 1", async () => {
    await postIt();
    expect(cents()).toEqual([[IDS.b1, 5001], [IDS.b2, 5000]]);
  });

  it("follows an Operating Agreement override for its category, down to the cent with the leftover cent to rank 1", async () => {
    db().seed("allocation_overrides", [override({ parameters: { percents: { [IDS.b1]: 70, [IDS.b2]: 30 } } })]);
    await postIt();
    expect(cents()).toEqual([[IDS.b1, 7001], [IDS.b2, 3000]]); // 70.007 and 30.003 round down, the leftover cent goes to rank 1
    expect(posted.reduce((s, l) => s + Math.round(l.amount * 100), 0)).toBe(10001);
  });

  it("applies only when configured: another category, a later start date, a retired override or another property's leaves the default alone", async () => {
    for (const o of [override({ expense_category: "Utilities" }), override({ effective_from: "2026-11-01" }), override({ retired_at: "2026-09-01T00:00:00Z" }), override({ property_id: "other-property" })]) {
      db().seed("allocation_overrides", [o]);
      db().table("allocation_overrides").length = 1;
      db().table("allocation_overrides")[0] = o;
      db().table("expenses")[0].status = "draft";
      await postIt();
      expect(cents(), JSON.stringify(o)).toEqual([[IDS.b1, 5001], [IDS.b2, 5000]]);
    }
  });

  it("refuses to post when an override no longer covers the cap table, rather than quietly using the default", async () => {
    db().seed("allocation_overrides", [override({ parameters: { percents: { [IDS.b1]: 100 } } })]);
    await expect(postIt()).rejects.toThrow(/exactly 100|every current holder/);
    db().table("allocation_overrides")[0] = override({ parameters: { percents: { [IDS.b1]: 60, [IDS.b3]: 40 } } });
    await expect(postIt()).rejects.toThrow("doesn't cover every current holder");
    expect(db().rpcResults.post_expense).not.toHaveBeenCalled();
  });
});

describe("the override engine", () => {
  const o = (x: Partial<AllocationOverride>): AllocationOverride => ({ id: "x", expenseCategory: "HVAC", expenseId: null, method: "custom_percent", percents: { a: 100 }, sourceOaSection: "OA", effectiveFrom: "2025-01-01", ...x });
  it("a per-expense override beats a category one, and the latest effective date wins", () => {
    const e = { id: "e1", category: "HVAC", incurredOn: "2026-06-01" };
    expect(pickOverride([o({ id: "cat" }), o({ id: "one", expenseCategory: null, expenseId: "e1" })], e)?.id).toBe("one");
    expect(pickOverride([o({ id: "old" }), o({ id: "new", effectiveFrom: "2026-01-01" })], e)?.id).toBe("new");
    expect(pickOverride([o({ id: "later", effectiveFrom: "2026-07-01" })], e)).toBeNull();
    expect(pickOverride([o({ expenseCategory: "Pest" })], e)).toBeNull();
  });
  it("percentages: above zero, two decimals at most, exactly 100", () => {
    expect(percentsProblem({ a: 50, b: 50 })).toBeNull();
    expect(percentsProblem({ a: 33.33, b: 33.33, c: 33.34 })).toBeNull();
    expect(percentsProblem({ a: 50, b: 49.99 })).toMatch(/exactly 100/);
    expect(percentsProblem({ a: 100, b: 0 })).toMatch(/above zero/);
    expect(percentsProblem({ a: 33.333, b: 66.667 })).toMatch(/two decimal/);
    expect(percentsProblem({})).toMatch(/every holder/);
  });
});

describe("the Manager's override screen", () => {
  const input = (o: Record<string, unknown> = {}) => ({ actorId: USERS.admin, propertyId: A, expenseCategory: "Structure & roof", method: "custom_percent" as const, percents: { [IDS.b1]: 60, [IDS.b2]: 40 }, sourceOaSection: "OA 5.2", effectiveFrom: "2026-01-01", ...o });

  it("only the Manager enters or retires an override, and reads them", async () => {
    for (const u of [USERS.b1, USERS.hla, USERS.ra, USERS.broker, "u-nobody"]) {
      await expect(cap.saveAllocationOverride(db(), input({ actorId: u }))).rejects.toThrow("Only the Manager");
      await expect(cap.retireAllocationOverride(db(), { actorId: u, overrideId: "ov-1", reason: "x" })).rejects.toThrow("Only the Manager");
      await expect(cap.allocationOverrides(db(), { userId: u, propertyId: A })).rejects.toThrow("Only the Manager");
    }
  });

  it("checks the section, the percentages and the usage basis before the database is asked", async () => {
    const spy = vi.fn(() => "x");
    db().rpcResults.save_allocation_override = spy;
    await expect(cap.saveAllocationOverride(db(), input({ sourceOaSection: " " }))).rejects.toThrow("Name the Operating Agreement section");
    await expect(cap.saveAllocationOverride(db(), input({ percents: { [IDS.b1]: 60, [IDS.b2]: 39 } }))).rejects.toThrow("exactly 100");
    await expect(cap.saveAllocationOverride(db(), input({ method: "usage_adjusted" }))).rejects.toThrow("no usage formula");
    expect(spy).not.toHaveBeenCalled();
    await cap.saveAllocationOverride(db(), input({ method: "usage_adjusted", basis: "Nights used FY2025" }));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ _category: "Structure & roof", _method: "usage_adjusted", _oa_section: "OA 5.2", _actor: USERS.admin, _params: { percents: { [IDS.b1]: 60, [IDS.b2]: 40 }, basis: "Nights used FY2025" } }));
  });

  it("lists every holder to enter percentages for, and each override with its section and who it names", async () => {
    db().seed("allocation_overrides", [override()]);
    const r = await cap.allocationOverrides(db(), { userId: USERS.admin, propertyId: A });
    expect(r.holders.map((h) => [h.key, h.shares])).toEqual([[IDS.b1, 1], [IDS.b2, 1]]);
    expect(r.overrides[0]).toMatchObject({ expenseCategory: "Structure & roof", method: "custom_percent", sourceOaSection: "OA 5.2", effectiveFrom: "2025-01-01", retiredAt: null });
    expect(r.overrides[0]!.percents.map((p) => [p.holderKey, p.percent])).toEqual([[IDS.b1, 50], [IDS.b2, 50]]);
  });

  it("retiring needs a reason", async () => {
    await cap.retireAllocationOverride(db(), { actorId: USERS.admin, overrideId: "ov-1", reason: "OA amended" });
    expect(db().rpcResults.retire_allocation_override).toHaveBeenCalledWith(expect.objectContaining({ _id: "ov-1", _reason: "OA amended", _actor: USERS.admin }));
  });
});

describe("the wiring and the assumption", () => {
  it("the usage-adjusted assumption is on the launch readiness page", () => {
    const item = LAUNCH_ITEMS.find((i) => i.key === "usage_adjusted_allocation");
    expect(item).toMatchObject({ status: "Placeholder", title: "Usage-adjusted expense allocation" });
    expect(item!.detail).toMatch(/ASSUMPTION/);
  });
  it("the rounding rule is documented in code and the admin tooltip, and the screens are wired", () => {
    expect(readFileSync("src/lib/expenses.ts", "utf8")).toContain("THE ROUNDING RULE");
    expect(readFileSync("src/routes/admin.expenses.tsx", "utf8")).toContain("ROUNDING_RULE_TEXT");
    const books = readFileSync("src/routes/admin.books.$propertyId.tsx", "utf8");
    for (const label of ["Expense allocation", "Save override", "ROUNDING_RULE_TEXT", "USAGE_ADJUSTED_ASSUMPTION"]) expect(books).toContain(label);
    expect(readFileSync("src/routes/admin.expenses.tsx", "utf8")).toContain("Split by the Operating Agreement override");
  });
});
