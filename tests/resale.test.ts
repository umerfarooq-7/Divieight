/** Resale Shop part 1: listing, the 240-hour window, co-owner scoping, consensus and the open market. */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import {
  createResaleListing,
  exerciseResaleRofr,
  expressResaleInterest,
  getOwnerResale,
  listOpenMarketResale,
  listResaleForAdmin,
  recordResalePosition,
  withdrawResaleElection,
  withdrawResaleListing,
} from "@/lib/resale.functions";
import { settleRofr } from "@/lib/resale.server";
import { rofrCloseAt } from "@/lib/resale";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const A = IDS.property;
const B = "prop-2";
const DAY = 86_400_000;
const PAST = new Date(Date.now() - DAY).toISOString();
const FUTURE = new Date(Date.now() + 200 * DAY).toISOString();

const cap = (property_id: string, share_number: number, holder: Record<string, unknown>, lock = PAST) =>
  db().seed("cap_table_entries", [
    { property_id, share_number, buyer_account_id: null, seller_id: null, retention_lock_started_at: "2025-01-01T00:00:00.000Z", retention_lock_expires_at: lock, ...holder },
  ]);

/**
 * A: B1 (2 members, share 1), B2 (1 member, shares 2-3), retained seller (share 4).
 * B: another owner, on another property. Everything is past its lock unless a test says otherwise.
 */
function seed() {
  seedPod(db());
  db().seed("properties", [{ id: B, address: "77 Second St", city: "Casper", state: "WY", zip: "82601", seller_id: "seller-2", usage_tag: "owner_occupied" }]);
  cap(A, 1, { holder_type: "buyer_account", buyer_account_id: IDS.b1 });
  cap(A, 2, { holder_type: "buyer_account", buyer_account_id: IDS.b2 });
  cap(A, 3, { holder_type: "buyer_account", buyer_account_id: IDS.b2 });
  cap(A, 4, { holder_type: "retained_seller", seller_id: IDS.seller });
  cap(B, 1, { holder_type: "buyer_account", buyer_account_id: IDS.b3 });
}

const list = (user: string, shareNumber: number, propertyId = A, askingPrice = 300000, feeAcknowledged = true) => {
  as(user);
  return createResaleListing({ data: { propertyId, shareNumber, askingPrice, feeAcknowledged } });
};
const row = (id: string) => db().table("resale_listings").find((l) => l.id === id)!;
const pastWindow = (id: string) => (row(id).rofr_closes_at = new Date(Date.now() - 1000).toISOString());
const exercise = (user: string, listingId: string, propertyId = A) => {
  as(user);
  return exerciseResaleRofr({ data: { propertyId, listingId } });
};
const position = (listingId: string, accountMemberId: string, value: "exercise" | "decline", initials: string) => {
  as(USERS.b1);
  return recordResalePosition({ data: { propertyId: A, listingId, accountMemberId, position: value, initials } });
};
const agreeB1 = async (listingId: string, value: "exercise" | "decline" = "exercise") => {
  await position(listingId, IDS.b1m1, value, "AO");
  await position(listingId, IDS.b1m2, value, "BO");
};
const onboard = (id: string, intent: string | null = null) =>
  Object.assign(db().table("buyer_accounts").find((b) => b.id === id)!, { onboarding_status: "active", intent });

describe("creating a listing", () => {
  it("a locked share can't be listed, with the unlock date, and nothing is written", async () => {
    seed();
    db().table("cap_table_entries").find((c) => c.property_id === A && c.share_number === 2)!.retention_lock_expires_at = FUTURE;
    const r = await list(USERS.b2, 2);
    expect(r.error).toMatch(/Share #2 is under the 12-month Retention Lock until .*\d{4}/);
    expect(db().table("resale_listings")).toEqual([]);
  });

  it("a hardship-released share can be listed", async () => {
    seed();
    db().table("cap_table_entries").find((c) => c.property_id === A && c.share_number === 2)!.retention_lock_expires_at = FUTURE;
    db().seed("retention_exceptions", [{ property_id: A, share_number: 2, requested_by_user_id: USERS.b2, status: "approved" }]);
    expect((await list(USERS.b2, 2)).error).toBeUndefined();
  });

  it("opens a 240-hour window, status rofr_open, $500 fee, and stores the owner's price", async () => {
    seed();
    const before = Date.now();
    const { id } = await list(USERS.b2, 2);
    const l = row(id!);
    expect(l).toMatchObject({ status: "rofr_open", flat_fee: 500, asking_price: 300000, seller_holder_key: IDS.b2, seller_user_id: USERS.b2, share_number: 2 });
    expect(new Date(l.rofr_closes_at).getTime() - new Date(l.rofr_opens_at).getTime()).toBe(240 * 3600_000);
    expect(new Date(l.rofr_opens_at).getTime()).toBeGreaterThanOrEqual(before);
    expect(db().audits("resale.listing_created")[0]!.metadata).toMatchObject({ fee_disclosed: true, flat_fee: 500 });
  });

  it("240 hours is exact across a clock change", () => {
    expect(rofrCloseAt(new Date("2027-03-08T12:00:00.000Z")).toISOString()).toBe("2027-03-18T12:00:00.000Z");
  });

  it("requires the fee to be acknowledged and a real price", async () => {
    seed();
    expect((await list(USERS.b2, 2, A, 300000, false)).error).toMatch(/fee/);
    for (const bad of [0, -5, Number.NaN]) expect((await list(USERS.b2, 2, A, bad)).error).toMatch(/asking price/);
    expect(db().table("resale_listings")).toEqual([]);
  });

  it("only your own share, and only once at a time", async () => {
    seed();
    expect((await list(USERS.b1, 2)).error).toBe("You don't hold that share.");
    expect((await list(USERS.b3, 2)).error).toMatch(/ownership/);
    await list(USERS.b2, 2);
    expect((await list(USERS.b2, 2)).error).toBe("This share is already listed.");
    expect((await list(USERS.b2, 3)).error).toBeUndefined();
  });

  it("notifies the other co-owners of that property only", async () => {
    seed();
    await list(USERS.b2, 2);
    const told = (user: string) => db().notificationsFor(user).filter((n) => n.type === "resale").length;
    expect(told(USERS.b1)).toBe(1);
    expect(told(IDS.seller)).toBe(1);
    expect(told(USERS.b2)).toBe(0);
    expect(told(USERS.b3)).toBe(0);
  });

  it("a retained seller lists under the same rules", async () => {
    seed();
    const { id } = await list(IDS.seller, 4);
    expect(row(id!).seller_holder_key).toBe(`seller:${IDS.seller}`);
  });
});

describe("exercising the right of first refusal", () => {
  it("a co-owner of the same property elects at the asking price, with their rank", async () => {
    seed();
    const { id } = await list(IDS.seller, 4);
    db().table("buyer_accounts").find((b) => b.id === IDS.b2)!.priority_rank_timestamp = "2026-01-01T00:00:00.000Z";
    db().table("buyer_accounts").find((b) => b.id === IDS.b1)!.priority_rank_timestamp = "2026-02-01T00:00:00.000Z";
    expect((await exercise(USERS.b2, id!)).error).toBeUndefined();
    const e = db().table("resale_rofr_elections")[0]!;
    expect(e).toMatchObject({ listing_id: id, holder_key: IDS.b2, user_id: USERS.b2, status: "active", priority_rank_at_election: 1 });
    expect(db().audits("resale.rofr_exercised")).toHaveLength(1);
    expect((await exercise(USERS.b2, id!)).error).toMatch(/already exercised/);
  });

  it("a co-owner of B can't see or elect on A's listing, even with its id or under B's id", async () => {
    seed();
    const { id } = await list(USERS.b2, 2);
    as(USERS.b3);
    expect(await getOwnerResale({ data: { propertyId: A } })).toEqual({ allowed: false, shares: [], mine: [], coOwners: [] });
    const onB = await getOwnerResale({ data: { propertyId: B } });
    expect(onB.coOwners).toEqual([]);
    expect(onB.mine).toEqual([]);
    expect((await exercise(USERS.b3, id!, A)).error).toBe("This listing isn't available.");
    expect((await exercise(USERS.b3, id!, B)).error).toBe("This listing isn't available.");
    expect(db().table("resale_rofr_elections")).toEqual([]);
  });

  it("a retained seller can elect on a buyer's listing", async () => {
    seed();
    const { id } = await list(USERS.b2, 2);
    expect((await exercise(IDS.seller, id!)).error).toBeUndefined();
    expect(db().table("resale_rofr_elections")[0]!.holder_key).toBe(`seller:${IDS.seller}`);
  });

  it("the seller can't elect on their own listing", async () => {
    seed();
    const { id } = await list(USERS.b2, 2);
    expect((await exercise(USERS.b2, id!)).error).toMatch(/own listing/);
  });

  it("nobody can elect once the window has passed", async () => {
    seed();
    const { id } = await list(IDS.seller, 4);
    pastWindow(id!);
    expect((await exercise(USERS.b2, id!)).error).toMatch(/isn't open/);
  });

  it("a multi-member account needs every member to agree", async () => {
    seed();
    const { id } = await list(USERS.b2, 2);
    expect((await exercise(USERS.b1, id!)).error).toMatch(/Waiting for Alice One, Bob One/);
    await position(id!, IDS.b1m1, "exercise", "AO");
    expect((await exercise(USERS.b1, id!)).error).toMatch(/Waiting for Bob One/);
    await position(id!, IDS.b1m2, "decline", "BO");
    expect((await exercise(USERS.b1, id!)).error).toMatch(/disagree/);
    await position(id!, IDS.b1m2, "exercise", "BO");
    expect((await exercise(USERS.b1, id!)).error).toBeUndefined();
    expect(db().audits("resale.member_position_recorded")[0]!.metadata.secondary_verification_method).toBe("typed_initials");
  });

  it("an account that agreed to decline can't exercise; wrong initials are refused", async () => {
    seed();
    const { id } = await list(USERS.b2, 2);
    expect((await position(id!, IDS.b1m1, "exercise", "ZZ")).error).toMatch(/initials/);
    await agreeB1(id!, "decline");
    expect((await exercise(USERS.b1, id!)).error).toMatch(/agreed to decline/);
    as(USERS.b1);
    expect((await recordResalePosition({ data: { propertyId: A, listingId: id!, accountMemberId: IDS.b2m1, position: "exercise", initials: "CT" } })).error).toMatch(/isn't on your account/);
  });

  it("an election can be withdrawn during the window, and made again", async () => {
    seed();
    const { id } = await list(IDS.seller, 4);
    await exercise(USERS.b2, id!);
    as(USERS.b2);
    await withdrawResaleElection({ data: { propertyId: A, listingId: id! } });
    expect(db().table("resale_rofr_elections")[0]!.status).toBe("withdrawn");
    expect((await exercise(USERS.b2, id!)).error).toBeUndefined();
    expect(db().table("resale_rofr_elections")).toHaveLength(1);
    expect(db().table("resale_rofr_elections")[0]!.status).toBe("active");
  });
});

describe("when the window closes", () => {
  it("no elections: goes open_market, once, telling the seller", async () => {
    seed();
    const { id } = await list(USERS.b2, 2);
    expect(await settleRofr(db())).toEqual({ openMarket: 0, exercised: 0 });
    expect(row(id!).status).toBe("rofr_open");
    pastWindow(id!);
    expect(await settleRofr(db())).toEqual({ openMarket: 1, exercised: 0 });
    expect(row(id!).status).toBe("open_market");
    expect(await settleRofr(db())).toEqual({ openMarket: 0, exercised: 0 });
    expect(db().audits("resale.rofr_closed")).toHaveLength(1);
    expect(db().notificationsFor(USERS.b2).filter((n) => /open market/.test(n.message))).toHaveLength(1);
  });

  it("an election goes to conflict resolution and never reaches the open market", async () => {
    seed();
    const { id } = await list(IDS.seller, 4);
    await exercise(USERS.b2, id!);
    pastWindow(id!);
    expect(await settleRofr(db())).toEqual({ openMarket: 0, exercised: 1 });
    expect(row(id!).status).toBe("rofr_exercised");
    expect(db().table("resale_rofr_elections")[0]!.status).toBe("active");
  });

  it("only withdrawn elections count as none", async () => {
    seed();
    const { id } = await list(IDS.seller, 4);
    await exercise(USERS.b2, id!);
    as(USERS.b2);
    await withdrawResaleElection({ data: { propertyId: A, listingId: id! } });
    pastWindow(id!);
    await settleRofr(db());
    expect(row(id!).status).toBe("open_market");
  });

  it("two sweeps at once move a listing only once", async () => {
    seed();
    const { id } = await list(USERS.b2, 2);
    pastWindow(id!);
    const [a, b] = await Promise.all([settleRofr(db()), settleRofr(db())]);
    expect(a.openMarket + b.openMarket).toBe(1);
    expect(db().audits("resale.rofr_closed")).toHaveLength(1);
  });

  it("opening the page moves an overdue listing even if the sweep hasn't run", async () => {
    seed();
    const { id } = await list(USERS.b2, 2);
    pastWindow(id!);
    as(USERS.b2);
    const { mine } = await getOwnerResale({ data: { propertyId: A } });
    expect(mine[0]).toMatchObject({ status: "open_market" });
  });
});

describe("withdrawing a listing", () => {
  it("works during ROFR, closes elections and tells co-owners; only the seller can", async () => {
    seed();
    const { id } = await list(USERS.b2, 2);
    await agreeB1(id!);
    await exercise(USERS.b1, id!);
    as(IDS.seller);
    expect((await withdrawResaleListing({ data: { propertyId: A, listingId: id! } })).error).toBe("This listing isn't available.");
    as(USERS.b2);
    expect((await withdrawResaleListing({ data: { propertyId: A, listingId: id! } })).error).toBeUndefined();
    expect(row(id!).status).toBe("withdrawn");
    expect(db().table("resale_rofr_elections")[0]!.status).toBe("lost");
    expect(db().notificationsFor(USERS.b1).some((n) => /withdrawn/.test(n.message))).toBe(true);
    expect((await list(USERS.b2, 2)).error).toBeUndefined();
  });

  it("is allowed while elections are unresolved, refused once a winner is confirmed", async () => {
    seed();
    const open = await list(USERS.b2, 2);
    await agreeB1(open.id!);
    await exercise(USERS.b1, open.id!);
    pastWindow(open.id!);
    await settleRofr(db());
    as(USERS.b2);
    let view = await getOwnerResale({ data: { propertyId: A } });
    expect(view.mine[0]).toMatchObject({ status: "rofr_exercised", canWithdraw: true, electionCount: 1 });

    db().table("resale_rofr_elections")[0]!.status = "won";
    view = await getOwnerResale({ data: { propertyId: A } });
    expect(view.mine[0]!.canWithdraw).toBe(false);
    expect((await withdrawResaleListing({ data: { propertyId: A, listingId: open.id! } })).error).toMatch(/can't be withdrawn/);
    expect(row(open.id!).status).toBe("rofr_exercised");
  });

  it("works from the open market, not after a sale", async () => {
    seed();
    const { id } = await list(USERS.b2, 2);
    row(id!).status = "sold";
    as(USERS.b2);
    expect((await withdrawResaleListing({ data: { propertyId: A, listingId: id! } })).error).toMatch(/can't be withdrawn/);
    expect(row(id!).status).toBe("sold");
  });
});

describe("the open market", () => {
  it("hides a listing during ROFR and shows it after, without seller details", async () => {
    seed();
    onboard(IDS.b3);
    const { id } = await list(USERS.b2, 2);
    as(USERS.b3);
    expect((await listOpenMarketResale()).listings).toEqual([]);
    pastWindow(id!);
    const { allowed, listings } = await listOpenMarketResale();
    expect(allowed).toBe(true);
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ id, propertyId: A, shareNumber: 2, askingPrice: 300000, interested: false });
    expect(JSON.stringify(listings[0])).not.toContain(USERS.b2);
    expect(JSON.stringify(listings[0])).not.toContain(IDS.b2);
  });

  it("an exercised listing stays hidden", async () => {
    seed();
    onboard(IDS.b3);
    const { id } = await list(IDS.seller, 4);
    await exercise(USERS.b2, id!);
    pastWindow(id!);
    as(USERS.b3);
    expect((await listOpenMarketResale()).listings).toEqual([]);
  });

  it("is for onboarded buyers only: not mid-onboarding, not non-buyers", async () => {
    seed();
    const { id } = await list(USERS.b2, 2);
    pastWindow(id!);
    await settleRofr(db());
    as(USERS.b3);
    db().table("buyer_accounts").find((b) => b.id === IDS.b3)!.onboarding_status = "vetting_pending";
    expect(await listOpenMarketResale()).toEqual({ allowed: false, listings: [] });
    expect((await expressResaleInterest({ data: { listingId: id! } })).error).toMatch(/onboarding/);
    as(IDS.seller);
    expect(await listOpenMarketResale()).toEqual({ allowed: false, listings: [] });
  });

  it("the seller doesn't see their own listing", async () => {
    seed();
    onboard(IDS.b2);
    const { id } = await list(USERS.b2, 2);
    pastWindow(id!);
    as(USERS.b2);
    expect((await listOpenMarketResale()).listings).toEqual([]);
    expect((await expressResaleInterest({ data: { listingId: id! } })).error).toMatch(/isn't available/);
  });

  it("reuses the compatibility filter", async () => {
    seed();
    onboard(IDS.b1, "long_term");
    db().table("properties").find((p) => p.id === B)!.usage_tag = "short_term_rental";
    const { id } = await list(USERS.b3, 1, B);
    pastWindow(id!);
    as(USERS.b1);
    expect((await listOpenMarketResale()).listings[0]!.incompatible).toBe(true);
  });

  it("express interest reaches the admin once and is only for open-market listings", async () => {
    seed();
    onboard(IDS.b3);
    const { id } = await list(USERS.b2, 2);
    as(USERS.b3);
    expect((await expressResaleInterest({ data: { listingId: id! } })).error).toMatch(/isn't available/);
    pastWindow(id!);
    expect((await expressResaleInterest({ data: { listingId: id! } })).error).toBeUndefined();
    expect((await expressResaleInterest({ data: { listingId: id! } })).error).toMatch(/already/);
    expect(db().notificationsFor(USERS.admin).filter((n) => /expressed interest/.test(n.message))).toHaveLength(1);
    expect((await listOpenMarketResale()).listings[0]!.interested).toBe(true);
    as(USERS.admin);
    const { rows } = await listResaleForAdmin();
    expect(rows[0]!.interested[0]!.email).toBe("b3@test.local");
    expect(db().audits("resale.interest_expressed")).toHaveLength(1);
  });
});

describe("access", () => {
  it("Rev 48: an owner opens the shop with no Digital Key, no executed OA, and a locked share", async () => {
    seed();
    db().table("cap_table_entries").find((c) => c.property_id === A && c.share_number === 2)!.retention_lock_expires_at = FUTURE;
    as(USERS.b2);
    const view = await getOwnerResale({ data: { propertyId: A } });
    expect(view.allowed).toBe(true);
    expect(view.shares).toEqual([
      { shareNumber: 2, locked: true, lockExpiresAt: FUTURE, listed: false },
      { shareNumber: 3, locked: false, lockExpiresAt: PAST, listed: false },
    ]);
  });

  it("the admin list is admin only", async () => {
    seed();
    as(USERS.b1);
    await expect(listResaleForAdmin()).rejects.toThrow("Not authorized");
  });
});
