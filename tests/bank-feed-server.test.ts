/** Month 6, Prompt 3, the app side: who links an account, the encrypted item, and a daily run that is always logged. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { harness } from "./setup";
import { seedPod, USERS, IDS } from "./fixtures";
import { linkOperatingAccount, listBankFeed, revokeOperatingAccount, runBankFeed, runBankFeedNow } from "@/lib/bank-feed.server";
import { SimulatedBankFeedAdapter, defaultSimulatedScript } from "@/lib/bank-feed-adapters/simulated";
import { decryptPii } from "@/lib/pii-crypto.server";
import type { BankFeedAdapter } from "@/lib/bank-feed";

const db = () => harness.db as any;

beforeEach(() => {
  process.env["W9_TIN_ENCRYPTION_KEY"] = Buffer.alloc(32, 7).toString("base64");
  seedPod(db());
  db().rpcResults.grant_llc_plaid_consent = (a: any) => {
    db().table("llc_plaid_consents").push({ id: "consent-1", property_id: a._property, status: "active", plaid_item_ref: a._item.plaid_item_ref, provider: a._item.provider, last_ingested_through: null });
    return "consent-1";
  };
  db().rpcResults.upsert_bank_transaction = { action: "inserted" };
  db().rpcResults.categorize_new_bank_transactions = { posted: 2, needs_review: 3 };
});

const link = () => linkOperatingAccount(db(), new SimulatedBankFeedAdapter(), { actorId: USERS.admin, propertyId: IDS.property });

describe("linking", () => {
  it("only the Manager links an account; the item is encrypted before it is stored, and it is the LLC's own consent", async () => {
    for (const u of [USERS.b1, USERS.hla, USERS.ra, USERS.broker]) await expect(linkOperatingAccount(db(), new SimulatedBankFeedAdapter(), { actorId: u, propertyId: IDS.property })).rejects.toThrow("Only the Manager");
    const r = await link();
    expect(r).toMatchObject({ consentId: "consent-1", institutionName: "Simulated Bank" });
    const stored = db().table("llc_plaid_consents")[0];
    expect(JSON.stringify(stored)).not.toContain(`sim-item-${IDS.property}`);
    expect(decryptPii(stored.plaid_item_ref, `llc_plaid:${IDS.property}`)).toBe(`sim-item-${IDS.property}`);
    // Bound to its own property: moved elsewhere it will not decrypt.
    expect(() => decryptPii(stored.plaid_item_ref, "llc_plaid:other")).toThrow();
    // Never touches the buyer side.
    expect(db().table("member_plaid_consents")).toHaveLength(0);
  });

  it("an LLC with an operating account already linked can't link another, and without the encryption key nothing is stored", async () => {
    await link();
    await expect(link()).rejects.toThrow("already has an operating account");
    db().table("llc_plaid_consents").length = 0;
    delete process.env["W9_TIN_ENCRYPTION_KEY"];
    await expect(link()).rejects.toThrow(/encryption key/);
    expect(db().table("llc_plaid_consents")).toHaveLength(0);
  });

  it("only the Manager revokes", async () => {
    await link();
    db().rpcResults.revoke_llc_plaid_consent = vi.fn(() => null);
    await expect(revokeOperatingAccount(db(), { actorId: USERS.b1, propertyId: IDS.property })).rejects.toThrow("Only the Manager");
    await revokeOperatingAccount(db(), { actorId: USERS.admin, propertyId: IDS.property });
    expect(db().rpcResults.revoke_llc_plaid_consent).toHaveBeenCalledTimes(1);
    await expect(revokeOperatingAccount(db(), { actorId: USERS.admin, propertyId: "nope" })).rejects.toThrow("no operating account");
  });
});

describe("the daily run", () => {
  const adapterFor = () => new SimulatedBankFeedAdapter();

  it("pulls every active LLC, upserts each transaction, categorizes, and is audit logged", async () => {
    await link();
    db().table("llc_plaid_consents").push({ id: "consent-revoked", property_id: "p-old", status: "revoked", plaid_item_ref: {}, provider: "simulated" });
    const r = await runBankFeed(db(), adapterFor, { trigger: "schedule" });
    expect(r.properties).toHaveLength(1); // the revoked one is never read
    expect(r.properties[0]).toMatchObject({ propertyId: IDS.property, fetched: 6, inserted: 6, posted: 2, needsReview: 3, error: null });
    const log = db().audits("bank_feed.run");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_type: "system", entity_id: r.runId });
    expect(log[0].metadata).toMatchObject({ run_id: r.runId, trigger: "schedule", properties: 1, transactions_fetched: 6, posted_to_ledger: 2, needs_review: 3, failed: 0 });
    expect(log[0].metadata.started_at <= log[0].metadata.finished_at).toBe(true);
  });

  it("every run is logged, even one with nothing to do", async () => {
    const r = await runBankFeed(db(), adapterFor, { trigger: "schedule" });
    expect(r.properties).toEqual([]);
    expect(db().audits("bank_feed.run")).toHaveLength(1);
    await runBankFeed(db(), adapterFor, { trigger: "schedule" });
    expect(db().audits("bank_feed.run")).toHaveLength(2);
  });

  it("a failing property is logged and the others still run; a manual run is the Manager's and logged with who", async () => {
    await link();
    db().table("llc_plaid_consents").push({ id: "c2", property_id: "p-2", status: "active", plaid_item_ref: { ciphertext: "x", iv: "y", auth_tag: "z", key_version: 1 }, provider: "simulated", last_ingested_through: null });
    const r = await runBankFeed(db(), adapterFor, { trigger: "schedule" });
    expect(r.properties.map((p) => [p.propertyId, p.error === null])).toEqual([[IDS.property, true], ["p-2", false]]);
    expect(db().audits("bank_feed.run")[0].metadata.failed).toBe(1);
    await expect(runBankFeedNow(db(), adapterFor, { actorId: USERS.b1 })).rejects.toThrow("Only the Manager");
    await runBankFeedNow(db(), adapterFor, { actorId: USERS.admin, propertyId: IDS.property });
    expect(db().audits("bank_feed.run").at(-1)).toMatchObject({ actor_id: USERS.admin, actor_type: "admin" });
  });

  it("asks the bank for a week before where it got to, with the decrypted item, and records where it got to", async () => {
    await link();
    db().table("llc_plaid_consents")[0].last_ingested_through = "2026-11-10";
    const seen: Array<[string, string | null]> = [];
    const spy: BankFeedAdapter = {
      provider: "simulated",
      link: async () => ({ itemRef: "x", institutionName: "x", accountMask: "x" }),
      listTransactions: async (ref, since) => {
        seen.push([ref, since]);
        return { transactions: defaultSimulatedScript()[0]!.transactions, removed: ["gone-1"], balanceCents: 1234 };
      },
    };
    const recorded = vi.fn(() => null);
    db().rpcResults.record_bank_feed_position = recorded;
    db().rpcResults.remove_bank_transaction = { action: "ignored" };
    const r = await runBankFeed(db(), () => spy, { trigger: "manual", actorId: USERS.admin });
    expect(seen).toEqual([[`sim-item-${IDS.property}`, "2026-11-03"]]);
    expect(r.properties[0]!.removed).toBe(1);
    expect(recorded).toHaveBeenCalledWith(expect.objectContaining({ _property: IDS.property, _through: "2026-11-05", _balance_cents: 1234 }));
  });

  it("with the database refusing (a revoked consent), the run records the error instead of ingesting", async () => {
    await link();
    db().rpc = async (fn: string) => (fn === "has_role" ? { data: true, error: null } : { data: null, error: { message: "This LLC has no active bank-feed consent: nothing is ingested." } });
    const r = await runBankFeed(db(), adapterFor, { trigger: "schedule" });
    expect(r.properties[0]!.error).toMatch(/no active bank-feed consent/);
    expect(r.properties[0]!.inserted).toBe(0);
  });
});

describe("the admin page's data", () => {
  it("is the Manager's, and joins the link, the reconciliation and what needs review", async () => {
    await link();
    db().table("llc_plaid_consents")[0].granted_by_entity = "divieight, LLC as Manager";
    db().seed("bank_reconciliation", [{ property_id: IDS.property, bank_balance_cents: "1000", ledger_cash_cents: "400", difference_cents: "600", unmatched_count: "1", unmatched_in_cents: "0", unmatched_out_cents: "50", needs_review_count: "1", pending_count: "0", unreconciled_cents: "650", last_ingested_through: "2026-11-07" }]);
    db().seed("bank_transactions", [
      { id: "t1", property_id: IDS.property, status: "needs_review", posted_date: "2026-11-05", amount_cents: "50", direction: "out", merchant_name: "Zeta", description: "POS", review_reason: "no_matching_rule" },
      { id: "t2", property_id: IDS.property, status: "posted" },
    ]);
    await expect(listBankFeed(db(), { userId: USERS.b1 })).rejects.toThrow("Only the Manager");
    const rows = await listBankFeed(db(), { userId: USERS.admin });
    const row = rows.find((r) => r.propertyId === IDS.property)!;
    expect(row.consent).toMatchObject({ entity: "divieight, LLC as Manager", provider: "simulated" });
    expect(row.reconciliation).toMatchObject({ bankBalanceCents: 1000, ledgerCashCents: 400, differenceCents: 600, unreconciledCents: 650, needsReviewCount: 1 });
    expect(row.review).toEqual([{ id: "t1", postedDate: "2026-11-05", amountCents: 50, direction: "out", merchantName: "Zeta", description: "POS", reason: "no_matching_rule" }]);
  });
});
