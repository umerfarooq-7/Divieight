/**
 * "Let divieight choose an agent for me".
 *
 * The buyer asks; an admin picks from the eligible agents; the agent accepts or
 * declines. A decline returns the request to the queue. Two scopes:
 *
 *  - Account (property_id null): assignment goes through the buyer-designation
 *    fields, so the agent's accept/decline, broker rules, referral staging and
 *    notifications are the existing respondToDesignation / applyTether path.
 *  - One property: the buyer's agent holds that listing. Acceptance writes a
 *    property_agent_overrides row; their other properties keep the usual agent.
 *
 * Seller-side counterpart: autoAssignListingAgent + listing_agent_declines.
 */

import { adminRecipients, deliver } from "@/lib/authorization.notify.server";
import { budgetBucketLabel } from "@/lib/budget-buckets";
import { blockedAgentIdsForBuyer } from "@/lib/dual-agency";
import { eoBlocksNewWork } from "@/lib/eo-expiry";
import { marketCoversArea, parseMarkets } from "@/lib/markets";
import { announcePropertyAgentChange } from "@/lib/property-agent.server";

type Db = { from: (t: string) => any };

const DESIGNATION_WINDOW_DAYS = 3;
const MISSING_SCHEMA = "Database is missing agent_assignment_requests — run agent-assignment.sql in Supabase.";

export type AssignmentStatus = "pending" | "assigned" | "accepted" | "cancelled";

export interface AgentAssignmentRequest {
  id: string;
  buyer_account_id: string;
  property_id: string | null;
  status: AssignmentStatus;
  assigned_agent_id: string | null;
  replaced_agent_id: string | null;
  referral_preserved: boolean;
  requested_at: string;
}

export interface EligibleAgent {
  id: string;
  fullName: string;
  markets: string[];
}

export interface AdminAssignmentRow {
  id: string;
  status: AssignmentStatus;
  buyerRef: string;
  budgetBucket: string;
  market: string | null;
  property: { id: string; label: string } | null;
  /** Dual-agency constraint: Listing Agents who can never take this buyer. */
  excludedAgents: string[];
  assignedAgentName: string | null;
  declinedCount: number;
  requestedAt: string;
  eligible: EligibleAgent[];
}

type AgentRow = {
  id: string;
  auth_user_id: string | null;
  email: string | null;
  full_name: string | null;
  markets: unknown;
  onboarding_status: string | null;
  license_verified: boolean | null;
  nar_cert_lapsed: boolean | null;
  relationship_status: string | null;
  transactions_held: boolean | null;
  broker_id: string | null;
  eo_lapsed?: boolean | null;
  eo_expires_at?: string | null;
};
const AGENT_COLS =
  "id, auth_user_id, email, full_name, markets, onboarding_status, license_verified, nar_cert_lapsed, relationship_status, transactions_held, broker_id, eo_lapsed, eo_expires_at, created_at";

type PropertyRow = {
  id: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  listing_agent_id: string | null;
};
const PROPERTY_COLS = "id, address, city, state, zip, listing_agent_id";
const labelOf = (p: PropertyRow) => [p.address, p.city, p.state].filter(Boolean).join(", ");

/** Active, licensed, E&O valid, NAR current, linked to a broker, not on hold. */
export function agentIsActive(a: AgentRow): boolean {
  return (
    a.onboarding_status === "complete" &&
    a.license_verified === true &&
    a.nar_cert_lapsed !== true &&
    a.transactions_held !== true &&
    (a.relationship_status ?? "active") === "active" &&
    Boolean(a.broker_id) &&
    !eoBlocksNewWork(a)
  );
}

function coversBuyerMarket(a: AgentRow, market: string | null): boolean {
  const m = (market ?? "").trim();
  return Boolean(m) && parseMarkets(a.markets).some((x) => marketCoversArea(x, m));
}

/** Resident on the property: its zip's state, or its exact state or city. */
function coversProperty(a: AgentRow, p: PropertyRow): boolean {
  const state = (p.state ?? "").trim().toLowerCase();
  const city = (p.city ?? "").trim().toLowerCase();
  return parseMarkets(a.markets).some((x) => {
    const m = x.trim().toLowerCase();
    return (Boolean(p.zip) && marketCoversArea(m, p.zip!)) || m === state || m === city;
  });
}

export async function openAssignmentRequest(
  db: Db,
  buyerAccountId: string,
  propertyId: string | null,
): Promise<AgentAssignmentRequest | null> {
  let q = db
    .from("agent_assignment_requests")
    .select("*")
    .eq("buyer_account_id", buyerAccountId)
    .in("status", ["pending", "assigned"]);
  q = propertyId ? q.eq("property_id", propertyId) : q.is("property_id", null);
  const { data, error } = await q.limit(1);
  if (error) return null; // before agent-assignment.sql is run there are no requests
  return ((data ?? [])[0] as AgentAssignmentRequest) ?? null;
}

async function agentNameOf(db: Db, agentId: string | null): Promise<string | null> {
  if (!agentId) return null;
  const { data } = await db.from("agents").select("full_name").eq("id", agentId).maybeSingle();
  return (data?.full_name as string | null) ?? null;
}

/** What the buyer sees about an open request. No agent is named until one is assigned. */
export async function assignmentView(db: Db, request: AgentAssignmentRequest | null) {
  if (!request) return null;
  return {
    requestId: request.id,
    status: request.status,
    agentName: request.status === "assigned" ? await agentNameOf(db, request.assigned_agent_id) : null,
  };
}

async function audit(db: Db, actorId: string | null, actorType: string, action: string, buyerId: string, metadata: Record<string, unknown>) {
  await db.from("audit_log").insert({
    actor_id: actorId,
    actor_type: actorType,
    action_type: action,
    entity_type: "buyer_account",
    entity_id: buyerId,
    metadata,
  });
}

async function notifyAdmins(db: Db, subject: string, message: string) {
  for (const admin of await adminRecipients(db as never)) {
    await deliver(db as never, admin, { subject, message, link: "/admin/agent-assignments", type: "agent_assignment" });
  }
}

async function buyerRecipient(db: Db, buyerAccountId: string) {
  const { data } = await db.from("buyer_accounts").select("auth_user_id, email").eq("id", buyerAccountId).maybeSingle();
  return data ? { authUserId: data.auth_user_id as string, email: (data.email as string | null) ?? null } : null;
}

async function propertyFor(db: Db, propertyId: string | null): Promise<PropertyRow | null> {
  if (!propertyId) return null;
  const { data } = await db.from("properties").select(PROPERTY_COLS).eq("id", propertyId).maybeSingle();
  return (data as PropertyRow) ?? null;
}

/** The buyer asks divieight to choose. Idempotent while a request is open. */
export async function requestPlatformAssignment(
  db: Db,
  params: {
    actorId: string;
    buyerAccountId: string;
    propertyId?: string | null;
    replacedAgentId?: string | null;
    referralPreserved?: boolean;
  },
): Promise<AgentAssignmentRequest> {
  const propertyId = params.propertyId ?? null;
  const open = await openAssignmentRequest(db, params.buyerAccountId, propertyId);
  if (open) return open;

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("agent_assignment_requests")
    .insert({
      buyer_account_id: params.buyerAccountId,
      property_id: propertyId,
      status: "pending",
      replaced_agent_id: params.replacedAgentId ?? null,
      referral_preserved: params.referralPreserved ?? false,
      requested_at: now,
    })
    .select("*")
    .maybeSingle();
  if (error || !data) throw new Error(MISSING_SCHEMA);

  if (!propertyId) {
    await db
      .from("buyer_accounts")
      .update({
        agent_selection_mode: "platform_assigned",
        platform_assignment_status: "pending",
        platform_assignment_requested_at: now,
      })
      .eq("id", params.buyerAccountId);
  }
  await audit(db, params.actorId, "buyer", "buyer.agent_platform_assignment_requested", params.buyerAccountId, {
    request_id: data.id,
    property_id: propertyId,
  });
  await notifyAdmins(db, "A buyer asked divieight to choose an agent", "A Buyer Account is waiting for an agent assignment.");
  return data as AgentAssignmentRequest;
}

/** Clear the designation fields an account-level assignment filled in. */
const CLEARED_DESIGNATION = {
  designated_agent_id: null,
  designated_agent_email: null,
  designated_agent_name: null,
  designated_at: null,
  designation_deadline_at: null,
  designation_expired: false,
  tether_status: "pending",
};

/** The buyer goes back to choosing their own agent. */
export async function cancelPlatformAssignment(db: Db, params: { actorId: string; buyerAccountId: string; requestId: string }) {
  const { data } = await db.from("agent_assignment_requests").select("*").eq("id", params.requestId).maybeSingle();
  const request = data as AgentAssignmentRequest | null;
  if (!request || request.buyer_account_id !== params.buyerAccountId) throw new Error("Request not found");
  if (request.status !== "pending" && request.status !== "assigned") return;

  await db
    .from("agent_assignment_requests")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", request.id);
  if (!request.property_id) {
    await db
      .from("buyer_accounts")
      .update({
        agent_selection_mode: "self_selected",
        platform_assignment_status: null,
        platform_assignment_requested_at: null,
        ...(request.status === "assigned" ? CLEARED_DESIGNATION : {}),
      })
      .eq("id", request.buyer_account_id);
  }
  await audit(db, params.actorId, "buyer", "buyer.agent_platform_assignment_cancelled", request.buyer_account_id, {
    request_id: request.id,
    property_id: request.property_id,
  });
}

async function declinedAgentIds(db: Db, requestId: string): Promise<string[]> {
  const { data } = await db.from("agent_assignment_declines").select("agent_id").eq("request_id", requestId);
  return ((data ?? []) as Array<{ agent_id: string }>).map((d) => d.agent_id);
}

/** Listing Agents who can never take this request. */
async function excludedAgentIds(db: Db, request: AgentAssignmentRequest, property: PropertyRow | null): Promise<string[]> {
  const blocked = await blockedAgentIdsForBuyer(db as never, request.buyer_account_id);
  return [...new Set([...blocked, ...(property?.listing_agent_id ? [property.listing_agent_id] : [])])];
}

function eligibleFrom(
  agents: AgentRow[],
  params: { excluded: string[]; declined: string[]; market: string | null; property: PropertyRow | null },
): EligibleAgent[] {
  const out: EligibleAgent[] = [];
  for (const a of agents) {
    if (params.excluded.includes(a.id) || params.declined.includes(a.id)) continue;
    if (!agentIsActive(a)) continue;
    if (!(params.property ? coversProperty(a, params.property) : coversBuyerMarket(a, params.market))) continue;
    out.push({ id: a.id, fullName: a.full_name ?? "Agent", markets: parseMarkets(a.markets) });
  }
  return out;
}

/** The admin queue: open requests with the coarse facts needed to choose. */
export async function listAssignmentQueue(db: Db): Promise<AdminAssignmentRow[]> {
  const { data, error } = await db
    .from("agent_assignment_requests")
    .select("*")
    .in("status", ["pending", "assigned"])
    .order("requested_at", { ascending: true });
  if (error) throw new Error(MISSING_SCHEMA);
  const requests = (data ?? []) as AgentAssignmentRequest[];
  if (requests.length === 0) return [];

  const { data: agentRows } = await db.from("agents").select(AGENT_COLS).order("created_at", { ascending: true });
  const agents = (agentRows ?? []) as AgentRow[];
  const nameOf = (id: string | null) => agents.find((a) => a.id === id)?.full_name ?? null;

  const rows: AdminAssignmentRow[] = [];
  for (const request of requests) {
    const { data: buyer } = await db
      .from("buyer_accounts")
      .select("primary_target_market, target_budget_bucket, target_budget")
      .eq("id", request.buyer_account_id)
      .maybeSingle();
    const property = await propertyFor(db, request.property_id);
    const market = (buyer?.primary_target_market as string | null) ?? null;
    const excluded = await excludedAgentIds(db, request, property);
    const declined = await declinedAgentIds(db, request.id);
    rows.push({
      id: request.id,
      status: request.status,
      buyerRef: `Buyer Account ${request.buyer_account_id.slice(0, 8)}`,
      // Coarse bucket only — never the amount.
      budgetBucket: budgetBucketLabel(buyer?.target_budget_bucket, buyer?.target_budget),
      market,
      property: property ? { id: property.id, label: labelOf(property) } : null,
      excludedAgents: excluded.map((id) => nameOf(id) ?? id),
      assignedAgentName: nameOf(request.assigned_agent_id),
      declinedCount: declined.length,
      requestedAt: request.requested_at,
      eligible: eligibleFrom(agents, { excluded, declined, market, property }),
    });
  }
  return rows;
}

/** Admin picks an agent; the eligibility rules are re-checked here. */
export async function assignAgent(db: Db, params: { actorId: string; requestId: string; agentId: string }) {
  const { data } = await db.from("agent_assignment_requests").select("*").eq("id", params.requestId).maybeSingle();
  const request = data as AgentAssignmentRequest | null;
  if (!request) throw new Error("Request not found");
  if (request.status !== "pending") throw new Error("This request is no longer waiting for an assignment.");

  const { data: buyer } = await db
    .from("buyer_accounts")
    .select("id, primary_target_market, tether_status")
    .eq("id", request.buyer_account_id)
    .maybeSingle();
  if (!buyer) throw new Error("Buyer account not found");
  if (!request.property_id && buyer.tether_status === "tethered") throw new Error("This buyer already has an agent.");

  const property = await propertyFor(db, request.property_id);
  const { data: agentRow } = await db.from("agents").select(AGENT_COLS).eq("id", params.agentId).maybeSingle();
  const agent = agentRow as AgentRow | null;
  if (!agent) throw new Error("Agent not found");
  const excluded = await excludedAgentIds(db, request, property);
  if (excluded.includes(agent.id)) throw new Error("This agent holds a listing in this buyer's pod and can't represent them.");
  const eligible = eligibleFrom([agent], {
    excluded,
    declined: await declinedAgentIds(db, request.id),
    market: (buyer.primary_target_market as string | null) ?? null,
    property,
  });
  if (eligible.length === 0) throw new Error("This agent isn't eligible for this request.");

  const now = new Date();
  await db
    .from("agent_assignment_requests")
    .update({
      status: "assigned",
      assigned_agent_id: agent.id,
      assigned_by: params.actorId,
      assigned_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", request.id);

  if (!request.property_id) {
    // Same fields designateAgent sets: the agent answers through the existing
    // designation accept/decline, which runs the existing tether function.
    await db
      .from("buyer_accounts")
      .update({
        designated_agent_id: agent.id,
        designated_agent_email: agent.email ? agent.email.trim().toLowerCase() : null,
        designated_agent_name: agent.full_name,
        designated_at: now.toISOString(),
        designation_deadline_at: new Date(now.getTime() + DESIGNATION_WINDOW_DAYS * 864e5).toISOString(),
        designation_expired: false,
        tether_status: "awaiting_designation",
        platform_assignment_status: "assigned",
      })
      .eq("id", request.buyer_account_id);
  }

  const where = property ? ` on ${labelOf(property)}` : "";
  if (agent.auth_user_id) {
    await db.from("notifications").insert({
      seller_id: agent.auth_user_id,
      message: `divieight assigned you as Resident Agent for a buyer${where} — accept or decline.`,
      type: "designation",
    });
  }
  const recipient = await buyerRecipient(db, request.buyer_account_id);
  if (recipient) {
    await deliver(db as never, recipient, {
      subject: "divieight assigned your agent",
      message: `divieight assigned ${agent.full_name ?? "an agent"} as your agent${where}. We'll confirm as soon as they accept.`,
      link: property ? `/reserve/${property.id}` : "/buyer/dashboard",
      type: "agent_assignment",
    });
  }
  await audit(db, params.actorId, "admin", "buyer.agent_platform_assigned", request.buyer_account_id, {
    request_id: request.id,
    property_id: request.property_id,
    agent_id: agent.id,
    assigned_by: "platform",
  });
}

/** The agent declined (or let the window lapse): back to the queue, never re-offered to them. */
async function returnToPending(db: Db, request: AgentAssignmentRequest, params: { actorId: string | null; reason: "declined" | "expired" }) {
  const agentId = request.assigned_agent_id;
  if (agentId) await db.from("agent_assignment_declines").insert({ request_id: request.id, agent_id: agentId });
  const now = new Date().toISOString();
  await db
    .from("agent_assignment_requests")
    .update({ status: "pending", assigned_agent_id: null, assigned_at: null, assigned_by: null, responded_at: now, updated_at: now })
    .eq("id", request.id);
  if (!request.property_id) {
    await db
      .from("buyer_accounts")
      .update({ ...CLEARED_DESIGNATION, platform_assignment_status: "pending" })
      .eq("id", request.buyer_account_id);
  }
  const recipient = await buyerRecipient(db, request.buyer_account_id);
  if (recipient) {
    await deliver(db as never, recipient, {
      subject: "We're finding you another agent",
      message: "The agent divieight assigned isn't available, so we're choosing another. You don't need to do anything.",
      link: "/buyer/dashboard",
      type: "agent_assignment",
    });
  }
  await notifyAdmins(db, "An assigned agent didn't take a buyer", "An agent assignment is back in the queue and needs a new agent.");
  await audit(db, params.actorId, params.actorId ? "agent" : "system", "buyer.agent_platform_assignment_returned", request.buyer_account_id, {
    request_id: request.id,
    property_id: request.property_id,
    agent_id: agentId,
    reason: params.reason,
  });
}

/**
 * Hook for the existing designation decline/expiry. Returns true when this
 * designation came from divieight (and has gone back to the queue); false means
 * a self-selected designation, which keeps its existing behaviour.
 */
export async function platformDesignationEnded(
  db: Db,
  params: { buyerAccountId: string; actorId: string | null; reason: "declined" | "expired" },
): Promise<boolean> {
  const request = await openAssignmentRequest(db, params.buyerAccountId, null);
  if (!request || request.status !== "assigned") return false;
  await returnToPending(db, request, { actorId: params.actorId, reason: params.reason });
  return true;
}

/** Hook for the existing designation accept: the tether is in place. */
export async function platformDesignationAccepted(db: Db, buyerAccountId: string) {
  const request = await openAssignmentRequest(db, buyerAccountId, null);
  if (!request || request.status !== "assigned") return;
  const now = new Date().toISOString();
  await db
    .from("agent_assignment_requests")
    .update({ status: "accepted", responded_at: now, updated_at: now })
    .eq("id", request.id);
}

/** Property-scoped offers waiting on this agent. */
export async function listPropertyOffers(db: Db, agentId: string) {
  const { data, error } = await db
    .from("agent_assignment_requests")
    .select("*")
    .eq("assigned_agent_id", agentId)
    .eq("status", "assigned");
  if (error) return [];
  const out: Array<{ requestId: string; propertyLabel: string }> = [];
  for (const r of (data ?? []) as AgentAssignmentRequest[]) {
    if (!r.property_id) continue; // account-level offers appear as designation requests
    const property = await propertyFor(db, r.property_id);
    out.push({ requestId: r.id, propertyLabel: property ? labelOf(property) : "A property" });
  }
  return out;
}

/** The agent answers a property-scoped offer. Acceptance creates the per-property agent. */
export async function respondToPropertyOffer(
  db: Db,
  params: { actorId: string; agentId: string; requestId: string; accept: boolean },
): Promise<{ error?: string }> {
  const { data } = await db.from("agent_assignment_requests").select("*").eq("id", params.requestId).maybeSingle();
  const request = data as AgentAssignmentRequest | null;
  if (!request || !request.property_id || request.status !== "assigned" || request.assigned_agent_id !== params.agentId)
    return { error: "This assignment is no longer available." };

  if (!params.accept) {
    await returnToPending(db, request, { actorId: params.actorId, reason: "declined" });
    return {};
  }

  const { data: agentRow } = await db.from("agents").select(AGENT_COLS).eq("id", params.agentId).maybeSingle();
  const agent = agentRow as AgentRow | null;
  if (!agent || !agentIsActive(agent)) return { error: "Your account can't take on new buyers right now." };
  const property = await propertyFor(db, request.property_id);
  if (property?.listing_agent_id === params.agentId)
    return { error: "You hold the listing on this property and cannot also represent a buyer in its pod." };

  const override = {
    resident_agent_id: params.agentId,
    replaced_agent_id: request.replaced_agent_id,
    referral_preserved: request.referral_preserved,
    created_by: params.actorId,
  };
  const { data: existing } = await db
    .from("property_agent_overrides")
    .select("id")
    .eq("buyer_account_id", request.buyer_account_id)
    .eq("property_id", request.property_id)
    .maybeSingle();
  const { error } = existing
    ? await db.from("property_agent_overrides").update(override).eq("id", existing.id)
    : await db
        .from("property_agent_overrides")
        .insert({ buyer_account_id: request.buyer_account_id, property_id: request.property_id, ...override });
  if (error) return { error: error.message };

  const now = new Date().toISOString();
  await db
    .from("agent_assignment_requests")
    .update({ status: "accepted", responded_at: now, updated_at: now })
    .eq("id", request.id);

  const recipient = await buyerRecipient(db, request.buyer_account_id);
  if (recipient) {
    await deliver(db as never, recipient, {
      subject: "Your agent for this property is confirmed",
      message: `${agent.full_name ?? "Your agent"} is your agent for ${property ? labelOf(property) : "this property"}. You can now finish your reservation.${request.referral_preserved ? " Your original agent keeps their referral share." : ""}`,
      link: `/reserve/${request.property_id}`,
      type: "agent_assignment",
    });
  }
  if (request.replaced_agent_id) {
    await announcePropertyAgentChange(db, {
      actorId: params.actorId,
      buyerAccountId: request.buyer_account_id,
      propertyId: request.property_id,
      reservationId: null,
      replacedAgentId: request.replaced_agent_id,
      newAgentId: params.agentId,
      referralPreserved: request.referral_preserved,
      chosenBy: "platform",
    });
  }
  return {};
}
