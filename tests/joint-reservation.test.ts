/** Joint reservations: two linked co-buyers taking ONE share together. The initiator reserves and pays; the partner is asked first. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";

vi.mock("@/lib/pod.server", () => ({
  fetchPodComposition: async (propertyId: string) => {
    const db = harness.db;
    const p = db.table("properties").find((x) => x.id === propertyId);
    if (!p) return null;
    const reserved = db
      .table("pod_reservations")
      .filter((r) => r.property_id === propertyId && r.status === "reserved")
      .reduce((s, r) => s + (r.shares_reserved ?? 0), 0);
    return {
      propertyId,
      totalShares: 8,
      retainedShares: 0,
      reservedShares: reserved,
      availableShares: 8 - reserved,
      hardLocked: Boolean(p.hard_locked),
      listingStatus: p.listing_status ?? "forming",
      slots: [],
    };
  },
}));
vi.mock("@/lib/authorization.notify.server", () => ({ sendEmail: vi.fn(async () => true) }));

import { checkReservationEligibility, createReservation, getMyReservations, withdrawReservation } from "@/lib/reservations.functions";
import { removeCoBuyer } from "@/lib/co-buyer.server";
import { incomingJointRequests, respondToJointRequest, cancelJointRequest } from "@/lib/joint-reservation.server";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const HOME = "prop-joint";
const reservations = () => db().table("pod_reservations").filter((r) => r.property_id === HOME);
const requests = () => db().table("joint_reservation_requests");
const joints = () => db().table("joint_reservations");
const told = (user: string, re: RegExp) => db().table("notifications").some((n) => n.seller_id === user && re.test(String(n.message)));

// Dan (b3) and Carol (b2) are linked co-buyers. Both are onboarded and tethered; Dan starts the reservation.
beforeEach(() => {
  seedPod(db());
  for (const m of db().table("account_members")) m.status = "active";
  db().seed("properties", [{ id: HOME, address: "5 Joint Way", city: "Cody", state: "WY", zip: "82414", seller_id: IDS.seller, listing_status: "forming", exit_type: "full_exit" }]);
  for (const id of [IDS.b2, IDS.b3]) Object.assign(db().table("buyer_accounts").find((b) => b.id === id)!, { tether_status: "tethered", golden_ticket_issued: true });
  db().seed("co_buyer_links", [{ id: "link-1", inviter_account_id: IDS.b3, invitee_account_id: IDS.b2, invitee_name: "Carol Two", invitee_email: "b2@test.local", token_hash: "x", status: "active", invited_at: new Date().toISOString() }]);
});

const reserveTogether = (withCoBuyer = true) => {
  as(USERS.b3);
  return createReservation({ data: { propertyId: HOME, withCoBuyer } as never });
};

describe("the choice on the reserve screen", () => {
  it("offers 'together' when the co-buyer is ready, and nothing when there is no co-buyer", async () => {
    as(USERS.b3);
    const e = await checkReservationEligibility({ data: { propertyId: HOME } });
    expect(e).toMatchObject({ ok: true, coBuyer: { partnerName: "Carol Two", available: true, unavailableReason: null } });
    as(USERS.b1);
    Object.assign(db().table("buyer_accounts").find((b) => b.id === IDS.b1)!, { tether_status: "tethered" });
    const alone = await checkReservationEligibility({ data: { propertyId: HOME } });
    expect(alone.coBuyer ?? null).toBeNull();
  });

  it("says why when the co-buyer is still onboarding", async () => {
    db().table("buyer_accounts").find((b) => b.id === IDS.b2)!.golden_ticket_issued = false;
    as(USERS.b3);
    const e = await checkReservationEligibility({ data: { propertyId: HOME } });
    expect(e.coBuyer).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/still finishing onboarding/) });
  });
});

describe("taking the share together", () => {
  it("reserves it in the initiator's name at once and asks the co-buyer", async () => {
    const r = await reserveTogether();
    expect(r).toMatchObject({ ok: true, joint: { partnerName: "Carol Two" }, jointError: null });
    expect(reservations()).toHaveLength(1);
    expect(reservations()[0]).toMatchObject({ buyer_account_id: IDS.b3, shares_reserved: 1, status: "reserved" });
    expect(requests()).toHaveLength(1);
    expect(requests()[0]).toMatchObject({ initiator_account_id: IDS.b3, partner_account_id: IDS.b2, status: "pending", reservation_id: reservations()[0]!.id });
    expect(told(USERS.b2, /wants to take a share with you|would like to hold it together/)).toBe(true);
    expect(db().audits("buyer.joint_request_sent")).toHaveLength(1);
    // Nobody else's share count moves: still one share reserved.
    expect(reservations().reduce((s, x) => s + x.shares_reserved, 0)).toBe(1);
  });

  it("alone is exactly as before: no request, no joint row", async () => {
    const r = await reserveTogether(false);
    expect(r).toMatchObject({ ok: true, joint: null });
    expect(requests()).toHaveLength(0);
  });

  it("refuses to reserve at all if the co-buyer can't take it, so nothing is left half-done", async () => {
    db().table("buyer_accounts").find((b) => b.id === IDS.b2)!.golden_ticket_issued = false;
    const r = await reserveTogether();
    expect(r).toMatchObject({ ok: false, reason: "error", message: expect.stringMatching(/still finishing onboarding/) });
    expect(reservations()).toHaveLength(0);
    expect(requests()).toHaveLength(0);
  });

  it("refuses if the co-buyer already holds a share in this home", async () => {
    db().seed("pod_reservations", [{ id: "carol-own", property_id: HOME, buyer_account_id: IDS.b2, shares_reserved: 1, status: "reserved" }]);
    const r = await reserveTogether();
    expect(r).toMatchObject({ ok: false, reason: "error", message: expect.stringMatching(/already holds a share/) });
    expect(reservations().filter((x) => x.buyer_account_id === IDS.b3)).toHaveLength(0);
  });

  it("refuses without an active link", async () => {
    db().table("co_buyer_links")[0]!.status = "revoked";
    const r = await reserveTogether();
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/don't have an active co-buyer/) });
    expect(reservations()).toHaveLength(0);
  });
});

describe("the co-buyer answers", () => {
  it("accepting makes them the second holder of the same share; the reservation count does not change", async () => {
    await reserveTogether();
    as(USERS.b2);
    const incoming = await incomingJointRequests(db(), { userId: USERS.b2 });
    expect(incoming).toEqual([expect.objectContaining({ initiatorName: "Dan Three", propertyId: HOME, address: "5 Joint Way" })]);
    await expect(respondToJointRequest(db(), { userId: USERS.b2, requestId: incoming[0]!.id, accept: true })).resolves.toEqual({ status: "accepted" });
    expect(joints()).toEqual([expect.objectContaining({ reservation_id: reservations()[0]!.id, primary_account_id: IDS.b3, partner_account_id: IDS.b2, status: "active", property_id: HOME })]);
    expect(requests()[0]!.status).toBe("accepted");
    expect(reservations()).toHaveLength(1);
    expect(reservations().reduce((s, x) => s + x.shares_reserved, 0)).toBe(1);
    expect(told(USERS.b3, /accepted/)).toBe(true);
    expect(db().audits("buyer.joint_request_accepted")).toHaveLength(1);
  });

  it("both dashboards show the share: the initiator's own, the partner's marked as held together", async () => {
    await reserveTogether();
    const id = requests()[0]!.id;
    as(USERS.b3);
    expect((await getMyReservations()).find((r) => r.property_id === HOME)?.joint).toMatchObject({ role: "initiator", status: "pending", partnerName: "Carol Two" });
    await respondToJointRequest(db(), { userId: USERS.b2, requestId: id, accept: true });
    as(USERS.b3);
    expect((await getMyReservations()).find((r) => r.property_id === HOME)?.joint).toMatchObject({ role: "initiator", status: "active" });
    as(USERS.b2);
    const mine = await getMyReservations();
    expect(mine.find((r) => r.property_id === HOME)).toMatchObject({ shares_reserved: 1, joint: { role: "partner", status: "active", partnerName: "Dan Three" } });
  });

  it("the partner can no longer reserve a share in the same home on their own", async () => {
    await reserveTogether();
    await respondToJointRequest(db(), { userId: USERS.b2, requestId: requests()[0]!.id, accept: true });
    as(USERS.b2);
    expect(await createReservation({ data: { propertyId: HOME } as never })).toMatchObject({ ok: false, reason: "already_reserved" });
    expect((await checkReservationEligibility({ data: { propertyId: HOME } })).reason).toBe("already_reserved");
  });

  it("declining leaves the share with the initiator alone, and tells them", async () => {
    await reserveTogether();
    await expect(respondToJointRequest(db(), { userId: USERS.b2, requestId: requests()[0]!.id, accept: false })).resolves.toEqual({ status: "declined" });
    expect(requests()[0]!.status).toBe("declined");
    expect(joints()).toHaveLength(0);
    expect(reservations()[0]).toMatchObject({ buyer_account_id: IDS.b3, status: "reserved" });
    expect(told(USERS.b3, /declined/)).toBe(true);
    as(USERS.b3);
    expect((await getMyReservations()).find((r) => r.property_id === HOME)?.joint).toMatchObject({ status: "declined" });
  });

  it("only the buyer it was sent to can answer, and only once", async () => {
    await reserveTogether();
    const id = requests()[0]!.id;
    await expect(respondToJointRequest(db(), { userId: USERS.b3, requestId: id, accept: true })).rejects.toThrow("isn't addressed to you");
    await respondToJointRequest(db(), { userId: USERS.b2, requestId: id, accept: false });
    await expect(respondToJointRequest(db(), { userId: USERS.b2, requestId: id, accept: true })).rejects.toThrow("can't be found");
  });

  it("an unanswered request expires after its time: the share stays the initiator's alone", async () => {
    await reserveTogether();
    requests()[0]!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await incomingJointRequests(db(), { userId: USERS.b2 })).toEqual([]);
    expect(requests()[0]!.status).toBe("expired");
    await expect(respondToJointRequest(db(), { userId: USERS.b2, requestId: requests()[0]!.id, accept: true })).rejects.toThrow("expired");
    expect(told(USERS.b3, /didn't answer/)).toBe(true);
    expect(joints()).toHaveLength(0);
  });

  it("needs the Golden Ticket of the one accepting", async () => {
    await reserveTogether();
    db().table("buyer_accounts").find((b) => b.id === IDS.b2)!.golden_ticket_issued = false;
    await expect(respondToJointRequest(db(), { userId: USERS.b2, requestId: requests()[0]!.id, accept: true })).rejects.toThrow("Golden Ticket");
    expect(joints()).toHaveLength(0);
  });

  it("can't be accepted once the link has ended or the share is gone", async () => {
    await reserveTogether();
    db().table("co_buyer_links")[0]!.status = "revoked";
    await expect(respondToJointRequest(db(), { userId: USERS.b2, requestId: requests()[0]!.id, accept: true })).rejects.toThrow("no longer linked");
    db().table("co_buyer_links")[0]!.status = "active";
    reservations()[0]!.status = "withdrawn";
    await expect(respondToJointRequest(db(), { userId: USERS.b2, requestId: requests()[0]!.id, accept: true })).rejects.toThrow("no longer reserved");
    expect(requests()[0]!.status).toBe("cancelled");
  });
});

describe("taking it alone after all, and withdrawing", () => {
  it("the initiator can withdraw the request while it waits; the reservation is untouched", async () => {
    await reserveTogether();
    await cancelJointRequest(db(), { userId: USERS.b3, requestId: requests()[0]!.id });
    expect(requests()[0]!.status).toBe("cancelled");
    expect(reservations()[0]).toMatchObject({ buyer_account_id: IDS.b3, status: "reserved" });
    expect(told(USERS.b2, /withdrew the request/)).toBe(true);
    expect(await incomingJointRequests(db(), { userId: USERS.b2 })).toEqual([]);
  });

  it("only the initiator can, and only while it waits", async () => {
    await reserveTogether();
    await expect(cancelJointRequest(db(), { userId: USERS.b2, requestId: requests()[0]!.id })).rejects.toThrow("can't be found");
  });

  it("withdrawing the share ends the joint hold and tells the partner", async () => {
    await reserveTogether();
    await respondToJointRequest(db(), { userId: USERS.b2, requestId: requests()[0]!.id, accept: true });
    as(USERS.b3);
    expect(await withdrawReservation({ data: { reservationId: reservations()[0]!.id } })).toMatchObject({ ok: true });
    expect(joints()[0]).toMatchObject({ status: "ended", ended_reason: "withdrawn" });
    expect(told(USERS.b2, /was withdrawn/)).toBe(true);
    as(USERS.b2);
    expect((await getMyReservations()).filter((r) => r.property_id === HOME)).toHaveLength(0);
  });

  it("withdrawing while the request still waits closes it", async () => {
    await reserveTogether();
    as(USERS.b3);
    await withdrawReservation({ data: { reservationId: reservations()[0]!.id } });
    expect(requests()[0]!.status).toBe("cancelled");
  });
});

describe("the co-buyer link", () => {
  it("can't be ended while a share is held together or a request waits", async () => {
    await reserveTogether();
    await expect(removeCoBuyer(db(), { userId: USERS.b2 })).rejects.toThrow("share a reservation");
    await respondToJointRequest(db(), { userId: USERS.b2, requestId: requests()[0]!.id, accept: true });
    await expect(removeCoBuyer(db(), { userId: USERS.b3 })).rejects.toThrow("share a reservation");
    expect(db().table("co_buyer_links")[0]!.status).toBe("active");
  });

  it("can be ended once the share is withdrawn", async () => {
    await reserveTogether();
    await respondToJointRequest(db(), { userId: USERS.b2, requestId: requests()[0]!.id, accept: true });
    as(USERS.b3);
    await withdrawReservation({ data: { reservationId: reservations()[0]!.id } });
    await removeCoBuyer(db(), { userId: USERS.b3 });
    expect(db().table("co_buyer_links")[0]!.status).toBe("revoked");
  });
});
