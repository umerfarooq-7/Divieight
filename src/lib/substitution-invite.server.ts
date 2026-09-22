import {
  buildInvitationText,
  responseWindow,
  type MySubstitutionInvitation,
} from "@/lib/substitution-invite";

/**
 * Substitution invitation engine (server-only).
 *
 * Rules enforced here:
 *  - exactly ONE candidate holds a live invitation per property at a time —
 *    the pipeline is never broadcast;
 *  - the candidate's own tethered Resident Agent is notified alongside them;
 *  - remaining pod members learn only that a slot is vacant and substitution
 *    is in progress — never who left or why;
 *  - decline/expiry cascades to the next candidate by Priority Rank and
 *    carries no consequence for the candidate;
 *  - nothing in here is reachable by an agent: no search, no selection, no
 *    request. The platform drives every step.
 */

type Db = { from: (t: string) => any };

async function audit(
  db: Db,
  row: {
    actorId: string | null;
    actorType: "buyer" | "agent" | "seller" | "broker";
    actionType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await db.from("audit_log").insert({
    actor_id: row.actorId,
    actor_type: row.actorType,
    action_type: row.actionType,
    entity_type: "property",
    entity_id: row.entityId ?? null,
    metadata: row.metadata ?? {},
  });
}

async function notify(db: Db, authUserId: string | null | undefined, message: string) {
  if (!authUserId) return;
  await db.from("notifications").insert({
    seller_id: authUserId,
    message,
    type: "substitution",
  });
}

interface PropertyRow {
  id: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  usage_tag: string | null;
  listing_price: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  square_feet: number | null;
  exit_type: string | null;
  retained_shares: number | null;
  listing_status: string | null;
  anticipated_closing_date: string | null;
}

const PROPERTY_COLS =
  "id, address, city, state, zip, usage_tag, listing_price, bedrooms, bathrooms, square_feet, exit_type, retained_shares, listing_status, anticipated_closing_date";

async function loadProperty(db: Db, propertyId: string): Promise<PropertyRow | null> {
  const { data } = await db.from("properties").select(PROPERTY_COLS).eq("id", propertyId).maybeSingle();
  return (data ?? null) as PropertyRow | null;
}

async function activeReservations(db: Db, propertyId: string) {
  const { data } = await db
    .from("pod_reservations")
    .select("id, buyer_account_id, shares_reserved")
    .eq("property_id", propertyId)
    .eq("status", "reserved");
  return (data ?? []) as { id: string; buyer_account_id: string; shares_reserved: number }[];
}

function openShares(property: PropertyRow, reserved: number) {
  const retained = property.exit_type === "hybrid_exit" ? (property.retained_shares ?? 0) : 0;
  return Math.max(0, 8 - retained - reserved);
}

/** Members of the pod, notified in generic terms only. */
async function notifyRemainingMembers(db: Db, propertyId: string, message: string) {
  const active = await activeReservations(db, propertyId);
  if (active.length === 0) return 0;
  const { data: buyers } = await db
    .from("buyer_accounts")
    .select("id, auth_user_id")
    .in("id", active.map((a) => a.buyer_account_id));
  for (const b of (buyers ?? []) as any[]) await notify(db, b.auth_user_id, message);
  return (buyers ?? []).length;
}

/** Buyers already offered this slice (any outcome) plus current pod members. */
async function excludedBuyerIds(db: Db, propertyId: string, extra: string[] = []) {
  const { data: invited } = await db
    .from("substitution_invitations")
    .select("buyer_account_id")
    .eq("property_id", propertyId);
  const active = await activeReservations(db, propertyId);
  return Array.from(
    new Set([
      ...extra.filter(Boolean),
      ...((invited ?? []) as any[]).map((i) => i.buyer_account_id),
      ...active.map((a) => a.buyer_account_id),
    ]),
  );
}

/**
 * Offer the slice to the single highest-priority compatible candidate.
 * No-ops when a live invitation already exists or the pod is full again.
 */
export async function inviteNextCandidate(
  db: Db,
  params: { propertyId: string; vacatedReservationId?: string | null; actorId: string | null },
) {
  const property = await loadProperty(db, params.propertyId);
  if (!property) return { invited: false, reason: "property_not_found" as const };

  const active = await activeReservations(db, params.propertyId);
  const reserved = active.reduce((s, a) => s + (a.shares_reserved ?? 0), 0);
  const available = openShares(property, reserved);
  if (available === 0) return { invited: false, reason: "pod_full" as const };

  const { data: live } = await db
    .from("substitution_invitations")
    .select("id, expires_at")
    .eq("property_id", params.propertyId)
    .eq("status", "pending")
    .limit(1);
  if (((live ?? []) as any[]).some((i) => new Date(i.expires_at).getTime() > Date.now())) {
    return { invited: false, reason: "invitation_outstanding" as const };
  }

  const exclude = await excludedBuyerIds(db, params.propertyId);
  const { findCandidates } = await import("@/lib/substitution.server");
  const [candidate] = await findCandidates(db as any, property as any, exclude, 1);
  if (!candidate) {
    await audit(db, {
      actorId: params.actorId,
      actorType: "buyer",
      actionType: "substitution.candidates_exhausted",
      entityId: property.id,
      metadata: { excluded_count: exclude.length, shares_open: available },
    });
    return { invited: false, reason: "no_candidate" as const };
  }

  const { data: buyer } = await db
    .from("buyer_accounts")
    .select("id, auth_user_id, tethered_resident_agent_id")
    .eq("id", candidate.buyerAccountId)
    .maybeSingle();

  const { data: seqRows } = await db
    .from("substitution_invitations")
    .select("sequence")
    .eq("property_id", params.propertyId)
    .order("sequence", { ascending: false })
    .limit(1);
  const sequence = (((seqRows ?? []) as any[])[0]?.sequence ?? 0) + 1;

  const win = responseWindow(property.anticipated_closing_date);
  const sharePrice = property.listing_price != null ? property.listing_price / 8 : null;

  const { data: invitation } = await db
    .from("substitution_invitations")
    .insert({
      property_id: property.id,
      vacated_reservation_id: params.vacatedReservationId ?? null,
      buyer_account_id: candidate.buyerAccountId,
      resident_agent_id: buyer?.tethered_resident_agent_id ?? null,
      sequence,
      shares_offered: 1,
      share_price: sharePrice,
      anticipated_closing_date: property.anticipated_closing_date,
      window_hours: win.hours,
      window_shortened: win.shortened,
      expires_at: win.expiresAt,
      status: "pending",
    })
    .select("id")
    .maybeSingle();

  const body = buildInvitationText({
    address: property.address,
    city: property.city,
    state: property.state,
    zip: property.zip,
    bedrooms: property.bedrooms,
    bathrooms: property.bathrooms,
    squareFeet: property.square_feet,
    usageTag: property.usage_tag,
    sharesOffered: available,
    sharePrice,
    anticipatedClosingDate: property.anticipated_closing_date,
    windowHours: win.hours,
    windowShortened: win.shortened,
    expiresAt: win.expiresAt,
  });

  await notify(db, buyer?.auth_user_id, body);

  // The candidate's own tethered Resident Agent is told too — same redaction.
  let agentNotified = false;
  if (buyer?.tethered_resident_agent_id) {
    const { data: agent } = await db
      .from("agents")
      .select("id, auth_user_id")
      .eq("id", buyer.tethered_resident_agent_id)
      .maybeSingle();
    if (agent?.auth_user_id) {
      await notify(
        db,
        agent.auth_user_id,
        `Your tethered buyer has been invited to take an available 1/8th share on ${property.address}, ${property.city}, ${property.state}. The pod is already formed — this would be joining an in-progress transaction. ${win.shortened ? `Shortened response window: ${win.hours} hours.` : `Response window: ${win.hours} hours.`}`,
      );
      agentNotified = true;
    }
  }

  await audit(db, {
    actorId: params.actorId,
    actorType: "buyer",
    actionType: "substitution.invitation_sent",
    entityId: property.id,
    metadata: {
      invitation_id: (invitation as any)?.id ?? null,
      sequence,
      buyer_account_id: candidate.buyerAccountId,
      priority_rank: candidate.priorityRank,
      priority_rank_timestamp: candidate.priorityRankTimestamp,
      matched_on: candidate.matchedOn,
      window_hours: win.hours,
      window_shortened: win.shortened,
      expires_at: win.expiresAt,
      resident_agent_notified: agentNotified,
      shares_offered: 1,
      share_price: sharePrice,
    },
  });

  return { invited: true, invitationId: (invitation as any)?.id ?? null, sequence };
}

/** Called the moment a slice vacates (withdrawal OR Default). */
export async function openSubstitution(
  db: Db,
  params: {
    propertyId: string;
    vacatedReservationId?: string | null;
    actorId: string | null;
    cause: "withdrawal" | "default";
  },
) {
  // Remaining members: no name, no reason, no KYO detail.
  const notified = await notifyRemainingMembers(
    db,
    params.propertyId,
    "A share in your pod is currently vacant. Substitution is in progress and we'll confirm as soon as the pod is complete again.",
  );

  await audit(db, {
    actorId: params.actorId,
    actorType: "buyer",
    actionType: "substitution.members_notified",
    entityId: params.propertyId,
    metadata: {
      members_notified: notified,
      // Cause is recorded in the audit trail only — never in member-facing copy.
      cause: params.cause,
      disclosed_to_members: "vacancy_and_progress_only",
    },
  });

  return inviteNextCandidate(db, {
    propertyId: params.propertyId,
    vacatedReservationId: params.vacatedReservationId ?? null,
    actorId: params.actorId,
  });
}

/** Candidate accepts or declines. Decline carries no consequence. */
export async function respondToInvitation(
  db: Db,
  params: {
    invitationId: string;
    buyerAccountId: string;
    authUserId: string;
    response: "accepted" | "declined";
  },
) {
  const { data: invitation } = await db
    .from("substitution_invitations")
    .select("*")
    .eq("id", params.invitationId)
    .eq("buyer_account_id", params.buyerAccountId)
    .maybeSingle();
  if (!invitation) return { ok: false, reason: "not_found" as const };
  if (invitation.status !== "pending") return { ok: false, reason: "not_pending" as const };
  if (new Date(invitation.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: "expired" as const };
  }

  const respondedAt = new Date().toISOString();

  if (params.response === "declined") {
    await db
      .from("substitution_invitations")
      .update({ status: "declined", responded_at: respondedAt })
      .eq("id", invitation.id);
    await audit(db, {
      actorId: params.authUserId,
      actorType: "buyer",
      actionType: "substitution.invitation_declined",
      entityId: invitation.property_id,
      metadata: {
        invitation_id: invitation.id,
        sequence: invitation.sequence,
        consequence: "none",
      },
    });
    await inviteNextCandidate(db, {
      propertyId: invitation.property_id,
      vacatedReservationId: invitation.vacated_reservation_id,
      actorId: params.authUserId,
    });
    return { ok: true, reason: "declined" as const };
  }

  const property = await loadProperty(db, invitation.property_id);
  if (!property) return { ok: false, reason: "not_found" as const };
  const active = await activeReservations(db, invitation.property_id);
  const reserved = active.reduce((s, a) => s + (a.shares_reserved ?? 0), 0);
  if (openShares(property, reserved) < 1) {
    await db
      .from("substitution_invitations")
      .update({ status: "superseded", responded_at: respondedAt })
      .eq("id", invitation.id);
    return { ok: false, reason: "pod_full" as const };
  }

  const { data: buyer } = await db
    .from("buyer_accounts")
    .select("id, liquidity_verified")
    .eq("id", params.buyerAccountId)
    .maybeSingle();
  if (!buyer?.liquidity_verified) return { ok: false, reason: "not_liquidity_verified" as const };

  const { data: inserted } = await db
    .from("pod_reservations")
    .insert({
      property_id: invitation.property_id,
      buyer_account_id: params.buyerAccountId,
      shares_reserved: invitation.shares_offered ?? 1,
      status: "reserved",
    })
    .select("id")
    .maybeSingle();

  await db
    .from("substitution_invitations")
    .update({ status: "accepted", responded_at: respondedAt })
    .eq("id", invitation.id);

  const afterActive = await activeReservations(db, invitation.property_id);
  const afterReserved = afterActive.reduce((s, a) => s + (a.shares_reserved ?? 0), 0);
  const complete = openShares(property, afterReserved) === 0;

  if (complete && property.listing_status !== "system_lock") {
    await db
      .from("properties")
      .update({ listing_status: "system_lock" })
      .eq("id", property.id);
  }

  // Substitution changes who holds a unit — refresh the cap table.
  {
    const { syncCapTable } = await import("@/lib/entity-genesis.server");
    await syncCapTable(db as never, {
      propertyId: property.id,
      actorId: params.authUserId,
      reason: "substitution_accepted",
    });
  }

  await audit(db, {
    actorId: params.authUserId,
    actorType: "buyer",
    actionType: "substitution.invitation_accepted",
    entityId: property.id,
    metadata: {
      invitation_id: invitation.id,
      sequence: invitation.sequence,
      reservation_id: (inserted as any)?.id ?? null,
      pod_complete: complete,
    },
  });

  // A Substitute Member funds their pro-rata earnest money on the SAME
  // timeline as the member they replace — a condition of installation.
  {
    // Link to the obligation of the member being replaced, when there is one.
    let replacesObligationId: string | null = null;
    if (invitation.vacated_reservation_id) {
      const { data: vacated } = await db
        .from("pod_reservations")
        .select("buyer_account_id")
        .eq("id", invitation.vacated_reservation_id)
        .maybeSingle();
      if (vacated?.buyer_account_id) {
        const { data: prior } = await db
          .from("earnest_money_obligations")
          .select("id")
          .eq("property_id", property.id)
          .eq("buyer_account_id", vacated.buyer_account_id)
          .maybeSingle();
        replacesObligationId = prior?.id ?? null;
      }
    }

    const { createSubstituteObligation } = await import("@/lib/earnest-money.server");
    await createSubstituteObligation(db as never, {
      propertyId: property.id,
      buyerAccountId: params.buyerAccountId,
      shares: invitation.shares_offered ?? 1,
      actorId: params.authUserId,
      replacesObligationId,
    });
  }

  if (complete) {
    await notifyRemainingMembers(
      db,
      invitation.property_id,
      "Your pod is complete again — the vacant share has been filled and the transaction continues on schedule.",
    );
    await audit(db, {
      actorId: params.authUserId,
      actorType: "buyer",
      actionType: "substitution.completed",
      entityId: property.id,
      metadata: { invitation_id: invitation.id },
    });
  }

  return { ok: true, reason: "accepted" as const, podComplete: complete };
}

/** Bounded expiry sweep: expire lapsed invitations and cascade to the next candidate. */
export async function runSubstitutionExpirySweep(db: Db, limit = 100) {
  const { data: rows } = await db
    .from("substitution_invitations")
    .select("id, property_id, vacated_reservation_id, sequence, buyer_account_id")
    .eq("status", "pending")
    .lte("expires_at", new Date().toISOString())
    .limit(limit);

  const pending = (rows ?? []) as any[];
  let cascaded = 0;

  for (const inv of pending) {
    await db
      .from("substitution_invitations")
      .update({ status: "expired", responded_at: new Date().toISOString() })
      .eq("id", inv.id);
    await audit(db, {
      actorId: null,
      actorType: "buyer",
      actionType: "substitution.invitation_expired",
      entityId: inv.property_id,
      metadata: {
        invitation_id: inv.id,
        sequence: inv.sequence,
        buyer_account_id: inv.buyer_account_id,
        consequence: "none",
      },
    });
    const res = await inviteNextCandidate(db, {
      propertyId: inv.property_id,
      vacatedReservationId: inv.vacated_reservation_id,
      actorId: null,
    });
    if (res.invited) cascaded += 1;
  }

  return { expired: pending.length, cascaded };
}

/** The invitations addressed to one buyer account, with their rendered body. */
export async function invitationsForBuyer(
  db: Db,
  buyerAccountId: string,
): Promise<MySubstitutionInvitation[]> {
  const { data: rows } = await db
    .from("substitution_invitations")
    .select("*")
    .eq("buyer_account_id", buyerAccountId)
    .order("invited_at", { ascending: false })
    .limit(20);

  const invitations = (rows ?? []) as any[];
  if (invitations.length === 0) return [];

  const { data: props } = await db
    .from("properties")
    .select(PROPERTY_COLS)
    .in("id", Array.from(new Set(invitations.map((i) => i.property_id))));
  const byId = new Map(((props ?? []) as any[]).map((p) => [p.id, p as PropertyRow]));

  return invitations.flatMap((i) => {
    const p = byId.get(i.property_id);
    if (!p) return [];
    return [
      {
        id: i.id,
        propertyId: p.id,
        address: p.address,
        city: p.city,
        state: p.state,
        zip: p.zip,
        sharesOffered: i.shares_offered ?? 1,
        sharePrice: i.share_price ?? null,
        anticipatedClosingDate: i.anticipated_closing_date ?? null,
        windowHours: i.window_hours ?? 72,
        windowShortened: Boolean(i.window_shortened),
        expiresAt: i.expires_at,
        invitedAt: i.invited_at,
        status:
          i.status === "pending" && new Date(i.expires_at).getTime() <= Date.now()
            ? "expired"
            : i.status,
        body: buildInvitationText({
          address: p.address,
          city: p.city,
          state: p.state,
          zip: p.zip,
          bedrooms: p.bedrooms,
          bathrooms: p.bathrooms,
          squareFeet: p.square_feet,
          usageTag: p.usage_tag,
          sharesOffered: i.shares_offered ?? 1,
          sharePrice: i.share_price ?? null,
          anticipatedClosingDate: i.anticipated_closing_date ?? null,
          windowHours: i.window_hours ?? 72,
          windowShortened: Boolean(i.window_shortened),
          expiresAt: i.expires_at,
        }),
      } satisfies MySubstitutionInvitation,
    ];
  });
}
