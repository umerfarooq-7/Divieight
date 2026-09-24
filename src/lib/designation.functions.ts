import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { applyTether, loadBuyerForTether, notifyAgentUser, runTethering } from "@/lib/tethering.functions";
import { residencyFor } from "@/lib/markets";

/**
 * Buyer-Designated Agent flow + Refer-Only Election.
 *
 * Compensation scope: a referring agent's only compensation in any of these
 * paths is their share of the buyer-side commission cascade at closing (25%
 * referral split, or the full amount when they are the tethered agent), paid
 * by the title/escrow company from sale proceeds. The Platform pays nothing.
 */

type Db = { from: (t: string) => any };

/** 3 calendar days to accept a designation (Prompt 4 ethics acknowledgment). */
export const DESIGNATION_WINDOW_DAYS = 3;

export interface AgentSearchResult {
  id: string;
  full_name: string;
  email: string | null;
  markets: string[] | null;
}

export interface DesignationState {
  tetherStatus: "pending" | "tethered" | "awaiting_designation";
  designatedAgentId: string | null;
  designatedAgentName: string | null;
  designatedAgentEmail: string | null;
  designationDeadlineAt: string | null;
  designationExpired: boolean;
  tetheredAgentName: string | null;
}

export interface DesignationRequest {
  buyerAccountId: string;
  buyerEmail: string | null;
  market: string | null;
  designatedAt: string | null;
  deadlineAt: string | null;
}

export interface ReferOnlyElection {
  id: string;
  buyerAccountId: string;
  buyerEmail: string | null;
  market: string | null;
  createdAt: string;
}

async function admin(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function buyerAccountFor(db: Db, userId: string, buyerAccountId: string) {
  const { data } = await db
    .from("buyer_accounts")
    .select("*")
    .eq("id", buyerAccountId)
    .eq("auth_user_id", userId)
    .maybeSingle();
  return data;
}

async function agentFor(db: Db, userId: string) {
  const { data } = await db
    .from("agents")
    .select("id, auth_user_id, full_name, email, markets, created_at, eo_lapsed, eo_expires_at")
    .eq("auth_user_id", userId)
    .maybeSingle();
  return data;
}

async function sendInviteEmail(to: string, name: string | null, origin: string) {
  const key = process.env['RESEND_API_KEY'];
  if (!key) return;
  const { resendFrom, supportFooter } = await import("@/lib/email-sender");
  const body = `${name ? `Hi ${name},` : "Hello,"}

A vetted buyer on divieight has designated you as their agent.

Create your Professional Portal account to accept the tethering invitation:
${origin}/agent/register

You have ${DESIGNATION_WINDOW_DAYS} calendar days to accept before the buyer may name another agent or accept a platform assignment.

Compensation for representing this buyer is the buyer-side commission paid at closing by the title/escrow company from sale proceeds, through your Broker of Record. divieight does not pay agents directly.${supportFooter(origin)}`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: resendFrom(),
        to,
        subject: "A divieight buyer has designated you as their agent",
        text: body,
      }),
    });
  } catch (e) {
    console.error("[designation] invite email failed", e);
  }
}

/* ------------------------------------------------------------------ */
/* Buyer side                                                          */
/* ------------------------------------------------------------------ */

export const searchAgents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { query: string }) => input)
  .handler(async ({ data }): Promise<AgentSearchResult[]> => {
    const q = data.query.trim();
    if (q.length < 2) return [];
    const db = await admin();
    const { data: rows } = await db
      .from("agents")
      .select("id, full_name, email, markets")
      .or(`full_name.ilike.%${q}%,email.ilike.%${q}%`)
      .limit(10);
    return (rows ?? []) as AgentSearchResult[];
  });

export const getDesignationState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { buyerAccountId: string }) => input)
  .handler(async ({ data, context }): Promise<DesignationState | null> => {
    const db = await admin();
    const buyer = await buyerAccountFor(db, context.userId, data.buyerAccountId);
    if (!buyer) return null;

    let tetheredAgentName: string | null = null;
    if (buyer.tethered_resident_agent_id) {
      const { data: a } = await db
        .from("agents")
        .select("full_name")
        .eq("id", buyer.tethered_resident_agent_id)
        .maybeSingle();
      tetheredAgentName = a?.full_name ?? null;
    }

    return {
      tetherStatus: buyer.tether_status ?? "pending",
      designatedAgentId: buyer.designated_agent_id ?? null,
      designatedAgentName: buyer.designated_agent_name ?? null,
      designatedAgentEmail: buyer.designated_agent_email ?? null,
      designationDeadlineAt: buyer.designation_deadline_at ?? null,
      designationExpired: Boolean(buyer.designation_expired),
      tetheredAgentName,
    };
  });

export const designateAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      buyerAccountId: string;
      agentId?: string | null;
      email?: string | null;
      name?: string | null;
      origin: string;
    }) => input,
  )
  .handler(async ({ data, context }): Promise<{ error?: string; invited?: boolean }> => {
    const db = await admin();
    const buyer = await buyerAccountFor(db, context.userId, data.buyerAccountId);
    if (!buyer) return { error: "Buyer account not found." };
    if (buyer.tether_status === "tethered") {
      return { error: "You are already tethered to an agent." };
    }

    let agent: any = null;
    if (data.agentId) {
      const { data: row } = await db
        .from("agents")
        .select("id, auth_user_id, full_name, email")
        .eq("id", data.agentId)
        .maybeSingle();
      agent = row ?? null;
      if (!agent) return { error: "That agent could not be found." };
    }

    const email = (agent?.email ?? data.email ?? "").trim().toLowerCase();
    if (!agent && !email) return { error: "Enter the agent's email address." };

    const now = new Date();
    const deadline = new Date(now.getTime() + DESIGNATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    await db
      .from("buyer_accounts")
      .update({
        designated_agent_id: agent?.id ?? null,
        designated_agent_email: email || null,
        designated_agent_name: agent?.full_name ?? data.name ?? null,
        designated_at: now.toISOString(),
        designation_deadline_at: deadline.toISOString(),
        designation_expired: false,
        tether_status: "awaiting_designation",
      })
      .eq("id", buyer.id);

    let invited = false;
    if (agent) {
      await notifyAgentUser(
        db,
        agent.auth_user_id,
        "A buyer has designated you as their agent — accept or decline within 3 days.",
        "designation",
      );
    } else {
      await db.from("agent_invitations").insert({
        invited_email: email,
        invited_name: data.name ?? null,
        invited_by_buyer_account_id: buyer.id,
        status: "pending",
      });
      await sendInviteEmail(email, data.name ?? null, data.origin);
      invited = true;
    }

    await db.from("audit_log").insert({
      actor_id: context.userId,
      actor_type: "buyer",
      action_type: "buyer.agent_designated",
      entity_type: "buyer_account",
      entity_id: buyer.id,
      metadata: { agent_id: agent?.id ?? null, email, deadline_at: deadline.toISOString() },
    });

    return { invited };
  });

export const resendDesignationInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { buyerAccountId: string; origin: string }) => input)
  .handler(async ({ data, context }): Promise<{ error?: string }> => {
    const db = await admin();
    const buyer = await buyerAccountFor(db, context.userId, data.buyerAccountId);
    if (!buyer?.designated_agent_email && !buyer?.designated_agent_id) {
      return { error: "No designated agent on file." };
    }

    const now = new Date();
    const deadline = new Date(now.getTime() + DESIGNATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    await db
      .from("buyer_accounts")
      .update({
        designation_deadline_at: deadline.toISOString(),
        designation_expired: false,
        tether_status: "awaiting_designation",
      })
      .eq("id", buyer.id);

    if (buyer.designated_agent_id) {
      const { data: a } = await db
        .from("agents")
        .select("auth_user_id")
        .eq("id", buyer.designated_agent_id)
        .maybeSingle();
      await notifyAgentUser(
        db,
        a?.auth_user_id ?? null,
        "Reminder: a buyer has designated you as their agent — accept or decline within 3 days.",
        "designation",
      );
    } else if (buyer.designated_agent_email) {
      await db
        .from("agent_invitations")
        .update({ last_sent_at: now.toISOString() })
        .eq("invited_by_buyer_account_id", buyer.id)
        .eq("status", "pending");
      await sendInviteEmail(buyer.designated_agent_email, buyer.designated_agent_name, data.origin);
    }

    await db.from("audit_log").insert({
      actor_id: context.userId,
      actor_type: "buyer",
      action_type: "buyer.agent_designation_resent",
      entity_type: "buyer_account",
      entity_id: buyer.id,
      metadata: { email: buyer.designated_agent_email },
    });
    return {};
  });

export const clearDesignation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { buyerAccountId: string }) => input)
  .handler(async ({ data, context }): Promise<{ error?: string }> => {
    const db = await admin();
    const buyer = await buyerAccountFor(db, context.userId, data.buyerAccountId);
    if (!buyer) return { error: "Buyer account not found." };
    await db
      .from("buyer_accounts")
      .update({
        designated_agent_id: null,
        designated_agent_email: null,
        designated_agent_name: null,
        designated_at: null,
        designation_deadline_at: null,
        designation_expired: false,
        tether_status: "pending",
      })
      .eq("id", buyer.id);
    await db
      .from("agent_invitations")
      .update({ status: "cancelled" })
      .eq("invited_by_buyer_account_id", buyer.id)
      .eq("status", "pending");
    return {};
  });

/** Buyer gives up on their named agent and takes the automatic selection. */
export const acceptPlatformAssignment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { buyerAccountId: string }) => input)
  .handler(async ({ data, context }) => {
    const db = await admin();
    const buyer = await buyerAccountFor(db, context.userId, data.buyerAccountId);
    if (!buyer) return { error: "Buyer account not found." };

    await db
      .from("buyer_accounts")
      .update({
        designated_agent_id: null,
        designated_agent_email: null,
        designated_agent_name: null,
        designation_deadline_at: null,
        designation_expired: false,
        tether_status: "pending",
      })
      .eq("id", buyer.id);
    await db
      .from("agent_invitations")
      .update({ status: "cancelled" })
      .eq("invited_by_buyer_account_id", buyer.id)
      .eq("status", "pending");

    const result = await runTethering(db, buyer.id, context.userId, { ignoreDesignation: true });
    return { result };
  });

/* ------------------------------------------------------------------ */
/* Agent side                                                          */
/* ------------------------------------------------------------------ */

export const listDesignationRequests = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<DesignationRequest[]> => {
    const db = await admin();
    const agent = await agentFor(db, context.userId);
    if (!agent) return [];

    // A buyer may have invited this agent by email before they joined —
    // claim any pending invitation now that the profile exists.
    if (agent.email) {
      const { data: invites } = await db
        .from("agent_invitations")
        .select("id, invited_by_buyer_account_id")
        .eq("invited_email", agent.email.trim().toLowerCase())
        .eq("status", "pending");
      for (const inv of invites ?? []) {
        await db
          .from("agent_invitations")
          .update({ status: "accepted", accepted_agent_id: agent.id, accepted_at: new Date().toISOString() })
          .eq("id", inv.id);
        if (inv.invited_by_buyer_account_id) {
          await db
            .from("buyer_accounts")
            .update({ designated_agent_id: agent.id, designated_agent_name: agent.full_name })
            .eq("id", inv.invited_by_buyer_account_id)
            .eq("tether_status", "awaiting_designation");
        }
      }
    }

    const { data: rows } = await db
      .from("buyer_accounts")
      .select("id, email, primary_target_market, designated_at, designation_deadline_at")
      .eq("designated_agent_id", agent.id)
      .eq("tether_status", "awaiting_designation");
    return (rows ?? []).map((r: any) => ({
      buyerAccountId: r.id,
      buyerEmail: r.email ?? null,
      market: r.primary_target_market ?? null,
      designatedAt: r.designated_at ?? null,
      deadlineAt: r.designation_deadline_at ?? null,
    }));
  });

/** Designated agent accepts (tether now) or declines (buyer picks again). */
export const respondToDesignation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { buyerAccountId: string; accept: boolean }) => input)
  .handler(async ({ data, context }): Promise<{ error?: string; tethered?: boolean }> => {
    const db = await admin();
    const agent = await agentFor(db, context.userId);
    if (!agent) return { error: "Agent profile not found." };

    const buyer = await loadBuyerForTether(db, data.buyerAccountId);
    if (!buyer || buyer.designated_agent_id !== agent.id) {
      return { error: "This designation is no longer available." };
    }

    if (data.accept) {
      const { eoBlocksNewWork, EO_LAPSED_MESSAGE } = await import("@/lib/eo-expiry");
      // Lapsed E&O coverage blocks accepting a new tethering invitation.
      if (eoBlocksNewWork(agent as { eo_lapsed?: boolean | null; eo_expires_at?: string | null })) {
        return { error: EO_LAPSED_MESSAGE };
      }
    }

    if (!data.accept) {
      await db
        .from("buyer_accounts")
        .update({
          designated_agent_id: null,
          designated_agent_name: null,
          designated_agent_email: null,
          designation_deadline_at: null,
          tether_status: "awaiting_designation",
          designation_expired: true,
        })
        .eq("id", buyer.id);
      await db.from("notifications").insert({
        seller_id: buyer.auth_user_id,
        message: "Your designated agent declined. Name a different agent or accept a platform assignment.",
        type: "designation",
      });
      await db.from("audit_log").insert({
        actor_id: context.userId,
        actor_type: "agent",
        action_type: "agent.designation_declined",
        entity_type: "buyer_account",
        entity_id: buyer.id,
        metadata: { agent_id: agent.id },
      });
      return { tethered: false };
    }

    // Dual-agency: the Listing Agent on a property in this buyer's pod can
    // never be tethered to them.
    const { listingAgentConflict, logDualAgency, DUAL_AGENCY_DESIGNATION_MESSAGE } = await import(
      "@/lib/dual-agency"
    );
    const conflict = await listingAgentConflict(db, agent.id, buyer.id);
    if (conflict.conflict) {
      await logDualAgency(db, {
        actorId: context.userId,
        point: "tethering",
        agentId: agent.id,
        propertyId: conflict.propertyId,
        buyerAccountId: buyer.id,
        resolution: "buyer designation rejected",
      });
      return { error: DUAL_AGENCY_DESIGNATION_MESSAGE };
    }

    // Same tethering logic as the automatic path, with the designated agent.

    let referringAgentId: string | null = null;
    let referringAgentRole: "non_resident" | "resident" | null = null;
    if (buyer.referring_agent_id && buyer.referring_agent_id !== agent.id) {
      const { data: ref } = await db
        .from("agents")
        .select("id, markets")
        .eq("id", buyer.referring_agent_id)
        .maybeSingle();
      if (ref) {
        referringAgentId = ref.id;
        // Derived for this buyer's market, never read from a stored role.
        referringAgentRole = residencyFor(ref.markets, (buyer.primary_target_market ?? "").trim());
      }
    }

    await applyTether(db, {
      buyer,
      agent,
      actorId: context.userId,
      referringAgentId,
      referringAgentRole,
      market: (buyer.primary_target_market ?? "").trim(),
      source: "designated",
    });

    await db
      .from("buyer_accounts")
      .update({ designation_deadline_at: null, designation_expired: false })
      .eq("id", buyer.id);
    await db.from("notifications").insert({
      seller_id: buyer.auth_user_id,
      message: `${agent.full_name} accepted your designation — you're now tethered.`,
      type: "designation",
    });
    await db.from("audit_log").insert({
      actor_id: context.userId,
      actor_type: "agent",
      action_type: "agent.designation_accepted",
      entity_type: "buyer_account",
      entity_id: buyer.id,
      metadata: { agent_id: agent.id },
    });

    return { tethered: true };
  });

export const listReferOnlyElections = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ReferOnlyElection[]> => {
    const db = await admin();
    const agent = await agentFor(db, context.userId);
    if (!agent) return [];
    const { data: rows } = await db
      .from("refer_only_elections")
      .select("id, buyer_account_id, created_at")
      .eq("referring_agent_id", agent.id)
      .eq("status", "pending");

    const out: ReferOnlyElection[] = [];
    for (const r of rows ?? []) {
      const { data: b } = await db
        .from("buyer_accounts")
        .select("email, primary_target_market")
        .eq("id", r.buyer_account_id)
        .maybeSingle();
      out.push({
        id: r.id,
        buyerAccountId: r.buyer_account_id,
        buyerEmail: b?.email ?? null,
        market: b?.primary_target_market ?? null,
        createdAt: r.created_at,
      });
    }
    return out;
  });

/**
 * Refer-Only Election. Accepting tethers the referring Resident Agent to the
 * buyer; electing Refer-Only re-runs the selection logic for a DIFFERENT
 * Resident Agent and stages the NAR Referral Agreement — the referring agent's
 * only compensation is the 25% referral split of the buyer-side commission at
 * closing.
 */
export const respondToReferOnly = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { electionId: string; choice: "accept_tether" | "refer_only" }) => input)
  .handler(async ({ data, context }): Promise<{ error?: string }> => {
    const db = await admin();
    const agent = await agentFor(db, context.userId);
    if (!agent) return { error: "Agent profile not found." };

    const { data: election } = await db
      .from("refer_only_elections")
      .select("id, buyer_account_id, referring_agent_id, status")
      .eq("id", data.electionId)
      .maybeSingle();
    if (!election || election.referring_agent_id !== agent.id || election.status !== "pending") {
      return { error: "This election is no longer available." };
    }

    if (data.choice === "accept_tether") {
      const { eoBlocksNewWork, EO_LAPSED_MESSAGE } = await import("@/lib/eo-expiry");
      if (eoBlocksNewWork(agent as { eo_lapsed?: boolean | null; eo_expires_at?: string | null })) {
        return { error: EO_LAPSED_MESSAGE };
      }
    }

    await db
      .from("refer_only_elections")
      .update({
        status: data.choice === "accept_tether" ? "accepted_tether" : "refer_only",
        decided_at: new Date().toISOString(),
      })
      .eq("id", election.id);

    await db.from("audit_log").insert({
      actor_id: context.userId,
      actor_type: "agent",
      action_type:
        data.choice === "accept_tether" ? "agent.tether_accepted" : "agent.refer_only_elected",
      entity_type: "buyer_account",
      entity_id: election.buyer_account_id,
      metadata: { agent_id: agent.id },
    });

    const result = await runTethering(db, election.buyer_account_id, context.userId);
    if (result.dualAgencyBlocked) {
      const { DUAL_AGENCY_MESSAGE } = await import("@/lib/dual-agency");
      return { error: DUAL_AGENCY_MESSAGE };
    }
    return {};

  });

/* ------------------------------------------------------------------ */
/* 3-day window sweep (manually triggerable)                           */
/* ------------------------------------------------------------------ */

const EXPIRY_NOTICE =
  "Your designated agent has not responded within 3 days. Resend the invitation, name a different agent, or accept a platform assignment.";

/**
 * Sends the expiry notice by email and reports whether delivery was accepted.
 * A rejected send (bounce, invalid address, provider refusal) is what triggers
 * the "awaiting tether resolution" admin flag.
 */
async function sendExpiryNotice(to: string | null): Promise<boolean> {
  if (!to) return false;
  const key = process.env['RESEND_API_KEY'];
  if (!key) return false;
  const { resendFrom } = await import("@/lib/email-sender");
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: resendFrom(),
        to,
        subject: "Action needed: your designated agent has not responded",
        text: `${EXPIRY_NOTICE}\n\nSign in to divieight to choose how to continue.`,
      }),
    });
    return res.ok;
  } catch (e) {
    console.error("[designation] expiry notice failed", e);
    return false;
  }
}

export async function runDesignationSweep(
  db: Db,
): Promise<{ expired: number; undeliverable: number }> {
  const now = new Date();
  const nowIso = now.toISOString();
  const { data: rows } = await db
    .from("buyer_accounts")
    .select(
      "id, auth_user_id, email, designation_deadline_at, designation_expired, tether_status",
    )
    .eq("tether_status", "awaiting_designation")
    .eq("designation_expired", false)
    .not("designation_deadline_at", "is", null)
    .lt("designation_deadline_at", nowIso);

  let expired = 0;
  let undeliverable = 0;
  for (const b of rows ?? []) {
    await db.from("notifications").insert({
      seller_id: b.auth_user_id,
      message: EXPIRY_NOTICE,
      type: "designation",
    });

    const delivered = await sendExpiryNotice(b.email ?? null);
    if (!delivered) undeliverable += 1;

    await db
      .from("buyer_accounts")
      .update({
        designation_expired: true,
        designation_expiry_notified_at: nowIso,
        designation_notice_delivery_failed: !delivered,
        ...(delivered ? { last_successful_contact_at: nowIso } : {}),
      })
      .eq("id", b.id);

    await db.from("audit_log").insert({
      actor_id: b.auth_user_id,
      actor_type: "system",
      action_type: "buyer.agent_designation_expired",
      entity_type: "buyer_account",
      entity_id: b.id,
      metadata: { deadline_at: b.designation_deadline_at, notice_delivered: delivered },
    });
    expired += 1;
  }
  return { expired, undeliverable };
}
