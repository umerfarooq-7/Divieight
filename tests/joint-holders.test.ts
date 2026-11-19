/** Joint holders: a share two co-buyers hold together, through due diligence, the cap table, closing and the owner area. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS, hoursFromNow } from "./fixtures";

vi.mock("@/lib/authorization.notify.server", () => ({ sendEmail: vi.fn(async () => true), deliver: vi.fn(async () => ({ portal: true, emailed: false, duplicate: false })), adminRecipients: vi.fn(async () => []), memberEmailsFor: vi.fn(async () => []), uniqueEmails: (l: string[]) => l }));

import { syncCapTable } from "@/lib/entity-genesis.server";
import { buyerConnectedToProperty } from "@/lib/property-access.server";
import { accountsOnProperty } from "@/lib/ack-gate.server";
import { buyerActionItems } from "@/lib/buyer-actions.functions";
import { getOwnerProperty, listOwnerProperties } from "@/lib/owner.functions";
import { castVoteBallot, createVoteAsAdmin, getVoteForOwner, openVoteAsAdmin } from "@/lib/votes.functions";
import { savePayoutMethod } from "@/lib/distributions.server";
import { respondToJointRequest, endJointForReservation, holderAccountFor, coHolderAccountOf } from "@/lib/joint-reservation.server";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const HOME = "prop-jh";
const RES = "res-jh";

// Dan (b3) reserved a share on HOME; Carol (b2) holds it with him.
beforeEach(() => {
  seedPod(db());
  for (const m of db().table("account_members")) m.status = "active";
  db().seed("properties", [{ id: HOME, address: "8 Joint Way", city: "Cody", state: "WY", zip: "82414", seller_id: IDS.seller, listing_status: "forming", exit_type: "full_exit", created_at: "2026-09-01T00:00:00.000Z", hard_locked_at: "2026-09-02T00:00:00.000Z" }]);
  for (const id of [IDS.b2, IDS.b3]) Object.assign(db().table("buyer_accounts").find((b) => b.id === id)!, { tether_status: "tethered", golden_ticket_issued: true });
  db().seed("pod_reservations", [{ id: RES, property_id: HOME, buyer_account_id: IDS.b3, shares_reserved: 1, status: "reserved", reserved_at: "2026-09-03T00:00:00.000Z" }]);
  db().seed("co_buyer_links", [{ id: "link-1", inviter_account_id: IDS.b3, invitee_account_id: IDS.b2, invitee_name: "Carol Two", invitee_email: "b2@test.local", token_hash: "x", status: "active", invited_at: new Date().toISOString() }]);
  db().seed("joint_reservation_requests", [{ id: "req-1", reservation_id: RES, property_id: HOME, initiator_account_id: IDS.b3, partner_account_id: IDS.b2, link_id: "link-1", status: "accepted", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 1e9).toISOString() }]);
  db().seed("joint_reservations", [{ id: "joint-1", reservation_id: RES, property_id: HOME, primary_account_id: IDS.b3, partner_account_id: IDS.b2, request_id: "req-1", status: "active" }]);
});

const caps = () => db().table("cap_table_entries").filter((c) => c.property_id === HOME);

describe("the cap table", () => {
  it("keeps one row for the share and names both holders on it", async () => {
    const r = await syncCapTable(db() as never, { propertyId: HOME, actorId: USERS.b3, reason: "joint_accepted" });
    expect(r.rows).toHaveLength(1);
    expect(caps()).toHaveLength(1);
    expect(caps()[0]).toMatchObject({ share_number: 1, holder_type: "buyer_account", buyer_account_id: IDS.b3, co_holder_account_id: IDS.b2 });
    expect(caps()[0]!.account_member_names).toEqual(["Dan Three", "Carol Two"]);
  });

  it("changes when the joint hold ends, and the co-holder is removed from the row", async () => {
    await syncCapTable(db() as never, { propertyId: HOME, actorId: USERS.b3, reason: "joint_accepted" });
    await endJointForReservation(db() as never, { reservationId: RES, actorUserId: USERS.b3, reason: "withdrawn" });
    const r = await syncCapTable(db() as never, { propertyId: HOME, actorId: USERS.b3, reason: "reservation_withdrawn" });
    expect(r.changed).toBe(true);
    expect(caps()[0]!.co_holder_account_id ?? null).toBeNull();
    expect(caps()[0]!.account_member_names).toEqual(["Dan Three"]);
  });

  it("an alone reservation is unchanged: no co-holder written", async () => {
    db().table("joint_reservations")[0]!.status = "ended";
    await syncCapTable(db() as never, { propertyId: HOME, actorId: USERS.b3, reason: "x" });
    expect(caps()[0]!.co_holder_account_id ?? null).toBeNull();
  });
});

describe("due diligence and authorizations are the co-holder's own", () => {
  it("the co-holder is connected to the property while the joint hold is live, and not after", async () => {
    expect(await buyerConnectedToProperty(db(), IDS.b2, HOME, { activeOnly: true })).toBe(true);
    expect(await buyerConnectedToProperty(db(), IDS.b1, HOME, { activeOnly: true })).toBe(false);
    db().table("joint_reservations")[0]!.status = "ended";
    expect(await buyerConnectedToProperty(db(), IDS.b2, HOME, { activeOnly: true })).toBe(false);
  });

  it("a co-holder named on the cap table stays connected after closing", async () => {
    await syncCapTable(db() as never, { propertyId: HOME, actorId: USERS.b3, reason: "x" });
    db().table("joint_reservations")[0]!.status = "ended";
    expect(await buyerConnectedToProperty(db(), IDS.b2, HOME)).toBe(true);
  });

  it("the property's accounts include the co-holder, so the gates and the Posture Record count them", async () => {
    expect(await accountsOnProperty(db(), HOME)).toEqual([IDS.b2, IDS.b3].sort());
  });

  it("the co-holder sees their own due-diligence action for the share; the money obligations are not theirs", async () => {
    db().seed("due_diligence_inventory", [{ id: "doc-1", property_id: HOME, document_title: "HOA Rules", required: true, content_hash: "h1", superseded_by: null, placed_at: new Date().toISOString() }]);
    const mine = await buyerActionItems(db() as never, IDS.b2);
    expect(mine.actions.some((a) => a.kind === "due_diligence" && a.propertyId === HOME)).toBe(true);
    expect(mine.actions.some((a) => a.kind === "earnest_money" || a.kind === "closing_funds")).toBe(false);
  });
});

describe("after closing, as a co-owner", () => {
  async function closed() {
    await syncCapTable(db() as never, { propertyId: HOME, actorId: USERS.b3, reason: "x" });
    db().seed("entity_genesis", [{ property_id: HOME, llc_name: "D8 Joint, LLC", ein_status: "verified", oa_executed_at: "2026-10-05T00:00:00.000Z" }]);
    // The closing saga issues a Digital Key to each holder of a row, the co-holder included.
    db().seed("co_owner_digital_keys", [
      { property_id: HOME, holder_type: "buyer_account", buyer_account_id: IDS.b3, seller_id: null, shares: 1, status: "active" },
      { property_id: HOME, holder_type: "buyer_account", buyer_account_id: IDS.b2, seller_id: null, shares: 1, status: "active" },
    ]);
  }

  it("the co-holder has the property in their owner area, with the same share and no money of their own", async () => {
    await closed();
    as(USERS.b2);
    const list = await listOwnerProperties();
    expect(list.properties.find((p) => p.propertyId === HOME)).toMatchObject({ shareCount: 1, active: true });
    const detail = await getOwnerProperty({ data: { propertyId: HOME } });
    expect(detail).toMatchObject({ access: "active", property: { shareNumbers: [1], shareCount: 1, capital: null } });
  });

  it("both owners see the same single share", async () => {
    await closed();
    as(USERS.b3);
    expect(await getOwnerProperty({ data: { propertyId: HOME } })).toMatchObject({ access: "active", property: { shareNumbers: [1] } });
  });

  it("someone with no part in the share still sees nothing", async () => {
    await closed();
    as(USERS.b1);
    expect(await getOwnerProperty({ data: { propertyId: HOME } })).toEqual({ access: "none" });
  });

  it("a co-holder acts as the buyer who reserved it, and the share is one holder", async () => {
    expect(await holderAccountFor(db(), IDS.b2, HOME)).toEqual({ accountId: IDS.b3, asPartner: true });
    expect(await holderAccountFor(db(), IDS.b3, HOME)).toEqual({ accountId: IDS.b3, asPartner: false });
    expect(await coHolderAccountOf(db(), IDS.b3, HOME)).toBe(IDS.b2);
  });
});

describe("voting: one share, one ballot, and the first of the two casts it", () => {
  async function openVote() {
    await syncCapTable(db() as never, { propertyId: HOME, actorId: USERS.b3, reason: "x" });
    as(USERS.admin);
    const { id } = await createVoteAsAdmin({ data: { propertyId: HOME, title: "Paint the fence", voteType: "ordinary", opensAt: hoursFromNow(-1), closesAt: hoursFromNow(24) } });
    await openVoteAsAdmin({ data: { voteId: id } });
    return id;
  }
  const cast = (voteId: string, user: string, choice: string) => {
    as(user);
    return castVoteBallot({ data: { propertyId: HOME, voteId, choice } });
  };
  const ballots = (voteId: string) => db().table("vote_ballots").filter((b) => b.vote_id === voteId);

  it("the co-holder sees the same weight of one share", async () => {
    const id = await openVote();
    as(USERS.b2);
    expect(await getVoteForOwner({ data: { propertyId: HOME, voteId: id } })).toMatchObject({ myWeight: 1, myShareNumbers: [1] });
  });

  it("the co-holder casts it: one ballot under the share, recorded as theirs", async () => {
    const id = await openVote();
    await expect(cast(id, USERS.b2, "Yes")).resolves.toEqual({ changed: false });
    expect(ballots(id)).toHaveLength(1);
    expect(ballots(id)[0]).toMatchObject({ holder_key: IDS.b3, choice: "Yes", cast_by_user_id: USERS.b2 });
  });

  it("whoever casts first casts it: the other cannot overwrite, so the share never counts twice", async () => {
    const id = await openVote();
    await cast(id, USERS.b3, "Yes");
    await expect(cast(id, USERS.b2, "No")).resolves.toMatchObject({ error: expect.stringMatching(/co-holder has already cast/) });
    expect(ballots(id)).toHaveLength(1);
    expect(ballots(id)[0]).toMatchObject({ choice: "Yes", cast_by_user_id: USERS.b3 });
  });

  it("the one who cast it can change their own ballot", async () => {
    const id = await openVote();
    await cast(id, USERS.b2, "Yes");
    await expect(cast(id, USERS.b2, "No")).resolves.toEqual({ changed: true });
    expect(ballots(id)[0]).toMatchObject({ choice: "No", cast_by_user_id: USERS.b2 });
  });
});

describe("money stays with the buyer who reserved the share", () => {
  it("the co-holder can't change where the share's distributions are paid", async () => {
    await syncCapTable(db() as never, { propertyId: HOME, actorId: USERS.b3, reason: "x" });
    await expect(savePayoutMethod(db() as never, { userId: USERS.b2, propertyId: HOME, routing: "110000000", account: "000123456789" })).rejects.toThrow(/go to the buyer who reserved it/);
  });
});

describe("accepting once the cap table is locked", () => {
  it("is refused: who holds what is fixed", async () => {
    db().table("joint_reservations")[0]!.status = "ended";
    db().table("joint_reservation_requests")[0]!.status = "pending";
    db().seed("entity_genesis", [{ property_id: HOME, llc_name: "x", cap_table_locked_at: "2026-10-01T00:00:00.000Z" }]);
    await expect(respondToJointRequest(db() as never, { userId: USERS.b2, requestId: "req-1", accept: true })).rejects.toThrow(/cap table is already locked/);
    expect(db().table("joint_reservations").filter((j) => j.status === "active")).toHaveLength(0);
  });
});
