/**
 * Per-property Resident Agent.
 *
 * A Buyer Account is tethered to one Resident Agent account-wide
 * (buyer_accounts.tethered_resident_agent_id). When that agent holds the
 * listing on a property the buyer reserves into, the buyer is given a
 * different agent for THAT property only — a row in property_agent_overrides.
 * Every property-specific decision (DD acknowledgment, authorizations,
 * reports, funding notices, HLA pool, settlement, closing holds) asks this
 * module who the buyer's agent is on that property; the buyer's other
 * properties keep the account-level agent.
 */

type Db = { from: (t: string) => any };

export interface PropertyAgentOverride {
  buyer_account_id: string;
  property_id: string;
  resident_agent_id: string;
  replaced_agent_id: string | null;
  referral_preserved: boolean;
}

const COLS = "buyer_account_id, property_id, resident_agent_id, replaced_agent_id, referral_preserved";

/** Overrides matching the filter. Empty (not an error) before property-agent.sql is run. */
export async function loadAgentOverrides(
  db: Db,
  filter: { buyerIds?: string[]; propertyIds?: string[]; agentId?: string },
): Promise<PropertyAgentOverride[]> {
  if (filter.buyerIds && filter.buyerIds.length === 0) return [];
  if (filter.propertyIds && filter.propertyIds.length === 0) return [];
  let q = db.from("property_agent_overrides").select(COLS);
  if (filter.buyerIds) q = q.in("buyer_account_id", filter.buyerIds);
  if (filter.propertyIds) q = q.in("property_id", filter.propertyIds);
  if (filter.agentId) q = q.eq("resident_agent_id", filter.agentId);
  const { data, error } = await q;
  if (error) return [];
  return (data ?? []) as PropertyAgentOverride[];
}

/** The buyer's Resident Agent on this property. */
export async function effectiveAgentId(
  db: Db,
  buyerAccountId: string,
  propertyId: string,
  accountAgentId?: string | null,
): Promise<string | null> {
  const [override] = await loadAgentOverrides(db, { buyerIds: [buyerAccountId], propertyIds: [propertyId] });
  if (override) return override.resident_agent_id;
  if (accountAgentId !== undefined) return accountAgentId;
  const { data } = await db
    .from("buyer_accounts")
    .select("tethered_resident_agent_id")
    .eq("id", buyerAccountId)
    .maybeSingle();
  return (data?.tethered_resident_agent_id as string | null) ?? null;
}

/**
 * Buyer rows with `tethered_resident_agent_id` replaced by each buyer's agent
 * on this property — a drop-in for property-scoped code that read the column.
 */
export async function withPropertyAgents<T extends { id: string; tethered_resident_agent_id?: string | null }>(
  db: Db,
  propertyId: string,
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const overrides = await loadAgentOverrides(db, { buyerIds: rows.map((r) => r.id), propertyIds: [propertyId] });
  if (overrides.length === 0) return rows;
  const byBuyer = new Map(overrides.map((o) => [o.buyer_account_id, o.resident_agent_id]));
  return rows.map((r) => (byBuyer.has(r.id) ? { ...r, tethered_resident_agent_id: byBuyer.get(r.id)! } : r));
}

/**
 * (buyer, property) pairs — live reservations — on which this agent is the
 * buyer's Resident Agent: account-level tethers minus properties overridden to
 * someone else, plus properties overridden to this agent.
 */
export async function agentPropertyPairs(
  db: Db,
  agentId: string,
): Promise<Array<{ buyerAccountId: string; propertyId: string }>> {
  const { data: tethered } = await db.from("buyer_accounts").select("id").eq("tethered_resident_agent_id", agentId);
  const tetheredIds = ((tethered ?? []) as Array<{ id: string }>).map((b) => b.id);
  const assigned = await loadAgentOverrides(db, { agentId });
  const buyerIds = [...new Set([...tetheredIds, ...assigned.map((o) => o.buyer_account_id)])];
  if (buyerIds.length === 0) return [];

  const { data: res } = await db
    .from("pod_reservations")
    .select("buyer_account_id, property_id")
    .in("buyer_account_id", buyerIds)
    .eq("status", "reserved");
  const overrides = await loadAgentOverrides(db, { buyerIds });
  const overrideFor = new Map(overrides.map((o) => [`${o.buyer_account_id}:${o.property_id}`, o.resident_agent_id]));
  const tetheredSet = new Set(tetheredIds);

  const seen = new Set<string>();
  const out: Array<{ buyerAccountId: string; propertyId: string }> = [];
  for (const r of (res ?? []) as Array<{ buyer_account_id: string; property_id: string }>) {
    const key = `${r.buyer_account_id}:${r.property_id}`;
    if (seen.has(key)) continue;
    const override = overrideFor.get(key);
    const mine = override ? override === agentId : tetheredSet.has(r.buyer_account_id);
    if (!mine) continue;
    seen.add(key);
    out.push({ buyerAccountId: r.buyer_account_id, propertyId: r.property_id });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reservation-time dual-agency checkpoint (4th point; see dual-agency.ts)
// ---------------------------------------------------------------------------

export interface ReservationAgentConflict {
  code: "DUAL_AGENCY_CONFLICT";
  conflicting_agent_id: string;
  conflicting_agent_name: string | null;
  referring_agent_id_same: boolean;
}

/**
 * Conflict when the buyer's agent on this property would be the property's
 * own Listing Agent. A buyer who already has a per-property agent here has no
 * conflict (that agent was chosen to resolve it).
 */
export async function reservationAgentConflict(
  db: Db,
  buyer: { id: string; tethered_resident_agent_id: string | null; referring_agent_id?: string | null },
  propertyId: string,
): Promise<ReservationAgentConflict | null> {
  if (!buyer.tethered_resident_agent_id) return null;
  const { data: property } = await db.from("properties").select("listing_agent_id").eq("id", propertyId).maybeSingle();
  const listing = (property?.listing_agent_id as string | null) ?? null;
  if (!listing || listing !== (await effectiveAgentId(db, buyer.id, propertyId, buyer.tethered_resident_agent_id)))
    return null;
  const { data: agent } = await db.from("agents").select("full_name").eq("id", listing).maybeSingle();
  return {
    code: "DUAL_AGENCY_CONFLICT",
    conflicting_agent_id: listing,
    conflicting_agent_name: (agent?.full_name as string | null) ?? null,
    referring_agent_id_same: Boolean(buyer.referring_agent_id) && buyer.referring_agent_id === listing,
  };
}

/** Why an agent can't take this property's buyer, or null when they can. */
export async function replacementAgentProblem(db: Db, agentId: string, listingAgentId: string): Promise<string | null> {
  if (!agentId) return "Choose an agent.";
  if (agentId === listingAgentId) return "That agent holds the listing on this property — choose a different agent.";
  const { data: agent } = await db
    .from("agents")
    .select("id, eo_lapsed, eo_expires_at")
    .eq("id", agentId)
    .maybeSingle();
  if (!agent) return "Agent not found.";
  const { eoBlocksNewWork } = await import("@/lib/eo-expiry");
  if (eoBlocksNewWork(agent as { eo_lapsed?: boolean | null; eo_expires_at?: string | null }))
    return "That agent can't take on new buyers right now — choose a different agent.";
  return null;
}

/**
 * "Let divieight choose": the most-tenured eligible agent, preferring one who
 * covers the buyer's market; never the Listing Agent.
 */
export async function pickReplacementAgent(
  db: Db,
  params: { listingAgentId: string; market: string | null },
): Promise<string | null> {
  const { data: agents } = await db
    .from("agents")
    .select("id, markets, created_at, eo_lapsed, eo_expires_at")
    .order("created_at", { ascending: true });
  const { eoBlocksNewWork } = await import("@/lib/eo-expiry");
  const { parseMarkets, marketCoversArea } = await import("@/lib/markets");
  const eligible = ((agents ?? []) as Array<{ id: string; markets: unknown; eo_lapsed?: boolean | null; eo_expires_at?: string | null }>)
    .filter((a) => a.id !== params.listingAgentId && !eoBlocksNewWork(a));
  const market = (params.market ?? "").trim();
  const local = market ? eligible.find((a) => parseMarkets(a.markets).some((m) => marketCoversArea(m, market))) : undefined;
  return (local ?? eligible[0])?.id ?? null;
}

/** Notices and audit once the reservation is finalized with a per-property agent. */
export async function announcePropertyAgentChange(
  db: Db,
  params: {
    actorId: string;
    buyerAccountId: string;
    propertyId: string;
    reservationId: string;
    replacedAgentId: string;
    newAgentId: string;
    referralPreserved: boolean;
    chosenBy: "buyer" | "platform";
  },
) {
  const { deliver, adminRecipients } = await import("@/lib/authorization.notify.server");
  const { data: property } = await db.from("properties").select("address, city, state").eq("id", params.propertyId).maybeSingle();
  const where = property ? `${property.address}, ${property.city}, ${property.state}` : "a property";
  const { data: agents } = await db
    .from("agents")
    .select("id, auth_user_id, email, full_name")
    .in("id", [params.replacedAgentId, params.newAgentId]);
  const byId = new Map(((agents ?? []) as Array<{ id: string; auth_user_id: string; email: string | null; full_name: string | null }>).map((a) => [a.id, a]));
  const oldAgent = byId.get(params.replacedAgentId);
  const newAgent = byId.get(params.newAgentId);

  // Old agent: information only — no buyer private data.
  if (oldAgent)
    await deliver(db as never, { authUserId: oldAgent.auth_user_id, email: oldAgent.email }, {
      subject: "A buyer needs a different agent for one of your listings",
      message: `One of your buyers reserved a share in ${where}, where you hold the listing, so a different Resident Agent represents them on that property. Your representation on their other properties is unchanged.${params.referralPreserved ? " You keep your referral share on that property." : ""}`,
      link: "/agent/dashboard",
    });
  // New agent: assignment for this one property.
  if (newAgent)
    await deliver(db as never, { authUserId: newAgent.auth_user_id, email: newAgent.email }, {
      subject: "You've been assigned a buyer for one property",
      message: `You are now the Resident Agent for a divieight buyer on ${where}. The buyer's usual agent holds this listing, so you represent them on this property only.`,
      link: "/agent/dashboard",
    });
  for (const admin of await adminRecipients(db as never))
    await deliver(db as never, admin, {
      subject: "Dual-agency conflict resolved at reservation",
      message: `A reservation on ${where} was finalized with a per-property Resident Agent (${newAgent?.full_name ?? params.newAgentId}) because the buyer's agent (${oldAgent?.full_name ?? params.replacedAgentId}) holds the listing.${params.referralPreserved ? " The original agent keeps the referral share." : ""}`,
      link: "/admin/audit-log",
    });

  await db.from("audit_log").insert({
    actor_id: params.actorId,
    actor_type: "buyer",
    action_type: "buyer.property_agent_assigned",
    entity_type: "property",
    entity_id: params.propertyId,
    metadata: {
      buyer_account_id: params.buyerAccountId,
      reservation_id: params.reservationId,
      replaced_agent_id: params.replacedAgentId,
      resident_agent_id: params.newAgentId,
      referral_preserved: params.referralPreserved,
      chosen_by: params.chosenBy,
      reason: "dual_agency_listing_agent",
    },
  });
}
