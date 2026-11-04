/** Hybrid Exit sellers after closing: the one-time banner, governance access, share labels and dual roles. */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { syncCapTable } from "@/lib/entity-genesis.server";
import { claimCoOwnerBanners, getOwnerNavState, getOwnerProperty, listOwnerProperties } from "@/lib/owner.functions";
import { getOwnerLlc } from "@/lib/owner-llc.functions";
import { castVoteBallot, closeVoteAsAdmin, createVoteAsAdmin, getVoteForOwner, openVoteAsAdmin } from "@/lib/votes.functions";
import { hoursFromNow } from "./fixtures";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const A = IDS.property;
const B = "prop-2";
const LISTED = "2026-01-01T00:00:00.000Z";
const PAID = "2026-01-02T00:00:00.000Z";

/** Run the real cap table creation on A with this exit, then activate it like closing does. */
async function close(exit: { exit_type: string; retained_shares: number }, active = true) {
  seedPod(db());
  Object.assign(db().table("properties").find((p) => p.id === A)!, exit, { created_at: LISTED });
  db().seed("entity_genesis", [{ property_id: A, llc_name: "D8 Lusk, LLC", ein_status: "verified", oa_executed_at: active ? "2026-10-05T00:00:00.000Z" : null }]);
  await syncCapTable(db(), { propertyId: A, actorId: USERS.admin, reason: "test" });
  if (exit.retained_shares > 0 && exit.exit_type === "hybrid_exit" && active) {
    db().seed("co_owner_digital_keys", [{ property_id: A, holder_type: "retained_seller", buyer_account_id: null, seller_id: IDS.seller, shares: exit.retained_shares }]);
  }
}
const HYBRID = { exit_type: "hybrid_exit", retained_shares: 3 };
const pay = (amount_cents: number, retained_shares = 3, extra: Record<string, unknown> = {}) =>
  db().seed("enrollment_payments", [{ seller_id: IDS.seller, property_id: null, retained_shares, amount_cents, status: "paid", created_at: PAID, ...extra }]);
const labels = async () => {
  as(IDS.seller);
  const r = await getOwnerProperty({ data: { propertyId: A } });
  return r.access === "active" ? r.property.shareLabels : null;
};

describe("the one-time banner", () => {
  it("appears once, with the LLC name and the seller's share count", async () => {
    await close(HYBRID);
    as(IDS.seller);
    expect((await claimCoOwnerBanners()).banners).toEqual([{ propertyId: A, llcName: "D8 Lusk, LLC", shareCount: 3 }]);
    expect((await claimCoOwnerBanners()).banners).toEqual([]);
  });

  it("waits for activation: no executed OA or no key means no banner, and it isn't used up", async () => {
    await close(HYBRID, false);
    as(IDS.seller);
    expect((await claimCoOwnerBanners()).banners).toEqual([]);
    expect(db().table("owner_activation_notices")).toEqual([]);

    db().table("entity_genesis")[0]!.oa_executed_at = "2026-10-05T00:00:00.000Z";
    expect((await claimCoOwnerBanners()).banners).toEqual([]);

    db().seed("co_owner_digital_keys", [{ property_id: A, holder_type: "retained_seller", buyer_account_id: null, seller_id: IDS.seller, shares: 3 }]);
    expect((await claimCoOwnerBanners()).banners).toHaveLength(1);
  });

  it("a seller who retained on two properties gets one banner each, with that property's count", async () => {
    await close(HYBRID);
    db().seed("properties", [{ id: B, address: "77 Second St", city: "Casper", state: "WY", zip: "82601", seller_id: IDS.seller }]);
    db().seed("entity_genesis", [{ property_id: B, llc_name: "D8 Casper, LLC", oa_executed_at: "2026-10-06T00:00:00.000Z" }]);
    db().seed("cap_table_entries", [{ property_id: B, share_number: 1, holder_type: "retained_seller", buyer_account_id: null, seller_id: IDS.seller, acquisition_date: LISTED, retention_lock_expires_at: LISTED }]);
    db().seed("co_owner_digital_keys", [{ property_id: B, holder_type: "retained_seller", buyer_account_id: null, seller_id: IDS.seller, shares: 1 }]);
    as(IDS.seller);
    expect((await claimCoOwnerBanners()).banners).toEqual([
      { propertyId: A, llcName: "D8 Lusk, LLC", shareCount: 3 },
      { propertyId: B, llcName: "D8 Casper, LLC", shareCount: 1 },
    ]);
  });

  it("is only for retained sellers, not buyers", async () => {
    await close(HYBRID);
    db().seed("co_owner_digital_keys", [{ property_id: A, holder_type: "buyer_account", buyer_account_id: IDS.b1, seller_id: null, shares: 1 }]);
    as(USERS.b1);
    expect((await claimCoOwnerBanners()).banners).toEqual([]);
  });
});

describe("governance access", () => {
  it("the seller's user id maps to their retained shares, through the real cap table", async () => {
    await close(HYBRID);
    const retained = db().table("cap_table_entries").filter((c) => c.holder_type === "retained_seller");
    expect(retained.map((c) => [c.share_number, c.seller_id])).toEqual([[1, IDS.seller], [2, IDS.seller], [3, IDS.seller]]);
    as(IDS.seller);
    expect(await getOwnerNavState()).toEqual({ isOwner: true });
    expect((await getOwnerProperty({ data: { propertyId: A } })).access).toBe("active");
  });

  it("votes with weight = retained shares, counted at the tally", async () => {
    await close(HYBRID);
    as(USERS.admin);
    const { id } = await createVoteAsAdmin({ data: { propertyId: A, title: "Roof", voteType: "ordinary", opensAt: hoursFromNow(-1), closesAt: hoursFromNow(24) } });
    await openVoteAsAdmin({ data: { voteId: id } });
    as(IDS.seller);
    expect((await getVoteForOwner({ data: { propertyId: A, voteId: id } }))?.myWeight).toBe(3);
    expect((await castVoteBallot({ data: { propertyId: A, voteId: id, choice: "Yes" } })).error).toBeUndefined();
    as(USERS.admin);
    await closeVoteAsAdmin({ data: { voteId: id } });
    const { tally } = db().table("votes").find((v) => v.id === id)!.result_summary;
    expect(tally.find((t: { choice: string }) => t.choice === "Yes").shares).toBe(3);
  });

  it("the roster shows the seller as a retained co-owner", async () => {
    await close(HYBRID);
    as(IDS.seller);
    const llc = await getOwnerLlc({ data: { propertyId: A } });
    expect(JSON.stringify(llc)).toContain("Seller co-owner (retained)");
  });
});

describe("share labels", () => {
  it("first retained share is the free Legacy Seat; the rest show the fee from the payment", async () => {
    await close(HYBRID);
    pay(514000);
    expect(await labels()).toEqual([
      { shareNumber: 1, label: "Legacy Seat (free)" },
      { shareNumber: 2, label: "Extra retained share (paid $2,570)" },
      { shareNumber: 3, label: "Extra retained share (paid $2,570)" },
    ]);
  });

  it("reads the amount rather than assuming it", async () => {
    await close(HYBRID);
    pay(400000);
    expect((await labels())![1]!.label).toBe("Extra retained share (paid $2,000)");
  });

  it("doesn't claim a payment that isn't there: unpaid, pending, or a different share count", async () => {
    await close(HYBRID);
    expect((await labels())![1]!.label).toBe("Extra retained share (payment not on record)");
    pay(514000, 3, { status: "pending" });
    pay(257000, 2);
    expect((await labels())![1]!.label).toBe("Extra retained share (payment not on record)");
  });

  it("a payment for the seller's other listing doesn't count for this one", async () => {
    await close(HYBRID);
    db().seed("properties", [{ id: B, address: "77 Second St", city: "Casper", state: "WY", zip: "82601", seller_id: IDS.seller, created_at: "2026-06-01T00:00:00.000Z" }]);
    pay(514000, 3, { created_at: "2026-06-02T00:00:00.000Z" });
    expect((await labels())![1]!.label).toBe("Extra retained share (payment not on record)");
    pay(514000, 3, { property_id: A, created_at: "2026-06-03T00:00:00.000Z" });
    expect((await labels())![1]!.label).toBe("Extra retained share (paid $2,570)");
  });

  it("one retained share is only the Legacy Seat; buyers get no labels", async () => {
    await close({ exit_type: "hybrid_exit", retained_shares: 1 });
    expect(await labels()).toEqual([{ shareNumber: 1, label: "Legacy Seat (free)" }]);
    db().seed("cap_table_entries", [{ property_id: A, share_number: 7, holder_type: "buyer_account", buyer_account_id: IDS.b1, seller_id: null, acquisition_date: LISTED, retention_lock_expires_at: LISTED }]);
    db().seed("co_owner_digital_keys", [{ property_id: A, holder_type: "buyer_account", buyer_account_id: IDS.b1, seller_id: null, shares: 1 }]);
    as(USERS.b1);
    const r = await getOwnerProperty({ data: { propertyId: A } });
    expect(r.access === "active" && r.property.shareLabels).toEqual([]);
  });
});

describe("full-exit sellers", () => {
  it("get no shares, no owner access, no banner and no vote", async () => {
    await close({ exit_type: "full_exit", retained_shares: 0 });
    expect(db().table("cap_table_entries").filter((c) => c.holder_type === "retained_seller")).toEqual([]);
    as(IDS.seller);
    expect(await getOwnerNavState()).toEqual({ isOwner: false });
    expect((await listOwnerProperties()).properties).toEqual([]);
    expect(await getOwnerProperty({ data: { propertyId: A } })).toEqual({ access: "none" });
    expect((await claimCoOwnerBanners()).banners).toEqual([]);
    as(USERS.admin);
    const { id } = await createVoteAsAdmin({ data: { propertyId: A, title: "Roof", voteType: "ordinary", opensAt: hoursFromNow(-1), closesAt: hoursFromNow(24) } });
    await openVoteAsAdmin({ data: { voteId: id } });
    as(IDS.seller);
    expect((await castVoteBallot({ data: { propertyId: A, voteId: id, choice: "Yes" } })).error).toBe("This vote isn't available.");
  });

  it("stale retained_shares on a full exit still give nothing", async () => {
    await close({ exit_type: "full_exit", retained_shares: 3 });
    as(IDS.seller);
    expect(await getOwnerNavState()).toEqual({ isOwner: false });
  });
});

describe("dual role", () => {
  /** The seller retained 3 on A and, under the same login, bought 2 on B. */
  async function dual() {
    await close(HYBRID);
    db().seed("properties", [{ id: B, address: "77 Second St", city: "Casper", state: "WY", zip: "82601", seller_id: "seller-2" }]);
    db().seed("buyer_accounts", [{ id: "buyer-dual", auth_user_id: IDS.seller, email: "dual@test.local" }]);
    db().seed("entity_genesis", [{ property_id: B, llc_name: "D8 Casper, LLC", ein_status: "pending", oa_executed_at: "2026-10-06T00:00:00.000Z" }]);
    for (const share_number of [5, 6]) {
      db().seed("cap_table_entries", [{ property_id: B, share_number, holder_type: "buyer_account", buyer_account_id: "buyer-dual", seller_id: null, acquisition_date: LISTED, retention_lock_expires_at: "2027-10-06T00:00:00.000Z" }]);
    }
    db().seed("co_owner_digital_keys", [{ property_id: B, holder_type: "buyer_account", buyer_account_id: "buyer-dual", seller_id: null, shares: 2 }]);
    as(IDS.seller);
  }

  it("shows one card per property with that property's own count and LLC", async () => {
    await dual();
    const { properties } = await listOwnerProperties();
    expect(properties.map((p) => [p.propertyId, p.shareCount, p.llcName, p.active]).sort()).toEqual([
      [B, 2, "D8 Casper, LLC", true],
      [A, 3, "D8 Lusk, LLC", true],
    ].sort());
  });

  it("each property's detail holds only its own shares and labels", async () => {
    await dual();
    pay(514000);
    const a = await getOwnerProperty({ data: { propertyId: A } });
    const b = await getOwnerProperty({ data: { propertyId: B } });
    expect(a.access === "active" && [a.property.shareNumbers, a.property.shareLabels.length]).toEqual([[1, 2, 3], 3]);
    expect(b.access === "active" && [b.property.shareNumbers, b.property.shareLabels]).toEqual([[5, 6], []]);
  });

  it("a key on one property doesn't activate the other, and the banner covers only the retained one", async () => {
    await dual();
    db().table("co_owner_digital_keys").splice(0, 1);
    expect((await getOwnerProperty({ data: { propertyId: A } })).access).toBe("inactive");
    expect((await getOwnerProperty({ data: { propertyId: B } })).access).toBe("active");
    expect((await claimCoOwnerBanners()).banners).toEqual([]);
  });

  it("votes weigh by the role held on that property", async () => {
    await dual();
    const weight = async (propertyId: string) => {
      as(USERS.admin);
      const { id } = await createVoteAsAdmin({ data: { propertyId, title: "Roof", voteType: "ordinary", opensAt: hoursFromNow(-1), closesAt: hoursFromNow(24) } });
      await openVoteAsAdmin({ data: { voteId: id } });
      as(IDS.seller);
      return (await getVoteForOwner({ data: { propertyId, voteId: id } }))?.myWeight;
    };
    expect(await weight(A)).toBe(3);
    expect(await weight(B)).toBe(2);
  });
});
