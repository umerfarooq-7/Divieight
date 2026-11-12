/** Month 6, Prompt 4, the app side: the Manager's actions, and the Heavy Lifting Agent's view with nothing personal in it. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, USERS, IDS } from "./fixtures";
import * as books from "@/lib/books.server";

const db = () => harness.db as any;
const admin = USERS.admin;

beforeEach(() => {
  seedPod(db());
  db().seed("cap_table_entries", [{ property_id: IDS.property, share_number: 1, holder_type: "buyer_account", buyer_account_id: IDS.b1 }]);
  for (const fn of ["post_bank_transaction", "post_manual_entry", "create_recurring_rule", "save_categorization_rule"]) db().rpcResults[fn] = `${fn}-id`;
  for (const fn of ["ignore_bank_transaction", "set_recurring_rule_active", "set_categorization_rule_active", "reopen_period"]) db().rpcResults[fn] = vi.fn(() => null);
  db().rpcResults.recategorize_entry = { reversal_entry_id: "rev-1", corrected_entry_id: "cor-1" };
  db().rpcResults.capitalize_entry = { reversal_entry_id: "rev-2", corrected_entry_id: "cor-2" };
  db().rpcResults.apply_rules_to_needs_review = { posted: 3, still_needs_review: 2 };
  db().rpcResults.apply_due_recurring = { posted: 1, failed: 0, already_applied: 0, as_of: "2026-11-30" };
});

describe("only the Manager acts", () => {
  const everyone = [USERS.b1, USERS.hla, USERS.ra, USERS.broker, "u-nobody"];
  it("nobody else posts, ignores, corrects, sets up recurring expenses, edits rules or reopens a period", async () => {
    for (const u of everyone) {
      const calls = [
        books.postBankTransaction(db(), { actorId: u, transactionId: "t", splits: [{ code: "6400", cents: 1 }] }),
        books.ignoreBankTransaction(db(), { actorId: u, transactionId: "t", reason: "x" }),
        books.postManualEntry(db(), { actorId: u, propertyId: IDS.property, date: "2026-11-01", amountCents: 100, direction: "out", accountCode: "6400", memo: "m" }),
        books.recategorizeEntry(db(), { actorId: u, entryId: "e", mapping: { l: "6600" }, reason: "x" }),
        books.capitalizeEntry(db(), { actorId: u, entryId: "e", reason: "x" }),
        books.createRecurringRule(db(), { actorId: u, propertyId: IDS.property, description: "d", amountCents: 100, accountCode: "6500", frequency: "monthly", firstRun: "2026-12-01" }),
        books.setRecurringRuleActive(db(), { actorId: u, ruleId: "r", active: false }),
        books.saveCategorizationRule(db(), { actorId: u, propertyId: IDS.property, matchType: "keyword", pattern: "x", accountCode: "6400" }),
        books.setCategorizationRuleActive(db(), { actorId: u, ruleId: "r", active: false }),
        books.applyRulesToNeedsReview(db(), { actorId: u, propertyId: IDS.property }),
        books.reopenPeriod(db(), { actorId: u, propertyId: IDS.property, year: 2026, month: 1, reason: "x" }),
        books.applyDueRecurring(db(), { actorId: u, propertyId: IDS.property }),
        books.booksOverview(db(), { userId: u, propertyId: IDS.property }),
      ];
      for (const c of calls) await expect(c).rejects.toThrow("Only the Manager");
    }
  });

  it("the Manager's calls reach the database with their id and where they came from", async () => {
    const request = { ip: "203.0.113.7", userAgent: "ua" };
    expect(await books.postBankTransaction(db(), { actorId: admin, transactionId: "t", splits: [{ code: "6400", cents: 60 }, { code: "6300", cents: 40 }], request })).toEqual({ entryId: "post_bank_transaction-id" });
    expect(await books.recategorizeEntry(db(), { actorId: admin, entryId: "e", mapping: { l: "6600" }, reason: "r", request })).toEqual({ reversalEntryId: "rev-1", correctedEntryId: "cor-1" });
    expect(await books.capitalizeEntry(db(), { actorId: admin, entryId: "e", reason: "r" })).toEqual({ reversalEntryId: "rev-2", correctedEntryId: "cor-2" });
    expect(await books.applyRulesToNeedsReview(db(), { actorId: admin, propertyId: IDS.property })).toEqual({ posted: 3, stillNeedsReview: 2 });
    expect(await books.applyDueRecurring(db(), { actorId: admin, propertyId: IDS.property })).toEqual({ posted: 1, failed: 0, alreadyApplied: 0, asOf: "2026-11-30" });
    // The scheduled job has no user: it is the database's own job.
    expect((await books.applyDueRecurring(db(), {})).posted).toBe(1);
  });

  it("a reason is required for every correction and for reopening a period, before the database is asked", async () => {
    await expect(books.recategorizeEntry(db(), { actorId: admin, entryId: "e", mapping: { l: "6600" }, reason: "  " })).rejects.toThrow("Say why");
    await expect(books.capitalizeEntry(db(), { actorId: admin, entryId: "e", reason: "" })).rejects.toThrow("Say why");
    await expect(books.reopenPeriod(db(), { actorId: admin, propertyId: IDS.property, year: 2026, month: 1, reason: " " })).rejects.toThrow("Say why");
    await expect(books.postManualEntry(db(), { actorId: admin, propertyId: IDS.property, date: "2026-11-01", amountCents: 1.5, direction: "out", accountCode: "6400", memo: "m" })).rejects.toThrow("whole number of cents");
    await expect(books.createRecurringRule(db(), { actorId: admin, propertyId: IDS.property, description: "d", amountCents: 0, accountCode: "6500", frequency: "monthly", firstRun: "2026-12-01" })).rejects.toThrow("whole number of cents");
  });

  it("the database's refusals come through (a closed period, splits that don't add up)", async () => {
    const real = db().rpc.bind(db());
    db().rpc = async (fn: string, a: any) => (fn === "post_bank_transaction" ? { data: null, error: { message: "The splits add up to 90 cents but the transaction is 100 cents." } } : real(fn, a));
    await expect(books.postBankTransaction(db(), { actorId: admin, transactionId: "t", splits: [{ code: "6400", cents: 90 }] })).rejects.toThrow("splits add up to 90 cents");
  });
});

describe("the Heavy Lifting Agent's view", () => {
  beforeEach(() => {
    db().rpcResults.trial_balance = [
      { account_id: "a1", coa_version: 1, code: "1000", name: "Cash (LLC operating account)", type: "asset", normal_balance: "debit", member_id: null, debit_cents: "900", credit_cents: "0", balance_cents: "900" },
      { account_id: "a2", coa_version: 1, code: "3000", name: "Member Capital Contributions", type: "equity", normal_balance: "credit", member_id: IDS.b1, debit_cents: "0", credit_cents: "600", balance_cents: "600" },
      { account_id: "a2", coa_version: 1, code: "3000", name: "Member Capital Contributions", type: "equity", normal_balance: "credit", member_id: IDS.b2, debit_cents: "0", credit_cents: "300", balance_cents: "300" },
    ];
    db().seed("journal_entries", [{ id: "e1", property_id: IDS.property, entry_date: "2026-11-02", source: "manual", memo: "Alice One's roof deposit", source_ref: "owner_capital_accounts:x", reverses_entry_id: null, posted_at: "2026-11-02T00:00:00Z", created_by: USERS.admin }]);
    db().seed("journal_lines", [
      { id: "l1", entry_id: "e1", account_id: "a1", member_id: null, debit_cents: "900", credit_cents: "0" },
      { id: "l2", entry_id: "e1", account_id: "a2", member_id: IDS.b1, debit_cents: "0", credit_cents: "900" },
    ]);
    db().seed("coa_accounts", [
      { id: "a1", code: "1000", name: "Cash (LLC operating account)", type: "asset", is_member_control: false },
      { id: "a2", code: "3000", name: "Member Capital Contributions", type: "equity", is_member_control: true },
    ]);
    db().seed("bank_transactions", [
      { id: "b1", property_id: IDS.property, status: "needs_review", merchant_name: "Alice One Plumbing", description: "TIN 12-3456789", is_pending: false },
      { id: "b2", property_id: IDS.property, status: "new", is_pending: true, merchant_name: "Bob One" },
    ]);
    db().seed("accounting_periods", [{ property_id: IDS.property, year: 2026, month: 9, status: "closed" }]);
    db().seed("recurring_rules", [{ id: "r1", property_id: IDS.property, active: true, description: "Alice One's cleaner" }]);
  });

  it("shows property-level amounts and counts, and no member names, ids, memos, merchants or TINs anywhere", async () => {
    const view = await books.hlaBooksView(db(), { userId: USERS.hla, propertyId: IDS.property });
    expect(view.trial.map((r) => [r.code, r.name, r.balanceCents])).toEqual([["1000", "Cash (LLC operating account)", 900], ["3000", "Member Capital Contributions (all members)", 900]]);
    expect(view.entries).toEqual([{ date: "2026-11-02", source: "manual", reversal: false, lines: [{ account: "1000 Cash (LLC operating account)", debitCents: 900, creditCents: 0 }, { account: "Member capital (all members)", debitCents: 0, creditCents: 900 }] }]);
    expect(view).toMatchObject({ needsReviewCount: 1, pendingBankCount: 1, closedPeriods: [{ year: 2026, month: 9 }], openRecurring: 1 });
    const json = JSON.stringify(view);
    for (const personal of [IDS.b1, IDS.b2, "Alice", "Bob", "Plumbing", "TIN", "12-3456789", "roof deposit", "owner_capital_accounts", "cleaner", "Member 1", "Member 2"]) expect(json, personal).not.toContain(personal);
  });

  it("is for the pod's accepted Heavy Lifting Agent only: the Manager uses the full screen; members, other agents and strangers are refused", async () => {
    for (const u of [USERS.admin, USERS.b1, USERS.ra, USERS.broker, "u-nobody"]) await expect(books.hlaBooksView(db(), { userId: u, propertyId: IDS.property })).rejects.toThrow("Not authorized");
    db().table("pods")[0].hla_status = "pending";
    await expect(books.hlaBooksView(db(), { userId: USERS.hla, propertyId: IDS.property })).rejects.toThrow("Not authorized");
  });

  it("has no way to write: the view's code never calls a database function that changes anything", () => {
    const src = readFileSync("src/lib/books.server.ts", "utf8");
    const view = src.slice(src.indexOf("export async function hlaBooksView"));
    expect(view).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    expect(view).not.toMatch(/db\.rpc\(\s*"(post_|ignore_|recategorize|capitalize|create_|set_|apply_|reopen|close_|reverse_)/);
    const page = readFileSync("src/routes/agent.pods.$id.books.tsx", "utf8");
    expect(page).not.toMatch(/useMutation|Post|Reverse|Recategorize|Capitalize|Ignore/);
    expect(page).toMatch(/getHlaBooksView/);
  });
});

describe("the Manager's page", () => {
  it("lists what needs review with the suggested account, the postable accounts, entries with their corrections, and the rest", async () => {
    db().seed("properties", [{ id: "p-x", address: "9 Test Rd", city: "Lusk", state: "WY" }]);
    db().seed("coa_versions", [{ id: "v1", version: 1 }]);
    db().seed("coa_accounts", [
      { id: "a1", version_id: "v1", code: "1000", name: "Cash", type: "asset", is_member_control: false, active: true },
      { id: "a2", version_id: "v1", code: "3000", name: "Member Capital", type: "equity", is_member_control: true, active: true },
      { id: "a3", version_id: "v1", code: "6400", name: "Repairs", type: "expense", is_member_control: false, active: true },
      { id: "a4", version_id: "v1", code: "6600", name: "Retired", type: "expense", is_member_control: false, active: false },
    ]);
    db().seed("bank_transactions", [{ id: "t1", property_id: "p-x", status: "needs_review", posted_date: "2026-11-02", amount_cents: "500", direction: "out", merchant_name: "Zeta", description: "POS", review_reason: "no_matching_rule" }]);
    db().rpcResults.suggest_bank_account = [{ code: "6400", name: "Repairs", rule_id: "r" }];
    db().seed("journal_entries", [
      { id: "e1", property_id: "p-x", entry_date: "2026-11-02", source: "manual", memo: "Sofa", reverses_entry_id: null, is_adjustment: false, posted_at: "2026-11-02T00:00:00Z" },
      { id: "e2", property_id: "p-x", entry_date: "2026-11-03", source: "manual", memo: "Reversal", reverses_entry_id: "e1", reversal_reason: "recategorize: x", is_adjustment: false, posted_at: "2026-11-03T00:00:00Z" },
    ]);
    db().seed("journal_lines", [{ id: "l1", entry_id: "e1", account_id: "a3", member_id: null, debit_cents: "500", credit_cents: "0" }, { id: "l2", entry_id: "e1", account_id: "a1", member_id: null, debit_cents: "0", credit_cents: "500" }]);
    db().seed("entry_corrections", [{ property_id: "p-x", original_entry_id: "e1", kind: "recategorize", reason: "x" }]);
    db().seed("ledger_attachments", [{ id: "att1", property_id: "p-x", entry_id: "e1", file_name: "receipt.jpg" }]);
    db().seed("recurring_rules", [{ id: "rr", property_id: "p-x", description: "Mgmt fee", amount_cents: "25000", coa_account_id: "a3", frequency: "monthly", next_run: "2026-12-01", active: true }]);
    db().seed("recurring_applications", [{ rule_id: "rr", property_id: "p-x", status: "failed", run_date: "2026-11-01" }]);
    db().seed("categorization_rules", [{ id: "cr1", property_id: null, match_type: "keyword", pattern: "repair", coa_account_id: "a3", priority: 60, active: true }, { id: "cr2", property_id: "other", match_type: "keyword", pattern: "nope", coa_account_id: "a3", priority: 1, active: true }]);
    db().seed("accounting_periods", [{ property_id: "p-x", year: 2026, month: 9, status: "closed" }]);
    db().seed("accounting_period_events", [{ property_id: "p-x", year: 2026, month: 9, action: "closed", reason: null, at: "2026-10-01T00:00:00Z" }]);
    const o = await books.booksOverview(db(), { userId: admin, propertyId: "p-x" });
    expect(o.property.label).toBe("9 Test Rd, Lusk, WY");
    expect(o.accounts.map((a) => a.code)).toEqual(["1000", "6400"]); // no member account, no retired account
    expect(o.review).toEqual([{ id: "t1", postedDate: "2026-11-02", amountCents: 500, direction: "out", merchantName: "Zeta", description: "POS", reason: "no_matching_rule", suggestion: { code: "6400", name: "Repairs" } }]);
    const e1 = o.entries.find((e) => e.id === "e1")!;
    expect(e1).toMatchObject({ reversed: true, isReversal: false, correction: { kind: "recategorize", reason: "x" }, receipts: [{ id: "att1", fileName: "receipt.jpg" }] });
    expect(o.entries.find((e) => e.id === "e2")).toMatchObject({ isReversal: true, reason: "recategorize: x" });
    expect(o.recurring).toEqual([{ id: "rr", description: "Mgmt fee", amountCents: 25000, accountCode: "6400", frequency: "monthly", nextRun: "2026-12-01", active: true, lastStatus: "failed" }]);
    expect(o.rules.map((r) => r.id)).toEqual(["cr1"]); // another property's rule isn't shown
    expect(o.periods).toEqual([{ year: 2026, month: 9, status: "closed" }]);
    expect(o.periodHistory).toHaveLength(1);
  });

  it("the page and the routes are for the Manager: the admin layout, the signed receipt link, and the schedule", async () => {
    const page = readFileSync("src/routes/admin.books.$propertyId.tsx", "utf8");
    expect(page).toMatch(/createFileRoute\("\/admin\/books\/\$propertyId"\)/);
    // No control edits an entry: the only entry actions are the three that post new entries.
    expect(page).not.toMatch(/updateEntry|editEntry|deleteEntry|Edit entry/);
    for (const label of ["Recategorize", "Capitalize", "Reverse", "Reason (required)", "Apply to existing needs-review", "Reopen"]) expect(page).toContain(label);
    db().rpcResults.createSignedUrl = null;
    await expect(books.receiptLink(db(), { userId: USERS.b1, propertyId: IDS.property, attachmentId: "x" })).rejects.toThrow("Only the Manager");
    expect(readFileSync("cron-sweeps.sql", "utf8")).toContain("'recurring-sweep'");
    expect(readFileSync("src/routes/api.public.recurring-sweep.ts", "utf8")).toMatch(/ESCALATION_SWEEP_SECRET/);
  });
});
