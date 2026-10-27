/**
 * Dual-agency checkpoint 4 — at reservation. A buyer whose (account-level)
 * agent holds the listing on the property they reserve must take a different
 * agent for THAT property; their other properties keep the usual agent.
 */
import { describe, it, expect, vi } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { seedClosing, PER_SHARE } from "./closing-fixture";

// The pod math reads through a public client; point it at the fake DB.
vi.mock("@/lib/pod.server", () => ({
  fetchPodComposition: async (propertyId: string) => {
    const db = harness.db;
    const p = db.table("properties").find((x) => x.id === propertyId);
    if (!p) return null;
    const reserved = db
      .table("pod_reservations")
      .filter((r) => r.property_id === propertyId && r.status === "reserved")
      .reduce((s, r) => s + (r.shares_reserved ?? 0), 0);
    const retained = p.exit_type === "hybrid_exit" ? (p.retained_shares ?? 0) : 0;
    return {
      propertyId,
      totalShares: 8,
      retainedShares: retained,
      reservedShares: reserved,
      availableShares: 8 - retained - reserved,
      hardLocked: Boolean(p.hard_locked),
      listingStatus: p.listing_status ?? "forming",
      slots: [],
    };
  },
}));

import { createReservation } from "@/lib/reservations.functions";
import { effectiveAgentId, withPropertyAgents } from "@/lib/property-agent.server";
import { getAgentDiligenceTasks, placeDiligenceDocument } from "@/lib/due-diligence.functions";
import { generateAndTransmit, latestSourceOfTruth } from "@/lib/settlement.server";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const B = "prop-listed-by-ra";

/** B1 already holds a share in A (fixture) and is tethered to RA, who lists property B. */
function seed() {
  seedPod(db());
  db().seed("properties", [
    { id: B, address: "9 Listing Ln", city: "Cody", state: "WY", zip: "82414", seller_id: IDS.seller, listing_status: "forming", listing_agent_id: IDS.ra, exit_type: "full_exit" },
  ]);
  Object.assign(db().table("buyer_accounts").find((b) => b.id === IDS.b1)!, { tether_status: "tethered" });
  // The RPC runs inside Postgres; mirror property-agent.sql here.
  db().rpcResults.reserve_share_with_agent = (a: {
    p_property_id: string;
    p_resident_agent_id: string;
    p_replaced_agent_id: string;
    p_referral_preserved: boolean;
  }) => {
    const buyer = db().table("buyer_accounts").find((b) => b.auth_user_id === harness.userId)!;
    const listing = db().table("properties").find((p) => p.id === a.p_property_id)!.listing_agent_id;
    if (listing !== a.p_replaced_agent_id || buyer.tethered_resident_agent_id !== listing) throw new Error("no conflict");
    if (a.p_resident_agent_id === listing) throw new Error("listing agent");
    db().seed("property_agent_overrides", [
      {
        buyer_account_id: buyer.id,
        property_id: a.p_property_id,
        resident_agent_id: a.p_resident_agent_id,
        replaced_agent_id: a.p_replaced_agent_id,
        referral_preserved: a.p_referral_preserved && buyer.referring_agent_id === a.p_replaced_agent_id,
      },
    ]);
    const id = `res-${a.p_property_id}`;
    db().seed("pod_reservations", [{ id, property_id: a.p_property_id, buyer_account_id: buyer.id, shares_reserved: 1, status: "reserved" }]);
    return id;
  };
}

const reserveB = (extra: Record<string, unknown> = {}) => {
  as(USERS.b1);
  return createReservation({ data: { propertyId: B, ...extra } });
};
const reservationsOn = (pid: string) =>
  db().table("pod_reservations").filter((r) => r.property_id === pid && r.buyer_account_id === IDS.b1);

describe("reservation-time dual-agency checkpoint", () => {
  it("(1) blocks finalization and returns the structured conflict", async () => {
    seed();
    const r = await reserveB();
    expect(r).toMatchObject({
      ok: false,
      reason: "dual_agency_conflict",
      conflict: { code: "DUAL_AGENCY_CONFLICT", conflicting_agent_id: IDS.ra, conflicting_agent_name: "Rita Resident", referring_agent_id_same: false },
    });
    expect(reservationsOn(B)).toEqual([]);
    expect(db().table("property_agent_overrides")).toEqual([]);
    const log = db().audits("compliance.dual_agency_blocked")[0]!;
    expect(log.metadata).toMatchObject({ detection_point: "reservation", agent_id: IDS.ra, property_id: B });
  });

  it("(2) choosing a new agent finalizes with a per-property tether; the other property keeps RA", async () => {
    seed();
    const r = await reserveB({ replacementAgentId: IDS.ra2 });
    expect(r).toMatchObject({ ok: true, agentChange: { newAgentId: IDS.ra2, newAgentName: "Rory Resident", referralPreserved: false } });
    expect(reservationsOn(B)).toHaveLength(1);

    expect(db().table("buyer_accounts").find((b) => b.id === IDS.b1)!.tethered_resident_agent_id).toBe(IDS.ra);
    expect(await effectiveAgentId(db(), IDS.b1, B)).toBe(IDS.ra2);
    expect(await effectiveAgentId(db(), IDS.b1, IDS.property)).toBe(IDS.ra);

    // Notices: old agent, new agent, admin — and the audit entry.
    expect(db().notificationsFor(USERS.ra).at(-1)!.message).toContain("Your representation on their other properties is unchanged");
    expect(db().notificationsFor(USERS.ra).at(-1)!.message).not.toContain("b1@test.local");
    expect(db().notificationsFor(USERS.ra2).at(-1)!.message).toContain("9 Listing Ln");
    expect(db().notificationsFor(USERS.admin).at(-1)!.message).toContain("per-property Resident Agent");
    expect(db().audits("buyer.property_agent_assigned")[0]!.metadata).toMatchObject({
      replaced_agent_id: IDS.ra,
      resident_agent_id: IDS.ra2,
      chosen_by: "buyer",
    });
  });

  it("the new agent does B's DD work; the old agent keeps A's and never sees B's", async () => {
    seed();
    await reserveB({ replacementAgentId: IDS.ra2 });
    as(USERS.admin);
    await placeDiligenceDocument({ data: { propertyId: B, documentTitle: "hoa-B", category: "hoa", fileUrl: "b.pdf", contentHash: "hb" } });
    await placeDiligenceDocument({ data: { propertyId: IDS.property, documentTitle: "hoa-A", category: "hoa", fileUrl: "a.pdf", contentHash: "ha" } });

    as(USERS.ra2);
    const ra2Tasks = (await getAgentDiligenceTasks()).tasks;
    expect(ra2Tasks.map((t) => [t.propertyId, t.buyerAccountId])).toEqual([[B, IDS.b1]]);
    as(USERS.ra);
    const raTasks = (await getAgentDiligenceTasks()).tasks;
    expect(raTasks.some((t) => t.propertyId === B)).toBe(false);
    expect(raTasks.some((t) => t.propertyId === IDS.property && t.buyerAccountId === IDS.b1)).toBe(true);
  });

  it("(3) a replaced referring agent stays referrer (flag on the conflict and the override)", async () => {
    seed();
    db().table("buyer_accounts").find((b) => b.id === IDS.b1)!.referring_agent_id = IDS.ra;
    const r = await reserveB();
    expect(r.conflict?.referring_agent_id_same).toBe(true);
    const done = await reserveB({ replacementAgentId: IDS.ra2 });
    expect(done.agentChange?.referralPreserved).toBe(true);
    expect(db().table("property_agent_overrides")[0]).toMatchObject({ replaced_agent_id: IDS.ra, referral_preserved: true });
    expect(db().notificationsFor(USERS.ra).at(-1)!.message).toContain("You keep your referral share");
  });

  it("(4) a non-conflict reservation behaves exactly as before", async () => {
    seed();
    db().table("properties").find((p) => p.id === B)!.listing_agent_id = IDS.hla;
    const r = await reserveB();
    expect(r).toMatchObject({ ok: true, reason: "ok", agentChange: null });
    expect(reservationsOn(B)).toHaveLength(1);
    expect(db().table("property_agent_overrides")).toEqual([]);
    expect(db().audits("compliance.dual_agency_blocked")).toEqual([]);
  });

  it("(5) the server rejects the Listing Agent as replacement, and ineligible picks", async () => {
    seed();
    const self = await reserveB({ replacementAgentId: IDS.ra });
    expect(self).toMatchObject({ ok: false, reason: "invalid_replacement_agent" });
    const ghost = await reserveB({ replacementAgentId: "agent-does-not-exist" });
    expect(ghost).toMatchObject({ ok: false, reason: "invalid_replacement_agent" });
    expect(reservationsOn(B)).toEqual([]);
  });

  it("'let divieight choose' assigns an eligible agent other than the Listing Agent", async () => {
    seed();
    const r = await reserveB({ autoAssignAgent: true });
    expect(r.ok).toBe(true);
    expect(r.agentChange?.newAgentId).toBeTruthy();
    expect(r.agentChange?.newAgentId).not.toBe(IDS.ra);
    expect(db().audits("buyer.property_agent_assigned")[0]!.metadata.chosen_by).toBe("platform");
  });

  it("withPropertyAgents rewrites only the overridden property", async () => {
    seed();
    await reserveB({ replacementAgentId: IDS.ra2 });
    const row = { id: IDS.b1, tethered_resident_agent_id: IDS.ra };
    expect((await withPropertyAgents(db(), B, [row]))[0]!.tethered_resident_agent_id).toBe(IDS.ra2);
    expect((await withPropertyAgents(db(), IDS.property, [row]))[0]!.tethered_resident_agent_id).toBe(IDS.ra);
  });
});

describe("settlement on a property with a per-property agent", () => {
  it("pays the new agent as Resident Agent and keeps the referrer's 25% — math unchanged", async () => {
    await seedClosing();
    // B1 on property A: RA (account agent, also B1's referrer) replaced by RA2 here.
    db().table("buyer_accounts").find((b) => b.id === IDS.b1)!.referring_agent_id = IDS.ra;
    db().seed("property_agent_overrides", [
      { buyer_account_id: IDS.b1, property_id: IDS.property, resident_agent_id: IDS.ra2, replaced_agent_id: IDS.ra, referral_preserved: true },
    ]);
    const res = await generateAndTransmit(db(), USERS.admin, IDS.property);
    expect(res.status).toBe("transmitted");
    const sot = (await latestSourceOfTruth(db(), IDS.property))!.structured;
    const b1Share = sot.shares.find((s) => s.buyerAccountId === IDS.b1)!;
    const resident = b1Share.lines.find((l) => l.role === "resident_agent")!;
    const referral = b1Share.lines.find((l) => l.role === "referring_agent")!;
    expect(resident.agentId).toBe(IDS.ra2);
    expect(referral.agentId).toBe(IDS.ra);
    // 25% referral / 75% resident of the same share commission (before any HLA carve-out).
    expect(referral.grossCents + resident.grossCents).toBe(PER_SHARE);
    expect(Math.abs(referral.grossCents - PER_SHARE / 4)).toBeLessThanOrEqual(1);
  });
});
