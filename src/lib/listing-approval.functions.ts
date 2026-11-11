import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parseMarkets } from "@/lib/markets";
import { scanForTriggerPhrases, type TriggerPhraseHit } from "@/lib/compliance-phrases";
import type {
  ComplianceReview,
  ContentItem,
  Disposition,
  ListingAgentProperty,
} from "@/lib/listing-approval";

/**
 * Listing Agent dashboard, Gate 1 (Listing-Content Approval Queue) and
 * Gate 2 (Pre-Publication Compliance Review).
 *
 * PUBLISH RULE: `properties.status` is what the public marketplace reads.
 * It only becomes 'listed' inside `tryPublish()`, which requires BOTH
 * content_approval_status = 'approved' AND compliance_status = 'cleared'.
 *
 * Compensation scope unchanged: Listing Agents are paid only through
 * commission at closing via their Broker of Record. The Platform pays nothing.
 */

type Db = { from: (t: string) => any };

async function admin(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function agentFor(db: Db, userId: string) {
  const { data } = await db
    .from("agents")
    .select("id, full_name, broker_id, auth_user_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  return data as
    | { id: string; full_name: string; broker_id: string | null }
    | null;
}

async function brokerFor(db: Db, userId: string) {
  const { data } = await db
    .from("brokers")
    .select("id, brokerage_name, auth_user_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  return data as { id: string; brokerage_name: string | null } | null;
}

async function isAdmin(supabase: any, userId: string) {
  const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  return Boolean(data);
}

async function audit(
  db: Db,
  row: {
    actorId: string;
    actorType: "seller" | "agent" | "buyer" | "broker";
    actionType: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await db.from("audit_log").insert({
    actor_id: row.actorId,
    actor_type: row.actorType,
    action_type: row.actionType,
    entity_type: row.entityType,
    entity_id: row.entityId ?? null,
    metadata: row.metadata ?? {},
  });
}

async function notifyUser(db: Db, authUserId: string, message: string, type: string) {
  await db.from("notifications").insert({ seller_id: authUserId, message, type });
}

/* ------------------------------------------------------------------ */
/* 1. Listing Agent tagging (seller side)                              */
/* ------------------------------------------------------------------ */

export interface ListingAgentOption {
  id: string;
  full_name: string;
  email: string | null;
  markets: string[] | null;
  license_state: string | null;
}

export const searchListingAgents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { query: string }) => data)
  .handler(async ({ data }): Promise<ListingAgentOption[]> => {
    const db = await admin();
    const q = (data.query ?? "").trim().replace(/[(),]/g, " ").trim();
    let query = db
      .from("agents")
      .select("id, full_name, email, markets, license_state")
      .limit(10);
    if (q) {
      query = query.or(
        `full_name.ilike.%${q}%,email.ilike.%${q}%,license_number.ilike.%${q}%,license_state.ilike.%${q}%`,
      );
    }
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return (rows ?? []) as ListingAgentOption[];
  });

async function assertSellerOwns(db: Db, propertyId: string, userId: string) {
  const { data } = await db
    .from("properties")
    .select("id, seller_id, address, state")
    .eq("id", propertyId)
    .maybeSingle();
  if (!data || data.seller_id !== userId) throw new Error("Property not found.");
  return data as { id: string; seller_id: string; address: string; state: string | null };
}

export const tagListingAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; agentId: string }) => data)
  .handler(async ({ data, context }) => {
    const db = await admin();
    const property = await assertSellerOwns(db, data.propertyId, context.userId);

    const { data: agent } = await db
      .from("agents")
      .select("id, full_name, auth_user_id")
      .eq("id", data.agentId)
      .maybeSingle();
    // Listing Agent is a per-property relationship, not a stored role.
    if (!agent) throw new Error("That agent could not be found.");

    // Dual-agency: release (and re-tether) any buyer in this property's pod
    // already tethered to this agent BEFORE the tag is finalized.
    const { clearTethersForListingAgent } = await import("@/lib/dual-agency");
    await clearTethersForListingAgent(db, {
      propertyId: property.id,
      agentId: agent.id,
      actorId: context.userId,
    });

    await db
      .from("properties")
      .update({
        listing_agent_id: agent.id,
        listing_agent_engagement_status: "pending",
        listing_agent_engagement_at: new Date().toISOString(),
        listing_agent_decline_reason: null,
      })
      .eq("id", property.id);

    await audit(db, {
      actorId: context.userId,
      actorType: "seller",
      actionType: "seller.listing_agent_tagged",
      entityType: "property",
      entityId: property.id,
      metadata: { agent_id: agent.id, agent_name: agent.full_name },
    });
    if (agent.auth_user_id) {
      await notifyUser(
        db,
        agent.auth_user_id,
        `A seller asked you to act as Listing Agent for ${property.address} — accept or decline the engagement.`,
        "listing_agent",
      );
    }
    return { ok: true, agentName: agent.full_name as string };
  });

export const inviteListingAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; email: string; fullName?: string }) => data)
  .handler(async ({ data, context }) => {
    const db = await admin();
    const property = await assertSellerOwns(db, data.propertyId, context.userId);
    const email = data.email.trim().toLowerCase();

    // If they're already on-platform as a Listing Agent, tag them directly.
    const { data: existingRows } = await db
      .from("agents")
      .select("id, full_name, auth_user_id")
      .ilike("email", email)
      .limit(1);
    const existing = ((existingRows ?? []) as any[])[0] ?? null;
    if (existing) {
      const { clearTethersForListingAgent: clearInvited } = await import("@/lib/dual-agency");
      await clearInvited(db, {
        propertyId: property.id,
        agentId: existing.id,
        actorId: context.userId,
      });
      await db
        .from("properties")
        .update({
          listing_agent_id: existing.id,
          listing_agent_engagement_status: "pending",
          listing_agent_engagement_at: new Date().toISOString(),
          listing_agent_decline_reason: null,
        })
        .eq("id", property.id);

      if (existing.auth_user_id) {
        await notifyUser(
          db,
          existing.auth_user_id,
          `A seller asked you to act as Listing Agent for ${property.address} — accept or decline the engagement.`,
          "listing_agent",
        );
      }
      await audit(db, {
        actorId: context.userId,
        actorType: "seller",
        actionType: "seller.listing_agent_tagged",
        entityType: "property",
        entityId: property.id,
        metadata: { agent_id: existing.id, via: "email_match" },
      });
      return { ok: true, invited: false, agentName: existing.full_name as string };
    }

    // Only one pending invitation per property — supersede any earlier one.
    await db
      .from("listing_agent_invitations")
      .update({ status: "superseded" })
      .eq("property_id", property.id)
      .eq("status", "pending");

    const { error: inviteError } = await db.from("listing_agent_invitations").insert({
      property_id: property.id,
      seller_id: context.userId,
      email,
      full_name: data.fullName?.trim() || null,
      status: "pending",
    });
    if (inviteError) throw new Error(inviteError.message);
    await audit(db, {
      actorId: context.userId,
      actorType: "seller",
      actionType: "seller.listing_agent_invited",
      entityType: "property",
      entityId: property.id,
      metadata: { email },
    });
    return { ok: true, invited: true, agentName: null };
  });

export interface ListingAgentTagState {
  agentId: string | null;
  agentName: string | null;
  invitedEmail: string | null;
  contentApprovalStatus: string;
  complianceStatus: string;
  status: string;
  flaggedPhrases: string[];
  rejectedItems: { id: string; label: string; reason: string | null }[];
  /** 'none' | 'pending' | 'accepted' | 'declined' */
  engagementStatus: string;
  /** Why the agent turned the engagement down (declined state only). */
  engagementDeclineReason: string | null;
  /** Set when an engaged Listing Agent rejected the whole property. */
  listingRejectionReason: string | null;
  listingRejectedAt: string | null;
}

export const getListingAgentTagState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => data)
  .handler(async ({ data, context }): Promise<ListingAgentTagState> => {
    const db = await admin();
    const { data: property } = await db
      .from("properties")
      .select(
        "id, seller_id, status, listing_agent_id, content_approval_status, compliance_status, listing_agent_engagement_status, listing_agent_decline_reason, listing_rejection_reason, listing_rejected_at",
      )
      .eq("id", data.propertyId)
      .maybeSingle();
    if (!property || property.seller_id !== context.userId) throw new Error("Property not found.");

    let agentName: string | null = null;
    if (property.listing_agent_id) {
      const { data: agent } = await db
        .from("agents")
        .select("full_name")
        .eq("id", property.listing_agent_id)
        .maybeSingle();
      agentName = agent?.full_name ?? null;
    }

    const { data: invite } = await db
      .from("listing_agent_invitations")
      .select("email, status")
      .eq("property_id", property.id)
      .eq("status", "pending")
      .maybeSingle();

    const { data: rejected } = await db
      .from("listing_content_items")
      .select("id, label, item_type, reject_reason")
      .eq("property_id", property.id)
      .eq("disposition", "rejected");

    const { data: review } = await db
      .from("compliance_reviews")
      .select("flagged_phrases, status")
      .eq("property_id", property.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      agentId: property.listing_agent_id ?? null,
      agentName,
      invitedEmail: invite?.email ?? null,
      contentApprovalStatus: property.content_approval_status ?? "not_submitted",
      complianceStatus: property.compliance_status ?? "not_started",
      status: property.status,
      flaggedPhrases:
        review && review.status !== "approved" ? ((review.flagged_phrases ?? []) as string[]) : [],
      rejectedItems: ((rejected ?? []) as any[]).map((r) => ({
        id: r.id,
        label: r.label ?? r.item_type,
        reason: r.reject_reason ?? null,
      })),
      engagementStatus: property.listing_agent_engagement_status ?? "none",
      engagementDeclineReason: property.listing_agent_decline_reason ?? null,
      listingRejectionReason: property.listing_rejection_reason ?? null,
      listingRejectedAt: property.listing_rejected_at ?? null,
    };
  });

/* ------------------------------------------------------------------ */
/* 1b. Listing Agent engagement: accept / decline / auto-assign         */
/* ------------------------------------------------------------------ */

export interface ListingEngagementInvitation {
  propertyId: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  sellerName: string | null;
  listingPrice: number | null;
  invitedAt: string | null;
}

/** Engagements this Listing Agent has been asked to accept or decline. */
export const listMyListingEngagements = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ListingEngagementInvitation[]> => {
    const db = await admin();
    const agent = await agentFor(db, context.userId);
    if (!agent) return [];

    const { data: props } = await db
      .from("properties")
      .select("id, address, city, state, zip, seller_id, listing_price, listing_agent_engagement_at")
      .eq("listing_agent_id", agent.id)
      .eq("listing_agent_engagement_status", "pending")
      .order("listing_agent_engagement_at", { ascending: true });
    const rows = (props ?? []) as any[];
    if (rows.length === 0) return [];

    const { data: sellers } = await db
      .from("sellers")
      .select("id, full_name")
      .in("id", rows.map((r) => r.seller_id));
    const nameById = new Map(((sellers ?? []) as any[]).map((s) => [s.id, s.full_name]));

    return rows.map((r) => ({
      propertyId: r.id,
      address: r.address,
      city: r.city,
      state: r.state,
      zip: r.zip,
      sellerName: nameById.get(r.seller_id) ?? null,
      listingPrice: r.listing_price ?? null,
      invitedAt: r.listing_agent_engagement_at ?? null,
    }));
  });

/** Listing Agent accepts or declines the engagement itself (before any content review). */
export const respondToListingEngagement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; accept: boolean; reason?: string }) => data)
  .handler(async ({ data, context }) => {
    const db = await admin();
    const agent = await agentFor(db, context.userId);
    if (!agent) throw new Error("Not authorized.");

    const { data: property } = await db
      .from("properties")
      .select("id, address, seller_id, listing_agent_id, listing_agent_engagement_status")
      .eq("id", data.propertyId)
      .maybeSingle();
    if (!property || property.listing_agent_id !== agent.id) throw new Error("Engagement not found.");
    if (property.listing_agent_engagement_status !== "pending") {
      throw new Error("This engagement has already been answered.");
    }

    if (data.accept) {
      await db
        .from("properties")
        .update({
          listing_agent_engagement_status: "accepted",
          listing_agent_engagement_at: new Date().toISOString(),
          listing_agent_decline_reason: null,
        })
        .eq("id", property.id);
      await db
        .from("listing_agent_invitations")
        .update({ status: "accepted" })
        .eq("property_id", property.id)
        .eq("status", "pending");
      await audit(db, {
        actorId: context.userId,
        actorType: "agent",
        actionType: "listing.agent_engagement_accepted",
        entityType: "property",
        entityId: property.id,
        metadata: { agent_id: agent.id },
      });
      await notifyUser(
        db,
        property.seller_id,
        `${agent.full_name} accepted the Listing Agent engagement for ${property.address}.`,
        "listing_agent",
      );
      return { ok: true, accepted: true };
    }

    const reason = (data.reason ?? "").trim() || "No reason given.";
    await db.from("listing_agent_declines").insert({
      property_id: property.id,
      agent_id: agent.id,
      reason,
    });
    await db
      .from("properties")
      .update({
        listing_agent_id: null,
        listing_agent_engagement_status: "declined",
        listing_agent_engagement_at: new Date().toISOString(),
        listing_agent_decline_reason: reason,
      })
      .eq("id", property.id);
    await audit(db, {
      actorId: context.userId,
      actorType: "agent",
      actionType: "listing.agent_engagement_declined",
      entityType: "property",
      entityId: property.id,
      metadata: { agent_id: agent.id, reason },
    });
    await notifyUser(
      db,
      property.seller_id,
      `${agent.full_name} declined the Listing Agent engagement for ${property.address}: ${reason}. Choose another Listing Agent, or let divieight assign one.`,
      "listing_agent",
    );
    return { ok: true, accepted: false };
  });

/**
 * Seller asks the platform to pick a Listing Agent: earliest-registered
 * licensed listing agent serving the property's state, skipping anyone who
 * already declined this property.
 */
export const autoAssignListingAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => data)
  .handler(async ({ data, context }) => {
    const db = await admin();
    const property = await assertSellerOwns(db, data.propertyId, context.userId);

    const { data: declines } = await db
      .from("listing_agent_declines")
      .select("agent_id")
      .eq("property_id", property.id);
    const declined = new Set(((declines ?? []) as any[]).map((d) => d.agent_id));

    const { data: agents } = await db
      .from("agents")
      .select("id, full_name, auth_user_id, license_state, markets")
      .order("created_at", { ascending: true });

    const pool = ((agents ?? []) as any[]).filter((a) => !declined.has(a.id));
    const state = (property.state ?? "").toLowerCase();
    const match =
      pool.find(
        (a) =>
          (a.license_state ?? "").toLowerCase() === state ||
          parseMarkets(a.markets).some((m: string) => m.toLowerCase().includes(state)),
      ) ?? pool[0];

    if (!match) {
      return { ok: false as const, agentName: null, message: "No Listing Agent is available right now." };
    }

    const { clearTethersForListingAgent: clearAuto } = await import("@/lib/dual-agency");
    await clearAuto(db, {
      propertyId: property.id,
      agentId: match.id,
      actorId: context.userId,
    });

    await db
      .from("properties")
      .update({
        listing_agent_id: match.id,
        listing_agent_engagement_status: "pending",
        listing_agent_engagement_at: new Date().toISOString(),
        listing_agent_decline_reason: null,
      })
      .eq("id", property.id);

    await audit(db, {
      actorId: context.userId,
      actorType: "seller",
      actionType: "listing.agent_auto_assigned",
      entityType: "property",
      entityId: property.id,
      metadata: { agent_id: match.id, agent_name: match.full_name, assigned_by: "platform" },
    });
    if (match.auth_user_id) {
      await notifyUser(
        db,
        match.auth_user_id,
        `divieight assigned you as Listing Agent for ${property.address} — accept or decline the engagement.`,
        "listing_agent",
      );
    }
    return { ok: true as const, agentName: match.full_name as string, message: null };
  });

/**
 * An engaged Listing Agent rejects the property outright. The listing returns
 * to draft so the seller can edit the property details and resubmit.
 */
export const rejectListingProperty = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; reason: string }) => data)
  .handler(async ({ data, context }) => {
    const db = await admin();
    const agent = await agentFor(db, context.userId);
    if (!agent) throw new Error("Not authorized.");
    const reason = data.reason.trim();
    if (reason.length < 5) throw new Error("Give the seller a reason for the rejection.");

    const { data: property } = await db
      .from("properties")
      .select("id, address, seller_id, listing_agent_id, listing_agent_engagement_status")
      .eq("id", data.propertyId)
      .maybeSingle();
    if (!property || property.listing_agent_id !== agent.id) throw new Error("Listing not found.");
    if (property.listing_agent_engagement_status !== "accepted") {
      throw new Error("Accept the engagement before reviewing this property.");
    }

    await db
      .from("properties")
      .update({
        status: "draft",
        content_approval_status: "changes_requested",
        compliance_status: "not_started",
        listing_rejection_reason: reason,
        listing_rejected_at: new Date().toISOString(),
        listing_rejected_by_agent_id: agent.id,
      })
      .eq("id", property.id);
    await audit(db, {
      actorId: context.userId,
      actorType: "agent",
      actionType: "listing.property_rejected_by_listing_agent",
      entityType: "property",
      entityId: property.id,
      metadata: { agent_id: agent.id, reason },
    });
    await notifyUser(
      db,
      property.seller_id,
      `${agent.full_name} rejected ${property.address}: ${reason}. Edit your property details and resubmit.`,
      "listing_agent",
    );
    return { ok: true };
  });

/* ------------------------------------------------------------------ */
/* 2. Submitting content into Gate 1                                    */
/* ------------------------------------------------------------------ */

/**
 * Snapshots every public-facing content element (description, photo captions,
 * virtual tour narrative) into the approval queue and moves the property to
 * `pending_review`. Called at the end of the seller's listing flow.
 */
export const submitListingForApproval = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => data)
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { data: property } = await db
      .from("properties")
      .select("id, seller_id, address, description, listing_agent_id, status")
      .eq("id", data.propertyId)
      .maybeSingle();
    if (!property || property.seller_id !== context.userId) throw new Error("Property not found.");

    const { data: media } = await db
      .from("property_media")
      .select("id, caption, narrative, media_type, display_order")
      .eq("property_id", property.id);

    const items: any[] = [];
    if (property.description?.trim()) {
      items.push({
        property_id: property.id,
        item_type: "description",
        label: "Listing description",
        contributor_id: context.userId,
        original_content: property.description.trim(),
      });
    }
    ((media ?? []) as any[]).forEach((m, i) => {
      if (m.media_type === "photo" && m.caption?.trim()) {
        items.push({
          property_id: property.id,
          item_type: "photo_caption",
          label: `Photo caption ${i + 1}`,
          media_id: m.id,
          contributor_id: context.userId,
          original_content: m.caption.trim(),
        });
      }
      if (m.media_type === "virtual_tour" && m.narrative?.trim()) {
        items.push({
          property_id: property.id,
          item_type: "virtual_tour_narrative",
          label: "Virtual tour narrative",
          media_id: m.id,
          contributor_id: context.userId,
          original_content: m.narrative.trim(),
        });
      }
    });

    // Re-submission replaces any prior pending/rejected snapshot.
    await db
      .from("listing_content_items")
      .delete()
      .eq("property_id", property.id)
      .in("disposition", ["pending", "rejected"]);
    if (items.length > 0) await db.from("listing_content_items").insert(items);

    await db
      .from("properties")
      .update({
        status: "pending_review",
        content_approval_status: items.length > 0 ? "pending" : "approved",
        compliance_status: "not_started",
        // A fresh submission clears any earlier whole-property rejection.
        listing_rejection_reason: null,
        listing_rejected_at: null,
      })
      .eq("id", property.id);

    await audit(db, {
      actorId: context.userId,
      actorType: "seller",
      actionType: "listing.content_submitted_for_approval",
      entityType: "property",
      entityId: property.id,
      metadata: { item_count: items.length },
    });

    if (property.listing_agent_id) {
      const { data: agent } = await db
        .from("agents")
        .select("auth_user_id")
        .eq("id", property.listing_agent_id)
        .maybeSingle();
      if (agent?.auth_user_id) {
        await notifyUser(
          db,
          agent.auth_user_id,
          `${items.length} listing content item(s) await your approval for ${property.address}.`,
          "listing_approval",
        );
      }
    }

    // No content to review at Gate 1 — go straight to Gate 2.
    if (items.length === 0) await runComplianceGate(db, property.id, context.userId);

    return { ok: true, itemCount: items.length };
  });

/* ------------------------------------------------------------------ */
/* 3. Listing Agent dashboard                                           */
/* ------------------------------------------------------------------ */

/** Property ids this caller may act on: tagged agent, that agent's broker, or admin. */
async function authorizedScope(db: Db, supabase: any, userId: string) {
  const agent = await agentFor(db, userId);
  if (agent) return { kind: "agent" as const, agent, broker: null, agentIds: [agent.id] };
  const broker = await brokerFor(db, userId);
  if (broker) {
    const { data: agents } = await db.from("agents").select("id").eq("broker_id", broker.id);
    return {
      kind: "broker" as const,
      agent: null,
      broker,
      agentIds: ((agents ?? []) as any[]).map((a) => a.id),
    };
  }
  if (await isAdmin(supabase, userId)) {
    return { kind: "admin" as const, agent: null, broker: null, agentIds: null };
  }
  throw new Error("Not authorized.");
}

export const listMyListingProperties = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ListingAgentProperty[]> => {
    const db = await admin();
    const scope = await authorizedScope(db, context.supabase, context.userId);

    let query = db
      .from("properties")
      .select(
        "id, address, city, state, zip, status, listing_status, listing_price, content_approval_status, compliance_status, seller_id, listing_agent_id",
      )
      .not("listing_agent_id", "is", null)
      // Only engagements the agent actually accepted appear in their portfolio.
      .eq("listing_agent_engagement_status", "accepted")
      .order("created_at", { ascending: false });
    if (scope.agentIds) query = query.in("listing_agent_id", scope.agentIds);
    const { data: props } = await query;
    const rows = (props ?? []) as any[];
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const [{ data: sellers }, { data: reservations }, { data: pods }, { data: pending }] =
      await Promise.all([
        // Exit type / retention election live on the seller record.
        db
          .from("sellers")
          .select("id, full_name, exit_type, retained_shares")
          .in("id", rows.map((r) => r.seller_id)),
        db.from("pod_reservations").select("property_id, shares_reserved, status").in("property_id", ids),
        db.from("pods").select("property_id, status, hla_status, closing_hold_active").in("property_id", ids),
        db
          .from("listing_content_items")
          .select("property_id, disposition")
          .in("property_id", ids)
          .eq("disposition", "pending"),
      ]);

    const sellerById = new Map(((sellers ?? []) as any[]).map((s) => [s.id, s]));
    const reserved = new Map<string, number>();
    ((reservations ?? []) as any[])
      .filter((r) => r.status === "reserved")
      .forEach((r) =>
        reserved.set(r.property_id, (reserved.get(r.property_id) ?? 0) + (r.shares_reserved ?? 0)),
      );
    const podByProp = new Map(((pods ?? []) as any[]).map((p) => [p.property_id, p]));
    const pendingCount = new Map<string, number>();
    ((pending ?? []) as any[]).forEach((p) =>
      pendingCount.set(p.property_id, (pendingCount.get(p.property_id) ?? 0) + 1),
    );

    return rows.map((r) => ({
      id: r.id,
      address: r.address,
      city: r.city,
      state: r.state,
      zip: r.zip,
      status: r.status,
      listing_status: r.listing_status ?? "forming",
      listing_price: r.listing_price,
      exit_type: sellerById.get(r.seller_id)?.exit_type ?? null,
      retained_shares: sellerById.get(r.seller_id)?.retained_shares ?? null,
      content_approval_status: r.content_approval_status ?? "not_submitted",
      compliance_status: r.compliance_status ?? "not_started",
      seller_name: sellerById.get(r.seller_id)?.full_name ?? null,
      reserved_shares: reserved.get(r.id) ?? 0,
      pending_items: pendingCount.get(r.id) ?? 0,
      pod_status: podByProp.get(r.id)?.status ?? null,
      hla_status: podByProp.get(r.id)?.hla_status ?? null,
      closing_hold_active: Boolean(podByProp.get(r.id)?.closing_hold_active),
    }));
  });

/* ------------------------------------------------------------------ */
/* 4. Gate 1 — approval queue                                           */
/* ------------------------------------------------------------------ */

export const listApprovalQueue = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ items: ContentItem[]; actingAsBroker: boolean }> => {
    const db = await admin();
    const scope = await authorizedScope(db, context.supabase, context.userId);

    let propQuery = db
      .from("properties")
      .select("id, address, listing_agent_id")
      .not("listing_agent_id", "is", null)
      .eq("listing_agent_engagement_status", "accepted");
    if (scope.agentIds) propQuery = propQuery.in("listing_agent_id", scope.agentIds);
    const { data: props } = await propQuery;
    const rows = (props ?? []) as any[];
    if (rows.length === 0) return { items: [], actingAsBroker: scope.kind === "broker" };

    const addressById = new Map(rows.map((r) => [r.id, r.address]));
    const { data: items } = await db
      .from("listing_content_items")
      .select("*")
      .in("property_id", rows.map((r) => r.id))
      .eq("disposition", "pending")
      .order("created_at", { ascending: true });

    return {
      items: ((items ?? []) as any[]).map((i) => ({
        ...i,
        address: addressById.get(i.property_id) ?? "",
      })) as ContentItem[],
      actingAsBroker: scope.kind === "broker",
    };
  });

export const disposeContentItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      itemId: string;
      disposition: Exclude<Disposition, "pending">;
      revisedText?: string;
      reason?: string;
      unavailabilityNote?: string;
    }) => data,
  )
  .handler(async ({ data, context }) => {
    const db = await admin();
    const scope = await authorizedScope(db, context.supabase, context.userId);

    const { data: item } = await db
      .from("listing_content_items")
      .select("*")
      .eq("id", data.itemId)
      .maybeSingle();
    if (!item) throw new Error("Content item not found.");

    const { data: property } = await db
      .from("properties")
      .select("id, address, seller_id, listing_agent_id")
      .eq("id", item.property_id)
      .maybeSingle();
    if (!property) throw new Error("Property not found.");
    if (scope.agentIds && !scope.agentIds.includes(property.listing_agent_id)) {
      throw new Error("Not authorized for this listing.");
    }

    if (data.disposition === "approved_with_modification" && !data.revisedText?.trim()) {
      throw new Error("Provide the revised text.");
    }
    if (data.disposition === "rejected" && !data.reason?.trim()) {
      throw new Error("A reason is required to reject content.");
    }

    const actingAsBroker = scope.kind === "broker";
    const decidedAt = new Date().toISOString();

    await db
      .from("listing_content_items")
      .update({
        disposition: data.disposition,
        revised_content:
          data.disposition === "approved_with_modification" ? data.revisedText!.trim() : null,
        reject_reason: data.disposition === "rejected" ? data.reason!.trim() : null,
        decided_by_agent_id: scope.agent?.id ?? null,
        decided_by_broker_id: scope.broker?.id ?? null,
        agent_unavailable: actingAsBroker,
        unavailability_note: actingAsBroker
          ? data.unavailabilityNote?.trim() ||
            "Listing Agent unavailable — approved by their Broker of Record."
          : null,
        decided_at: decidedAt,
      })
      .eq("id", item.id);

    // If approved with modification, the modified text becomes the live copy.
    if (data.disposition === "approved_with_modification") {
      const revised = data.revisedText!.trim();
      if (item.item_type === "description") {
        await db.from("properties").update({ description: revised }).eq("id", property.id);
      } else if (item.media_id && item.item_type === "photo_caption") {
        await db.from("property_media").update({ caption: revised }).eq("id", item.media_id);
      } else if (item.media_id) {
        await db.from("property_media").update({ narrative: revised }).eq("id", item.media_id);
      }
    }

    await audit(db, {
      actorId: context.userId,
      actorType: actingAsBroker ? "broker" : "agent",
      actionType:
        data.disposition === "rejected"
          ? "listing.content_rejected"
          : data.disposition === "approved_with_modification"
            ? "listing.content_approved_with_modification"
            : "listing.content_approved",
      entityType: "property",
      entityId: property.id,
      metadata: {
        content_item_id: item.id,
        item_type: item.item_type,
        contributor_id: item.contributor_id,
        original_content: item.original_content,
        disposition: data.disposition,
        revision_text: data.revisedText?.trim() ?? null,
        reject_reason: data.reason?.trim() ?? null,
        decided_at: decidedAt,
        decided_by: actingAsBroker ? "broker_of_record" : "listing_agent",
        broker_id: scope.broker?.id ?? null,
        agent_id: scope.agent?.id ?? null,
        agent_unavailable: actingAsBroker,
        unavailability_note: actingAsBroker
          ? data.unavailabilityNote?.trim() || "Listing Agent unavailable."
          : null,
      },
    });

    if (data.disposition === "rejected") {
      await db
        .from("properties")
        .update({ content_approval_status: "changes_requested", status: "draft" })
        .eq("id", property.id);
      await notifyUser(
        db,
        property.seller_id,
        `Your Listing Agent asked for changes on ${property.address}: ${data.reason!.trim()}`,
        "listing_approval",
      );
      return { ok: true, gateCleared: false, flagged: [] as string[] };
    }

    // Gate 1 clears only when nothing is left pending or rejected.
    const { data: remaining } = await db
      .from("listing_content_items")
      .select("id, disposition")
      .eq("property_id", property.id)
      .in("disposition", ["pending", "rejected"]);
    if ((remaining ?? []).length > 0) return { ok: true, gateCleared: false, flagged: [] as string[] };

    await db
      .from("properties")
      .update({ content_approval_status: "approved" })
      .eq("id", property.id);
    await audit(db, {
      actorId: context.userId,
      actorType: actingAsBroker ? "broker" : "agent",
      actionType: "listing.gate1_cleared",
      entityType: "property",
      entityId: property.id,
      metadata: { decided_by: actingAsBroker ? "broker_of_record" : "listing_agent" },
    });

    const result = await runComplianceGate(db, property.id, context.userId);
    return { ok: true, gateCleared: true, flagged: result.flagged };
  });

/* ------------------------------------------------------------------ */
/* 5. Gate 2 — automated compliance filter                              */
/* ------------------------------------------------------------------ */

async function runComplianceGate(db: Db, propertyId: string, actorId: string) {
  const { data: property } = await db
    .from("properties")
    .select("id, address, description, seller_id, listing_agent_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (!property) return { flagged: [] as string[] };

  const { data: items } = await db
    .from("listing_content_items")
    .select("item_type, label, original_content, revised_content, disposition")
    .eq("property_id", propertyId)
    .in("disposition", ["approved", "approved_with_modification"]);

  const hits: TriggerPhraseHit[] = [];
  ((items ?? []) as any[]).forEach((i) => {
    const text = i.revised_content ?? i.original_content;
    hits.push(...scanForTriggerPhrases(text, i.label ?? i.item_type));
  });
  if (property.description) {
    hits.push(...scanForTriggerPhrases(property.description, "Listing description"));
  }

  const phrases = Array.from(new Set(hits.map((h) => h.phrase)));

  if (phrases.length > 0) {
    await db.from("compliance_reviews").insert({
      property_id: propertyId,
      flagged_phrases: phrases,
      flagged_excerpts: hits,
      status: "flagged",
    });
    await db
      .from("properties")
      .update({ compliance_status: "flagged", status: "pending_review" })
      .eq("id", propertyId);
    await audit(db, {
      actorId,
      actorType: "agent",
      actionType: "listing.compliance_flagged",
      entityType: "property",
      entityId: propertyId,
      metadata: { flagged_phrases: phrases, excerpts: hits },
    });

    const list = phrases.join(", ");
    await notifyUser(
      db,
      property.seller_id,
      `Compliance review: ${property.address} was held for the phrase(s): ${list}. Revise the copy or request human review.`,
      "compliance",
    );
    if (property.listing_agent_id) {
      const { data: agent } = await db
        .from("agents")
        .select("auth_user_id")
        .eq("id", property.listing_agent_id)
        .maybeSingle();
      if (agent?.auth_user_id) {
        await notifyUser(
          db,
          agent.auth_user_id,
          `Compliance held ${property.address} for the phrase(s): ${list}.`,
          "compliance",
        );
      }
    }
    return { flagged: phrases };
  }

  await db.from("properties").update({ compliance_status: "cleared" }).eq("id", propertyId);
  await audit(db, {
    actorId,
    actorType: "agent",
    actionType: "listing.compliance_cleared",
    entityType: "property",
    entityId: propertyId,
  });
  await tryPublish(db, propertyId, actorId);
  return { flagged: [] as string[] };
}

/** The ONLY path that makes a listing publicly visible. Both gates required. */
async function tryPublish(db: Db, propertyId: string, actorId: string) {
  const { data: p } = await db
    .from("properties")
    .select("id, address, seller_id, content_approval_status, compliance_status")
    .eq("id", propertyId)
    .maybeSingle();
  if (!p) return false;
  if (p.content_approval_status !== "approved" || p.compliance_status !== "cleared") return false;

  // When the setting is on, a seller whose eligibility result isn't 'eligible' can't publish. Off by default.
  const { sellerListingGate } = await import("@/lib/seller-eligibility.server");
  const gate = await sellerListingGate(db, p.seller_id);
  if (gate.blocked) {
    await audit(db, { actorId, actorType: "agent", actionType: "listing.publish_blocked_seller_eligibility", entityType: "property", entityId: propertyId, metadata: { held: gate.held } });
    await notifyUser(db, p.seller_id, gate.message ?? "", "compliance");
    return false;
  }

  await db
    .from("properties")
    .update({ status: "listed", published_at: new Date().toISOString() })
    .eq("id", propertyId);
  await audit(db, {
    actorId,
    actorType: "agent",
    actionType: "listing.published",
    entityType: "property",
    entityId: propertyId,
    metadata: { gates: ["content_approval", "compliance_review"] },
  });
  await notifyUser(
    db,
    p.seller_id,
    `Both review gates cleared — ${p.address} is now live on the marketplace.`,
    "listing",
  );
  return true;
}

/** Seller/agent asks a human compliance officer to look at a flagged listing. */
export const requestHumanComplianceReview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; note?: string }) => data)
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { data: review } = await db
      .from("compliance_reviews")
      .select("id, property_id, status")
      .eq("property_id", data.propertyId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!review) throw new Error("No compliance review on file.");

    await db
      .from("compliance_reviews")
      .update({ status: "human_review", resolution_note: data.note?.trim() || null })
      .eq("id", review.id);
    await db
      .from("properties")
      .update({ compliance_status: "human_review" })
      .eq("id", data.propertyId);
    await audit(db, {
      actorId: context.userId,
      actorType: "seller",
      actionType: "listing.compliance_human_review_requested",
      entityType: "property",
      entityId: data.propertyId,
      metadata: { note: data.note?.trim() ?? null },
    });
    return { ok: true };
  });

/** Seller revised the copy — rescan without needing another Gate 1 pass. */
export const rescanCompliance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => data)
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { data: property } = await db
      .from("properties")
      .select("id, seller_id")
      .eq("id", data.propertyId)
      .maybeSingle();
    if (!property || property.seller_id !== context.userId) throw new Error("Property not found.");
    return runComplianceGate(db, data.propertyId, context.userId);
  });

/* ------------------------------------------------------------------ */
/* 6. Admin human-review resolution                                     */
/* ------------------------------------------------------------------ */

export const listComplianceReviews = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ComplianceReview[]> => {
    const db = await admin();
    if (!(await isAdmin(context.supabase, context.userId))) throw new Error("Not authorized.");
    const { data: reviews } = await db
      .from("compliance_reviews")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    const rows = (reviews ?? []) as any[];
    if (rows.length === 0) return [];
    const { data: props } = await db
      .from("properties")
      .select("id, address")
      .in("id", rows.map((r) => r.property_id));
    const addr = new Map(((props ?? []) as any[]).map((p) => [p.id, p.address]));
    return rows.map((r) => ({
      id: r.id,
      property_id: r.property_id,
      address: addr.get(r.property_id) ?? "—",
      flagged_phrases: (r.flagged_phrases ?? []) as string[],
      status: r.status,
      resolution_note: r.resolution_note ?? null,
      created_at: r.created_at,
      resolved_at: r.resolved_at ?? null,
    }));
  });

export const resolveComplianceReview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { reviewId: string; decision: "approved" | "denied"; note: string }) => data)
  .handler(async ({ data, context }) => {
    const db = await admin();
    if (!(await isAdmin(context.supabase, context.userId))) throw new Error("Not authorized.");
    if (!data.note.trim()) throw new Error("A decision note is required.");

    const { data: review } = await db
      .from("compliance_reviews")
      .select("id, property_id, flagged_phrases")
      .eq("id", data.reviewId)
      .maybeSingle();
    if (!review) throw new Error("Review not found.");

    await db
      .from("compliance_reviews")
      .update({
        status: data.decision,
        resolution_note: data.note.trim(),
        resolved_by: context.userId,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", review.id);

    await db
      .from("properties")
      .update({ compliance_status: data.decision === "approved" ? "cleared" : "denied" })
      .eq("id", review.property_id);

    await audit(db, {
      actorId: context.userId,
      actorType: "agent",
      actionType:
        data.decision === "approved"
          ? "listing.compliance_human_approved"
          : "listing.compliance_human_denied",
      entityType: "property",
      entityId: review.property_id,
      metadata: { review_id: review.id, note: data.note.trim(), flagged_phrases: review.flagged_phrases },
    });

    if (data.decision === "approved") await tryPublish(db, review.property_id, context.userId);
    else {
      const { data: p } = await db
        .from("properties")
        .select("seller_id, address")
        .eq("id", review.property_id)
        .maybeSingle();
      if (p) {
        await notifyUser(
          db,
          p.seller_id,
          `Compliance denied publication of ${p.address}: ${data.note.trim()}`,
          "compliance",
        );
      }
    }
    return { ok: true };
  });

/**
 * Listing Agent / Broker / Admin view of one tagged property: full detail,
 * photos and data-room documents. Read through the admin client and scoped
 * by `authorizedScope`, because RLS on `properties` is seller-owned and the
 * public marketplace page only serves listings already published.
 */
export const getListingAgentPropertyDetail = createServerFn({ method: "GET" })
  .inputValidator((data: { propertyId: string }) => data)
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
    const scope = await authorizedScope(db, context.supabase, context.userId);

    const { data: property } = await db
      .from("properties")
      .select(
        "id, address, city, state, zip, status, listing_status, listing_price, property_type, bedrooms, bathrooms, square_footage, description, seller_id, listing_agent_id, content_approval_status, compliance_status, listing_agent_engagement_status",
      )
      .eq("id", data.propertyId)
      .maybeSingle();
    if (!property) throw new Error("Listing not found.");
    if (scope.agentIds && !scope.agentIds.includes(property.listing_agent_id)) {
      throw new Error("You are not the Listing Agent for this property.");
    }
    // Details stay hidden until the agent accepts the engagement.
    if (
      scope.kind === "agent" &&
      (property.listing_agent_engagement_status ?? "none") !== "accepted"
    ) {
      throw new Error("Accept the Listing Agent engagement to view this property.");
    }

    const [{ data: seller }, { data: media }, { data: docs }] = await Promise.all([
      db
        .from("sellers")
        .select("id, full_name, exit_type, retained_shares")
        .eq("id", property.seller_id)
        .maybeSingle(),
      db
        .from("property_media")
        .select("url, caption, display_order, media_type")
        .eq("property_id", property.id)
        .eq("media_type", "photo")
        .order("display_order", { ascending: true }),
      db
        .from("property_documents")
        .select("id, document_name, document_type, file_url, uploaded_at")
        .eq("property_id", property.id)
        .order("uploaded_at", { ascending: false }),
    ]);

    const photoPaths = ((media ?? []) as any[]).map((m) => m.url).filter(Boolean);
    let photos: { url: string; caption: string | null }[] = [];
    if (photoPaths.length > 0) {
      const { data: signed } = await supabaseAdmin.storage
        .from("property-media")
        .createSignedUrls(photoPaths, 60 * 60);
      const byPath = new Map<string, string>();
      ((signed ?? []) as any[]).forEach((s) => {
        if (s.path && s.signedUrl) byPath.set(s.path, s.signedUrl);
      });
      photos = ((media ?? []) as any[])
        .map((m) => ({ url: byPath.get(m.url) ?? "", caption: m.caption ?? null }))
        .filter((p) => !!p.url);
    }

    const documents: { id: string; name: string; type: string | null; url: string | null; uploadedAt: string | null }[] =
      [];
    for (const d of (docs ?? []) as any[]) {
      const { data: signed } = await supabaseAdmin.storage
        .from("property-documents")
        .createSignedUrl(d.file_url, 60 * 60);
      documents.push({
        id: d.id,
        name: d.document_name,
        type: d.document_type ?? null,
        url: signed?.signedUrl ?? null,
        uploadedAt: d.uploaded_at ?? null,
      });
    }

    return {
      property: {
        id: property.id,
        address: property.address,
        city: property.city,
        state: property.state,
        zip: property.zip,
        status: property.status,
        listing_status: property.listing_status ?? "forming",
        listing_price: property.listing_price,
        property_type: property.property_type,
        bedrooms: property.bedrooms,
        bathrooms: property.bathrooms,
        square_footage: property.square_footage,
        description: property.description,
        content_approval_status: property.content_approval_status ?? "not_submitted",
        compliance_status: property.compliance_status ?? "not_started",
      },
      seller: seller
        ? {
            full_name: seller.full_name ?? null,
            exit_type: seller.exit_type ?? null,
            retained_shares: seller.retained_shares ?? null,
          }
        : null,
      photos,
      documents,
    };
  });
