/** Module 22, the app side: who may write (the Manager only), who may read (member, Heavy Lifting Agent without member detail). */
import { describe, it, expect, beforeEach } from "vitest";
import { harness } from "./setup";
import { seedPod, USERS, IDS } from "./fixtures";
import { STANDARD_CHART, ledgerLineProblem } from "@/lib/bookkeeping";
import { chartOfAccounts, closeLedgerPeriod, ledgerAccountActivity, ledgerRoleFor, ledgerTrialBalance, postLedgerEntry, reverseLedgerEntry, reviseChart } from "@/lib/bookkeeping.server";

const db = () => harness.db as any;
const lines = [{ code: "1000", debitCents: 500 }, { code: "3000", memberId: IDS.b1, creditCents: 500 }];
const meta = { source: "manual" as const };

beforeEach(() => {
  seedPod(db());
  db().seed("cap_table_entries", [{ property_id: IDS.property, share_number: 1, holder_type: "buyer_account", buyer_account_id: IDS.b1 }]);
  db().rpcResults.post_entry = "entry-1";
  db().rpcResults.reverse_entry = "entry-2";
  db().rpcResults.create_coa_version = "v2";
  db().rpcResults.trial_balance = [
    { account_id: "a1", coa_version: 1, code: "3000", name: "Member Capital Contributions", type: "equity", normal_balance: "credit", member_id: IDS.b2, debit_cents: "0", credit_cents: "500", balance_cents: "500" },
    { account_id: "a1", coa_version: 1, code: "3000", name: "Member Capital Contributions", type: "equity", normal_balance: "credit", member_id: IDS.b1, debit_cents: "0", credit_cents: "300", balance_cents: "300" },
  ];
  db().rpcResults.account_ledger = [{ entry_id: "e1", entry_date: "2026-01-01", posted_at: "2026-01-01T00:00:00Z", source: "manual", source_ref: null, memo: "From Alice One", reverses_entry_id: null, member_id: IDS.b1, debit_cents: "0", credit_cents: "300", running_balance_cents: "300" }];
});

describe("writing is the Manager's, through the functions only", () => {
  it("the Manager posts, reverses, closes a period and revises the chart", async () => {
    expect(await postLedgerEntry(db(), { actorId: USERS.admin, propertyId: IDS.property, lines, meta })).toEqual({ entryId: "entry-1" });
    expect(await reverseLedgerEntry(db(), { actorId: USERS.admin, entryId: "entry-1", reason: "dup" })).toEqual({ entryId: "entry-2" });
    await closeLedgerPeriod(db(), { actorId: USERS.admin, propertyId: IDS.property, year: 2026, month: 1 });
    expect(await reviseChart(db(), { actorId: USERS.admin, notes: "Add pest control" })).toEqual({ versionId: "v2" });
    expect(db().audits("ledger.chart_revised")).toHaveLength(1);
  });

  it("a member, an agent, a broker and a stranger can't write", async () => {
    for (const user of [USERS.b1, USERS.hla, USERS.ra, USERS.broker, "u-nobody"]) {
      await expect(postLedgerEntry(db(), { actorId: user, propertyId: IDS.property, lines, meta })).rejects.toThrow("Only the Manager");
      await expect(reverseLedgerEntry(db(), { actorId: user, entryId: "e", reason: "x" })).rejects.toThrow("Only the Manager");
      await expect(closeLedgerPeriod(db(), { actorId: user, propertyId: IDS.property, year: 2026, month: 1 })).rejects.toThrow("Only the Manager");
      await expect(reviseChart(db(), { actorId: user, notes: "x" })).rejects.toThrow("Only the Manager");
    }
  });

  it("refuses an unbalanced entry or a reversal without a reason before asking the database", () => {
    expect(ledgerLineProblem([{ code: "1000", debitCents: 10 }, { code: "3000", creditCents: 9 }])).toMatch(/unbalanced/);
    expect(ledgerLineProblem([{ code: "1000", debitCents: 1.5 }, { code: "3000", creditCents: 1.5 }])).toMatch(/whole numbers of cents/);
    expect(ledgerLineProblem([{ code: "1000" }, { code: "3000" }])).toMatch(/debit or a credit/);
    return expect(reverseLedgerEntry(db(), { actorId: USERS.admin, entryId: "e", reason: "  " })).rejects.toThrow("Say why");
  });

  it("passes the database's refusal through", async () => {
    db().rpcResults.post_entry = () => { throw new Error("x"); };
    const real = db().rpc.bind(db());
    db().rpc = async (fn: string, a: any) => (fn === "post_entry" ? { data: null, error: { message: "The entry is unbalanced: debits 10 cents, credits 9 cents." } } : real(fn, a));
    await expect(postLedgerEntry(db(), { actorId: USERS.admin, propertyId: IDS.property, lines, meta })).rejects.toThrow("unbalanced");
  });
});

describe("reading", () => {
  it("who may read: the Manager, a member of the property, its accepted Heavy Lifting Agent; nobody else", async () => {
    expect(await ledgerRoleFor(db(), USERS.admin, IDS.property)).toBe("manager");
    expect(await ledgerRoleFor(db(), USERS.b1, IDS.property)).toBe("member");
    expect(await ledgerRoleFor(db(), USERS.hla, IDS.property)).toBe("heavy_lifting_agent");
    for (const u of [USERS.ra, USERS.broker, USERS.b3, "u-nobody"]) expect(await ledgerRoleFor(db(), u, IDS.property)).toBeNull();
    db().table("pods")[0].hla_status = "pending";
    expect(await ledgerRoleFor(db(), USERS.hla, IDS.property)).toBeNull();
    for (const u of [USERS.ra, "u-nobody"]) {
      await expect(ledgerTrialBalance(db(), { userId: u, propertyId: IDS.property })).rejects.toThrow("Not authorized");
      await expect(ledgerAccountActivity(db(), { userId: u, propertyId: IDS.property, accountId: "a1" })).rejects.toThrow("Not authorized");
    }
  });

  it("a member and the Manager see member detail; a Heavy Lifting Agent sees amounts with anonymous labels and no memo", async () => {
    const manager = await ledgerTrialBalance(db(), { userId: USERS.admin, propertyId: IDS.property });
    expect(manager.rows.map((r) => r.member)).toEqual([IDS.b2, IDS.b1]);
    expect(manager.balanced).toBe(false); // credits only in this canned data; the real ledger always balances
    const hla = await ledgerTrialBalance(db(), { userId: USERS.hla, propertyId: IDS.property });
    expect(hla.role).toBe("heavy_lifting_agent");
    expect(JSON.stringify(hla)).not.toContain(IDS.b1);
    expect(JSON.stringify(hla)).not.toContain(IDS.b2);
    expect(hla.rows.map((r) => [r.member, r.balanceCents])).toEqual([["Member 2", 500], ["Member 1", 300]]);
    const m = await ledgerAccountActivity(db(), { userId: USERS.b1, propertyId: IDS.property, accountId: "a1" });
    expect(m.rows[0]).toMatchObject({ memo: "From Alice One", member: IDS.b1, runningBalanceCents: 300 });
    const h = await ledgerAccountActivity(db(), { userId: USERS.hla, propertyId: IDS.property, accountId: "a1" });
    expect(h.rows[0]).toMatchObject({ memo: null, member: "Member 1", creditCents: 300 });
  });

  it("the chart read returns the latest version, typed", async () => {
    db().seed("coa_versions", [{ id: "v1", version: 1, effective_from: "2026-01-01", notes: null }, { id: "v2", version: 2, effective_from: "2026-06-01", notes: "x" }]);
    db().seed("coa_accounts", [{ id: "x1", version_id: "v1", code: "1000", name: "old", type: "asset", normal_balance: "debit", is_member_control: false, active: true }, { id: "x2", version_id: "v2", code: "1000", name: "new", type: "asset", normal_balance: "debit", is_member_control: false, active: true }]);
    const chart = await chartOfAccounts(db());
    expect(chart.version).toBe(2);
    expect(chart.accounts).toEqual([{ id: "x2", code: "1000", name: "new", type: "asset", normalBalance: "debit", isMemberControl: false, active: true }]);
  });

  it("the standard chart has no short-term-rental revenue account", () => {
    expect(STANDARD_CHART.filter((a) => a.type === "income").map((a) => a.name)).toEqual(["Other Income (incidental LLC income only)"]);
  });
});
