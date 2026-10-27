import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  composeHoldReason,
  type BrokerHoldPod,
  type ClosingHoldInput,
  type ClosingHoldState,
  type PodParty,
} from "@/lib/closing-hold";

/**
 * Broker Closing Hold — authority for a Broker of Record to halt a transaction
 * in its final stages.
 *
 * Authority scope (per spec): only the Broker of Record of the pod's Heavy
 * Lifting Agent, and only once that pod's hla_status = 'accepted'. Any broker
 * currently linked to that Heavy Lifting Agent may also lift the hold.
 *
 * MONTH 4 INTEGRATION POINT: pods.closing_hold_active is the flag the closing
 * engine checks before allowing the Closing Ping Saga to proceed. Month 4 must
 * refuse to advance any closing step while this flag is true.
 *
 * Money-flow scope unchanged: brokers only ever receive real-estate commission
 * paid at closing by title/escrow from sale proceeds.
 */

type Db = { from: (t: string) => any };

async function admin(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function brokerFor(db: Db, userId: string) {
  const { data } = await db
    .from("brokers")
    .select("id, brokerage_name, auth_user_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  return data ?? null;
}

async function holdStateFor(db: Db, pod: any): Promise<ClosingHoldState> {
  let placedByBrokerName: string | null = null;
  if (pod.closing_hold_placed_by) {
    const { data } = await db
      .from("brokers")
      .select("brokerage_name")
      .eq("id", pod.closing_hold_placed_by)
      .maybeSingle();
    placedByBrokerName = data?.brokerage_name ?? null;
  }
  return {
    active: Boolean(pod.closing_hold_active),
    reason: pod.closing_hold_reason ?? null,
    placedAt: pod.closing_hold_placed_at ?? null,
    placedByBrokerName,
    liftedAt: pod.closing_hold_lifted_at ?? null,
  };
}

/** Buyers + agents inside a pod, usable as "affected parties" on a hold. */
async function podParties(db: Db, pod: any): Promise<PodParty[]> {
  const { data: reservations } = await db
    .from("pod_reservations")
    .select("buyer_account_id, reserved_at")
    .eq("property_id", pod.property_id)
    .eq("status", "reserved")
    .order("reserved_at", { ascending: true });

  const buyerIds = (reservations ?? []).map((r: any) => r.buyer_account_id);
  const buyers = new Map<string, any>();
  if (buyerIds.length) {
    // Minimal projection — no contact, financial or document data.
    const { data } = await db
      .from("buyer_accounts")
      .select("id, primary_name, tethered_resident_agent_id")
      .in("id", buyerIds);
    const { withPropertyAgents } = await import("@/lib/property-agent.server");
    for (const b of await withPropertyAgents(db, pod.property_id, (data ?? []) as any[])) buyers.set(b.id, b);
  }

  const agentIds = [
    ...new Set(
      [
        pod.heavy_lifting_agent_id,
        ...[...buyers.values()].map((b) => b.tethered_resident_agent_id),
      ].filter(Boolean),
    ),
  ] as string[];
  const agentNames = new Map<string, string>();
  if (agentIds.length) {
    const { data } = await db.from("agents").select("id, full_name").in("id", agentIds);
    for (const a of data ?? []) agentNames.set(a.id, a.full_name);
  }

  const parties: PodParty[] = (reservations ?? []).map((r: any, i: number) => ({
    id: `buyer:${r.buyer_account_id}`,
    label: `Share ${i + 1} · ${buyers.get(r.buyer_account_id)?.primary_name ?? "Buyer"}`,
    kind: "buyer" as const,
  }));
  for (const id of agentIds) {
    parties.push({
      id: `agent:${id}`,
      label:
        (agentNames.get(id) ?? "Agent") +
        (id === pod.heavy_lifting_agent_id ? " (Heavy Lifting Agent)" : " (Resident Agent)"),
      kind: "agent" as const,
    });
  }
  return parties;
}

/** Pods this broker supervises through an accepted Heavy Lifting Agent. */
export const listBrokerHoldPods = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BrokerHoldPod[]> => {
    const db = await admin();
    const broker = await brokerFor(db, context.userId);
    if (!broker) return [];

    const { data: agents } = await db
      .from("agents")
      .select("id, full_name")
      .eq("broker_id", broker.id);
    const agentIds = (agents ?? []).map((a: any) => a.id);
    if (!agentIds.length) return [];
    const agentNames = new Map<string, string>(
      (agents ?? []).map((a: any) => [a.id, a.full_name]),
    );

    const { data: pods } = await db
      .from("pods")
      .select("*")
      .eq("hla_status", "accepted")
      .in("heavy_lifting_agent_id", agentIds);

    const out: BrokerHoldPod[] = [];
    for (const pod of (pods ?? []) as any[]) {
      const { data: property } = await db
        .from("properties")
        .select("address, city, state, zip, listing_status")
        .eq("id", pod.property_id)
        .maybeSingle();
      out.push({
        podId: pod.id,
        propertyId: pod.property_id,
        address: property?.address ?? "—",
        city: property?.city ?? "",
        state: property?.state ?? "",
        zip: property?.zip ?? "",
        listingStatus: property?.listing_status ?? "",
        heavyLifterName: agentNames.get(pod.heavy_lifting_agent_id) ?? "Heavy Lifting Agent",
        heavyLifterAgentId: pod.heavy_lifting_agent_id,
        acceptedAt: pod.accepted_at ?? null,
        parties: await podParties(db, pod),
        hold: await holdStateFor(db, pod),
      });
    }
    return out;
  });

async function authorizeBroker(db: Db, userId: string, podId: string) {
  const broker = await brokerFor(db, userId);
  if (!broker) return { error: "Broker of Record profile not found." } as const;
  const { data: pod } = await db.from("pods").select("*").eq("id", podId).maybeSingle();
  if (!pod) return { error: "Pod not found." } as const;
  if (pod.hla_status !== "accepted" || !pod.heavy_lifting_agent_id) {
    return { error: "This pod has no accepted Heavy Lifting Agent yet." } as const;
  }
  const { data: agent } = await db
    .from("agents")
    .select("id, full_name, broker_id, auth_user_id")
    .eq("id", pod.heavy_lifting_agent_id)
    .maybeSingle();
  if (!agent || agent.broker_id !== broker.id) {
    return {
      error: "Only the Heavy Lifting Agent's Broker of Record may manage this pod's closing hold.",
    } as const;
  }
  return { broker, pod, agent } as const;
}

export const placeClosingHold = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: ClosingHoldInput) => input)
  .handler(async ({ data, context }): Promise<{ ok?: boolean; error?: string }> => {
    const issue = data.issueDescription.trim();
    const resolution = data.proposedResolution.trim();
    if (!issue) return { error: "Describe the issue before placing a hold." };
    if (!resolution) return { error: "A proposed resolution path is required." };

    const db = await admin();
    const auth = await authorizeBroker(db, context.userId, data.podId);
    if ("error" in auth) return { error: auth.error };
    const { broker, pod, agent } = auth;
    if (pod.closing_hold_active) return { error: "A closing hold is already active on this pod." };

    const parties = await podParties(db, pod);
    const labels = parties
      .filter((p) => data.affectedParties.includes(p.id))
      .map((p) => p.label);
    const now = new Date().toISOString();
    const reason = composeHoldReason({
      issueDescription: issue,
      affectedPartyLabels: labels,
      proposedResolution: resolution,
    });

    const { error } = await db
      .from("pods")
      .update({
        closing_hold_active: true,
        closing_hold_reason: reason,
        closing_hold_placed_by: broker.id,
        closing_hold_placed_at: now,
        closing_hold_lifted_at: null,
      })
      .eq("id", pod.id);
    if (error) return { error: error.message };

    // Everyone involved in the pod is notified; the reason travels with it.
    const recipients = new Set<string>();
    if (agent.auth_user_id) recipients.add(agent.auth_user_id);
    const { data: reservations } = await db
      .from("pod_reservations")
      .select("buyer_account_id")
      .eq("property_id", pod.property_id)
      .eq("status", "reserved");
    const buyerIds = (reservations ?? []).map((r: any) => r.buyer_account_id);
    if (buyerIds.length) {
      const { data: buyerRows } = await db
        .from("buyer_accounts")
        .select("id, auth_user_id, tethered_resident_agent_id")
        .in("id", buyerIds);
      const { withPropertyAgents } = await import("@/lib/property-agent.server");
      const buyers = await withPropertyAgents(db, pod.property_id, (buyerRows ?? []) as any[]);
      const tethered = [
        ...new Set((buyers ?? []).map((b: any) => b.tethered_resident_agent_id).filter(Boolean)),
      ] as string[];
      for (const b of buyers ?? []) if (b.auth_user_id) recipients.add(b.auth_user_id);
      if (tethered.length) {
        const { data: rows } = await db.from("agents").select("auth_user_id").in("id", tethered);
        for (const r of rows ?? []) if (r.auth_user_id) recipients.add(r.auth_user_id);
      }
    }
    for (const uid of recipients) {
      await db.from("notifications").insert({
        seller_id: uid,
        message: `Closing hold placed by ${broker.brokerage_name} on your pod. Reason: ${issue}`,
        type: "closing_hold",
      });
    }

    await db.from("audit_log").insert({
      actor_id: context.userId,
      actor_type: "broker",
      action_type: "pod.closing_hold_placed",
      entity_type: "pod",
      entity_id: pod.id,
      metadata: {
        pod_id: pod.id,
        property_id: pod.property_id,
        broker_id: broker.id,
        brokerage_name: broker.brokerage_name,
        heavy_lifting_agent_id: agent.id,
        heavy_lifting_agent_name: agent.full_name,
        issue_description: issue,
        affected_parties: data.affectedParties,
        affected_party_labels: labels,
        proposed_resolution: resolution,
        placed_at: now,
      },
    });

    return { ok: true };
  });

export const liftClosingHold = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { podId: string; resolutionNote: string }) => input)
  .handler(async ({ data, context }): Promise<{ ok?: boolean; error?: string }> => {
    const note = data.resolutionNote.trim();
    if (!note) return { error: "Record how the issue was resolved before lifting the hold." };

    const db = await admin();
    // Any broker currently linked to the Heavy Lifting Agent may lift, not only
    // the individual who placed it.
    const auth = await authorizeBroker(db, context.userId, data.podId);
    if ("error" in auth) return { error: auth.error };
    const { broker, pod, agent } = auth;
    if (!pod.closing_hold_active) return { error: "No closing hold is active on this pod." };

    const now = new Date().toISOString();
    const { error } = await db
      .from("pods")
      .update({
        closing_hold_active: false,
        closing_hold_lifted_at: now,
        closing_hold_reason: `${pod.closing_hold_reason ?? ""}\nResolution: ${note}`.trim(),
      })
      .eq("id", pod.id);
    if (error) return { error: error.message };

    if (agent.auth_user_id) {
      await db.from("notifications").insert({
        seller_id: agent.auth_user_id,
        message: `Closing hold lifted by ${broker.brokerage_name}. Resolution: ${note}`,
        type: "closing_hold",
      });
    }

    await db.from("audit_log").insert({
      actor_id: context.userId,
      actor_type: "broker",
      action_type: "pod.closing_hold_lifted",
      entity_type: "pod",
      entity_id: pod.id,
      metadata: {
        pod_id: pod.id,
        property_id: pod.property_id,
        broker_id: broker.id,
        brokerage_name: broker.brokerage_name,
        placed_by_broker_id: pod.closing_hold_placed_by,
        placed_at: pod.closing_hold_placed_at,
        original_reason: pod.closing_hold_reason,
        resolution_note: note,
        lifted_at: now,
      },
    });

    return { ok: true };
  });
