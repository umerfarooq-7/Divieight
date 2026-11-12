/** Month 6, Prompt 9, the app side: the Manager's flow around the database, the simulated ACH rail, the member's payout method and the owner's view. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, USERS, IDS } from "./fixtures";
import * as dist from "@/lib/distributions.server";
import { SimulatedDisbursementAdapter } from "@/lib/disbursement-adapters/simulated";
import { bankDetailsProblem, distributionNoticeText, routingNumberValid, splitDistribution } from "@/lib/distributions";

const db = () => harness.db as any;
const A = IDS.property;
const ROUTING = "021000021"; // a routing number that passes the ABA checksum
const FAR = new Date(Date.now() + 5000 * 3_600_000).toISOString();

type Pay = { id: string; distribution_id: string; property_id: string; holder_key: string; shares: number; amount_cents: number; status: string; payout_method_id: string | null; bank_last4: string | null; failure_reason: string | null };
let calls: Array<[string, Record<string, any>]> = [];

/** A tiny in-memory stand-in for the database functions, so the app's orchestration can be tested without Postgres. */
function wireRpc(distributionId: string) {
  const d = db();
  const rec = (fn: string, a: Record<string, any>) => calls.push([fn, a]);
  d.rpcResults.distributable_cash = vi.fn(() => ({ cash_cents: 1_000_000, reserve_cents: 100_000, committed_cents: 0, distributable_cents: 900_000 }));
  d.rpcResults.create_distribution = vi.fn((a: any) => {
    rec("create_distribution", a);
    return "dist-new";
  });
  d.rpcResults.authorize_distribution = vi.fn((a: any) => {
    rec("authorize_distribution", a);
    return { status: "authorized" };
  });
  d.rpcResults.claim_distribution_payments = vi.fn((a: any) => {
    rec("claim_distribution_payments", a);
    const rows = d.table("distribution_payments") as Pay[];
    const send: any[] = [];
    const held: any[] = [];
    for (const p of rows.filter((r) => r.distribution_id === a._id)) {
      if (a._holder_key ? !(p.holder_key === a._holder_key && p.status === "held") : !["pending", "held"].includes(p.status)) continue;
      const m = (d.table("member_payout_methods") as any[]).find((x) => x.holder_key === p.holder_key && x.status === "active");
      if (m) {
        p.status = "processing";
        p.payout_method_id = m.id;
        p.bank_last4 = m.last4;
        send.push({ payment_id: p.id, holder_key: p.holder_key, amount_cents: p.amount_cents, token: m.token, last4: m.last4 });
      } else if (p.status === "pending") {
        p.status = "held";
        held.push({ payment_id: p.id, holder_key: p.holder_key, amount_cents: p.amount_cents });
      }
    }
    return { send, held };
  });
  d.rpcResults.record_payment_result = vi.fn((a: any) => {
    rec("record_payment_result", a);
    const p = (d.table("distribution_payments") as Pay[]).find((x) => x.id === a._payment)!;
    if (p.status !== "processing") return { status: `already_${p.status}` };
    if (a._state === "sent") {
      p.status = "sent";
      d.table("journal_posts").push({ payment: p.id, cents: p.amount_cents }); // the entry the real function posts
    } else if (a._state === "failed") {
      p.status = "failed";
      p.failure_reason = a._reason;
    }
    return { status: a._state };
  });
  d.rpcResults.finalize_distribution = vi.fn((a: any) => {
    const rows = (d.table("distribution_payments") as Pay[]).filter((r) => r.distribution_id === a._id);
    const n = (s: string[]) => rows.filter((r) => s.includes(r.status)).length;
    const ev = (d.table("distribution_events") as any[]).find((e) => e.id === a._id)!;
    if (n(["processing"]) === 0) {
      if (n(["sent"]) > 0) ev.status = "executed";
      else if (n(["held", "pending"]) === 0 && n(["failed"]) > 0) ev.status = "failed";
    }
    return { status: ev.status, sent: n(["sent"]), processing: n(["processing"]), waiting: n(["held", "pending"]), failed: n(["failed"]) };
  });
  d.rpcResults.save_payout_method = vi.fn((a: any) => {
    rec("save_payout_method", a);
    for (const m of d.table("member_payout_methods") as any[]) if (m.holder_key === a._holder_key) m.status = "removed";
    d.table("member_payout_methods").push({ id: `pm-${d.table("member_payout_methods").length + 1}`, holder_key: a._holder_key, token: a._token, last4: a._last4, status: "active" });
    return "pm";
  });
  void distributionId;
}

const payment = (id: string, holder: string, cents: number, status = "pending"): Pay => ({ id, distribution_id: "dist-1", property_id: A, holder_key: holder, shares: 1, amount_cents: cents, status, payout_method_id: null, bank_last4: null, failure_reason: null });
const addMethod = (holder: string, token: string, last4 = "4321") => db().table("member_payout_methods").push({ id: `pm-${holder}`, holder_key: holder, token, last4, status: "active" });
const notes = () => (db().table("notifications") as any[]).map((n) => ({ to: n.seller_id, type: n.type, message: n.message as string }));
const paid = () => (db().table("journal_posts") as any[]).map((p) => [p.payment, p.cents]);

beforeEach(() => {
  seedPod(db());
  calls = [];
  for (const [id, at] of [[IDS.b1, "2026-01-01T00:00:00Z"], [IDS.b2, "2026-02-01T00:00:00Z"]] as const) {
    const b = db().table("buyer_accounts").find((x: any) => x.id === id)!;
    b.priority_rank = null;
    b.priority_rank_timestamp = at;
  }
  db().seed("cap_table_entries", [
    { property_id: A, share_number: 1, holder_type: "buyer_account", buyer_account_id: IDS.b1, seller_id: null, acquisition_date: FAR, retention_lock_expires_at: FAR },
    { property_id: A, share_number: 2, holder_type: "buyer_account", buyer_account_id: IDS.b2, seller_id: null, acquisition_date: FAR, retention_lock_expires_at: FAR },
  ]);
  db().seed("cap_table_history", []);
  db().seed("distribution_events", [{ id: "dist-1", property_id: A, workflow: "payout", status: "authorized", total_cents: 100_001, total_amount: 1000.01, record_date: "2026-10-01", reason: "Q3 distribution", created_at: new Date().toISOString() }]);
  db().seed("distribution_payments", [payment("pay-1", IDS.b1, 50_001), payment("pay-2", IDS.b2, 50_000)]);
  db().seed("member_payout_methods", []);
  db().seed("journal_posts", []);
  wireRpc("dist-1");
});

const run = (adapter: SimulatedDisbursementAdapter, o: Partial<Parameters<typeof dist.executeDistribution>[1]> = {}) => dist.executeDistribution(db(), { userId: USERS.admin, distributionId: "dist-1", adapter, ...o });

describe("initiating and previewing", () => {
  it("only the Manager previews or creates, and neither writes anything unless asked", async () => {
    const p = { propertyId: A, totalAmount: 1000.01, recordDate: "2026-10-01", reason: "Q3", method: "pro_rata" as const };
    await expect(dist.previewDistribution(db(), { userId: USERS.b1, ...p })).rejects.toThrow("Only the Manager");
    await expect(dist.createDistribution(db(), { userId: USERS.b1, ...p })).rejects.toThrow("Only the Manager");
    const r = await dist.previewDistribution(db(), { userId: USERS.admin, ...p });
    expect(db().rpcResults.create_distribution).not.toHaveBeenCalled();
    // 100001 cents over two equal holders: 50000 each, the leftover cent to rank 1.
    expect(r.lines.map((l) => [l.holderKey, l.amountCents])).toEqual([[IDS.b1, 50_001], [IDS.b2, 50_000]]);
    expect(r.holders.map((h) => h.holderKey)).toEqual([IDS.b1, IDS.b2]);
  });

  it("shows who would be paid and who would be held, and flags a total above the distributable cash", async () => {
    addMethod(IDS.b1, "tok_sim_ok_abcdef123456", "6789");
    const base = { userId: USERS.admin, propertyId: A, recordDate: "2026-10-01", reason: "Q3", method: "pro_rata" as const };
    const r = await dist.previewDistribution(db(), { ...base, totalAmount: 1000 });
    expect(r.lines.map((l) => [l.holderKey, l.payoutLast4])).toEqual([[IDS.b1, "6789"], [IDS.b2, null]]);
    expect(r.willBeHeld).toBe(1);
    expect(r.exceeds).toBe(false);
    expect(r.cash.distributableCents).toBe(900_000);
    expect((await dist.previewDistribution(db(), { ...base, totalAmount: 9000 })).exceeds).toBe(false); // exactly the distributable cash
    expect((await dist.previewDistribution(db(), { ...base, totalAmount: 9000.01 })).exceeds).toBe(true);
  });

  it("uses the holders on the RECORD DATE: a share that moved afterwards still counts for its old holder", async () => {
    // Share 2 went from buyer 2 to buyer 3 on 2026-10-15; the record date is 2026-10-01.
    db().table("cap_table_entries")[1].buyer_account_id = IDS.b3;
    db().seed("cap_table_history", [{ property_id: A, share_number: 2, from_holder_type: "buyer_account", from_buyer_account_id: IDS.b2, from_seller_id: null, changed_at: "2026-10-15T12:00:00Z" }]);
    const base = { userId: USERS.admin, propertyId: A, totalAmount: 1000, reason: "Q3", method: "pro_rata" as const };
    expect((await dist.previewDistribution(db(), { ...base, recordDate: "2026-10-01" })).lines.map((l) => l.holderKey)).toEqual([IDS.b1, IDS.b2]);
    expect((await dist.previewDistribution(db(), { ...base, recordDate: "2026-10-20" })).lines.map((l) => l.holderKey)).toEqual([IDS.b1, IDS.b3]);
  });

  it("creating passes the cents, the lines (rounded down, the leftover to rank 1) and an override with its section to the database", async () => {
    await dist.createDistribution(db(), { userId: USERS.admin, propertyId: A, totalAmount: 1000.01, recordDate: "2026-10-01", reason: " Q3 ", method: "pro_rata" });
    const a = calls.find(([f]) => f === "create_distribution")![1];
    expect(a).toMatchObject({ _total_cents: 100_001, _split_method: "pro_rata", _override: null, _actor: USERS.admin, _record_date: "2026-10-01" });
    expect(a._lines.map((l: any) => [l.holder_key, l.amount])).toEqual([[IDS.b1, 500.01], [IDS.b2, 500]]);
    calls = [];
    await dist.createDistribution(db(), { userId: USERS.admin, propertyId: A, totalAmount: 1000, recordDate: "2026-10-01", reason: "OA", method: "oa_override", percents: { [IDS.b1]: 70, [IDS.b2]: 30 }, oaSection: "OA 6.2" });
    const o = calls.find(([f]) => f === "create_distribution")![1];
    expect(o._override).toEqual({ percents: { [IDS.b1]: 70, [IDS.b2]: 30 }, oa_section: "OA 6.2" });
    expect(o._lines.map((l: any) => l.amount)).toEqual([700, 300]);
  });

  it("checks an override before the database is asked", async () => {
    const base = { userId: USERS.admin, propertyId: A, totalAmount: 1000, recordDate: "2026-10-01", reason: "OA", method: "oa_override" as const };
    await expect(dist.createDistribution(db(), { ...base, percents: { [IDS.b1]: 70, [IDS.b2]: 30 }, oaSection: " " })).rejects.toThrow("Name the Operating Agreement section");
    await expect(dist.createDistribution(db(), { ...base, percents: { [IDS.b1]: 70, [IDS.b2]: 20 }, oaSection: "OA 6.2" })).rejects.toThrow("exactly 100");
    await expect(dist.createDistribution(db(), { ...base, percents: { [IDS.b1]: 100 }, oaSection: "OA 6.2" })).rejects.toThrow("doesn't cover every current holder");
    await expect(dist.createDistribution(db(), { ...base, totalAmount: 10.005, percents: { [IDS.b1]: 70, [IDS.b2]: 30 }, oaSection: "OA 6.2" })).rejects.toThrow("two decimal");
    expect(db().rpcResults.create_distribution).not.toHaveBeenCalled();
  });

  it("the pure split is the Prompt 8 rule: down to the cent, leftover cents to rank 1", () => {
    const holders = [{ holderKey: "a", shares: 1, rank: 1 }, { holderKey: "b", shares: 1, rank: 2 }, { holderKey: "c", shares: 1, rank: 3 }];
    const lines = splitDistribution({ totalCents: 100, holders, method: "pro_rata" });
    expect(lines.map((l) => Math.round(l.amount * 100))).toEqual([34, 33, 33]);
  });
});

describe("authorizing with a typed signature", () => {
  it("the signature must be the Manager's own full name, checked on the server, before the database is asked", async () => {
    const p = { userId: USERS.admin, distributionId: "dist-1", managerName: "Mark Manager" };
    await expect(dist.authorizeDistribution(db(), { ...p, signedName: "Somebody Else" })).rejects.toThrow("full legal name");
    await expect(dist.authorizeDistribution(db(), { ...p, signedName: "  " })).rejects.toThrow("full legal name");
    await expect(dist.authorizeDistribution(db(), { ...p, signedName: "Mark Manager", managerName: null })).rejects.toThrow("full legal name");
    await expect(dist.authorizeDistribution(db(), { ...p, userId: USERS.b1, signedName: "Mark Manager" })).rejects.toThrow("Only the Manager");
    expect(db().rpcResults.authorize_distribution).not.toHaveBeenCalled();
  });

  it("authorizing tells each owner their own amount, from the record, once", async () => {
    db().seed("distribution_payments", [payment("pay-1", IDS.b1, 50_001), payment("pay-2", IDS.b2, 50_000)]);
    await dist.authorizeDistribution(db(), { userId: USERS.admin, distributionId: "dist-1", signedName: "mark manager", managerName: "Mark Manager" });
    expect(db().rpcResults.authorize_distribution).toHaveBeenCalledWith(expect.objectContaining({ _signed_name: "mark manager", _actor: USERS.admin }));
    const n = notes().filter((x) => x.type === "distribution_event");
    expect(n.map((x) => x.to).sort()).toEqual([USERS.b1, USERS.b2].sort());
    expect(n.find((x) => x.to === USERS.b1)!.message).toContain("$500.01");
    expect(n.find((x) => x.to === USERS.b2)!.message).toContain("$500.00");
    expect(n[0]!.message).toContain("$1,000.01");
    await dist.authorizeDistribution(db(), { userId: USERS.admin, distributionId: "dist-1", signedName: "Mark Manager", managerName: "Mark Manager" });
    expect(notes().filter((x) => x.type === "distribution_event")).toHaveLength(2); // the dedupe key: one notice per owner
  });

  it("a distribution that is no longer a draft can't be authorized again", async () => {
    db().rpcResults.authorize_distribution = () => ({ status: "not_draft", current: "executed" });
    await expect(dist.authorizeDistribution(db(), { userId: USERS.admin, distributionId: "dist-1", signedName: "Mark Manager", managerName: "Mark Manager" })).rejects.toThrow("executed");
  });

  it("the notice text is made from the record", () => {
    const text = distributionNoticeText({ totalCents: 100_001, recordDate: "2026-10-01", reason: "Q3", status: "authorized" }, { amountCents: 50_001, shares: 1 });
    expect(text).toContain("$1,000.01");
    expect(text).toContain("$500.01");
    expect(text).toContain("record date 2026-10-01");
    expect(text).toContain("Reason: Q3");
  });
});

describe("executing through the simulated ACH rail", () => {
  it("pays every member who has a payout method and posts once per payment; the adapter gets the token and the amount, never an account number", async () => {
    addMethod(IDS.b1, "tok_sim_ok_aaaaaaaaaaaa");
    addMethod(IDS.b2, "tok_sim_ok_bbbbbbbbbbbb");
    const adapter = new SimulatedDisbursementAdapter();
    const r = await run(adapter);
    expect(r).toMatchObject({ status: "executed", sent: 2, failed: 0, processing: 0, held: 0 });
    expect(adapter.sent.map((s) => [s.memberBankRef, s.amountCents, s.idempotencyKey])).toEqual([
      ["tok_sim_ok_aaaaaaaaaaaa", 50_001, "pay-1"],
      ["tok_sim_ok_bbbbbbbbbbbb", 50_000, "pay-2"],
    ]);
    expect(paid()).toEqual([["pay-1", 50_001], ["pay-2", 50_000]]);
    expect(notes().filter((n) => n.message.includes("was sent by ACH"))).toHaveLength(2);
  });

  it("exactly once: executing again sends nothing and posts nothing", async () => {
    addMethod(IDS.b1, "tok_sim_ok_aaaaaaaaaaaa");
    addMethod(IDS.b2, "tok_sim_ok_bbbbbbbbbbbb");
    const adapter = new SimulatedDisbursementAdapter();
    await run(adapter);
    await run(adapter);
    await run(adapter);
    expect(adapter.sent).toHaveLength(2);
    expect(paid()).toHaveLength(2);
    expect(notes().filter((n) => n.message.includes("was sent by ACH"))).toHaveLength(2);
  });

  it("a failed ACH posts nothing, alerts the Manager, and is retried only when asked", async () => {
    addMethod(IDS.b1, "tok_sim_ok_aaaaaaaaaaaa");
    addMethod(IDS.b2, "tok_sim_ok_bbbbbbbbbbbb");
    const adapter = new SimulatedDisbursementAdapter().fail("tok_sim_ok_aaaaaaaaaaaa", "Account closed");
    const r = await run(adapter);
    expect(r).toMatchObject({ status: "executed", sent: 1, failed: 1 });
    expect(paid()).toEqual([["pay-2", 50_000]]); // nothing for the failed one
    expect((db().table("distribution_payments") as Pay[]).find((p) => p.id === "pay-1")).toMatchObject({ status: "failed", failure_reason: "Account closed" });
    const alert = notes().find((n) => n.to === USERS.admin && n.message.includes("failed"));
    expect(alert?.message).toContain("Account closed");
    expect(alert?.message).toContain("Nothing was posted");
    // running again does not resend the failed one on its own
    await run(adapter);
    expect(adapter.sent.filter((s) => s.idempotencyKey === "pay-1")).toHaveLength(1);
  });

  it("when every payment fails the distribution is failed and nothing is posted", async () => {
    addMethod(IDS.b1, "tok_sim_ok_aaaaaaaaaaaa");
    addMethod(IDS.b2, "tok_sim_ok_bbbbbbbbbbbb");
    const adapter = new SimulatedDisbursementAdapter().fail("tok_sim_ok_aaaaaaaaaaaa").fail("tok_sim_ok_bbbbbbbbbbbb");
    const r = await run(adapter);
    expect(r.status).toBe("failed");
    expect(paid()).toEqual([]);
    expect(notes().filter((n) => n.to === USERS.admin)).toHaveLength(2);
  });

  it("a member without a payout method is held and told; the rest are paid and nothing waits on them", async () => {
    addMethod(IDS.b1, "tok_sim_ok_aaaaaaaaaaaa");
    const adapter = new SimulatedDisbursementAdapter();
    const r = await run(adapter);
    expect(r).toMatchObject({ status: "executed", sent: 1, held: 1 });
    expect(adapter.sent.map((s) => s.idempotencyKey)).toEqual(["pay-1"]);
    expect(paid()).toEqual([["pay-1", 50_001]]);
    expect((db().table("distribution_payments") as Pay[]).find((p) => p.id === "pay-2")!.status).toBe("held");
    const held = notes().find((n) => n.to === USERS.b2);
    expect(held?.message).toContain("not paid because you have no payout method");
    expect(held?.message).toContain("held for you");
    expect(notes().filter((n) => n.to === USERS.b2)).toHaveLength(1);
    // asking again does not tell them twice
    await run(adapter);
    expect(notes().filter((n) => n.to === USERS.b2)).toHaveLength(1);
  });

  it("a delayed transfer stays with the bank, posts nothing yet, and settles when checked", async () => {
    addMethod(IDS.b1, "tok_sim_ok_aaaaaaaaaaaa");
    addMethod(IDS.b2, "tok_sim_ok_bbbbbbbbbbbb");
    const adapter = new SimulatedDisbursementAdapter().delay("tok_sim_ok_aaaaaaaaaaaa");
    const r = await run(adapter);
    expect(r).toMatchObject({ status: "authorized", sent: 1, processing: 1 }); // still open while the bank has one
    expect(paid()).toEqual([["pay-2", 50_000]]);
    adapter.settle("pay-1", "sent");
    const s = await dist.settleDistribution(db(), { userId: USERS.admin, distributionId: "dist-1", adapter });
    expect(s).toMatchObject({ status: "executed", sent: 2, processing: 0 });
    expect(paid()).toEqual([["pay-2", 50_000], ["pay-1", 50_001]]);
    expect(adapter.sent).toHaveLength(2); // settling asked the rail, it did not send again
    await dist.settleDistribution(db(), { userId: USERS.admin, distributionId: "dist-1", adapter });
    expect(paid()).toHaveLength(2);
  });

  it("a delayed transfer that ends in failure posts nothing", async () => {
    addMethod(IDS.b1, "tok_sim_ok_aaaaaaaaaaaa");
    addMethod(IDS.b2, "tok_sim_ok_bbbbbbbbbbbb");
    const adapter = new SimulatedDisbursementAdapter().delay("tok_sim_ok_aaaaaaaaaaaa");
    await run(adapter);
    adapter.settle("pay-1", "failed", "Returned");
    const s = await dist.settleDistribution(db(), { userId: USERS.admin, distributionId: "dist-1", adapter });
    expect(s.failed).toBe(1);
    expect(paid()).toEqual([["pay-2", 50_000]]);
  });

  it("when the rail doesn't answer the payment stays with the bank: neither lost nor sent twice", async () => {
    addMethod(IDS.b1, "tok_sim_ok_aaaaaaaaaaaa");
    addMethod(IDS.b2, "tok_sim_ok_bbbbbbbbbbbb");
    const adapter = new SimulatedDisbursementAdapter();
    const real = adapter.sendAch.bind(adapter);
    let down = true;
    adapter.sendAch = async (ref, cents, key) => {
      if (down && key === "pay-1") throw new Error("timeout");
      return real(ref, cents, key);
    };
    await expect(run(adapter)).rejects.toThrow("didn't answer");
    expect((db().table("distribution_payments") as Pay[]).find((p) => p.id === "pay-1")!.status).toBe("processing");
    expect(paid()).toEqual([["pay-2", 50_000]]);
    await run(adapter); // claims nothing again: the payment is not sent a second time
    down = false;
    expect((db().table("distribution_payments") as Pay[]).find((p) => p.id === "pay-1")!.status).toBe("processing");
    const s = await dist.settleDistribution(db(), { userId: USERS.admin, distributionId: "dist-1", adapter });
    expect(s.sent).toBe(2); // the rail is asked by the same key and answers
    expect(paid()).toHaveLength(2);
  });

  it("only the Manager executes, settles or retries", async () => {
    const adapter = new SimulatedDisbursementAdapter();
    await expect(run(adapter, { userId: USERS.b1 })).rejects.toThrow("Only the Manager");
    await expect(dist.settleDistribution(db(), { userId: USERS.b1, distributionId: "dist-1", adapter })).rejects.toThrow("Only the Manager");
    await expect(dist.retryPayment(db(), { userId: USERS.b1, paymentId: "pay-1", adapter })).rejects.toThrow("Only the Manager");
    expect(adapter.sent).toHaveLength(0);
  });
});

describe("a member's payout method", () => {
  it("the bank details are checked, tokenized and dropped: only a token and the last four go to the database", async () => {
    const adapter = new SimulatedDisbursementAdapter();
    const r = await dist.savePayoutMethod(db(), { userId: USERS.b1, propertyId: A, routing: ROUTING, account: "000123456789", bankName: "First Bank", adapter });
    expect(r.released).toBe(0);
    const args = calls.find(([f]) => f === "save_payout_method")![1];
    expect(args).toMatchObject({ _holder_key: IDS.b1, _last4: "6789", _bank_name: "First Bank", _actor: USERS.b1 });
    expect(String(args._token)).toMatch(/^tok_sim_ok_/);
    // Nowhere in what was sent or stored is a full number.
    const everything = JSON.stringify([calls, db().table("member_payout_methods"), db().table("audit_log")]);
    expect(everything).not.toContain("000123456789");
    expect(everything).not.toContain(ROUTING);
  });

  it("rejects bad numbers, and only an owner of the property can add one", async () => {
    const adapter = new SimulatedDisbursementAdapter();
    await expect(dist.savePayoutMethod(db(), { userId: USERS.b1, propertyId: A, routing: "123456789", account: "000123456789", adapter })).rejects.toThrow("routing number");
    await expect(dist.savePayoutMethod(db(), { userId: USERS.b1, propertyId: A, routing: ROUTING, account: "12", adapter })).rejects.toThrow("account number");
    await expect(dist.savePayoutMethod(db(), { userId: "u-nobody", propertyId: A, routing: ROUTING, account: "000123456789", adapter })).rejects.toThrow("don't have ownership");
    expect(calls.filter(([f]) => f === "save_payout_method")).toHaveLength(0);
    expect(routingNumberValid(ROUTING)).toBe(true);
    expect(routingNumberValid("12345678")).toBe(false);
    expect(bankDetailsProblem(ROUTING, "000123456789")).toBeNull();
  });

  it("adding one releases that member's HELD payment, and only theirs", async () => {
    addMethod(IDS.b1, "tok_sim_ok_aaaaaaaaaaaa");
    const adapter = new SimulatedDisbursementAdapter();
    await run(adapter); // b2 is held
    expect(paid()).toEqual([["pay-1", 50_001]]);
    // A third member's pending payment must not be sent by someone else adding a method.
    (db().table("distribution_payments") as Pay[]).push(payment("pay-3", IDS.b3, 10, "pending"));
    const r = await dist.savePayoutMethod(db(), { userId: USERS.b2, propertyId: A, routing: ROUTING, account: "000123456789", adapter });
    expect(r.released).toBe(1);
    expect(paid()).toEqual([["pay-1", 50_001], ["pay-2", 50_000]]);
    expect((db().table("distribution_payments") as Pay[]).find((p) => p.id === "pay-3")!.status).toBe("pending");
    expect(adapter.sent.map((s) => s.idempotencyKey)).toEqual(["pay-1", "pay-2"]);
    expect(calls.filter(([f]) => f === "claim_distribution_payments").pop()![1]).toMatchObject({ _holder_key: IDS.b2, _actor: null });
  });

  it("the simulator's account numbers choose the outcome so every case can be seen live", async () => {
    const a = new SimulatedDisbursementAdapter();
    expect((await a.tokenizeBank({ routing: ROUTING, account: "000000000002" })).token).toMatch(/^tok_sim_fail_/);
    expect((await a.tokenizeBank({ routing: ROUTING, account: "000000000003" })).token).toMatch(/^tok_sim_slow_/);
    const ok = await a.tokenizeBank({ routing: ROUTING, account: "000000001234" });
    expect(ok.last4).toBe("1234");
    expect((await a.sendAch(ok.token, 100, "k1")).state).toBe("sent");
    expect((await a.sendAch((await a.tokenizeBank({ routing: ROUTING, account: "000000000002" })).token, 100, "k2")).state).toBe("failed");
  });
});

describe("what the owner sees", () => {
  it("their own payment on each distribution, never another member's amount", async () => {
    addMethod(IDS.b1, "tok_sim_ok_aaaaaaaaaaaa");
    await run(new SimulatedDisbursementAdapter());
    const r = await dist.ownerDistributions(db(), { userId: USERS.b1, propertyId: A });
    expect(r.allowed).toBe(true);
    if (!r.allowed) return;
    expect(r.payoutMethod).toMatchObject({ last4: "4321" });
    expect(r.distributions).toHaveLength(1);
    expect(r.distributions[0]).toMatchObject({ amountCents: 50_001, status: "sent", recordDate: "2026-10-01", reason: "Q3 distribution" });
    expect(JSON.stringify(r)).not.toContain("tok_sim");
    const other = await dist.ownerDistributions(db(), { userId: USERS.b2, propertyId: A });
    if (!other.allowed) throw new Error("expected allowed");
    expect(other.payoutMethod).toBeNull();
    expect(other.distributions[0]).toMatchObject({ amountCents: 50_000, status: "held" });
    expect(await dist.ownerDistributions(db(), { userId: "u-nobody", propertyId: A })).toEqual({ allowed: false });
  });
});

describe("what does not block, and the wiring", () => {
  it("the Manager's side never looks at the Retention Lock or an overdue expense", () => {
    const code = readFileSync("src/lib/distributions.server.ts", "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");
    expect(code).not.toMatch(/retention_lock|overdue|expense_allocations|capital_call/i);
  });

  it("the screens carry the steps the Manager and the owner need", () => {
    const admin = readFileSync("src/routes/admin.distributions.tsx", "utf8");
    for (const label of ["Preview each owner's amount", "Sign and authorize", "Execute: pay the owners", "Check payments with the bank", "Retry", "Void and make a corrected one", "Save reserve", "No payout method: will be held"]) expect(admin, label).toContain(label);
    const owner = readFileSync("src/routes/owner.properties.$propertyId.distributions.tsx", "utf8");
    for (const label of ["Where you are paid", "Save payout method", "held for you"]) expect(owner, label).toContain(label);
    expect(readFileSync("src/routes/owner.properties.$propertyId.index.tsx", "utf8")).toContain("/distributions");
  });
});
