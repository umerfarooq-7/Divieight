import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { formatMarkets } from "@/lib/markets";
import {
  HLA_ACCEPTANCE_WINDOW_DAYS,
  type Briefcase,
  type EligibleAgent,
  type HlaInvitation,
  type PodSelectionDetail,
  type PodSummary,
  type SelectionCycle,
} from "@/lib/hla";

/**
 * Heavy Lifting Agent (HLA) selection workflow — Rev 44, two-phase.
 *
 * TRIGGER POINT SUBSTITUTION (flagged for the spec owner):
 * the spec says selection happens "after the pod reaches Hard-Lock". The FSB
 * defines Hard-Lock as freezing on the FIRST share reservation, when the pod
 * may still have a single tethered Resident Agent. This build therefore uses a
 * practical trigger: selection becomes available at System-Lock (all 8 shares
 * reserved), so the full roster of tethered Resident Agents exists before
 * anyone is picked. CONFIRM with the client whether literal first-share
 * Hard-Lock timing is intended — if so, change SELECTION_TRIGGER below.
 *
 * PHASE 2 (future): after the Launch Period — the earlier of the first 25 pods
 * reaching this selection trigger, or 12 months from the first pod's trigger —
 * replace/extend the manual pick with an automated weighted calculation using
 * platform tenure and transaction productivity. Weighting parameters are
 * versioned and the version used at each selection is recorded
 * (pod_hla_selections.weighting_version). Pods assigned during Phase 1 are NOT
 * retroactively reassigned when Phase 2 ships. Phase 2 must also support a
 * Manager override with a required recorded basis, logged distinctly as an
 * override rather than an ordinary selection.
 *
 * Independence: nothing about subscription tier, payment to the Platform, or
 * any commercial relationship with the Platform may influence selection. No
 * such field exists in this module by design.
 */

const SELECTION_TRIGGER = "system_lock";

type Db = { from: (t: string) => any };

async function admin(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function requireAdmin(supabase: any, userId: string) {
  const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  return Boolean(data);
}

async function agentFor(db: Db, userId: string) {
  const { data } = await db
    .from("agents")
    .select("id, auth_user_id, full_name, broker_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  return data ?? null;
}

function deadlineFrom(iso: Date) {
  return new Date(iso.getTime() + HLA_ACCEPTANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** Ensure a pods row exists for every property that has reached the trigger. */
async function syncPods(db: Db) {
  const { data: properties } = await db
    .from("properties")
    .select("id, address, city, state, zip, listing_status")
    .eq("listing_status", SELECTION_TRIGGER);

  for (const p of properties ?? []) {
    const { data: existing } = await db
      .from("pods")
      .select("id")
      .eq("property_id", p.id)
      .maybeSingle();
    if (existing) continue;
    const { data: created } = await db
      .from("pods")
      .insert({ property_id: p.id, hla_status: "awaiting_selection" })
      .select("id")
      .maybeSingle();
    if (created?.id) {
      await db.from("notifications").insert({
        seller_id: null,
        message: `Pod for ${p.address}, ${p.city} is ready — select a Heavy Lifting Agent.`,
        type: "hla_selection",
      });
    }
  }
  return properties ?? [];
}

/**
 * Eligible pool: EXCLUSIVELY the Resident Agents already tethered to buyer
 * accounts holding an active reservation inside this pod. Mirrored by a
 * database trigger so a direct write cannot bypass it.
 *
 * Size is whatever the real distinct agent count is — NEVER assumed to be 8.
 * A pod legitimately has fewer tethered agents than shares when (a) one agent
 * represents multiple buyers in the pod (allowed, counted once here and
 * surfaced via buyersInPod), or (b) a Hybrid Exit seller retains shares, which
 * have no buyer and therefore no tethered Resident Agent at all.
 */
async function eligiblePool(db: Db, propertyId: string): Promise<EligibleAgent[]> {
  const { data: reservations } = await db
    .from("pod_reservations")
    .select("buyer_account_id, shares_reserved, reserved_at, status")
    .eq("property_id", propertyId)
    .eq("status", "reserved");

  const buyerIds = (reservations ?? []).map((r: any) => r.buyer_account_id);
  if (buyerIds.length === 0) return [];

  const { data: buyerRows } = await db
    .from("buyer_accounts")
    .select("id, tethered_resident_agent_id")
    .in("id", buyerIds);
  // The pool is each buyer's agent on THIS property, so a Listing Agent who was
  // replaced here (per-property agent) never enters it.
  const { withPropertyAgents } = await import("@/lib/property-agent.server");
  const buyers = await withPropertyAgents(db, propertyId, (buyerRows ?? []) as any[]);

  const counts = new Map<string, number>();
  for (const b of buyers ?? []) {
    if (!b.tethered_resident_agent_id) continue;
    counts.set(b.tethered_resident_agent_id, (counts.get(b.tethered_resident_agent_id) ?? 0) + 1);
  }
  if (counts.size === 0) return [];

  const { data: agents } = await db
    .from("agents")
    .select("id, full_name, license_state, markets, created_at, broker_id, eo_lapsed, eo_expires_at")
    .in("id", [...counts.keys()]);

  // An agent whose E&O coverage has lapsed may not be selected as Heavy
  // Lifting Agent until coverage is restored.
  const { eoBlocksNewWork } = await import("@/lib/eo-expiry");
  const covered = (agents ?? []).filter((a: any) => !eoBlocksNewWork(a));

  const brokerIds = (agents ?? []).map((a: any) => a.broker_id).filter(Boolean);
  const brokerNames = new Map<string, string>();
  if (brokerIds.length) {
    const { data: brokers } = await db
      .from("brokers")
      .select("id, brokerage_name")
      .in("id", brokerIds);
    for (const b of brokers ?? []) brokerNames.set(b.id, b.brokerage_name);
  }

  // Informational only in Phase 1 — never used in a scoring formula yet.
  const closed = new Map<string, number>();
  const { data: closedRows } = await db
    .from("pods")
    .select("heavy_lifting_agent_id")
    .eq("hla_status", "accepted")
    .in("heavy_lifting_agent_id", [...counts.keys()]);
  for (const r of closedRows ?? []) {
    if (r.heavy_lifting_agent_id)
      closed.set(r.heavy_lifting_agent_id, (closed.get(r.heavy_lifting_agent_id) ?? 0) + 1);
  }

  const now = Date.now();
  return covered.map((a: any) => ({
    agentId: a.id,
    fullName: a.full_name,
    licenseState: a.license_state ?? "—",
    serviceArea: formatMarkets(a.markets),
    joinedAt: a.created_at,
    tenureDays: Math.max(
      0,
      Math.floor((now - new Date(a.created_at).getTime()) / (24 * 60 * 60 * 1000)),
    ),
    closedTransactions: closed.get(a.id) ?? 0,
    brokerageName: a.broker_id ? (brokerNames.get(a.broker_id) ?? null) : null,
    buyersInPod: counts.get(a.id) ?? 0,
  }));
}

async function podSummary(db: Db, pod: any, property: any): Promise<PodSummary> {
  let heavyLifterName: string | null = null;
  if (pod.heavy_lifting_agent_id) {
    const { data: a } = await db
      .from("agents")
      .select("full_name")
      .eq("id", pod.heavy_lifting_agent_id)
      .maybeSingle();
    heavyLifterName = a?.full_name ?? null;
  }
  const eligible = await eligiblePool(db, pod.property_id);
  return {
    podId: pod.id,
    propertyId: pod.property_id,
    address: property?.address ?? "—",
    city: property?.city ?? "",
    state: property?.state ?? "",
    zip: property?.zip ?? "",
    listingStatus: property?.listing_status ?? "",
    hlaStatus: pod.hla_status,
    heavyLifterName,
    selectedAt: pod.selected_at ?? null,
    acceptanceDeadlineAt: pod.acceptance_deadline_at ?? null,
    eligibleCount: eligible.length,
    cycle: pod.selection_cycle ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* Admin (Manager) side                                                */
/* ------------------------------------------------------------------ */

export const listPods = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PodSummary[]> => {
    if (!(await requireAdmin(context.supabase, context.userId))) return [];
    const db = await admin();
    await syncPods(db);
    const { data: pods } = await db.from("pods").select("*").order("created_at", { ascending: false });
    const ids = (pods ?? []).map((p: any) => p.property_id);
    const props = new Map<string, any>();
    if (ids.length) {
      const { data: rows } = await db
        .from("properties")
        .select("id, address, city, state, zip, listing_status")
        .in("id", ids);
      for (const r of rows ?? []) props.set(r.id, r);
    }
    return Promise.all((pods ?? []).map((p: any) => podSummary(db, p, props.get(p.property_id))));
  });

export const getPodSelection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { podId: string }) => input)
  .handler(async ({ data, context }): Promise<PodSelectionDetail | null> => {
    if (!(await requireAdmin(context.supabase, context.userId))) return null;
    const db = await admin();
    const { data: pod } = await db.from("pods").select("*").eq("id", data.podId).maybeSingle();
    if (!pod) return null;
    const { data: property } = await db
      .from("properties")
      .select("id, address, city, state, zip, listing_status")
      .eq("id", pod.property_id)
      .maybeSingle();

    const summary = await podSummary(db, pod, property);
    const eligible = await eligiblePool(db, pod.property_id);

    const { data: cycles } = await db
      .from("pod_hla_selections")
      .select("*")
      .eq("pod_id", pod.id)
      .order("cycle", { ascending: false });

    const agentIds = [...new Set((cycles ?? []).map((c: any) => c.agent_id))];
    const names = new Map<string, string>();
    if (agentIds.length) {
      const { data: rows } = await db.from("agents").select("id, full_name").in("id", agentIds);
      for (const r of rows ?? []) names.set(r.id, r.full_name);
    }
    const brokerIds = [...new Set((cycles ?? []).map((c: any) => c.broker_id).filter(Boolean))];
    const brokerNames = new Map<string, string>();
    if (brokerIds.length) {
      const { data: rows } = await db.from("brokers").select("id, brokerage_name").in("id", brokerIds);
      for (const r of rows ?? []) brokerNames.set(r.id, r.brokerage_name);
    }

    const history: SelectionCycle[] = (cycles ?? []).map((c: any) => ({
      id: c.id,
      cycle: c.cycle,
      agentName: names.get(c.agent_id) ?? "Agent",
      brokerageName: c.broker_id ? (brokerNames.get(c.broker_id) ?? null) : null,
      selectionMethod: c.selection_method,
      selectionBasis: c.selection_basis ?? null,
      selectedAt: c.selected_at,
      outcome: c.outcome,
      outcomeAt: c.outcome_at ?? null,
    }));

    return { ...summary, eligible, history };
  });

export const selectHeavyLifter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { podId: string; agentId: string; basis?: string }) => input)
  .handler(async ({ data, context }): Promise<{ error?: string; ok?: boolean }> => {
    if (!(await requireAdmin(context.supabase, context.userId))) {
      return { error: "Admin access required." };
    }
    const db = await admin();
    const { data: pod } = await db.from("pods").select("*").eq("id", data.podId).maybeSingle();
    if (!pod) return { error: "Pod not found." };
    if (pod.hla_status === "pending_acceptance" || pod.hla_status === "accepted") {
      return { error: "This pod already has a Heavy Lifting Agent in place." };
    }

    // Validation-level eligible-pool enforcement (the DB trigger repeats it).
    const eligible = await eligiblePool(db, pod.property_id);
    if (!eligible.some((a) => a.agentId === data.agentId)) {
      return { error: "That agent is not tethered to a buyer in this pod." };
    }

    const { data: agent } = await db
      .from("agents")
      .select("id, auth_user_id, full_name, broker_id")
      .eq("id", data.agentId)
      .maybeSingle();
    if (!agent) return { error: "Agent not found." };

    const now = new Date();
    const cycle = (pod.selection_cycle ?? 0) + 1;

    await db
      .from("pods")
      .update({
        heavy_lifting_agent_id: agent.id,
        selection_method: "manual",
        selected_by: context.userId,
        selected_at: now.toISOString(),
        selection_basis: data.basis?.trim() || null,
        hla_status: "pending_acceptance",
        acceptance_deadline_at: deadlineFrom(now),
        accepted_at: null,
        declined_at: null,
        selection_cycle: cycle,
      })
      .eq("id", pod.id);

    // Append-only cycle record — a re-selection never overwrites the original.
    await db.from("pod_hla_selections").insert({
      pod_id: pod.id,
      cycle,
      property_id: pod.property_id,
      agent_id: agent.id,
      broker_id: agent.broker_id ?? null,
      selection_method: "manual",
      selected_by: context.userId,
      selection_basis: data.basis?.trim() || null,
      selected_at: now.toISOString(),
      outcome: "pending_acceptance",
    });

    await db.from("notifications").insert({
      seller_id: agent.auth_user_id,
      message:
        "You have been selected as Heavy Lifting Agent for a pod — accept or decline within 3 days.",
      type: "hla_invitation",
    });

    await db.from("audit_log").insert({
      actor_id: context.userId,
      actor_type: "agent",
      action_type: cycle > 1 ? "pod.heavy_lifter_reselected" : "pod.heavy_lifter_selected",
      entity_type: "pod",
      entity_id: pod.id,
      metadata: {
        pod_id: pod.id,
        property_id: pod.property_id,
        agent_id: agent.id,
        broker_of_record_id: agent.broker_id ?? null,
        phase: "manual",
        selection_cycle: cycle,
        selected_by: context.userId,
        basis: data.basis?.trim() || null,
        selected_at: now.toISOString(),
        trigger_point: SELECTION_TRIGGER,
      },
    });

    return { ok: true };
  });

/* ------------------------------------------------------------------ */
/* Agent side — formal acceptance                                      */
/* ------------------------------------------------------------------ */

export const getHlaInvitation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { podId: string }) => input)
  .handler(async ({ data, context }): Promise<HlaInvitation | null> => {
    const db = await admin();
    const agent = await agentFor(db, context.userId);
    if (!agent) return null;
    const { data: pod } = await db.from("pods").select("*").eq("id", data.podId).maybeSingle();
    if (!pod || pod.heavy_lifting_agent_id !== agent.id) return null;
    const { data: property } = await db
      .from("properties")
      .select("address, city, state, zip")
      .eq("id", pod.property_id)
      .maybeSingle();
    const { count } = await db
      .from("pod_reservations")
      .select("id", { count: "exact", head: true })
      .eq("property_id", pod.property_id)
      .eq("status", "reserved");
    return {
      podId: pod.id,
      propertyId: pod.property_id,
      address: property?.address ?? "—",
      city: property?.city ?? "",
      state: property?.state ?? "",
      zip: property?.zip ?? "",
      status: pod.hla_status,
      acceptanceDeadlineAt: pod.acceptance_deadline_at ?? null,
      selectionBasis: pod.selection_basis ?? null,
      buyersInPod: count ?? 0,
    };
  });

/** Pods where this agent has been selected as HLA and must respond. */
export const listMyHlaInvitations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<HlaInvitation[]> => {
    const db = await admin();
    const agent = await agentFor(db, context.userId);
    if (!agent) return [];
    const { data: pods } = await db
      .from("pods")
      .select("*")
      .eq("heavy_lifting_agent_id", agent.id)
      .eq("hla_status", "pending_acceptance");
    const out: HlaInvitation[] = [];
    for (const pod of (pods ?? []) as any[]) {
      const { data: property } = await db
        .from("properties")
        .select("address, city, state, zip")
        .eq("id", pod.property_id)
        .maybeSingle();
      const { count } = await db
        .from("pod_reservations")
        .select("id", { count: "exact", head: true })
        .eq("property_id", pod.property_id)
        .eq("status", "reserved");
      out.push({
        podId: pod.id,
        propertyId: pod.property_id,
        address: property?.address ?? "—",
        city: property?.city ?? "",
        state: property?.state ?? "",
        zip: property?.zip ?? "",
        status: pod.hla_status,
        acceptanceDeadlineAt: pod.acceptance_deadline_at ?? null,
        selectionBasis: pod.selection_basis ?? null,
        buyersInPod: count ?? 0,
      });
    }
    return out;
  });

export const respondToHlaInvitation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { podId: string; choice: "accept" | "decline"; note?: string }) => input)
  .handler(async ({ data, context }): Promise<{ error?: string; ok?: boolean }> => {
    const db = await admin();
    const agent = await agentFor(db, context.userId);
    if (!agent) return { error: "Agent profile not found." };
    const { data: pod } = await db.from("pods").select("*").eq("id", data.podId).maybeSingle();
    if (!pod || pod.heavy_lifting_agent_id !== agent.id) {
      return { error: "This invitation is not addressed to you." };
    }
    if (pod.hla_status !== "pending_acceptance") {
      return { error: "This invitation is no longer open." };
    }

    const now = new Date().toISOString();
    const accepted = data.choice === "accept";

    if (accepted) {
      await db
        .from("pods")
        .update({ hla_status: "accepted", accepted_at: now })
        .eq("id", pod.id);
      await markPodRoles(db, pod);
    } else {
      // Reset for an alternate pick from the remaining eligible pool.
      await db
        .from("pods")
        .update({
          hla_status: "awaiting_selection",
          heavy_lifting_agent_id: null,
          selection_method: null,
          selected_by: null,
          selected_at: null,
          selection_basis: null,
          acceptance_deadline_at: null,
          declined_at: now,
        })
        .eq("id", pod.id);
      await db.from("notifications").insert({
        seller_id: null,
        message: "A Heavy Lifting Agent declined — select an alternate from the pod's eligible pool.",
        type: "hla_selection",
      });
    }

    await db
      .from("pod_hla_selections")
      .update({ outcome: accepted ? "accepted" : "declined", outcome_at: now })
      .eq("pod_id", pod.id)
      .eq("cycle", pod.selection_cycle);

    await db.from("audit_log").insert({
      actor_id: context.userId,
      actor_type: "agent",
      action_type: accepted ? "pod.heavy_lifter_accepted" : "pod.heavy_lifter_declined",
      entity_type: "pod",
      entity_id: pod.id,
      metadata: {
        pod_id: pod.id,
        property_id: pod.property_id,
        agent_id: agent.id,
        broker_of_record_id: agent.broker_id ?? null,
        phase: pod.selection_method ?? "manual",
        selection_cycle: pod.selection_cycle,
        responded_at: now,
        note: data.note?.trim() || null,
      },
    });

    return { ok: true };
  });

/** Tag the remaining tethered Resident Agents as passive FOR THIS POD only. */
async function markPodRoles(db: Db, pod: any) {
  const eligible = await eligiblePool(db, pod.property_id);
  for (const a of eligible) {
    const isHl = a.agentId === pod.heavy_lifting_agent_id;
    const { data: existing } = await db
      .from("pod_agent_roles")
      .select("id")
      .eq("pod_id", pod.id)
      .eq("agent_id", a.agentId)
      .maybeSingle();
    const row = {
      is_heavy_lifter: isHl,
      is_passive_resident_agent: !isHl,
      updated_at: new Date().toISOString(),
    };
    if (existing?.id) {
      await db.from("pod_agent_roles").update(row).eq("id", existing.id);
    } else {
      await db.from("pod_agent_roles").insert({ pod_id: pod.id, agent_id: a.agentId, ...row });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Master Briefcase (unlocked only after acceptance)                   */
/* ------------------------------------------------------------------ */

export const getBriefcase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { podId: string }) => input)
  .handler(async ({ data, context }): Promise<Briefcase | { error: string }> => {
    const db = await admin();
    const agent = await agentFor(db, context.userId);
    const isManager = await requireAdmin(context.supabase, context.userId);
    if (!agent && !isManager) return { error: "Agent profile not found." };
    const { data: pod } = await db.from("pods").select("*").eq("id", data.podId).maybeSingle();
    if (!pod) return { error: "Pod not found." };
    if (!isManager && (pod.hla_status !== "accepted" || pod.heavy_lifting_agent_id !== agent!.id)) {
      return { error: "The Master Briefcase unlocks once you accept the Heavy Lifting role." };
    }

    const { data: property } = await db
      .from("properties")
      .select("address, city, state, zip")
      .eq("id", pod.property_id)
      .maybeSingle();

    const { data: reservations } = await db
      .from("pod_reservations")
      .select("buyer_account_id, shares_reserved, reserved_at")
      .eq("property_id", pod.property_id)
      .eq("status", "reserved")
      .order("reserved_at", { ascending: true });

    const buyerIds = (reservations ?? []).map((r: any) => r.buyer_account_id);
    const buyerRows = new Map<string, any>();
    if (buyerIds.length) {
      // Minimal projection: no email, phone, financials or documents.
      const { data: rows } = await db
        .from("buyer_accounts")
        .select("id, primary_name, tethered_resident_agent_id")
        .in("id", buyerIds);
      const { withPropertyAgents } = await import("@/lib/property-agent.server");
      for (const r of await withPropertyAgents(db, pod.property_id, (rows ?? []) as any[])) buyerRows.set(r.id, r);
    }
    const agentIds = [...new Set([...buyerRows.values()].map((b) => b.tethered_resident_agent_id).filter(Boolean))];
    const agentNames = new Map<string, string>();
    if (agentIds.length) {
      const { data: rows } = await db.from("agents").select("id, full_name").in("id", agentIds);
      for (const r of rows ?? []) agentNames.set(r.id, r.full_name);
    }

    const buyers = (reservations ?? []).map((r: any, i: number) => {
      const b = buyerRows.get(r.buyer_account_id);
      const mine = !!agent && b?.tethered_resident_agent_id === agent.id;
      const name: string = b?.primary_name ?? "";
      const initials = name
        ? name
            .split(/\s+/)
            .map((p: string) => p[0]?.toUpperCase())
            .join(".")
        : "—";
      return {
        buyerAccountId: r.buyer_account_id,
        // Other agents' buyers stay de-identified to initials only.
        displayLabel: mine ? name || `Share ${i + 1}` : `Share ${i + 1} · ${initials}`,
        sharesReserved: r.shares_reserved ?? 1,
        reservedAt: r.reserved_at,
        tetheredAgentName: b?.tethered_resident_agent_id
          ? (agentNames.get(b.tethered_resident_agent_id) ?? null)
          : null,
        isMine: mine,
      };
    });

    const { data: roles } = await db
      .from("pod_agent_roles")
      .select("agent_id, is_passive_resident_agent")
      .eq("pod_id", pod.id)
      .eq("is_passive_resident_agent", true);
    const passiveAgents = (roles ?? []).map((r: any) => ({
      agentId: r.agent_id,
      fullName: agentNames.get(r.agent_id) ?? "Resident Agent",
    }));

    const { data: messages } = await db
      .from("pod_messages")
      .select("id, author_label, body, created_at")
      .eq("pod_id", pod.id)
      .order("created_at", { ascending: true });

    // Broker Closing Hold state — surfaced to the Heavy Lifting Agent and the
    // Manager. MONTH 4: the closing engine must block while this is active.
    let holdBrokerName: string | null = null;
    if (pod.closing_hold_placed_by) {
      const { data: b } = await db
        .from("brokers")
        .select("brokerage_name")
        .eq("id", pod.closing_hold_placed_by)
        .maybeSingle();
      holdBrokerName = b?.brokerage_name ?? null;
    }

    return {
      podId: pod.id,
      address: property?.address ?? "—",
      city: property?.city ?? "",
      state: property?.state ?? "",
      zip: property?.zip ?? "",
      closingHold: {
        active: Boolean(pod.closing_hold_active),
        reason: pod.closing_hold_reason ?? null,
        placedAt: pod.closing_hold_placed_at ?? null,
        placedByBrokerName: holdBrokerName,
        liftedAt: pod.closing_hold_lifted_at ?? null,
      },
      buyers,
      passiveAgents,
      messages: (messages ?? []).map((m: any) => ({
        id: m.id,
        authorLabel: m.author_label,
        body: m.body,
        createdAt: m.created_at,
      })),
    };
  });

export const postBriefcaseMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { podId: string; body: string }) => input)
  .handler(async ({ data, context }): Promise<{ error?: string; ok?: boolean }> => {
    const body = data.body.trim();
    if (!body) return { error: "Write a message first." };
    const db = await admin();
    const agent = await agentFor(db, context.userId);
    const isManager = await requireAdmin(context.supabase, context.userId);
    if (!agent && !isManager) return { error: "Agent profile not found." };
    if (!isManager) {
      const { data: role } = await db
        .from("pod_agent_roles")
        .select("id")
        .eq("pod_id", data.podId)
        .eq("agent_id", agent!.id)
        .maybeSingle();
      if (!role) return { error: "You are not part of this pod." };
    }

    await db.from("pod_messages").insert({
      pod_id: data.podId,
      author_user_id: context.userId,
      author_label: isManager ? "divieight, LLC (Manager)" : agent!.full_name,
      body,
    });
    return { ok: true };
  });

/* ------------------------------------------------------------------ */
/* 3-calendar-day acceptance window sweep (manually triggerable)       */
/* ------------------------------------------------------------------ */

export async function runHlaAcceptanceSweep(db: Db): Promise<{ timedOut: number }> {
  const nowIso = new Date().toISOString();
  const { data: pods } = await db
    .from("pods")
    .select("*")
    .eq("hla_status", "pending_acceptance")
    .not("acceptance_deadline_at", "is", null)
    .lt("acceptance_deadline_at", nowIso);

  let timedOut = 0;
  for (const pod of pods ?? []) {
    const agentId = pod.heavy_lifting_agent_id;
    const { data: agent } = agentId
      ? await db.from("agents").select("id, broker_id").eq("id", agentId).maybeSingle()
      : { data: null };

    await db
      .from("pods")
      .update({
        hla_status: "awaiting_selection",
        heavy_lifting_agent_id: null,
        selection_method: null,
        selected_by: null,
        selected_at: null,
        selection_basis: null,
        acceptance_deadline_at: null,
        declined_at: nowIso,
      })
      .eq("id", pod.id);

    await db
      .from("pod_hla_selections")
      .update({ outcome: "timed_out", outcome_at: nowIso })
      .eq("pod_id", pod.id)
      .eq("cycle", pod.selection_cycle);

    await db.from("notifications").insert({
      seller_id: null,
      message:
        "A Heavy Lifting Agent did not respond within 3 days — select an alternate from the pod's eligible pool.",
      type: "hla_selection",
    });

    await db.from("audit_log").insert({
      actor_id: pod.selected_by ?? pod.id,
      actor_type: "agent",
      action_type: "pod.heavy_lifter_timed_out",
      entity_type: "pod",
      entity_id: pod.id,
      metadata: {
        pod_id: pod.id,
        property_id: pod.property_id,
        agent_id: agentId,
        broker_of_record_id: agent?.broker_id ?? null,
        phase: pod.selection_method ?? "manual",
        selection_cycle: pod.selection_cycle,
        deadline_at: pod.acceptance_deadline_at,
        timed_out_at: nowIso,
      },
    });
    timedOut += 1;
  }
  return { timedOut };
}
