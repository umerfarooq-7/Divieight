/**
 * Dual-agency rule (flat, no exceptions):
 *
 * An agent who is the Listing Agent on a property may NEVER be tethered as a
 * Resident Agent to any Buyer Account inside that property's pod.
 *
 * Enforced at three points:
 *   1. tethering time (Module 7 selection, buyer designation, "keep this buyer")
 *   2. when a seller tags/assigns a Listing Agent on a property
 *   3. at Hard-Lock, as a safeguard that logs a compliance alert if it fires
 *
 * The Heavy Lifting Agent pool is drawn only from tethered Resident Agents in
 * the pod, so blocking the tether automatically blocks HLA selection too — no
 * separate HLA check is needed.
 */

export type Db = { from: (t: string) => any };

/** The only message shown to an agent or buyer when this rule fires. */
export const DUAL_AGENCY_MESSAGE =
  "You hold the listing on this property and cannot also represent a buyer in its pod.";

/** Message shown to a buyer whose designated agent is the Listing Agent. */
export const DUAL_AGENCY_DESIGNATION_MESSAGE =
  "This agent is the Listing Agent for this property and cannot also represent a buyer in this transaction — please choose a different agent";

export type DualAgencyPoint = "tethering" | "listing_agent_tag" | "hard_lock";

export async function logDualAgency(
  db: Db,
  params: {
    actorId: string | null;
    point: DualAgencyPoint;
    agentId: string;
    propertyId: string | null;
    buyerAccountId: string | null;
    resolution: string;
  },
) {
  await db.from("audit_log").insert({
    actor_id: params.actorId,
    actor_type: "system",
    action_type: "compliance.dual_agency_blocked",
    entity_type: params.propertyId ? "property" : "buyer_account",
    entity_id: params.propertyId ?? params.buyerAccountId,
    metadata: {
      detection_point: params.point,
      agent_id: params.agentId,
      property_id: params.propertyId,
      buyer_account_id: params.buyerAccountId,
      resolution: params.resolution,
    },
  });
}

/** Every property whose pod this buyer holds a live reservation in. */
export async function buyerPodPropertyIds(db: Db, buyerAccountId: string): Promise<string[]> {
  const { data } = await db
    .from("pod_reservations")
    .select("property_id")
    .eq("buyer_account_id", buyerAccountId)
    .eq("status", "reserved");
  return Array.from(new Set((data ?? []).map((r: any) => r.property_id).filter(Boolean)));
}

/**
 * True when `agentId` holds the listing on any property in this buyer's pod(s).
 * Returns the conflicting property id so callers can log it.
 */
export async function listingAgentConflict(
  db: Db,
  agentId: string,
  buyerAccountId: string,
): Promise<{ conflict: boolean; propertyId: string | null }> {
  const propertyIds = await buyerPodPropertyIds(db, buyerAccountId);
  if (propertyIds.length === 0) return { conflict: false, propertyId: null };
  const { data } = await db
    .from("properties")
    .select("id")
    .in("id", propertyIds)
    .eq("listing_agent_id", agentId)
    .limit(1);
  const row = (data ?? [])[0];
  return { conflict: Boolean(row), propertyId: row?.id ?? null };
}

/** Buyer accounts with a live reservation in this property's pod. */
export async function podBuyerAccountIds(db: Db, propertyId: string): Promise<string[]> {
  const { data } = await db
    .from("pod_reservations")
    .select("buyer_account_id")
    .eq("property_id", propertyId)
    .eq("status", "reserved");
  return Array.from(new Set((data ?? []).map((r: any) => r.buyer_account_id).filter(Boolean)));
}

/**
 * Detection point 2 — called BEFORE a Listing Agent tag is finalized.
 *
 * Any buyer in that property's pod already tethered to this agent is released
 * and re-run through standard Selection Logic. If the agent was also that
 * buyer's referring agent, the referral share is preserved exactly as in the
 * hand-off path: the re-run stages a Standard NAR Referral Agreement between
 * the (now Listing Agent, still referrer) and the newly tethered agent, 25%/75%.
 */
export async function clearTethersForListingAgent(
  db: Db,
  params: { propertyId: string; agentId: string; actorId: string },
): Promise<{ retethered: string[] }> {
  const buyerIds = await podBuyerAccountIds(db, params.propertyId);
  if (buyerIds.length === 0) return { retethered: [] };

  const { data: rows } = await db
    .from("buyer_accounts")
    .select("id, auth_user_id")
    .in("id", buyerIds)
    .eq("tethered_resident_agent_id", params.agentId);

  const retethered: string[] = [];
  for (const buyer of rows ?? []) {
    await db
      .from("buyer_accounts")
      .update({
        tethered_resident_agent_id: null,
        tether_status: "pending",
        tethered_at: null,
        resident_agent_full_commission: false,
      })
      .eq("id", buyer.id);

    await logDualAgency(db, {
      actorId: params.actorId,
      point: "listing_agent_tag",
      agentId: params.agentId,
      propertyId: params.propertyId,
      buyerAccountId: buyer.id,
      resolution: "buyer released from tether and re-run through Selection Logic",
    });

    try {
      const { runTethering } = await import("@/lib/tethering.functions");
      await runTethering(db as any, buyer.id, params.actorId, { ignoreDesignation: true });
    } catch (e) {
      console.error("[dual-agency] re-tethering failed", e);
    }

    if (buyer.auth_user_id) {
      await db.from("notifications").insert({
        seller_id: buyer.auth_user_id,
        message:
          "Your agent now holds the listing on a property in your pod, so you've been re-assigned to a different Resident Agent.",
        type: "tethering",
      });
    }
    retethered.push(buyer.id);
  }
  return { retethered };
}

/**
 * Detection point 3 — Hard-Lock safeguard. Should never fire; if it does it
 * means points 1-2 missed something, so it logs a compliance alert.
 */
export async function verifyPodDualAgency(
  db: Db,
  params: { propertyId: string; actorId: string | null },
): Promise<{ violations: string[] }> {
  const { data: property } = await db
    .from("properties")
    .select("id, listing_agent_id")
    .eq("id", params.propertyId)
    .maybeSingle();
  if (!property?.listing_agent_id) return { violations: [] };

  const buyerIds = await podBuyerAccountIds(db, params.propertyId);
  if (buyerIds.length === 0) return { violations: [] };

  const { data: rows } = await db
    .from("buyer_accounts")
    .select("id")
    .in("id", buyerIds)
    .eq("tethered_resident_agent_id", property.listing_agent_id);

  const violations = (rows ?? []).map((r: any) => r.id as string);
  for (const buyerAccountId of violations) {
    await logDualAgency(db, {
      actorId: params.actorId,
      point: "hard_lock",
      agentId: property.listing_agent_id,
      propertyId: params.propertyId,
      buyerAccountId,
      resolution: "compliance alert — Listing Agent found tethered in pod at Hard-Lock",
    });
  }
  return { violations };
}

/**
 * Agent ids that may not be tethered to this buyer because they hold the
 * listing on a property in the buyer's pod(s).
 */
export async function blockedAgentIdsForBuyer(db: Db, buyerAccountId: string): Promise<string[]> {
  const propertyIds = await buyerPodPropertyIds(db, buyerAccountId);
  if (propertyIds.length === 0) return [];
  const { data } = await db
    .from("properties")
    .select("listing_agent_id")
    .in("id", propertyIds)
    .not("listing_agent_id", "is", null);
  return Array.from(new Set((data ?? []).map((r: any) => r.listing_agent_id).filter(Boolean)));
}
