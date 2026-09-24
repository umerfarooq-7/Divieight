/**
 * Title/Escrow Real-Time Handshake + Title Certainty Monitor — server side.
 *
 * Provider-agnostic: everything here talks to a TitleEscrowAdapter and the
 * normalized event shape. Real webhooks and admin simulations take the SAME
 * path through `ingestTitleWebhook`.
 */
import { deliver } from "@/lib/authorization.notify.server";
import { getTitleAdapter, DEFAULT_TITLE_PROVIDER, type ClosingBundle, type NormalizedTitleEvent } from "@/lib/title-adapters";
import type { SimulationOptions } from "@/lib/title-adapters/adapter";
import {
  MILESTONE_DESCRIPTIONS,
  MILESTONE_LABELS,
  TITLE_MILESTONES,
  type TitleMilestone,
  type TitleStatus,
} from "@/lib/title-escrow";

type Db = { from: (t: string) => any };

async function audit(db: Db, actorId: string | null, actionType: string, propertyId: string, metadata: Record<string, unknown>) {
  await db.from("audit_log").insert({
    actor_id: actorId,
    actor_type: actorId ? "admin" : "system",
    action_type: `title.${actionType}`,
    entity_type: "title_escrow",
    entity_id: propertyId,
    metadata,
  });
}

async function adminIds(db: Db) {
  const { data } = await db.from("user_roles").select("user_id").eq("role", "admin");
  return ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
}

// ---------------------------------------------------------------------------
// Closing Bundle
// ---------------------------------------------------------------------------

export async function sellerAcceptanceAuthorized(db: Db, propertyId: string) {
  const { data } = await db
    .from("authorization_requests")
    .select("id")
    .eq("property_id", propertyId)
    .eq("status", "authorized")
    .in("action_type", ["counter_offer_acceptance", "final_repa_acceptance"])
    .limit(1);
  return ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
}

export async function buildClosingBundle(db: Db, propertyId: string, sourceRequestId: string | null): Promise<ClosingBundle> {
  const { data: p } = await db
    .from("properties")
    .select("id, address, city, state, zip, listing_price, seller_id, exit_type, retained_shares, anticipated_closing_date")
    .eq("id", propertyId)
    .maybeSingle();
  if (!p) throw new Error("Property not found");
  const { data: res } = await db
    .from("pod_reservations")
    .select("buyer_account_id, shares_reserved, reserved_at")
    .eq("property_id", propertyId)
    .eq("status", "reserved")
    .order("reserved_at", { ascending: true });
  const reservations = (res ?? []) as Array<{ buyer_account_id: string; shares_reserved: number }>;
  const ids = reservations.map((r) => r.buyer_account_id);
  const { data: members } = ids.length
    ? await db.from("account_members").select("buyer_account_id, full_name").in("buyer_account_id", ids)
    : { data: [] };
  const { data: accounts } = ids.length
    ? await db.from("buyer_accounts").select("id, tethered_resident_agent_id").in("id", ids)
    : { data: [] };
  const { data: earnest } = await db.from("earnest_money_terms").select("funding_deadline, escrow_company, escrow_reference").eq("property_id", propertyId).maybeSingle();
  const { data: closing } = await db.from("closing_funds_terms").select("funding_deadline").eq("property_id", propertyId).maybeSingle();

  return {
    propertyId,
    property: { address: p.address, city: p.city, state: p.state, zip: p.zip, purchasePrice: p.listing_price ?? null },
    seller: { sellerId: p.seller_id ?? null, retainedShares: p.exit_type === "hybrid_exit" ? (p.retained_shares ?? 0) : 0 },
    buyers: reservations.map((r) => ({
      buyerAccountId: r.buyer_account_id,
      shares: r.shares_reserved ?? 1,
      memberNames: ((members ?? []) as Array<{ buyer_account_id: string; full_name: string | null }>)
        .filter((m) => m.buyer_account_id === r.buyer_account_id)
        .map((m) => m.full_name ?? "")
        .filter(Boolean),
      residentAgentId:
        ((accounts ?? []) as Array<{ id: string; tethered_resident_agent_id: string | null }>).find((a) => a.id === r.buyer_account_id)
          ?.tethered_resident_agent_id ?? null,
    })),
    closingTimeline: {
      anticipatedClosingDate: p.anticipated_closing_date ?? null,
      earnestMoneyDeadline: earnest?.funding_deadline ?? null,
      closingFundsDeadline: closing?.funding_deadline ?? null,
    },
    escrow: { company: earnest?.escrow_company ?? null, reference: earnest?.escrow_reference ?? null },
    sourceRequestId,
  };
}

/** Open the order with title once the offer is accepted (Prompt 3). */
export async function sendClosingBundle(
  db: Db,
  actorId: string,
  propertyId: string,
  opts: { manualOverrideReason?: string | null; provider?: string } = {},
) {
  const { data: existing } = await db.from("title_escrow_orders").select("id").eq("property_id", propertyId).maybeSingle();
  if (existing) throw new Error("A title order is already open for this property.");
  const acceptance = await sellerAcceptanceAuthorized(db, propertyId);
  if (!acceptance && !opts.manualOverrideReason?.trim())
    throw new Error("The offer hasn't been accepted through Buyer-Authorization yet — give a reason to open title manually.");

  const bundle = await buildClosingBundle(db, propertyId, acceptance);
  if (bundle.buyers.length === 0) throw new Error("No active reservations to put in the Closing Bundle.");
  const adapter = getTitleAdapter(opts.provider ?? DEFAULT_TITLE_PROVIDER);
  const result = await adapter.openOrder(bundle);

  const { error } = await db.from("title_escrow_orders").insert({
    property_id: propertyId,
    provider: adapter.provider,
    external_order_id: result.externalOrderId,
    simulated: result.simulated,
    bundle_payload: bundle,
    source_request_id: acceptance,
    status: "bundle_sent",
    created_by: actorId,
  });
  if (error) throw new Error(error.message);
  await audit(db, actorId, "closing_bundle_sent", propertyId, {
    provider: adapter.provider,
    external_order_id: result.externalOrderId,
    simulated: result.simulated,
    trigger: acceptance ? "offer_acceptance_authorized" : "manual_override",
    manual_override_reason: acceptance ? null : opts.manualOverrideReason,
    request: result.request,
  });
  return { externalOrderId: result.externalOrderId, simulated: result.simulated };
}

// ---------------------------------------------------------------------------
// Webhook ingestion (real and simulated share this path)
// ---------------------------------------------------------------------------

export type IngestResult =
  | { status: "processed"; milestone: TitleMilestone; propertyId: string; discrepancies: number; closingSaga?: string }
  | { status: "duplicate" | "ignored" | "unknown_order" | "unauthorized" };

export async function ingestTitleWebhook(
  db: Db,
  provider: string,
  rawBody: string,
  headers: Headers,
  opts: { simulated?: boolean } = {},
): Promise<IngestResult> {
  const adapter = getTitleAdapter(provider);
  const verified = await adapter.verifyWebhook(rawBody, headers);
  // Real webhooks must be signed. In-process admin simulations are accepted
  // unsigned only while no webhook secret is configured.
  if (!verified && !(opts.simulated && Object.keys(await adapter.signForSimulation(rawBody)).length === 0))
    return { status: "unauthorized" };

  const event = adapter.parseWebhook(rawBody);
  if (!event) return { status: "ignored" };

  const { data: dup } = await db.from("title_escrow_events").select("id").eq("external_event_id", event.externalEventId).maybeSingle();
  if (dup) return { status: "duplicate" };

  const { data: order } = await db
    .from("title_escrow_orders")
    .select("*")
    .eq("external_order_id", event.externalOrderId)
    .maybeSingle();
  if (!order) {
    await db.from("audit_log").insert({
      actor_id: null,
      actor_type: "system",
      action_type: "title.webhook_unknown_order",
      entity_type: "title_escrow",
      entity_id: null,
      metadata: { provider, external_order_id: event.externalOrderId, external_event_id: event.externalEventId },
    });
    return { status: "unknown_order" };
  }
  const propertyId = order.property_id as string;

  const { data: inserted, error } = await db
    .from("title_escrow_events")
    .insert({
      property_id: propertyId,
      milestone: event.milestone,
      received_at: new Date().toISOString(),
      raw_payload: JSON.parse(rawBody),
      provider,
      external_event_id: event.externalEventId,
      simulated: Boolean(opts.simulated),
    })
    .select("id")
    .maybeSingle();
  if (error || !inserted) throw new Error(error?.message ?? "Could not record the title event");

  const { data: prior } = await db.from("title_escrow_events").select("milestone").eq("property_id", propertyId);
  const seen = ((prior ?? []) as Array<{ milestone: TitleMilestone }>).map((e) => e.milestone);
  const expectedIndex = TITLE_MILESTONES.indexOf(event.milestone);
  const outOfOrder = TITLE_MILESTONES.slice(0, expectedIndex).some((m) => !seen.includes(m));

  await db
    .from("title_escrow_orders")
    .update({
      current_milestone: event.milestone,
      status: event.milestone === "funded_and_recorded" ? "completed" : "in_progress",
      updated_at: new Date().toISOString(),
    })
    .eq("id", order.id);

  await audit(db, null, "milestone_received", propertyId, {
    milestone: event.milestone,
    provider,
    simulated: Boolean(opts.simulated),
    external_event_id: event.externalEventId,
    event_id: inserted.id,
    out_of_order: outOfOrder,
  });

  let discrepancies = 0;
  if (event.milestone === "title_report_ready") await placeTitleCommitment(db, propertyId, event);
  if (event.milestone === "earnest_money_deposited") discrepancies = await crossCheckEarnestMoney(db, propertyId, inserted.id, event);
  if (event.milestone === "closing_scheduled" && event.closingDate) {
    await db.from("properties").update({ anticipated_closing_date: event.closingDate.slice(0, 10) }).eq("id", propertyId);
    await audit(db, null, "closing_date_set", propertyId, { closing_date: event.closingDate.slice(0, 10) });
  }
  if (event.milestone === "funded_and_recorded") discrepancies = await checkFundingPreconditions(db, propertyId, inserted.id);

  await broadcastStatus(db, propertyId, event.milestone);

  // Funded and recorded → the Closing Ping Saga (Prompt 13). Its own failures
  // land in saga_failures; the webhook is still acknowledged.
  let closingSaga: string | undefined;
  if (event.milestone === "funded_and_recorded") {
    const { startClosingSaga } = await import("@/lib/closing-saga.server");
    closingSaga = (await startClosingSaga(db, propertyId)).status;
  }
  return { status: "processed", milestone: event.milestone, propertyId, discrepancies, closingSaga };
}

/** Admin simulation panel: build a provider-native body and ingest it. */
export async function simulateMilestone(
  db: Db,
  actorId: string,
  propertyId: string,
  milestone: TitleMilestone,
  opts: SimulationOptions,
) {
  const { data: order } = await db.from("title_escrow_orders").select("*").eq("property_id", propertyId).maybeSingle();
  if (!order) throw new Error("Send the Closing Bundle first — there is no title order to update.");
  const adapter = getTitleAdapter(order.provider);
  const body = adapter.simulateWebhook(order.external_order_id, milestone, opts);
  const headers = new Headers(await adapter.signForSimulation(body));
  await audit(db, actorId, "webhook_simulated", propertyId, { milestone, provider: order.provider });
  return ingestTitleWebhook(db, order.provider, body, headers, { simulated: true });
}

// ---------------------------------------------------------------------------
// Milestone side effects
// ---------------------------------------------------------------------------

/** Automated document fetch: the Title Commitment becomes a Required DD document. */
async function placeTitleCommitment(db: Db, propertyId: string, event: NormalizedTitleEvent) {
  const doc = event.titleCommitment;
  if (!doc) return;
  const { data: prior } = await db
    .from("due_diligence_inventory")
    .select("id")
    .eq("property_id", propertyId)
    .eq("category", "title_commitment")
    .is("superseded_by", null);
  const { data: inserted, error } = await db
    .from("due_diligence_inventory")
    .insert({
      property_id: propertyId,
      document_title: doc.title,
      category: "title_commitment",
      file_url: doc.url,
      content_hash: doc.contentHash,
      required: true,
      // Title commitment/exception documents are governing instruments (Rev 43).
      is_governing_instrument: true,
    })
    .select("id")
    .maybeSingle();
  if (error || !inserted) throw new Error(error?.message ?? "Could not place the title commitment");

  for (const p of (prior ?? []) as Array<{ id: string }>) {
    await db.from("due_diligence_inventory").update({ superseded_by: inserted.id }).eq("id", p.id);
    await db.from("audit_log").insert({
      actor_id: null,
      actor_type: "system",
      action_type: "diligence.reacknowledgment_required",
      entity_type: "diligence_document",
      entity_id: inserted.id,
      metadata: { property_id: propertyId, reason: "amended_title_commitment", prior_document_id: p.id },
    });
  }
  await db.from("audit_log").insert({
    actor_id: null,
    actor_type: "system",
    action_type: "diligence.document_placed",
    entity_type: "diligence_document",
    entity_id: inserted.id,
    metadata: {
      property_id: propertyId,
      category: "title_commitment",
      required: true,
      is_governing_instrument: true,
      content_hash: doc.contentHash,
      source: "title_escrow_webhook",
    },
  });
  const { notifyNewRequiredDocument } = await import("@/lib/due-diligence-notify.server");
  await notifyNewRequiredDocument(db as never, {
    id: inserted.id,
    property_id: propertyId,
    document_title: doc.title,
    amended: ((prior ?? []) as unknown[]).length > 0,
  });
}

async function flag(
  db: Db,
  propertyId: string,
  eventId: string,
  kind: string,
  buyerAccountId: string | null,
  details: Record<string, unknown>,
) {
  await db.from("title_escrow_discrepancies").insert({
    property_id: propertyId,
    event_id: eventId,
    kind,
    buyer_account_id: buyerAccountId,
    details,
    status: "open",
  });
  await audit(db, null, "discrepancy_flagged", propertyId, { kind, buyer_account_id: buyerAccountId, details, event_id: eventId });
}

/**
 * Zero-Error early check: what escrow says was deposited vs. what Prompt 5's
 * tracking says was funded. Nothing is auto-corrected — mismatches are flagged.
 */
async function crossCheckEarnestMoney(db: Db, propertyId: string, eventId: string, event: NormalizedTitleEvent) {
  const { data } = await db
    .from("earnest_money_obligations")
    .select("buyer_account_id, amount, status")
    .eq("property_id", propertyId);
  const obligations = (data ?? []) as Array<{ buyer_account_id: string; amount: number; status: string }>;
  const deposits = event.deposits ?? [];
  let count = 0;

  if (obligations.length === 0) {
    if (deposits.length > 0 || event.allDepositsComplete) {
      await flag(db, propertyId, eventId, "no_platform_obligations", null, { deposits });
      count++;
    }
  }
  for (const d of deposits) {
    const o = obligations.find((x) => x.buyer_account_id === d.buyerAccountId);
    if (!o) continue;
    if (o.status !== "funded") {
      await flag(db, propertyId, eventId, "title_deposited_platform_unfunded", d.buyerAccountId, {
        title_amount: d.amount,
        platform_status: o.status,
      });
      count++;
    } else if (Math.round(Number(o.amount) * 100) !== Math.round(d.amount * 100)) {
      await flag(db, propertyId, eventId, "amount_mismatch", d.buyerAccountId, {
        title_amount: d.amount,
        platform_amount: Number(o.amount),
      });
      count++;
    }
  }
  for (const o of obligations.filter((x) => x.status === "funded")) {
    if (!deposits.some((d) => d.buyerAccountId === o.buyer_account_id)) {
      await flag(db, propertyId, eventId, "platform_funded_title_missing", o.buyer_account_id, { platform_amount: Number(o.amount) });
      count++;
    }
  }
  // Buyers already flagged individually above aren't repeated here.
  const unfunded = obligations.filter(
    (o) => o.status !== "funded" && !deposits.some((d) => d.buyerAccountId === o.buyer_account_id),
  );
  if (event.allDepositsComplete && unfunded.length > 0) {
    await flag(db, propertyId, eventId, "title_complete_platform_incomplete", null, {
      unfunded_buyer_accounts: unfunded.map((o) => o.buyer_account_id),
    });
    count++;
  }

  if (count > 0) {
    for (const id of await adminIds(db))
      await deliver(
        db,
        { authUserId: id, email: null },
        {
          subject: "Earnest-money discrepancy with title",
          message: `${count} mismatch(es) between the title company's earnest-money report and the platform's funding records. Review before closing.`,
          link: "/admin/title-escrow",
          type: "title_discrepancy",
        },
      );
  }
  return count;
}

/** At funding, surface any disbursement precondition that wasn't met. */
async function checkFundingPreconditions(db: Db, propertyId: string, eventId: string) {
  const { disbursementPreconditions } = await import("@/lib/closing-gates.server");
  const blockers = await disbursementPreconditions(db, propertyId);
  if (blockers.length === 0) return 0;
  await flag(db, propertyId, eventId, "funded_with_open_preconditions", null, { blockers });
  return 1;
}

// ---------------------------------------------------------------------------
// Status — the one source every dashboard reads
// ---------------------------------------------------------------------------

export async function titleStatus(db: Db, propertyId: string): Promise<TitleStatus> {
  const { data: order } = await db
    .from("title_escrow_orders")
    .select("provider, simulated, bundle_sent_at")
    .eq("property_id", propertyId)
    .maybeSingle();
  const { data: events } = await db
    .from("title_escrow_events")
    .select("milestone, received_at")
    .eq("property_id", propertyId)
    .order("received_at", { ascending: true });
  const { data: property } = await db.from("properties").select("anticipated_closing_date").eq("id", propertyId).maybeSingle();
  const list = (events ?? []) as Array<{ milestone: TitleMilestone; received_at: string }>;
  return {
    propertyId,
    provider: order?.provider ?? null,
    orderOpenedAt: list.find((e) => e.milestone === "order_opened")?.received_at ?? null,
    bundleSentAt: order?.bundle_sent_at ?? null,
    simulated: Boolean(order?.simulated),
    closingDate: property?.anticipated_closing_date ?? null,
    milestones: TITLE_MILESTONES.map((m) => ({ milestone: m, receivedAt: list.find((e) => e.milestone === m)?.received_at ?? null })),
  };
}

/** Everyone who follows this property: buyers, their agents, the HLA, the seller. */
export async function propertyWatchers(db: Db, propertyId: string) {
  const users = new Map<string, string | null>();
  const { data: res } = await db
    .from("pod_reservations")
    .select("buyer_account_id")
    .eq("property_id", propertyId)
    .eq("status", "reserved");
  const ids = [...new Set(((res ?? []) as Array<{ buyer_account_id: string }>).map((r) => r.buyer_account_id))];
  const agentIds = new Set<string>();
  if (ids.length) {
    const { data: buyers } = await db.from("buyer_accounts").select("auth_user_id, email, tethered_resident_agent_id").in("id", ids);
    for (const b of (buyers ?? []) as Array<{ auth_user_id: string; email: string | null; tethered_resident_agent_id: string | null }>) {
      users.set(b.auth_user_id, b.email);
      if (b.tethered_resident_agent_id) agentIds.add(b.tethered_resident_agent_id);
    }
  }
  const { data: pod } = await db.from("pods").select("heavy_lifting_agent_id, hla_status").eq("property_id", propertyId).maybeSingle();
  if (pod?.hla_status === "accepted" && pod.heavy_lifting_agent_id) agentIds.add(pod.heavy_lifting_agent_id);
  if (agentIds.size) {
    const { data: agents } = await db.from("agents").select("auth_user_id, email").in("id", [...agentIds]);
    for (const a of (agents ?? []) as Array<{ auth_user_id: string; email: string | null }>) users.set(a.auth_user_id, a.email);
  }
  const { data: property } = await db.from("properties").select("seller_id").eq("id", propertyId).maybeSingle();
  if (property?.seller_id) {
    const { data: seller } = await db.from("sellers").select("id, email").eq("id", property.seller_id).maybeSingle();
    users.set(property.seller_id, seller?.email ?? null);
  }
  return users;
}

async function broadcastStatus(db: Db, propertyId: string, milestone: TitleMilestone) {
  const { data: p } = await db.from("properties").select("address, city, state").eq("id", propertyId).maybeSingle();
  const where = p ? `${p.address}, ${p.city}, ${p.state}` : "your property";
  const watchers = await propertyWatchers(db, propertyId);
  for (const [authUserId, email] of watchers)
    await deliver(
      db,
      { authUserId, email },
      {
        subject: `Title update: ${MILESTONE_LABELS[milestone]}`,
        message: `Title update for ${where}: ${MILESTONE_LABELS[milestone]}. ${MILESTONE_DESCRIPTIONS[milestone]}`,
        type: "title",
      },
    );
  await audit(db, null, "status_broadcast", propertyId, { milestone, recipients: watchers.size });
}

export async function resolveDiscrepancy(db: Db, actorId: string, discrepancyId: string, note: string) {
  const { data: d } = await db.from("title_escrow_discrepancies").select("id, property_id, status, kind").eq("id", discrepancyId).maybeSingle();
  if (!d) throw new Error("Discrepancy not found");
  if (d.status === "resolved") throw new Error("Already resolved");
  await db
    .from("title_escrow_discrepancies")
    .update({ status: "resolved", resolution_note: note, resolved_by: actorId, resolved_at: new Date().toISOString() })
    .eq("id", discrepancyId);
  await audit(db, actorId, "discrepancy_resolved", d.property_id, { discrepancy_id: discrepancyId, kind: d.kind, note });
}

/** Can this user see the property's title status? */
export async function canViewTitleStatus(db: Db, authUserId: string, propertyId: string, isAdmin: boolean) {
  if (isAdmin) return true;
  return (await propertyWatchers(db, propertyId)).has(authUserId);
}
