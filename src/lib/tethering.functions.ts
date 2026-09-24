import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isResidentInMarket, marketMatches as marketsMatch } from "@/lib/markets";

/**
 * Resident Agent Selection Logic.
 *
 * Runs the moment a Buyer Account earns Golden Ticket status:
 *   1. read the buyer's primary_target_market (zip / market string)
 *   2. find agents whose `markets` array covers that market — "Resident" is
 *      derived here per transaction, never stored on the agent
 *   3. tether the most-tenured one (earliest created_at)
 *   4. if the buyer arrived through an agent referral, stage a Standard NAR
 *      Referral Agreement placeholder for later generation
 *   5. otherwise flag the Resident Agent for the full buyer-side commission
 *
 * Two paths short-circuit the automatic pick:
 *   - the buyer named their own agent (tether_status 'awaiting_designation')
 *   - the referring agent is a Resident Agent covering the buyer's market, who
 *     must first elect between taking the tether or Refer-Only
 *
 * Compensation note: every path here only decides how the buyer-side
 * commission cascade is split at closing (paid by title/escrow from sale
 * proceeds). The Platform never pays an agent or broker anything.
 *
 * Runs with the service role because a buyer cannot read the agents table and
 * cannot write notifications addressed to an agent's user id.
 */

export type TetherStatus = "pending" | "tethered" | "awaiting_designation";

export interface TetherResult {
  status: TetherStatus;
  residentAgentId: string | null;
  referralAgreementCreated: boolean;
  fullCommission: boolean;
  /** True when a Resident Agent referrer still owes a Refer-Only election. */
  awaitingReferOnlyElection?: boolean;
  /** True when the pick was refused because that agent holds the listing. */
  dualAgencyBlocked?: boolean;

}

/** Loose market match: exact zip, or either string containing the other. */
export const marketMatches = marketsMatch;

type Db = { from: (t: string) => any };

const IDLE: TetherResult = {
  status: "pending",
  residentAgentId: null,
  referralAgreementCreated: false,
  fullCommission: false,
};

export async function notifyAgentUser(db: Db, authUserId: string | null, message: string, type: string) {
  if (!authUserId) return;
  await db.from("notifications").insert({ seller_id: authUserId, message, type });
}

/**
 * Most-tenured agent who is Resident on this market — derived by checking the
 * buyer's market against each agent's `markets` array.
 */
async function pickResidentAgent(
  db: Db,
  market: string,
  excludeAgentId?: string | null,
  blockedAgentIds: string[] = [],
) {
  const { data: agents } = await db
    .from("agents")
    .select("id, auth_user_id, full_name, markets, created_at")
    .order("created_at", { ascending: true });

  if (!market) return undefined;
  return (agents ?? []).find(
    (a: any) =>
      a.id !== excludeAgentId &&
      !blockedAgentIds.includes(a.id) &&
      isResidentInMarket(a.markets, market),
  );
}


/**
 * Shared tether writer used by the automatic pick, the buyer-designated agent
 * acceptance, and the Refer-Only reassignment.
 */
export async function applyTether(
  db: Db,
  params: {
    buyer: any;
    agent: any;
    actorId: string;
    referringAgentId?: string | null;
    referringAgentRole?: "non_resident" | "resident" | null;
    market: string;
    source: "auto" | "designated" | "refer_only";
  },
): Promise<TetherResult> {
  const { buyer, agent, actorId, referringAgentId, referringAgentRole, market, source } = params;

  // Dual-agency rule: a Listing Agent can never be tethered inside that
  // property's pod. Flat check, no exceptions.
  const { listingAgentConflict, logDualAgency } = await import("@/lib/dual-agency");
  const conflict = await listingAgentConflict(db as any, agent.id, buyer.id);
  if (conflict.conflict) {
    await logDualAgency(db as any, {
      actorId,
      point: "tethering",
      agentId: agent.id,
      propertyId: conflict.propertyId,
      buyerAccountId: buyer.id,
      resolution: `tether blocked (${source})`,
    });
    return { ...IDLE, dualAgencyBlocked: true };
  }

  const stageAgreement = Boolean(referringAgentId) && referringAgentId !== agent.id;
  const fullCommission = !stageAgreement;
  const now = new Date().toISOString();


  await db
    .from("buyer_accounts")
    .update({
      tethered_resident_agent_id: agent.id,
      tether_status: "tethered",
      tethered_at: now,
      resident_agent_full_commission: fullCommission,
    })
    .eq("id", buyer.id);

  let referralAgreementCreated = false;
  if (stageAgreement) {
    const { data: pendingRow, error } = await db
      .from("pending_referral_agreements")
      .insert({
        buyer_account_id: buyer.id,
        non_resident_agent_id: referringAgentId,
        resident_agent_id: agent.id,
        referring_agent_role: referringAgentRole ?? "non_resident",
        status: "pending_generation",
      })
      .select("id")
      .maybeSingle();
    referralAgreementCreated = !error;
    // Generate the Standard NAR Referral Agreement immediately so both agents
    // can sign it; failures here must not roll back the tethering itself.
    if (pendingRow?.id) {
      try {
        const { generateReferralAgreement } = await import("@/lib/nar-referral.functions");
        await generateReferralAgreement(db, pendingRow.id, actorId);
      } catch (e) {
        console.error("[tethering] referral agreement generation failed", e);
      }
    }
  }


  await notifyAgentUser(db, agent.auth_user_id, "You've been tethered to a new buyer.", "tethering");

  await db.from("audit_log").insert({
    actor_id: actorId,
    actor_type: (actorId ? "buyer" : "system"),
    action_type: "buyer.resident_agent_tethered",
    entity_type: "buyer_account",
    entity_id: buyer.id,
    metadata: {
      resident_agent_id: agent.id,
      market,
      source,
      referring_agent_id: referringAgentId ?? null,
      referring_agent_role: referringAgentRole ?? null,
      referral_agreement: referralAgreementCreated,
      full_buyer_side_commission: fullCommission,
    },
  });

  return {
    status: "tethered",
    residentAgentId: agent.id,
    referralAgreementCreated,
    fullCommission,
  };
}

export async function loadBuyerForTether(db: Db, buyerAccountId: string) {
  const { data } = await db
    .from("buyer_accounts")
    .select(
      "id, auth_user_id, primary_target_market, referring_agent_id, golden_ticket_issued, tether_status, tethered_resident_agent_id, designated_agent_id, designated_agent_email",
    )
    .eq("id", buyerAccountId)
    .maybeSingle();
  return data;
}

/**
 * Core selection routine. `ignoreDesignation` is used by "Accept Platform
 * Assignment", where the buyer explicitly abandons their named agent.
 */
export async function runTethering(
  db: Db,
  buyerAccountId: string,
  actorId: string,
  opts: { ignoreDesignation?: boolean } = {},
): Promise<TetherResult> {
  const buyer = await loadBuyerForTether(db, buyerAccountId);
  if (!buyer || !buyer.golden_ticket_issued) return IDLE;

  if (buyer.tether_status === "tethered" && buyer.tethered_resident_agent_id) {
    return { ...IDLE, status: "tethered", residentAgentId: buyer.tethered_resident_agent_id };
  }

  // The buyer named their own agent — wait for that agent's acceptance.
  if (!opts.ignoreDesignation && buyer.tether_status === "awaiting_designation") {
    return { ...IDLE, status: "awaiting_designation" };
  }

  const market = (buyer.primary_target_market ?? "").trim();

  // Referral context.
  let referrer: any = null;
  if (buyer.referring_agent_id) {
    const { data } = await db
      .from("agents")
      .select("id, auth_user_id, full_name, markets, created_at")
      .eq("id", buyer.referring_agent_id)
      .maybeSingle();
    referrer = data ?? null;
  }

  let excludeAgentId: string | null = null;
  let referringAgentId: string | null = null;
  let referringAgentRole: "non_resident" | "resident" | null = null;

  // Dual-agency: agents holding the listing on a property in this buyer's pod
  // are never eligible for the tether.
  const { blockedAgentIdsForBuyer, logDualAgency } = await import("@/lib/dual-agency");
  const blockedAgentIds = await blockedAgentIdsForBuyer(db as any, buyer.id);

  // Residency is derived here, for this buyer's market only.
  const referrerIsResident = referrer ? isResidentInMarket(referrer.markets, market) : false;
  const referrerBlocked = Boolean(referrer && blockedAgentIds.includes(referrer.id));
  if (referrer && referrerBlocked) {
    // They keep the 25% referral share, but can never hold the tether.
    await logDualAgency(db as any, {
      actorId,
      point: "tethering",
      agentId: referrer.id,
      propertyId: null,
      buyerAccountId: buyer.id,
      resolution: "referring agent holds the listing — skipped, referral share preserved",
    });
    excludeAgentId = referrer.id;
    referringAgentId = referrer.id;
    referringAgentRole = referrerIsResident ? "resident" : "non_resident";
  } else if (referrer && !referrerIsResident) {
    referringAgentId = referrer.id;
    referringAgentRole = "non_resident";
  } else if (referrer && referrerIsResident) {

    // Refer-Only Election: this agent would normally be auto-tethered.
    const { data: election } = await db
      .from("refer_only_elections")
      .select("id, status")
      .eq("buyer_account_id", buyer.id)
      .eq("referring_agent_id", referrer.id)
      .maybeSingle();

    if (!election) {
      await db.from("refer_only_elections").insert({
        buyer_account_id: buyer.id,
        referring_agent_id: referrer.id,
        status: "pending",
      });
      await notifyAgentUser(
        db,
        referrer.auth_user_id,
        "Action required: a buyer you referred is now vetted — accept tethering or elect Refer-Only.",
        "refer_only_election",
      );
      return { ...IDLE, awaitingReferOnlyElection: true };
    }

    if (election.status === "pending") {
      return { ...IDLE, awaitingReferOnlyElection: true };
    }

    if (election.status === "accepted_tether") {
      return applyTether(db, {
        buyer,
        agent: referrer,
        actorId,
        referringAgentId: null,
        referringAgentRole: null,
        market,
        source: "auto",
      });
    }

    // refer_only — find a DIFFERENT Resident Agent and stage the agreement.
    excludeAgentId = referrer.id;
    referringAgentId = referrer.id;
    referringAgentRole = "resident";
  }

  const match = await pickResidentAgent(db, market, excludeAgentId, blockedAgentIds);
  if (!match) {
    await db
      .from("buyer_accounts")
      .update({ tether_status: "awaiting_designation" })
      .eq("id", buyer.id);
    return { ...IDLE, status: "awaiting_designation" };
  }

  return applyTether(db, {
    buyer,
    agent: match,
    actorId,
    referringAgentId,
    referringAgentRole,
    market,
    source: referringAgentRole === "resident" ? "refer_only" : "auto",
  });
}

export const tetherResidentAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { buyerAccountId: string }) => input)
  .handler(async ({ data, context }): Promise<TetherResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
    return runTethering(supabaseAdmin as unknown as Db, data.buyerAccountId, context.userId);
  });
