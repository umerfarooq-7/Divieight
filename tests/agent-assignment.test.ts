/**
 * "Let divieight choose an agent for me": buyer request → admin queue → agent
 * accept/decline, account-wide and for one property.
 */
import { describe, it, expect, vi } from "vitest";
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

import {
  assignAgentToRequest,
  cancelAgentAssignment,
  listAgentAssignments,
  listPropertyAssignmentOffers,
  requestAgentAssignment,
  respondToPropertyAssignment,
} from "@/lib/agent-assignment.functions";
import {
  designateAgent,
  getDesignationState,
  listDesignationRequests,
  respondToDesignation,
  runDesignationSweep,
} from "@/lib/designation.functions";
import { checkReservationEligibility, createReservation } from "@/lib/reservations.functions";
import { effectiveAgentId } from "@/lib/property-agent.server";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const B = "prop-listed-by-ra";
const ELIGIBLE = {
  onboarding_status: "complete",
  license_verified: true,
  nar_cert_lapsed: false,
  transactions_held: false,
  relationship_status: "active",
  eo_lapsed: false,
  markets: ["WY"],
};
const buyerRow = (id: string) => db().table("buyer_accounts").find((b) => b.id === id)!;
const agentRow = (id: string) => db().table("agents").find((a) => a.id === id)!;
const requests = () => db().table("agent_assignment_requests");

/** B3 is vetted, untethered, targeting a Wyoming zip. B1 is tethered to RA, who lists property B. */
function seed() {
  seedPod(db());
  for (const id of [IDS.ra, IDS.ra2, IDS.hla]) Object.assign(agentRow(id), ELIGIBLE);
  db().seed("properties", [
    { id: B, address: "9 Listing Ln", city: "Cody", state: "WY", zip: "82414", seller_id: IDS.seller, listing_status: "forming", listing_agent_id: IDS.ra },
  ]);
  Object.assign(buyerRow(IDS.b3), {
    tethered_resident_agent_id: null,
    tether_status: "pending",
    golden_ticket_issued: true,
    primary_target_market: "82601",
    target_budget_bucket: "under_500k",
    target_budget: 412345,
  });
  Object.assign(buyerRow(IDS.b1), { tether_status: "tethered", golden_ticket_issued: true, primary_target_market: "82601" });
  // Runs inside Postgres; mirror property-agent.sql (conflict path only).
  db().rpcResults.reserve_share_with_agent = () => {
    throw new Error("the platform path must not use the buyer-chosen RPC");
  };
}

async function askAsB3() {
  as(USERS.b3);
  return requestAgentAssignment();
}
const queue = async () => {
  as(USERS.admin);
  return (await listAgentAssignments()).rows;
};
const assign = (requestId: string, agentId: string) => {
  as(USERS.admin);
  return assignAgentToRequest({ data: { requestId, agentId } });
};

describe("self-selected flow is unchanged", () => {
  it("designating, then a decline, keeps the existing behaviour and creates no request", async () => {
    seed();
    as(USERS.b3);
    await designateAgent({ data: { buyerAccountId: IDS.b3, agentId: IDS.ra2, origin: "http://x" } });
    expect(buyerRow(IDS.b3)).toMatchObject({ tether_status: "awaiting_designation", designated_agent_id: IDS.ra2 });
    as(USERS.ra2);
    await respondToDesignation({ data: { buyerAccountId: IDS.b3, accept: false } });
    expect(buyerRow(IDS.b3)).toMatchObject({ tether_status: "awaiting_designation", designation_expired: true, designated_agent_id: null });
    expect(requests()).toEqual([]);
    expect(db().notificationsFor(USERS.b3).at(-1)!.message).toContain("Your designated agent declined");
  });

  it("accepting a self-selected designation tethers as before", async () => {
    seed();
    as(USERS.b3);
    await designateAgent({ data: { buyerAccountId: IDS.b3, agentId: IDS.ra2, origin: "http://x" } });
    as(USERS.ra2);
    expect(await respondToDesignation({ data: { buyerAccountId: IDS.b3, accept: true } })).toMatchObject({ tethered: true });
    expect(buyerRow(IDS.b3)).toMatchObject({ tether_status: "tethered", tethered_resident_agent_id: IDS.ra2 });
  });
});

describe("account-wide request", () => {
  it("creates one pending request, names no agent, and blocks reserving meanwhile", async () => {
    seed();
    await askAsB3();
    await askAsB3(); // idempotent
    expect(requests()).toHaveLength(1);
    expect(requests()[0]).toMatchObject({ status: "pending", property_id: null });
    expect(requests()[0]!.assigned_agent_id ?? null).toBeNull();
    expect(buyerRow(IDS.b3)).toMatchObject({ agent_selection_mode: "platform_assigned", platform_assignment_status: "pending" });
    expect(db().notificationsFor(USERS.admin).at(-1)!.message).toContain("waiting for an agent assignment");

    as(USERS.b3);
    const state = await getDesignationState({ data: { buyerAccountId: IDS.b3 } });
    expect(state!.platformAssignment).toMatchObject({ status: "pending", agentName: null });
    Object.assign(buyerRow(IDS.b3), { liquidity_verified: true });
    expect(await createReservation({ data: { propertyId: B } })).toMatchObject({ ok: false, reason: "awaiting_platform_assignment" });
    expect(await checkReservationEligibility({ data: { propertyId: B } })).toMatchObject({ reason: "awaiting_platform_assignment" });
    expect(db().table("pod_reservations").filter((r) => r.buyer_account_id === IDS.b3)).toEqual([]);
  });

  it("the queue shows the coarse bucket only and offers only eligible agents", async () => {
    seed();
    agentRow(IDS.hla).eo_lapsed = true;
    db().seed("agents", [
      { id: "agent-ca", auth_user_id: "u-ca", full_name: "Other Market", broker_id: IDS.broker, ...ELIGIBLE, markets: ["CA"] },
      { id: "agent-new", auth_user_id: "u-new", full_name: "Not Finished", broker_id: IDS.broker, ...ELIGIBLE, onboarding_status: "insurance_pending" },
    ]);
    await askAsB3();
    const [row] = await queue();
    expect(row!.market).toBe("82601");
    expect(JSON.stringify(row)).not.toContain("412345");
    expect(JSON.stringify(row)).not.toContain("b3@test.local");
    expect(row!.eligible.map((a) => a.id).sort()).toEqual([IDS.ra, IDS.ra2].sort());
    await expect(assign(row!.id, "agent-ca")).rejects.toThrow("isn't eligible");
    await expect(assign(row!.id, IDS.hla)).rejects.toThrow("isn't eligible");
    expect(requests()[0]!.status).toBe("pending");
  });

  it("assignment excludes a Listing Agent in the buyer's pod", async () => {
    seed();
    db().seed("pod_reservations", [{ id: "res-b3-B", property_id: B, buyer_account_id: IDS.b3, shares_reserved: 1, status: "reserved" }]);
    await askAsB3();
    const [row] = await queue();
    expect(row!.excludedAgents).toEqual(["Rita Resident"]);
    expect(row!.eligible.map((a) => a.id)).not.toContain(IDS.ra);
    await expect(assign(row!.id, IDS.ra)).rejects.toThrow("holds a listing");
    expect(requests()[0]!.assigned_agent_id ?? null).toBeNull();
  });

  it("assign → the buyer sees the agent → accept tethers through the existing path, referrer staged", async () => {
    seed();
    Object.assign(buyerRow(IDS.b3), { referring_agent_id: IDS.hla });
    await askAsB3();
    await assign(requests()[0]!.id, IDS.ra2);
    expect(requests()[0]).toMatchObject({ status: "assigned", assigned_agent_id: IDS.ra2 });
    expect(buyerRow(IDS.b3)).toMatchObject({ designated_agent_id: IDS.ra2, tether_status: "awaiting_designation", platform_assignment_status: "assigned" });
    expect(db().notificationsFor(USERS.b3).at(-1)!.message).toContain("Rory Resident");
    expect(db().audits("buyer.agent_platform_assigned")[0]!.metadata.assigned_by).toBe("platform");

    as(USERS.b3);
    expect((await getDesignationState({ data: { buyerAccountId: IDS.b3 } }))!.platformAssignment).toMatchObject({ status: "assigned", agentName: "Rory Resident" });

    as(USERS.ra2);
    expect((await listDesignationRequests({})).map((d) => d.buyerAccountId)).toEqual([IDS.b3]);
    expect(await respondToDesignation({ data: { buyerAccountId: IDS.b3, accept: true } })).toMatchObject({ tethered: true });
    expect(buyerRow(IDS.b3)).toMatchObject({ tether_status: "tethered", tethered_resident_agent_id: IDS.ra2, referring_agent_id: IDS.hla });
    expect(requests()[0]!.status).toBe("accepted");
    // Referrer keeps the share: the existing NAR agreement is staged RA2 + referrer.
    expect(db().table("pending_referral_agreements")[0]).toMatchObject({ buyer_account_id: IDS.b3, non_resident_agent_id: IDS.hla });

    as(USERS.b3);
    expect((await getDesignationState({ data: { buyerAccountId: IDS.b3 } }))!.tetheredAgentName).toBe("Rory Resident");
  });

  it("a decline returns the request to pending, and that agent isn't offered again", async () => {
    seed();
    await askAsB3();
    const id = requests()[0]!.id;
    await assign(id, IDS.ra2);
    as(USERS.ra2);
    await respondToDesignation({ data: { buyerAccountId: IDS.b3, accept: false } });

    expect(requests()[0]).toMatchObject({ status: "pending" });
    expect(requests()[0]!.assigned_agent_id ?? null).toBeNull();
    expect(buyerRow(IDS.b3)).toMatchObject({ tether_status: "pending", designated_agent_id: null, designation_expired: false, platform_assignment_status: "pending" });
    expect(db().notificationsFor(USERS.b3).at(-1)!.message).toContain("choosing another");
    const [row] = await queue();
    expect(row!.declinedCount).toBe(1);
    expect(row!.eligible.map((a) => a.id)).not.toContain(IDS.ra2);
    await expect(assign(id, IDS.ra2)).rejects.toThrow("isn't eligible");
  });

  it("an agent who never answers goes back to the queue too", async () => {
    seed();
    await askAsB3();
    await assign(requests()[0]!.id, IDS.ra2);
    buyerRow(IDS.b3).designation_deadline_at = "2020-01-01T00:00:00.000Z";
    await runDesignationSweep(db());
    expect(requests()[0]!.status).toBe("pending");
    expect(buyerRow(IDS.b3)).toMatchObject({ tether_status: "pending", designation_expired: false });
  });

  it("the buyer can go back to choosing their own agent", async () => {
    seed();
    await askAsB3();
    await assign(requests()[0]!.id, IDS.ra2);
    as(USERS.b3);
    await cancelAgentAssignment({ data: { requestId: requests()[0]!.id } });
    expect(requests()[0]!.status).toBe("cancelled");
    expect(buyerRow(IDS.b3)).toMatchObject({ agent_selection_mode: "self_selected", tether_status: "pending", designated_agent_id: null });
    as(USERS.ra2);
    expect(await listDesignationRequests({})).toEqual([]);
  });

  it("only admins can see or work the queue", async () => {
    seed();
    await askAsB3();
    as(USERS.b1);
    await expect(listAgentAssignments()).rejects.toThrow("Not authorized");
    await expect(assignAgentToRequest({ data: { requestId: requests()[0]!.id, agentId: IDS.ra2 } })).rejects.toThrow("Not authorized");
  });
});

describe("one-property request (the buyer's agent holds this listing)", () => {
  const reserveB = (extra: Record<string, unknown> = {}) => {
    as(USERS.b1);
    return createReservation({ data: { propertyId: B, ...extra } });
  };
  const onB = () => db().table("pod_reservations").filter((r) => r.property_id === B && r.buyer_account_id === IDS.b1);

  it("queues a request and reserves nothing until the agent accepts; other properties keep RA", async () => {
    seed();
    expect(await reserveB({ autoAssignAgent: true })).toMatchObject({ ok: false, reason: "awaiting_platform_assignment" });
    expect(requests()[0]).toMatchObject({ property_id: B, status: "pending", replaced_agent_id: IDS.ra });
    expect(onB()).toEqual([]);
    expect(db().table("property_agent_overrides")).toEqual([]);
    expect(await reserveB()).toMatchObject({ ok: false, reason: "awaiting_platform_assignment" });

    const [row] = await queue();
    expect(row!.property).toMatchObject({ id: B });
    expect(row!.excludedAgents).toContain("Rita Resident");
    expect(row!.eligible.map((a) => a.id)).not.toContain(IDS.ra);
    await expect(assign(row!.id, IDS.ra)).rejects.toThrow("holds a listing");

    await assign(row!.id, IDS.ra2);
    expect(await reserveB()).toMatchObject({ ok: false, reason: "awaiting_platform_assignment" });
    as(USERS.ra2);
    expect(await listPropertyAssignmentOffers({})).toEqual([{ requestId: row!.id, propertyLabel: "9 Listing Ln, Cody, WY" }]);
    expect(await respondToPropertyAssignment({ data: { requestId: row!.id, accept: true } })).toEqual({});

    expect(requests()[0]!.status).toBe("accepted");
    expect(await effectiveAgentId(db(), IDS.b1, B)).toBe(IDS.ra2);
    expect(await effectiveAgentId(db(), IDS.b1, IDS.property)).toBe(IDS.ra);
    expect(buyerRow(IDS.b1).tethered_resident_agent_id).toBe(IDS.ra);
    expect(db().notificationsFor(USERS.b1).at(-1)!.message).toContain("Rory Resident");

    expect(await reserveB()).toMatchObject({ ok: true, reason: "ok" });
    expect(onB()).toHaveLength(1);
  });

  it("a decline returns it to pending; another agent can then be assigned", async () => {
    seed();
    await reserveB({ autoAssignAgent: true });
    const id = requests()[0]!.id;
    await assign(id, IDS.ra2);
    as(USERS.ra2);
    await respondToPropertyAssignment({ data: { requestId: id, accept: false } });
    expect(requests()[0]!.status).toBe("pending");
    expect(db().table("property_agent_overrides")).toEqual([]);
    expect(buyerRow(IDS.b1).tether_status).toBe("tethered");
    await assign(id, IDS.hla);
    expect(requests()[0]).toMatchObject({ status: "assigned", assigned_agent_id: IDS.hla });
  });

  it("a replaced referrer keeps the referral share; only the assigned agent can answer", async () => {
    seed();
    buyerRow(IDS.b1).referring_agent_id = IDS.ra;
    await reserveB({ autoAssignAgent: true });
    const id = requests()[0]!.id;
    await assign(id, IDS.ra2);
    as(USERS.hla);
    expect(await respondToPropertyAssignment({ data: { requestId: id, accept: true } })).toMatchObject({ error: expect.any(String) });
    as(USERS.ra2);
    await respondToPropertyAssignment({ data: { requestId: id, accept: true } });
    expect(db().table("property_agent_overrides")[0]).toMatchObject({ resident_agent_id: IDS.ra2, replaced_agent_id: IDS.ra, referral_preserved: true });
    expect(db().notificationsFor(USERS.ra).at(-1)!.message).toContain("You keep your referral share");
  });
});
