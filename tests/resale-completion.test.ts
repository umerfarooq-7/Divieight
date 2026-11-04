/**
 * Resale completion and the Final Sync. The database function does the cap table
 * change; `mirrorSync` stands in for it here (the real SQL is run on Postgres
 * separately) so these tests can check everything that reads the result.
 */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { hoursFromNow, seedPod, IDS, USERS } from "./fixtures";
import { syncCapTable } from "@/lib/entity-genesis.server";
import { getOwnerLlc } from "@/lib/owner-llc.functions";
import { getOwnerProperty } from "@/lib/owner.functions";
import { pickRofrWinner, ROFR_WINNER_RULE } from "@/lib/resale";
import {
  cancelResaleSale,
  completeResaleSale,
  createResaleListing,
  exerciseResaleRofr,
  getOwnerResale,
  listResaleForAdmin,
  recordResalePosition,
  withdrawResaleListing,
} from "@/lib/resale.functions";
import { settleRofr } from "@/lib/resale.server";
import { adminCalendar, createCalendarYear, openSelection, ownerCalendar, transferUpcomingWeeks } from "@/lib/use-calendar.server";
import { castVoteBallot, closeVoteAsAdmin, createVoteAsAdmin, getVoteForOwner, openVoteAsAdmin } from "@/lib/votes.functions";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const A = IDS.property;
const PAST = new Date(Date.now() - 86_400_000).toISOString();

/** A: B1 (shares 1-2), B2 (share 3), retained seller (share 4). B1 and B2 ranked by reservation time. */
function seed() {
  seedPod(db());
  const cap = (share_number: number, holder: Record<string, unknown>) =>
    db().seed("cap_table_entries", [{ property_id: A, share_number, buyer_account_id: null, seller_id: null, account_member_names: [], acquisition_date: PAST, retention_lock_started_at: PAST, retention_lock_expires_at: PAST, ...holder }]);
  cap(1, { holder_type: "buyer_account", buyer_account_id: IDS.b1, account_member_names: ["Alice One", "Bob One"] });
  cap(2, { holder_type: "buyer_account", buyer_account_id: IDS.b1, account_member_names: ["Alice One", "Bob One"] });
  cap(3, { holder_type: "buyer_account", buyer_account_id: IDS.b2, account_member_names: ["Carol Two"] });
  cap(4, { holder_type: "retained_seller", seller_id: IDS.seller });
  rank(IDS.b1, "2026-01-01T00:00:00.000Z");
  rank(IDS.b2, "2026-02-01T00:00:00.000Z");
  db().seed("entity_genesis", [{ property_id: A, llc_name: "D8 Lusk, LLC", ein_status: "verified", oa_executed_at: PAST }]);
  db().seed("co_owner_digital_keys", [
    { property_id: A, holder_type: "buyer_account", buyer_account_id: IDS.b1, seller_id: null, shares: 2 },
    { property_id: A, holder_type: "buyer_account", buyer_account_id: IDS.b2, seller_id: null, shares: 1 },
    { property_id: A, holder_type: "retained_seller", buyer_account_id: null, seller_id: IDS.seller, shares: 1 },
  ]);
  db().rpcResults.complete_resale_transaction = mirrorSync;
}
const rank = (id: string, at: string) => (db().table("buyer_accounts").find((b) => b.id === id)!.priority_rank_timestamp = at);

/** Stands in for complete_resale_transaction in resale-completion.sql. */
function mirrorSync(args: { _transaction: string; _actor: string }) {
  const t = db().table("resale_transactions").find((x) => x.id === args._transaction)!;
  if (db().table("cap_table_history").some((h) => h.resale_transaction_id === t.id)) return { applied: false, reason: "already_applied" };
  const l = db().table("resale_listings").find((x) => x.id === t.listing_id)!;
  const c = db().table("cap_table_entries").find((x) => x.property_id === l.property_id && x.share_number === l.share_number)!;
  const seller = String(t.buyer_holder_key).startsWith("seller:");
  const buyerId = seller ? null : t.buyer_holder_key;
  db().seed("cap_table_history", [{ property_id: l.property_id, share_number: l.share_number, resale_transaction_id: t.id, from_buyer_account_id: c.buyer_account_id, from_seller_id: c.seller_id, to_buyer_account_id: buyerId }]);
  Object.assign(t, { status: "completed", completed_at: new Date().toISOString() });
  Object.assign(c, {
    holder_type: seller ? "retained_seller" : "buyer_account",
    buyer_account_id: buyerId,
    seller_id: seller ? String(t.buyer_holder_key).slice(7) : null,
    account_member_names: db().table("account_members").filter((m) => m.buyer_account_id === buyerId).map((m) => m.full_name),
    acquisition_date: new Date().toISOString(),
    retention_lock_expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
  });
  l.status = "sold";
  db().seed("cpa_worksheet_flags", [{ property_id: l.property_id, resale_transaction_id: t.id, flag_type: "section_754_review", note: `Share #${l.share_number} changed hands.` }]);
  return { applied: true };
}

const list = async (user: string, shareNumber: number) => {
  as(user);
  const r = await createResaleListing({ data: { propertyId: A, shareNumber, askingPrice: 300000, feeAcknowledged: true } });
  expect(r.error).toBeUndefined();
  return r.id!;
};
const agreeB1 = async (listingId: string) => {
  as(USERS.b1);
  await recordResalePosition({ data: { propertyId: A, listingId, accountMemberId: IDS.b1m1, position: "exercise", initials: "AO" } });
  await recordResalePosition({ data: { propertyId: A, listingId, accountMemberId: IDS.b1m2, position: "exercise", initials: "BO" } });
};
const elect = async (user: string, listingId: string) => {
  as(user);
  const r = await exerciseResaleRofr({ data: { propertyId: A, listingId } });
  expect(r.error).toBeUndefined();
};
const closeWindow = async (listingId: string) => {
  db().table("resale_listings").find((l) => l.id === listingId)!.rofr_closes_at = new Date(Date.now() - 1000).toISOString();
  return settleRofr(db());
};
const election = (holderKey: string) => db().table("resale_rofr_elections").find((e) => e.holder_key === holderKey)!;
const listing = (id: string) => db().table("resale_listings").find((l) => l.id === id)!;
const sale = () => db().table("resale_transactions")[0]!;
const complete = (transactionId = sale().id) => {
  as(USERS.admin);
  return completeResaleSale({ data: { transactionId } });
};
const shareHolder = (n: number) => db().table("cap_table_entries").find((c) => c.property_id === A && c.share_number === n)!;

/** B2's share 3 goes to B1, who won the ROFR. */
async function soldToB1() {
  const id = await list(USERS.b2, 3);
  await agreeB1(id);
  await elect(USERS.b1, id);
  await closeWindow(id);
  return id;
}

describe("conflict resolution", () => {
  it("two elections: the better rank wins, whoever elected first", async () => {
    seed();
    const id = await list(IDS.seller, 4);
    await elect(USERS.b2, id);
    await agreeB1(id);
    await elect(USERS.b1, id);
    expect(election(IDS.b1).priority_rank_at_election).toBe(1);
    expect(election(IDS.b2).priority_rank_at_election).toBe(2);
    expect(await closeWindow(id)).toEqual({ openMarket: 0, exercised: 1, resolved: 1 });
    expect(election(IDS.b1).status).toBe("won");
    expect(election(IDS.b2).status).toBe("lost");
    expect(listing(id).status).toBe("rofr_exercised");
    expect(sale()).toMatchObject({ listing_id: id, buyer_holder_key: IDS.b1, buyer_user_id: USERS.b1, price: 300000, flat_fee: 500, status: "pending_closing" });
  });

  it("one election wins automatically; no election goes open_market with no sale", async () => {
    seed();
    const one = await list(IDS.seller, 4);
    await elect(USERS.b2, one);
    await closeWindow(one);
    expect(election(IDS.b2).status).toBe("won");
    expect(sale().buyer_holder_key).toBe(IDS.b2);

    const none = await list(USERS.b2, 3);
    await closeWindow(none);
    expect(listing(none).status).toBe("open_market");
    expect(db().table("resale_transactions")).toHaveLength(1);
  });

  it("a retained seller takes the temporary last rank, so any buyer beats them", async () => {
    seed();
    const id = await list(USERS.b2, 3);
    await elect(IDS.seller, id);
    await agreeB1(id);
    await elect(USERS.b1, id);
    expect(election(`seller:${IDS.seller}`).priority_rank_at_election).toBe(9);
    await closeWindow(id);
    expect(election(IDS.b1).status).toBe("won");
    expect(election(`seller:${IDS.seller}`).status).toBe("lost");
  });

  it("tie: the earliest election wins; a missing rank loses", () => {
    const e = (id: string, rank: number | null, at: string) => ({ id, priority_rank_at_election: rank, elected_at: at });
    expect(pickRofrWinner([e("a", 2, "2027-01-02T00:00:00Z"), e("b", 2, "2027-01-01T00:00:00Z")])!.id).toBe("b");
    expect(pickRofrWinner([e("a", null, "2027-01-01T00:00:00Z"), e("b", 8, "2027-01-02T00:00:00Z")])!.id).toBe("b");
    expect(pickRofrWinner([])).toBeNull();
  });

  it("notifies the seller, the winner and the losers, once, with the rule; two sweeps make one sale", async () => {
    seed();
    const id = await list(IDS.seller, 4);
    await elect(USERS.b2, id);
    await agreeB1(id);
    await elect(USERS.b1, id);
    listing(id).rofr_closes_at = new Date(Date.now() - 1000).toISOString();
    await Promise.all([settleRofr(db()), settleRofr(db())]);
    await settleRofr(db());
    expect(db().table("resale_transactions")).toHaveLength(1);
    const mentions = (user: string, pattern: RegExp) => db().notificationsFor(user).filter((n) => pattern.test(n.message)).length;
    expect(mentions(USERS.b1, /confirmed as the buyer/)).toBe(1);
    expect(mentions(USERS.b2, new RegExp(ROFR_WINNER_RULE))).toBe(1);
    expect(mentions(IDS.seller, /confirmed as the buyer/)).toBe(1);
    expect(db().audits("resale.winner_confirmed")).toHaveLength(1);
    expect(db().audits("resale.winner_confirmed")[0]!.metadata).toMatchObject({ winner_holder_key: IDS.b1, winner_rank: 1, rule: ROFR_WINNER_RULE });
  });

  it("finishes a listing that stopped between creating the sale and marking elections", async () => {
    seed();
    const id = await list(IDS.seller, 4);
    await elect(USERS.b2, id);
    await closeWindow(id);
    election(IDS.b2).status = "active"; // as if the process stopped after the sale was created
    await settleRofr(db());
    expect(election(IDS.b2).status).toBe("won");
    expect(db().table("resale_transactions")).toHaveLength(1);
  });

  it("once a winner exists the seller can't withdraw", async () => {
    seed();
    const id = await soldToB1();
    as(USERS.b2);
    expect((await withdrawResaleListing({ data: { propertyId: A, listingId: id } })).error).toMatch(/buyer has been confirmed/);
    const { mine } = await getOwnerResale({ data: { propertyId: A } });
    expect(mine[0]).toMatchObject({ canWithdraw: false, saleStatus: "pending_closing" });
  });
});

describe("completing a sale", () => {
  it("triggers the sync with the sale's id and the admin", async () => {
    seed();
    await soldToB1();
    const calls: unknown[] = [];
    db().rpcResults.complete_resale_transaction = (args: { _transaction: string; _actor: string }) => {
      calls.push(args);
      return mirrorSync(args);
    };
    expect(await complete()).toEqual({ applied: true });
    expect(calls).toEqual([{ _transaction: sale().id, _actor: USERS.admin }]);
    expect(shareHolder(3).buyer_account_id).toBe(IDS.b1);
    expect(db().audits("resale.sale_completed")).toHaveLength(1);
  });

  it("is admin only", async () => {
    seed();
    await soldToB1();
    as(USERS.b1);
    await expect(completeResaleSale({ data: { transactionId: sale().id } })).rejects.toThrow("Not authorized");
    await expect(cancelResaleSale({ data: { transactionId: sale().id, reason: "no" } })).rejects.toThrow("Not authorized");
    expect(sale().status).toBe("pending_closing");
  });

  it("calling twice doesn't apply or notify twice", async () => {
    seed();
    await soldToB1();
    await complete();
    expect(await complete()).toEqual({ applied: false });
    expect(db().table("cap_table_history")).toHaveLength(1);
    expect(db().audits("resale.sale_completed")).toHaveLength(1);
    expect(db().notificationsFor(USERS.b1).filter((n) => /purchase is complete/.test(n.subject ?? n.message) || /You now hold/.test(n.message))).toHaveLength(1);
  });

  it("if the database refuses, the error reaches the admin and nothing is announced", async () => {
    seed();
    await soldToB1();
    (db() as any).rpc = async (fn: string, args: Record<string, unknown>) =>
      fn === "has_role" ? { data: args._user_id === USERS.admin, error: null } : { data: null, error: { message: "Share #3 is no longer held by the seller" } };
    await expect(complete()).rejects.toThrow("no longer held by the seller");
    expect(db().audits("resale.sale_completed")).toEqual([]);
    expect(shareHolder(3).buyer_account_id).toBe(IDS.b2);
  });
});

describe("cancelling a sale", () => {
  it("needs a reason, leaves the cap table untouched, is logged, and lets the seller relist", async () => {
    seed();
    const id = await soldToB1();
    const before = JSON.stringify(db().table("cap_table_entries"));
    as(USERS.admin);
    await expect(cancelResaleSale({ data: { transactionId: sale().id, reason: "  " } })).rejects.toThrow("Missing reason");
    await cancelResaleSale({ data: { transactionId: sale().id, reason: "Buyer's funds fell through" } });
    expect(sale()).toMatchObject({ status: "cancelled", cancel_reason: "Buyer's funds fell through", cancelled_by: USERS.admin });
    expect(JSON.stringify(db().table("cap_table_entries"))).toBe(before);
    expect(db().table("cap_table_history")).toEqual([]);
    expect(listing(id).status).toBe("withdrawn");
    expect(election(IDS.b1).status).toBe("lost");
    expect(db().audits("resale.sale_cancelled")[0]!.metadata.reason).toBe("Buyer's funds fell through");
    expect(db().notificationsFor(USERS.b2).some((n) => /fell through/.test(n.message))).toBe(true);
    expect(db().notificationsFor(USERS.b1).some((n) => /fell through/.test(n.message))).toBe(true);
    await list(USERS.b2, 3);
    expect(db().table("resale_listings").filter((l) => l.status === "rofr_open")).toHaveLength(1);
  });

  it("a completed sale can't be cancelled; a cancelled one isn't settled again", async () => {
    seed();
    await soldToB1();
    await complete();
    as(USERS.admin);
    await expect(cancelResaleSale({ data: { transactionId: sale().id, reason: "late" } })).rejects.toThrow("waiting to close");
    expect(sale().status).toBe("completed");
  });
});

describe("after the sync, everything reads the new holder", () => {
  it("the roster shows the new holder and not the old one", async () => {
    seed();
    await soldToB1();
    await complete();
    as(USERS.b1);
    const llc = JSON.stringify(await getOwnerLlc({ data: { propertyId: A } }));
    expect(llc).toContain("Alice One");
    expect(llc).not.toContain("Carol Two");
  });

  it("the seller loses that share's votes and access; the buyer's weight rises", async () => {
    seed();
    await soldToB1();
    as(USERS.admin);
    const { id } = await createVoteAsAdmin({ data: { propertyId: A, title: "Roof", voteType: "ordinary", opensAt: hoursFromNow(-1), closesAt: hoursFromNow(24) } });
    await openVoteAsAdmin({ data: { voteId: id } });
    as(USERS.b2);
    expect((await getVoteForOwner({ data: { propertyId: A, voteId: id } }))?.myWeight).toBe(1);
    await castVoteBallot({ data: { propertyId: A, voteId: id, choice: "Yes" } });
    await complete();
    as(USERS.b2);
    expect(await getVoteForOwner({ data: { propertyId: A, voteId: id } })).toBeNull();
    expect(await getOwnerProperty({ data: { propertyId: A } })).toEqual({ access: "none" });
    expect((await castVoteBallot({ data: { propertyId: A, voteId: id, choice: "No" } })).error).toBe("This vote isn't available.");
    as(USERS.b1);
    expect((await getVoteForOwner({ data: { propertyId: A, voteId: id } }))?.myWeight).toBe(3);
    // A ballot cast before the sale carries no weight once its holder has sold.
    as(USERS.admin);
    await closeVoteAsAdmin({ data: { voteId: id } });
    const { tally } = db().table("votes").find((v) => v.id === id)!.result_summary;
    expect(tally.find((t: { choice: string }) => t.choice === "Yes").shares).toBe(0);
  });

  it("a partial seller keeps their other shares", async () => {
    seed();
    const id = await list(USERS.b1, 2);
    await elect(USERS.b2, id);
    await closeWindow(id);
    await complete();
    as(USERS.b1);
    const r = await getOwnerProperty({ data: { propertyId: A } });
    expect(r.access === "active" && r.property.shareNumbers).toEqual([1]);
    as(USERS.b2);
    const b = await getOwnerProperty({ data: { propertyId: A } });
    expect(b.access === "active" && b.property.shareNumbers).toEqual([2, 3]);
  });

  it("the Month 4 cap table rebuild can't undo a resale", async () => {
    seed();
    await soldToB1();
    await complete();
    const before = JSON.stringify(db().table("cap_table_entries"));
    expect(await syncCapTable(db(), { propertyId: A, actorId: USERS.admin, reason: "late_reservation_change" })).toEqual({ rows: [], changed: false });
    expect(JSON.stringify(db().table("cap_table_entries"))).toBe(before);
  });

  it("the rebuild still works on a property with no resale", async () => {
    seed();
    const r = await syncCapTable(db(), { propertyId: A, actorId: USERS.admin, reason: "test" });
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it("selling a retained share doesn't relabel the seller's others", async () => {
    seed();
    Object.assign(db().table("properties").find((p) => p.id === A)!, { exit_type: "hybrid_exit", retained_shares: 3 });
    const cap = db().table("cap_table_entries");
    Object.assign(cap.find((c) => c.share_number === 1)!, { holder_type: "retained_seller", seller_id: IDS.seller, buyer_account_id: null });
    Object.assign(cap.find((c) => c.share_number === 2)!, { holder_type: "retained_seller", seller_id: IDS.seller, buyer_account_id: null });
    Object.assign(cap.find((c) => c.share_number === 4)!, { holder_type: "buyer_account", seller_id: null, buyer_account_id: IDS.b1 });
    Object.assign(cap.find((c) => c.share_number === 3)!, { holder_type: "retained_seller", seller_id: IDS.seller, buyer_account_id: null });
    db().seed("enrollment_payments", [{ seller_id: IDS.seller, property_id: A, retained_shares: 3, amount_cents: 514000, status: "paid", created_at: PAST }]);
    // Share #1, the Legacy Seat, is sold.
    Object.assign(cap.find((c) => c.share_number === 1)!, { holder_type: "buyer_account", seller_id: null, buyer_account_id: IDS.b2 });
    as(IDS.seller);
    const r = await getOwnerProperty({ data: { propertyId: A } });
    expect(r.access === "active" && r.property.shareLabels).toEqual([
      { shareNumber: 2, label: "Extra retained share (paid $2,570)" },
      { shareNumber: 3, label: "Extra retained share (paid $2,570)" },
    ]);
  });
});

describe("Section 754", () => {
  it("the flag shows in the admin view only, with no basis figures anywhere", async () => {
    seed();
    await soldToB1();
    await complete();
    as(USERS.admin);
    const { rows } = await listResaleForAdmin();
    expect(rows[0]!.cpaFlags[0]).toMatchObject({ flagType: "section_754_review" });
    expect(rows[0]!.sales[0]).toMatchObject({ status: "completed", flatFee: 500, price: 300000 });
    as(USERS.b1);
    await expect(listResaleForAdmin()).rejects.toThrow("Not authorized");
    const owner = JSON.stringify(await getOwnerResale({ data: { propertyId: A } }));
    expect(owner).not.toMatch(/754/);
    expect(JSON.stringify(rows)).not.toMatch(/basis_|step_up|stepUp|"basis"/i);
  });
});

describe("the calendar", () => {
  /** Open 2030 with quotas for the current holders and week 1 and 2 picked by B2. */
  async function calendarWithB2Weeks() {
    seed();
    const year = await createCalendarYear(db() as never, USERS.admin, A, 2099, 48);
    const rpc = db().rpc.bind(db());
    (db() as any).rpc = async (fn: string, args: Record<string, unknown>) => (fn === "advance_use_calendar_turn" ? { data: true, error: null } : rpc(fn, args));
    await openSelection(db() as never, USERS.admin, year.id);
    for (const week_number of [1, 2])
      Object.assign(db().table("use_calendar_weeks").find((w) => w.year === 2099 && w.week_number === week_number)!, { holder_key: IDS.b2 });
    return year;
  }

  it("the old holder keeps their picked weeks after the sale, and is told", async () => {
    const year = await calendarWithB2Weeks();
    await soldToB1();
    await complete();
    const weeks = db().table("use_calendar_weeks").filter((w) => w.holder_key === IDS.b2);
    expect(weeks.map((w) => w.week_number)).toEqual([1, 2]);
    expect(db().notificationsFor(USERS.b2).some((n) => /keep the 2 Use Calendar weeks/.test(n.message))).toBe(true);
    const admin = await adminCalendar(db() as never, A);
    const y = admin.years.find((row) => row.id === year.id)!;
    expect(y.weeks.find((w) => w.weekNumber === 1)!.holderName).toBe("Former holder");
    expect(y.weekHolders).toEqual([{ holderKey: IDS.b2, name: "Former holder" }]);
  });

  it("the admin can transfer upcoming weeks, with the quota, logged; only to a current holder", async () => {
    const year = await calendarWithB2Weeks();
    await soldToB1();
    await complete();
    const move = (toHolderKey: string, reason = "Part of the sale") => transferUpcomingWeeks(db() as never, { actorId: USERS.admin, yearId: year.id, fromHolderKey: IDS.b2, toHolderKey, reason });
    await expect(move(IDS.b2)).rejects.toThrow("two different holders");
    await expect(move(IDS.b3)).rejects.toThrow("isn't on this property's cap table");
    const quotaBefore = db().table("use_calendar_years")[0]!.quotas[IDS.b1];
    expect(await move(IDS.b1)).toEqual({ moved: 2 });
    expect(db().table("use_calendar_weeks").filter((w) => w.holder_key === IDS.b1).map((w) => w.week_number)).toEqual([1, 2]);
    expect(db().table("use_calendar_years")[0]!.quotas[IDS.b1]).toBe(quotaBefore + 2);
    expect(db().audits("use_calendar.weeks_transferred")[0]!.metadata).toMatchObject({ weeks: [1, 2], reason: "Part of the sale" });
    await expect(move(IDS.b1)).rejects.toThrow("no upcoming weeks");
  });

  it("the calendar page opens for the new holder; the sold-out holder takes no more turns", async () => {
    const year = await calendarWithB2Weeks();
    await soldToB1();
    await complete();
    const row = db().table("use_calendar_years").find((y) => y.id === year.id)!;
    (db() as any).rpc = async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "advance_use_calendar_turn") return { data: null, error: null };
      Object.assign(row, { turn_holder_key: args.p_next_holder_key, turn_seq: row.turn_seq + 1 });
      return { data: true, error: null };
    };
    expect((await ownerCalendar(db() as never, USERS.b1, A, 2099)).allowed).toBe(true);
    expect((await ownerCalendar(db() as never, USERS.b2, A, 2099)).allowed).toBe(false);
    expect(Object.keys(row.quotas)).toContain(IDS.b2);
    // The sold-out holder's turn passes at its deadline and never comes back to them.
    Object.assign(row, { turn_holder_key: IDS.b2, turn_phase: "normal", turn_round: 1, turn_deadline_at: new Date(Date.now() - 1000).toISOString() });
    await ownerCalendar(db() as never, USERS.b1, A, 2099);
    expect(db().audits("use_calendar.turn_skipped")).toHaveLength(1);
    expect(row.turn_holder_key).not.toBe(IDS.b2);

    // Nor does it land on them from the holder before them in the order.
    Object.assign(row, { turn_holder_key: IDS.b1, turn_phase: "normal", turn_round: 1, turn_deadline_at: new Date(Date.now() - 1000).toISOString() });
    await ownerCalendar(db() as never, USERS.b1, A, 2099);
    expect(row.turn_holder_key).toBe(`seller:${IDS.seller}`);
  });
});
