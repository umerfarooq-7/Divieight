import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parseMarkets, marketCoversArea } from "@/lib/markets";
import { BUDGET_BUCKETS, bucketById, bucketForAmount } from "@/lib/budget-buckets";

/**
 * Agent Pool View — read-only aggregate of what is forming in the markets an
 * agent is licensed and active in.
 *
 * PRIVACY BOUNDARY: this module may never return an individual buyer's name,
 * email, phone, identity, vetting detail, financial capacity, priority rank,
 * or any other KYO Record element. Only counts, unioned budget buckets,
 * aggregate intent tallies, zip codes, and share availability leave here.
 * An agent's own tethered buyers are shown in full ONLY through the existing
 * Verified Lead Dashboard (`agent-leads.functions.ts`), never here.
 *
 * UNTETHERED BUYERS: the count of buyers without a tethered Resident Agent is
 * deliberately NOT computed or returned. That figure is admin-only.
 *
 * NO TETHERING PATHWAY: viewing (or not viewing) this page has ZERO effect on
 * Module 7 Selection Logic. Nothing in this module writes to buyer_accounts,
 * records interest, or feeds any selection input — Selection Logic remains
 * purely tenure + market + dual-agency based. There are intentionally no
 * flag / favorite / request actions anywhere in this surface.
 */

export interface PoolProperty {
  propertyId: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  listingStatus: string;
  /** From the Eight-Slices Tracker: shares still unreserved. */
  remainingShares: number;
}

export interface PoolRosterAgent {
  agentId: string;
  fullName: string;
  brokerageName: string | null;
  brokerOfRecord: string | null;
  contactEmail: string | null;
  isMe: boolean;
}

export interface AgentPool {
  market: string;
  /** Verified Buyer Accounts (Digital Key issued) targeting this market. */
  verifiedBuyerCount: number;
  /** Union of the budget buckets present — never a recomputed range. */
  budgetBucketLabels: string[];
  budgetRangeLabel: string;
  intentPersonalUse: number;
  intentShortTermRental: number;
  zipCodes: string[];
  /** Properties in this market the pool has begun converging on. */
  properties: PoolProperty[];
  /** How many of the agent's own tethered buyers sit in this pool. */
  myBuyerCount: number;
  roster: PoolRosterAgent[];
}

type Db = { from: (t: string) => any };

function zipsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

/** Union of the buckets actually present — the extremes of what exists, nothing new. */
function unionLabel(bucketIds: Set<string>): string {
  const present = BUDGET_BUCKETS.filter((b) => bucketIds.has(b.id));
  if (present.length === 0) return "Not provided";
  if (present.length === 1) return present[0]!.label;
  const first = present[0]!;
  const last = present[present.length - 1]!;
  return last.max === null
    ? `$${Math.round(first.min / 1000)}K+`
    : `$${Math.round(first.min / 1000)}K–${Math.round(last.max / 1000)}K`;
}

export const listAgentPools = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AgentPool[]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
    const db = supabaseAdmin as unknown as Db;

    const { data: agent } = await db
      .from("agents")
      .select("id, markets")
      .eq("auth_user_id", context.userId)
      .maybeSingle();
    if (!agent) return [];

    const myMarkets = parseMarkets(agent.markets);
    if (myMarkets.length === 0) return [];

    // Verified buyers only — the pool is what has actually qualified.
    const { data: buyers } = await db
      .from("buyer_accounts")
      .select(
        "id, intent, primary_target_market, target_zip_codes, target_budget, target_budget_bucket, tethered_resident_agent_id",
      )
      .eq("golden_ticket_issued", true);

    const relevant = (buyers ?? []).filter((b: any) => {
      const market = (b.primary_target_market ?? "").trim();
      return market && myMarkets.some((m) => marketCoversArea(m, market));
    });
    if (relevant.length === 0) return [];

    // Group by the agent's OWN market label so pools read the way the agent
    // registered them, not the way each buyer typed their market.
    const groups = new Map<string, any[]>();
    for (const b of relevant) {
      const market = (b.primary_target_market ?? "").trim();
      const label = myMarkets.find((m) => marketCoversArea(m, market)) ?? market;
      const list = groups.get(label) ?? [];
      list.push(b);
      groups.set(label, list);
    }

    const pools: AgentPool[] = [];

    for (const [market, members] of groups) {
      const bucketIds = new Set<string>();
      const zips = new Set<string>();
      let personal = 0;
      let rental = 0;
      let mine = 0;
      const tetheredAgentIds = new Set<string>();

      for (const b of members) {
        const bucket = bucketById(b.target_budget_bucket) ?? bucketForAmount(b.target_budget);
        if (bucket) bucketIds.add(bucket.id);
        for (const z of zipsOf(b.target_zip_codes)) zips.add(z);
        if (b.intent === "short_term_rental") rental += 1;
        else if (b.intent === "long_term") personal += 1;
        if (b.tethered_resident_agent_id) {
          tetheredAgentIds.add(b.tethered_resident_agent_id);
          if (b.tethered_resident_agent_id === agent.id) mine += 1;
        }
        // Untethered buyers are counted into nothing — see PRIVACY BOUNDARY.
      }

      // Roster: which agents are active in this pool. No buyer linkage, no
      // per-agent buyer counts — that would leak pod composition.
      let roster: PoolRosterAgent[] = [];
      if (tetheredAgentIds.size > 0) {
        const { data: agents } = await db
          .from("agents")
          .select("id, full_name, email, broker_id")
          .in("id", [...tetheredAgentIds]);
        const brokerIds = (agents ?? []).map((a: any) => a.broker_id).filter(Boolean);
        const brokers = new Map<string, { brokerage: string | null; contact: string | null }>();
        if (brokerIds.length) {
          const { data: rows } = await db
            .from("brokers")
            .select("id, brokerage_name, contact_name")
            .in("id", brokerIds);
          for (const r of rows ?? [])
            brokers.set(r.id, { brokerage: r.brokerage_name ?? null, contact: r.contact_name ?? null });
        }
        roster = (agents ?? [])
          .map((a: any) => ({
            agentId: a.id,
            fullName: a.full_name,
            brokerageName: a.broker_id ? (brokers.get(a.broker_id)?.brokerage ?? null) : null,
            brokerOfRecord: a.broker_id ? (brokers.get(a.broker_id)?.contact ?? null) : null,
            contactEmail: a.email ?? null,
            isMe: a.id === agent.id,
          }))
          .sort((x: PoolRosterAgent, y: PoolRosterAgent) => x.fullName.localeCompare(y.fullName));
      }

      // Convergence: properties in this market carrying live reservations.
      const properties: PoolProperty[] = [];
      const { data: props } = await db
        .from("properties")
        .select("id, address, city, state, zip, listing_status, exit_type, retained_shares")
        .eq("status", "listed");

      for (const p of props ?? []) {
        const label = `${p.city ?? ""} ${p.state ?? ""} ${p.zip ?? ""}`.trim();
        if (!marketCoversArea(market, label) && !marketCoversArea(market, p.city ?? "")) continue;
        const { data: res } = await db
          .from("pod_reservations")
          .select("shares_reserved")
          .eq("property_id", p.id)
          .eq("status", "reserved");
        const reserved = (res ?? []).reduce(
          (sum: number, r: any) => sum + (r.shares_reserved ?? 0),
          0,
        );
        if (reserved <= 0) continue; // not converging yet
        const retained = p.exit_type === "hybrid_exit" ? (p.retained_shares ?? 0) : 0;
        properties.push({
          propertyId: p.id,
          address: p.address ?? "—",
          city: p.city ?? "",
          state: p.state ?? "",
          zip: p.zip ?? "",
          listingStatus: p.listing_status ?? "",
          remainingShares: Math.max(0, 8 - retained - reserved),
        });
      }

      pools.push({
        market,
        verifiedBuyerCount: members.length,
        budgetBucketLabels: BUDGET_BUCKETS.filter((b) => bucketIds.has(b.id)).map((b) => b.label),
        budgetRangeLabel: unionLabel(bucketIds),
        intentPersonalUse: personal,
        intentShortTermRental: rental,
        zipCodes: [...zips].sort(),
        properties,
        myBuyerCount: mine,
        roster,
      });
    }

    return pools.sort((a, b) => a.market.localeCompare(b.market));
  });
