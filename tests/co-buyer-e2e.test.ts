/**
 * Phases 1, 2 and 3 end to end, in the order a real pair of buyers goes through them:
 * invite by email → the other signs up and is linked → one reserves together → the other accepts → both do their own due diligence →
 * the cap table, the closing keys and the owner area name both → one vote, one ballot → the link can only end once the share is gone.
 */
import { describe, expect, it, vi } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS, hoursFromNow } from "./fixtures";

vi.mock("@/lib/pod.server", () => ({
  fetchPodComposition: async (propertyId: string) => {
    const db = harness.db;
    const p = db.table("properties").find((x) => x.id === propertyId);
    if (!p) return null;
    const reserved = db.table("pod_reservations").filter((r) => r.property_id === propertyId && r.status === "reserved").reduce((s, r) => s + (r.shares_reserved ?? 0), 0);
    return { propertyId, totalShares: 8, retainedShares: 0, reservedShares: reserved, availableShares: 8 - reserved, hardLocked: Boolean(p.hard_locked), listingStatus: p.listing_status ?? "forming", slots: [] };
  },
}));
const mails: Array<{ to: string; subject: string; link: string | null }> = [];
vi.mock("@/lib/authorization.notify.server", () => ({
  sendEmail: vi.fn(async (to: string, subject: string, _body: string, link: string | null) => {
    mails.push({ to, subject, link });
    return true;
  }),
  deliver: vi.fn(async () => ({ portal: true, emailed: false, duplicate: false })),
  adminRecipients: vi.fn(async () => []),
  memberEmailsFor: vi.fn(async () => []),
  uniqueEmails: (l: string[]) => l,
}));

import { acceptCoBuyerInvite, inviteCoBuyer, myCoBuyer, previewCoBuyerInvite, removeCoBuyer } from "@/lib/co-buyer.server";
import { checkReservationEligibility, createReservation, getMyReservations, withdrawReservation } from "@/lib/reservations.functions";
import { incomingJointRequests, respondToJointRequest } from "@/lib/joint-reservation.server";
import { buyerActionItems } from "@/lib/buyer-actions.functions";
import { getOwnerProperty } from "@/lib/owner.functions";
import { castVoteBallot, createVoteAsAdmin, getVoteForOwner, openVoteAsAdmin } from "@/lib/votes.functions";
import { syncCapTable } from "@/lib/entity-genesis.server";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const HOME = "prop-e2e";

describe("two co-buyers, from the invitation to the owner area", () => {
  it("runs the whole way", async () => {
    seedPod(db());
    for (const m of db().table("account_members")) m.status = "active";
    db().seed("properties", [{ id: HOME, address: "9 Together Way", city: "Cody", state: "WY", zip: "82414", seller_id: IDS.seller, listing_status: "forming", exit_type: "full_exit", created_at: "2026-09-01T00:00:00.000Z", hard_locked_at: "2026-09-02T00:00:00.000Z" }]);
    const dan = db().table("buyer_accounts").find((b) => b.id === IDS.b3)!;
    const carol = db().table("buyer_accounts").find((b) => b.id === IDS.b2)!;
    // Dan is onboarded. Carol has not signed up yet: her account does not exist under the invited address.
    Object.assign(dan, { tether_status: "tethered", golden_ticket_issued: true });
    const carolEmail = carol.email;
    carol.email = "somebody.else@test.local";

    // Phase 1: Dan invites Carol by email. The link opens sign-up with the address filled in.
    as(USERS.b3);
    const invited = await inviteCoBuyer(db(), { userId: USERS.b3, name: "Carol Two", email: carolEmail });
    expect(invited.emailed).toBe(true);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: carolEmail, subject: expect.stringContaining("invited you to buy together") });
    const token = decodeURIComponent((mails[0]!.link ?? "").split("co_buyer=")[1] ?? "");
    expect(await previewCoBuyerInvite(db(), { token })).toMatchObject({ inviterName: "Dan Three", inviteeEmail: carolEmail });
    expect((await myCoBuyer(db(), { userId: USERS.b3 })).link).toMatchObject({ status: "invited", partnerName: "Carol Two" });

    // Carol signs up with that address (her own account, own login), finishes onboarding, and is linked on first sign-in.
    carol.email = carolEmail;
    Object.assign(carol, { tether_status: "tethered", golden_ticket_issued: true });
    await acceptCoBuyerInvite(db(), { userId: USERS.b2, token });
    expect((await myCoBuyer(db(), { userId: USERS.b2 })).link).toMatchObject({ role: "invitee", status: "active", partnerName: "Dan Three", partnerProgress: "ready" });
    expect((await myCoBuyer(db(), { userId: USERS.b3 })).link).toMatchObject({ role: "inviter", status: "active", partnerProgress: "ready" });

    // Phase 2: on the reserve screen Dan is offered "together"; choosing it reserves the share in his name and asks Carol.
    as(USERS.b3);
    expect((await checkReservationEligibility({ data: { propertyId: HOME } })).coBuyer).toMatchObject({ partnerName: "Carol Two", available: true });
    const reserved = await createReservation({ data: { propertyId: HOME, withCoBuyer: true } as never });
    expect(reserved).toMatchObject({ ok: true, joint: { partnerName: "Carol Two" } });
    expect(db().table("pod_reservations").filter((r) => r.property_id === HOME)).toHaveLength(1);

    // Carol sees the request on her dashboard and accepts. Nothing yet changes the share count.
    const [request] = await incomingJointRequests(db(), { userId: USERS.b2 });
    expect(request).toMatchObject({ initiatorName: "Dan Three", address: "9 Together Way" });
    await respondToJointRequest(db(), { userId: USERS.b2, requestId: request!.id, accept: true });
    expect(db().table("pod_reservations").filter((r) => r.property_id === HOME && r.status === "reserved")).toHaveLength(1);
    as(USERS.b2);
    expect((await getMyReservations()).find((r) => r.property_id === HOME)?.joint).toMatchObject({ role: "partner", status: "active", partnerName: "Dan Three" });
    // She can no longer take a second share of her own in the same home.
    expect(await createReservation({ data: { propertyId: HOME } as never })).toMatchObject({ ok: false, reason: "already_reserved" });

    // Phase 3: the cap table names both on the one share, and each owes their own due diligence.
    const cap = db().table("cap_table_entries").filter((c) => c.property_id === HOME);
    expect(cap).toHaveLength(1);
    expect(cap[0]).toMatchObject({ buyer_account_id: IDS.b3, co_holder_account_id: IDS.b2 });
    expect(cap[0]!.account_member_names).toEqual(["Dan Three", "Carol Two"]);
    db().seed("due_diligence_inventory", [{ id: "doc-e2e", property_id: HOME, document_title: "Title Commitment", required: true, content_hash: "h", superseded_by: null, placed_at: new Date().toISOString() }]);
    for (const id of [IDS.b2, IDS.b3]) expect((await buyerActionItems(db() as never, id)).actions.some((a) => a.kind === "due_diligence" && a.propertyId === HOME), id).toBe(true);

    // Closing: each holder of the row gets a Digital Key; the owner area then shows the one share to both.
    // Reserving already opened the LLC record (Digital Genesis); closing executes its Operating Agreement.
    const genesis = db().table("entity_genesis").find((g) => g.property_id === HOME)!;
    Object.assign(genesis, { llc_name: "D8 Together, LLC", ein_status: "verified", oa_executed_at: "2026-10-05T00:00:00.000Z" });
    db().seed("co_owner_digital_keys", [IDS.b3, IDS.b2].map((id) => ({ property_id: HOME, holder_type: "buyer_account", buyer_account_id: id, seller_id: null, shares: 1, status: "active" })));
    for (const user of [USERS.b2, USERS.b3]) {
      as(user);
      expect(await getOwnerProperty({ data: { propertyId: HOME } }), user).toMatchObject({ access: "active", property: { shareNumbers: [1], shareCount: 1 } });
    }

    // One share, one ballot: Carol casts it first, so Dan cannot overwrite it.
    as(USERS.admin);
    const { id: voteId } = await createVoteAsAdmin({ data: { propertyId: HOME, title: "New roof", voteType: "ordinary", opensAt: hoursFromNow(-1), closesAt: hoursFromNow(24) } });
    await openVoteAsAdmin({ data: { voteId } });
    as(USERS.b2);
    expect(await getVoteForOwner({ data: { propertyId: HOME, voteId } })).toMatchObject({ myWeight: 1 });
    expect(await castVoteBallot({ data: { propertyId: HOME, voteId, choice: "Yes" } })).toEqual({ changed: false });
    as(USERS.b3);
    expect(await castVoteBallot({ data: { propertyId: HOME, voteId, choice: "No" } })).toMatchObject({ error: expect.stringMatching(/co-holder has already cast/) });
    expect(db().table("vote_ballots").filter((b) => b.vote_id === voteId)).toHaveLength(1);

    // The link cannot end while the share is held together; once Dan withdraws, the joint hold ends, Carol is told, and it can.
    await expect(removeCoBuyer(db(), { userId: USERS.b2 })).rejects.toThrow(/share a reservation/);
    as(USERS.b3);
    const reservationId = db().table("pod_reservations").find((r) => r.property_id === HOME)!.id;
    expect(await withdrawReservation({ data: { reservationId } })).toMatchObject({ ok: true });
    expect(db().table("joint_reservations")[0]).toMatchObject({ status: "ended" });
    expect(db().table("notifications").some((n) => n.seller_id === USERS.b2 && /was withdrawn/.test(String(n.message)))).toBe(true);
    await removeCoBuyer(db(), { userId: USERS.b2 });
    expect(db().table("co_buyer_links")[0]).toMatchObject({ status: "revoked" });
    // Each keeps their own account, onboarding and Golden Ticket.
    expect(dan.golden_ticket_issued).toBe(true);
    expect(carol.golden_ticket_issued).toBe(true);
    void syncCapTable;
  });

  it("a buyer who takes the share alone never touches any of it", async () => {
    seedPod(db());
    for (const m of db().table("account_members")) m.status = "active";
    db().seed("properties", [{ id: HOME, address: "9 Together Way", city: "Cody", state: "WY", zip: "82414", seller_id: IDS.seller, listing_status: "forming", exit_type: "full_exit", created_at: "2026-09-01T00:00:00.000Z" }]);
    Object.assign(db().table("buyer_accounts").find((b) => b.id === IDS.b3)!, { tether_status: "tethered", golden_ticket_issued: true });
    as(USERS.b3);
    const e = await checkReservationEligibility({ data: { propertyId: HOME } });
    expect(e.ok).toBe(true);
    expect(e.coBuyer ?? null).toBeNull();
    expect(await createReservation({ data: { propertyId: HOME } as never })).toMatchObject({ ok: true, joint: null });
    expect(db().table("joint_reservation_requests")).toHaveLength(0);
    expect(db().table("joint_reservations")).toHaveLength(0);
    const cap = db().table("cap_table_entries").filter((c) => c.property_id === HOME);
    expect(cap[0]?.co_holder_account_id ?? null).toBeNull();
  });
});
