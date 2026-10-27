import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type {
  BuyerPodDetails,
  MyReservation,
  PodComposition,
  ReservationEligibility,
  ReservationResult,
} from "@/lib/pod";

/** Public read: how many of the eight shares are taken. No buyer PII is exposed. */
export const getPodComposition = createServerFn({ method: "GET" })
  .inputValidator((data: { propertyId: string }) => ({ propertyId: String(data.propertyId) }))
  .handler(async ({ data }): Promise<PodComposition | null> => {
    const { fetchPodComposition } = await import("@/lib/pod.server");
    return fetchPodComposition(data.propertyId);
  });

/** Mini Liquidity Gate + availability check for a specific property. */
export const checkReservationEligibility = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => ({ propertyId: String(data.propertyId) }))
  .handler(async ({ data, context }): Promise<ReservationEligibility> => {
    const { fetchPodComposition } = await import("@/lib/pod.server");
    const { supabase, userId } = context;
    const base = {
      liquidityStatus: null as string | null,
      targetBudget: null as number | null,
      existingShares: 0,
      composition: null as PodComposition | null,
    };

    // tether_status post-dates the generated types; loose client here.
    const { data: buyer } = await (supabase as any)
      .from("buyer_accounts")
      .select("id, liquidity_verified, liquidity_status, target_budget, tether_status")
      .eq("auth_user_id", userId)
      .maybeSingle();

    if (!buyer) return { ok: false, reason: "no_buyer_account", ...base };

    const composition = await fetchPodComposition(data.propertyId);
    const info = {
      liquidityStatus: buyer.liquidity_status ?? null,
      targetBudget: buyer.target_budget ?? null,
      existingShares: 0,
      composition,
    };

    if (!composition) return { ok: false, reason: "not_found", ...info };

    const { data: mine } = await supabase
      .from("pod_reservations")
      .select("shares_reserved")
      .eq("property_id", data.propertyId)
      .eq("buyer_account_id", buyer.id)
      .eq("status", "reserved");

    info.existingShares = (mine ?? []).reduce((s, r) => s + (r.shares_reserved ?? 0), 0);

    if (!buyer.liquidity_verified) return { ok: false, reason: "not_liquidity_verified", ...info };
    // Browsing stays open in Pending Tether; only commitment waits on the tether.
    if ((buyer as { tether_status?: string | null }).tether_status !== "tethered")
      return { ok: false, reason: "not_tethered", ...info };
    if (info.existingShares > 0) return { ok: false, reason: "already_reserved", ...info };
    if (composition.availableShares < 1) return { ok: false, reason: "sold_out", ...info };

    return { ok: true, reason: "ok", ...info };
  });

/**
 * Creates the reservation, applies the Hard-Lock on first reservation
 * (freezing price-per-share / commission fields) and flips the listing to
 * `system_lock` when all eight shares are accounted for.
 */
export const createReservation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { propertyId: string; replacementAgentId?: string | null; autoAssignAgent?: boolean }) => ({
      propertyId: String(data.propertyId),
      // Only used to resolve a dual-agency conflict on this property.
      replacementAgentId: data.replacementAgentId ? String(data.replacementAgentId) : null,
      autoAssignAgent: data.autoAssignAgent === true,
    }),
  )
  .handler(async ({ data, context }): Promise<ReservationResult> => {
    const { fetchPodComposition } = await import("@/lib/pod.server");
    const { supabase, userId } = context;
    const fail = (reason: ReservationResult["reason"]): ReservationResult => ({
      ok: false,
      reason,
      reservationId: null,
      composition: null,
      systemLocked: false,
    });

    const { data: buyer } = await (supabase as any)
      .from("buyer_accounts")
      .select("id, liquidity_verified, tether_status")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!buyer) return fail("no_buyer_account");
    if (!buyer.liquidity_verified) return fail("not_liquidity_verified");
    // Browsing stays open in Pending Tether; only commitment waits on the tether.
    if ((buyer as { tether_status?: string | null }).tether_status !== "tethered")
      return fail("not_tethered");

    const before = await fetchPodComposition(data.propertyId);
    if (!before) return fail("not_found");
    if (before.availableShares < 1) return fail("sold_out");

    const { data: mine } = await supabase
      .from("pod_reservations")
      .select("id")
      .eq("property_id", data.propertyId)
      .eq("buyer_account_id", buyer.id)
      .eq("status", "reserved")
      .limit(1);
    if ((mine?.length ?? 0) > 0) return fail("already_reserved");

    // Dual-agency checkpoint 4: the buyer's agent may not hold THIS listing.
    // Nothing is reserved until the buyer has a different agent for this
    // property; their other properties keep the account-level agent.
    const { supabaseAdmin: adminDb } = await import("@/integrations/supabase/admin.server");
    const propertyAgent = await import("@/lib/property-agent.server");
    const { data: agentInfo } = await (adminDb as any)
      .from("buyer_accounts")
      .select("id, tethered_resident_agent_id, referring_agent_id, primary_target_market")
      .eq("id", buyer.id)
      .maybeSingle();
    const conflict = agentInfo
      ? await propertyAgent.reservationAgentConflict(adminDb as never, agentInfo, data.propertyId)
      : null;

    let inserted: { id: string } | null = null;
    let agentChange: ReservationResult["agentChange"] = null;
    if (conflict) {
      const resolving = Boolean(data.replacementAgentId) || data.autoAssignAgent;
      const { logDualAgency } = await import("@/lib/dual-agency");
      await logDualAgency(adminDb as never, {
        actorId: userId,
        point: "reservation",
        agentId: conflict.conflicting_agent_id,
        propertyId: data.propertyId,
        buyerAccountId: buyer.id,
        resolution: resolving
          ? "buyer re-tethered for this property before the reservation finalized"
          : "reservation paused — buyer asked to choose a different agent for this property",
      });
      if (!resolving) return { ...fail("dual_agency_conflict"), conflict };

      const newAgentId =
        data.replacementAgentId ??
        (await propertyAgent.pickReplacementAgent(adminDb as never, {
          listingAgentId: conflict.conflicting_agent_id,
          market: agentInfo?.primary_target_market ?? null,
        }));
      if (!newAgentId)
        return {
          ...fail("no_replacement_agent"),
          conflict,
          message: "No eligible agent is available right now — choose an agent yourself or contact support.",
        };
      const problem = await propertyAgent.replacementAgentProblem(adminDb as never, newAgentId, conflict.conflicting_agent_id);
      if (problem) return { ...fail("invalid_replacement_agent"), conflict, message: problem };

      // One transaction: the per-property agent and the reservation together.
      const { data: reservationId, error: rpcError } = await (supabase as any).rpc("reserve_share_with_agent", {
        p_property_id: data.propertyId,
        p_resident_agent_id: newAgentId,
        p_replaced_agent_id: conflict.conflicting_agent_id,
        p_referral_preserved: conflict.referring_agent_id_same,
      });
      if (rpcError || !reservationId) return { ...fail("error"), message: rpcError?.message ?? null };
      inserted = { id: String(reservationId) };
      const { data: newAgent } = await (adminDb as any).from("agents").select("full_name").eq("id", newAgentId).maybeSingle();
      agentChange = {
        newAgentId,
        newAgentName: newAgent?.full_name ?? null,
        referralPreserved: conflict.referring_agent_id_same,
      };
      await propertyAgent.announcePropertyAgentChange(adminDb as never, {
        actorId: userId,
        buyerAccountId: buyer.id,
        propertyId: data.propertyId,
        reservationId: inserted.id,
        replacedAgentId: conflict.conflicting_agent_id,
        newAgentId,
        referralPreserved: conflict.referring_agent_id_same,
        chosenBy: data.replacementAgentId ? "buyer" : "platform",
      });
    } else {
      const { data: row, error } = await supabase
        .from("pod_reservations")
        .insert({
          property_id: data.propertyId,
          buyer_account_id: buyer.id,
          shares_reserved: 1,
          status: "reserved",
        })
        .select("id")
        .maybeSingle();

      if (error || !row) return fail("error");
      inserted = row;
    }

    const after = await fetchPodComposition(data.propertyId);
    const systemLocked = (after?.availableShares ?? 1) === 0;

    // Hard-Lock + System Lock need to bypass seller-scoped RLS on properties.
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");

      const applyHardLock = !before.hardLocked;
      const applySystemLock = systemLocked && before.listingStatus !== "system_lock";
      if (applyHardLock || applySystemLock) {
        await supabaseAdmin
          .from("properties")
          .update({
            ...(applyHardLock
              ? { hard_locked: true, hard_locked_at: new Date().toISOString() }
              : {}),
            ...(applySystemLock ? { listing_status: "system_lock" as const } : {}),
          })
          .eq("id", data.propertyId);
      }

      // Entity Genesis Stage 1 reacts to the Hard-Lock trigger. It never
      // touches the price-freeze itself; the cap table then stays live on
      // every subsequent reservation.
      const { ensureDigitalGenesis } = await import("@/lib/entity-genesis.server");
      await ensureDigitalGenesis(supabaseAdmin as never, {
        propertyId: data.propertyId,
        actorId: userId,
        reason: applyHardLock ? "hard_lock" : "share_reserved",
      });

      // Dual-agency safeguard at Hard-Lock. Should never fire; if it does,
      // it logs a compliance alert because it means an earlier check missed.
      const { verifyPodDualAgency } = await import("@/lib/dual-agency");
      await verifyPodDualAgency(supabaseAdmin as any, {
        propertyId: data.propertyId,
        actorId: userId,
      });
      // Required documents already on file still need this buyer's
      // acknowledgment — tell them (and their agent) right away.
      const { notifyOutstandingDiligence } = await import("@/lib/due-diligence-notify.server");
      await notifyOutstandingDiligence(supabaseAdmin as never, {
        propertyId: data.propertyId,
        buyerAccountId: buyer.id,
      });
    } catch {
      // reservation stands even if the lock write fails; maintenance can retry
    }


    await supabase.from("audit_log").insert({
      actor_id: userId,
      actor_type: "buyer",
      action_type: "buyer.share_reserved",
      entity_type: "property",
      entity_id: data.propertyId,
      metadata: {
        reservation_id: inserted.id,
        shares_reserved: 1,
        hard_lock_applied: !before.hardLocked,
        system_lock: systemLocked,
      } as never,
    });

    return {
      ok: true,
      reason: "ok",
      reservationId: inserted.id,
      composition: after,
      systemLocked,
      agentChange,
    };
  });

/** "My Reservations" for the buyer dashboard. */
export const getMyReservations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MyReservation[]> => {
    const { supabase, userId } = context;

    const { data: buyer } = await supabase
      .from("buyer_accounts")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!buyer) return [];

    const { data: rows } = await supabase
      .from("pod_reservations")
      .select(
        "id, property_id, shares_reserved, status, reserved_at, properties ( address, city, state, zip, listing_price, listing_status )",
      )
      .eq("buyer_account_id", buyer.id)
      .order("reserved_at", { ascending: false });

    return (rows ?? []).map((r) => {
      const p = (r as unknown as { properties: Record<string, unknown> | null }).properties;
      return {
        id: r.id,
        property_id: r.property_id,
        shares_reserved: r.shares_reserved,
        status: r.status,
        reserved_at: r.reserved_at,
        address: (p?.address as string) ?? "Property",
        city: (p?.city as string) ?? "",
        state: (p?.state as string) ?? "",
        zip: (p?.zip as string) ?? "",
        listing_price: (p?.listing_price as number | null) ?? null,
        listing_status: (p?.listing_status as string) ?? "forming",
      };
    });
  });

/**
 * Withdraw a reservation before closing. Frees the slice on the Eight-Slices
 * Tracker, releases System Lock if the pod was full, and opens the Member
 * Substitution Pipeline (candidate identification is logged for the ops team).
 */
export const withdrawReservation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { reservationId: string }) => ({
    reservationId: String(data.reservationId),
  }))
  .handler(async ({ data, context }): Promise<{ ok: boolean; reason: string }> => {
    const { supabase, userId } = context;

    const { data: buyer } = await supabase
      .from("buyer_accounts")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!buyer) return { ok: false, reason: "no_buyer_account" };

    const { data: reservation } = await supabase
      .from("pod_reservations")
      .select("id, property_id, status, shares_reserved")
      .eq("id", data.reservationId)
      .eq("buyer_account_id", buyer.id)
      .maybeSingle();
    if (!reservation) return { ok: false, reason: "not_found" };
    if (reservation.status !== "reserved") return { ok: false, reason: "not_active" };

    // Once the pod reaches System Lock the slice can no longer be self-released;
    // exits run through the Member Substitution Pipeline instead.
    {
      const { fetchPodComposition } = await import("@/lib/pod.server");
      const comp = await fetchPodComposition(reservation.property_id);
      if (comp && comp.listingStatus !== "forming") {
        return { ok: false, reason: "pod_locked" };
      }
    }

    const { error } = await supabase
      .from("pod_reservations")
      .update({ status: "withdrawn" })
      .eq("id", reservation.id)
      .eq("buyer_account_id", buyer.id);
    if (error) return { ok: false, reason: "error" };

    // Releasing System Lock needs to bypass seller-scoped RLS on properties.
    let candidateCount = 0;
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
      const { data: property } = await supabaseAdmin
        .from("properties")
        .select(
          "id, address, city, state, zip, usage_tag, listing_price, listing_status, exit_type, retained_shares",
        )
        .eq("id", reservation.property_id)
        .maybeSingle();

      if (property?.listing_status === "system_lock") {
        await supabaseAdmin
          .from("properties")
          .update({ listing_status: "forming" as const })
          .eq("id", property.id);
      }

      if (property) {
        // Cap table always reflects the current holders.
        const { syncCapTable } = await import("@/lib/entity-genesis.server");
        await syncCapTable(supabaseAdmin as never, {
          propertyId: property.id,
          actorId: userId,
          reason: "reservation_withdrawn",
        });

        // Platform-driven substitution: remaining members get a redacted
        // vacancy notice, and exactly one candidate is invited at a time.
        const { openSubstitution } = await import("@/lib/substitution-invite.server");
        const result = await openSubstitution(supabaseAdmin as never, {
          propertyId: property.id,
          vacatedReservationId: reservation.id,
          actorId: userId,
          cause: "withdrawal",
        });
        candidateCount = result.invited ? 1 : 0;

        await supabase.from("audit_log").insert({
          actor_id: userId,
          actor_type: "buyer",
          action_type: "substitution.pipeline_opened",
          entity_type: "property",
          entity_id: property.id,
          metadata: {
            reservation_id: reservation.id,
            invitation_sent: result.invited,
            invitation_id: result.invited ? result.invitationId : null,
            outcome: result.invited ? "invited" : result.reason,
          } as never,
        });
      }
    } catch {
      // withdrawal stands even if lock release / candidate scan fails
    }

    await supabase.from("audit_log").insert({
      actor_id: userId,
      actor_type: "buyer",
      action_type: "buyer.reservation_withdrawn",
      entity_type: "property",
      entity_id: reservation.property_id,
      metadata: {
        reservation_id: reservation.id,
        shares_released: reservation.shares_reserved,
        candidates_identified: candidateCount,
      } as never,
    });

    return { ok: true, reason: "ok" };
  });

/**
 * Buyer-facing pod detail. Only a buyer holding a reservation in this pod can
 * read it, and other members are de-identified. The Heavy Lifting Agent's
 * Master Briefcase thread is intentionally NOT exposed here (see
 * agent.pods.$id.briefcase.tsx).
 */
export const getMyPodDetails = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => ({ propertyId: String(data.propertyId) }))
  .handler(async ({ data, context }): Promise<BuyerPodDetails | { error: string }> => {
    const { fetchPodComposition } = await import("@/lib/pod.server");
    const { supabase, userId } = context;

    const { data: buyer } = await (supabase as any)
      .from("buyer_accounts")
      .select("id, priority_rank, priority_rank_timestamp, tethered_resident_agent_id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!buyer) return { error: "Buyer account not found." };
    {
      // Show the buyer's agent on THIS property (per-property agent where one applies).
      const { supabaseAdmin: adminForAgent } = await import("@/integrations/supabase/admin.server");
      const { effectiveAgentId } = await import("@/lib/property-agent.server");
      buyer.tethered_resident_agent_id = await effectiveAgentId(
        adminForAgent as never,
        buyer.id,
        data.propertyId,
        buyer.tethered_resident_agent_id,
      );
    }

    const { data: mine } = await supabase
      .from("pod_reservations")
      .select("id, shares_reserved, status, reserved_at")
      .eq("property_id", data.propertyId)
      .eq("buyer_account_id", buyer.id)
      .order("reserved_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!mine) return { error: "You don't hold a reservation in this pod." };

    const composition = await fetchPodComposition(data.propertyId);
    const { supabaseAdmin: rawAdmin } = await import("@/integrations/supabase/admin.server");
    // Pod/agent tables post-date the generated types; use a loose client here.
    const supabaseAdmin = rawAdmin as unknown as {
      from: (t: string) => any;
      storage: (typeof rawAdmin)["storage"];
    };

    const { data: property } = await supabaseAdmin
      .from("properties")
      .select("id, address, city, state, zip, listing_price, property_type, exit_type, retained_shares, listing_status")
      .eq("id", data.propertyId)
      .maybeSingle();
    if (!property) return { error: "Property not found." };

    let photoUrl: string | null = null;
    const { data: media } = await supabaseAdmin
      .from("property_media")
      .select("url")
      .eq("property_id", data.propertyId)
      .eq("media_type", "photo")
      .order("display_order", { ascending: true })
      .limit(1);
    const path = media?.[0]?.url ?? null;
    if (path) {
      const { data: signed } = await supabaseAdmin.storage
        .from("property-media")
        .createSignedUrl(path, 60 * 60);
      photoUrl = signed?.signedUrl ?? null;
    }

    const { data: reservations } = await supabaseAdmin
      .from("pod_reservations")
      .select("buyer_account_id, shares_reserved, reserved_at")
      .eq("property_id", data.propertyId)
      .eq("status", "reserved")
      .order("reserved_at", { ascending: true });

    const members = (reservations ?? []).map((r: any, i: number) => ({
      label: r.buyer_account_id === buyer.id ? "You" : `Member ${i + 1}`,
      shares: r.shares_reserved ?? 1,
      reservedAt: r.reserved_at ?? null,
      isMine: r.buyer_account_id === buyer.id,
    }));

    const { data: pod } = await supabaseAdmin
      .from("pods")
      .select("*")
      .eq("property_id", data.propertyId)
      .maybeSingle();

    const agentIds = [buyer.tethered_resident_agent_id, pod?.heavy_lifting_agent_id].filter(
      Boolean,
    ) as string[];
    const names = new Map<string, string>();
    if (agentIds.length) {
      const { data: rows } = await supabaseAdmin
        .from("agents")
        .select("id, full_name")
        .in("id", agentIds);
      for (const a of rows ?? []) names.set(a.id, a.full_name);
    }

    let holdBrokerName: string | null = null;
    if (pod?.closing_hold_placed_by) {
      const { data: b } = await supabaseAdmin
        .from("brokers")
        .select("brokerage_name")
        .eq("id", pod.closing_hold_placed_by)
        .maybeSingle();
      holdBrokerName = (b as any)?.brokerage_name ?? null;
    }

    const retained =
      property.exit_type === "hybrid_exit" ? (property.retained_shares ?? 0) : 0;

    return {
      propertyId: property.id,
      address: property.address,
      city: property.city,
      state: property.state,
      zip: property.zip ?? "",
      listingPrice: property.listing_price ?? null,
      propertyType: property.property_type ?? null,
      photoUrl,
      composition:
        composition ?? {
          propertyId: property.id,
          totalShares: 8,
          retainedShares: retained,
          reservedShares: members.reduce((s: number, m: { shares: number }) => s + m.shares, 0),
          availableShares: Math.max(
            0,
            8 - retained - members.reduce((s: number, m: { shares: number }) => s + m.shares, 0),
          ),
          hardLocked: false,
          listingStatus: property.listing_status,
          slots: [],
        },
      myShares: mine.shares_reserved ?? 0,
      myStatus: mine.status,
      myReservedAt: mine.reserved_at ?? null,
      priorityRank: buyer.priority_rank ?? null,
      priorityRankTimestamp: buyer.priority_rank_timestamp ?? null,
      members,
      tetheredAgentName: buyer.tethered_resident_agent_id
        ? (names.get(buyer.tethered_resident_agent_id) ?? null)
        : null,
      heavyLiftingAgentName:
        pod?.hla_status === "accepted" && pod.heavy_lifting_agent_id
          ? (names.get(pod.heavy_lifting_agent_id) ?? null)
          : null,
      hlaStatus: pod?.hla_status ?? null,
      // Broker Closing Hold — MONTH 4: the closing engine must block while active.
      closingHold: {
        active: Boolean(pod?.closing_hold_active),
        reason: pod?.closing_hold_reason ?? null,
        placedAt: pod?.closing_hold_placed_at ?? null,
        placedByBrokerName: holdBrokerName,
        liftedAt: pod?.closing_hold_lifted_at ?? null,
      },
    };
  });
