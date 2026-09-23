/**
 * Pro-rata funding obligations paid DIRECTLY to escrow by each Buyer Account —
 * the shared engine behind Earnest Money (Prompt 5) and Closing-Cost Funding
 * (Prompt 7). The platform calculates, instructs and tracks; it never takes
 * custody. A missed obligation is a Default under PRA Section 8 and opens the
 * existing Member Substitution Pipeline; a Substitute Member inherits the same
 * obligation on the same timeline as a condition of installation.
 *
 * Each kind supplies its own tables, audit prefix, portal link and copy via
 * `FundingKind`; the lifecycle below is identical for both.
 */

import { deliver } from "@/lib/authorization.notify.server";
import {
  DEFAULT_FUNDING_METHODS,
  money,
  splitProRata,
  toCents,
  type EarnestObligation as FundingObligation,
  type EarnestTerms as FundingTerms,
} from "@/lib/earnest-money";

export type { FundingObligation, FundingTerms };

type Db = { from: (t: string) => any };

export interface FundingKind {
  termsTable: string;
  obligationsTable: string;
  /** audit_log action prefix, e.g. "earnest" → "earnest.funded". */
  auditPrefix: string;
  entityType: string;
  settingsKey: string;
  portalLink: string;
  /** Lower-case noun for copy, e.g. "earnest money", "closing funds". */
  noun: string;
  /** Short title-case noun for subjects, e.g. "Earnest money". */
  title: string;
  /** Cap-table sync reason recorded on Default. */
  defaultReason: string;
  /** Plain-language funding instruction for one obligation. */
  instruction: (o: FundingObligation, t: FundingTerms) => string;
  pra8Notice: string;
  substituteNotice: string;
  /** Opening sentence of the instruction notice. */
  issueLead: (propertyLabel: string) => string;
}

const DEFAULT_GRACE_HOURS = 24;
const DEFAULT_SUBSTITUTE_MIN_HOURS = 24;

export async function audit(
  db: Db,
  kind: FundingKind,
  row: {
    actorId: string | null;
    actorType?: string;
    actionType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await db.from("audit_log").insert({
    actor_id: row.actorId,
    actor_type: row.actorType ?? "admin",
    action_type: `${kind.auditPrefix}.${row.actionType}`,
    entity_type: kind.entityType,
    entity_id: row.entityId ?? null,
    metadata: row.metadata ?? {},
  });
}

async function settings(db: Db, kind: FundingKind) {
  const { data } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", kind.settingsKey)
    .maybeSingle();
  const v = (data?.value ?? {}) as Record<string, number>;
  return {
    graceHours: Number(v["grace_hours"] ?? DEFAULT_GRACE_HOURS),
    substituteMinimumHours: Number(v["substitute_minimum_hours"] ?? DEFAULT_SUBSTITUTE_MIN_HOURS),
  };
}

export async function loadTerms(db: Db, kind: FundingKind, propertyId: string): Promise<FundingTerms | null> {
  const { data } = await db.from(kind.termsTable).select("*").eq("property_id", propertyId).maybeSingle();
  return (data as FundingTerms) ?? null;
}

async function propertyFor(db: Db, id: string) {
  const { data } = await db
    .from("properties")
    .select("id, address, city, state")
    .eq("id", id)
    .maybeSingle();
  return data as { id: string; address: string; city: string; state: string } | null;
}

function label(p: { address: string; city: string; state: string } | null) {
  return p ? `${p.address}, ${p.city}, ${p.state}` : "your subject property";
}

async function activeHolders(db: Db, propertyId: string) {
  const { data } = await db
    .from("pod_reservations")
    .select("id, buyer_account_id, shares_reserved")
    .eq("property_id", propertyId)
    .eq("status", "reserved")
    // Deterministic order so a re-issue splits (and rounds) identically.
    .order("reserved_at", { ascending: true });
  return (data ?? []) as Array<{ id: string; buyer_account_id: string; shares_reserved: number | null }>;
}

async function buyerRecipient(db: Db, buyerAccountId: string) {
  const { data } = await db
    .from("buyer_accounts")
    .select("id, auth_user_id, email, tethered_resident_agent_id")
    .eq("id", buyerAccountId)
    .maybeSingle();
  return (data ?? null) as {
    id: string;
    auth_user_id: string;
    email: string | null;
    tethered_resident_agent_id: string | null;
  } | null;
}

async function agentRecipient(db: Db, agentId: string | null) {
  if (!agentId) return null;
  const { data } = await db.from("agents").select("auth_user_id, email").eq("id", agentId).maybeSingle();
  return (data ?? null) as { auth_user_id: string; email: string | null } | null;
}

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

export interface IssueFundingInput {
  propertyId: string;
  totalAmount: number;
  fundingDeadline: string;
  escrowCompany: string;
  escrowAccountDetails: string;
  escrowReference?: string | null;
  escrowContactEmail?: string | null;
  fundingMethods?: string[];
  sourceRequestId?: string | null;
}

export type IssueFundingResult =
  | { issued: number; sharesBasis: number; reason: null; conflicts: [] }
  | { issued: 0; reason: "no_active_reservations"; conflicts: [] }
  | {
      issued: 0;
      reason: "funded_amount_conflict";
      conflicts: Array<{ buyerAccountId: string; fundedAmount: number; newAmount: number }>;
    };

/** Split a total pro-rata by shares and issue each Buyer Account its notice. */
export async function issueObligations(
  db: Db,
  kind: FundingKind,
  actorId: string | null,
  input: IssueFundingInput,
): Promise<IssueFundingResult> {
  const holders = await activeHolders(db, input.propertyId);
  if (holders.length === 0) return { issued: 0, reason: "no_active_reservations", conflicts: [] };

  const sharesBasis = holders.reduce((s, h) => s + (h.shares_reserved ?? 1), 0);
  const parts = splitProRata(
    toCents(input.totalAmount),
    holders.map((h) => ({ buyerAccountId: h.buyer_account_id, shares: h.shares_reserved ?? 1 })),
  );
  const perShareAmount = sharesBasis > 0 ? input.totalAmount / sharesBasis : 0;

  // Money already sent to escrow can't be silently re-priced: if a re-issue
  // would change what a funded Account owes, refuse and name who's affected.
  const { data: fundedRows } = await db
    .from(kind.obligationsTable)
    .select("buyer_account_id, amount, status")
    .eq("property_id", input.propertyId)
    .eq("status", "funded");
  const fundedByBuyer = new Map(
    ((fundedRows ?? []) as Array<{ buyer_account_id: string; amount: number }>).map((o) => [
      o.buyer_account_id,
      toCents(Number(o.amount)),
    ]),
  );
  const conflicts = parts
    .filter((p) => fundedByBuyer.has(p.buyerAccountId) && fundedByBuyer.get(p.buyerAccountId) !== p.amountCents)
    .map((p) => ({
      buyerAccountId: p.buyerAccountId,
      fundedAmount: fundedByBuyer.get(p.buyerAccountId)! / 100,
      newAmount: p.amountCents / 100,
    }));
  if (conflicts.length > 0) {
    await audit(db, kind, {
      actorId,
      actionType: "reissue_blocked",
      metadata: { property_id: input.propertyId, total_amount: input.totalAmount, conflicts },
    });
    return { issued: 0, reason: "funded_amount_conflict", conflicts };
  }

  const methods =
    input.fundingMethods && input.fundingMethods.length > 0 ? input.fundingMethods : DEFAULT_FUNDING_METHODS;
  const termsRow = {
    property_id: input.propertyId,
    total_amount: input.totalAmount,
    shares_basis: sharesBasis,
    per_share_amount: perShareAmount,
    funding_deadline: input.fundingDeadline,
    escrow_company: input.escrowCompany,
    escrow_account_details: input.escrowAccountDetails,
    escrow_reference: input.escrowReference ?? null,
    escrow_contact_email: input.escrowContactEmail ?? null,
    funding_methods: methods,
    source_request_id: input.sourceRequestId ?? null,
    issued_by: actorId,
    updated_at: new Date().toISOString(),
  };
  const { error: termsError } = await db.from(kind.termsTable).upsert(termsRow, { onConflict: "property_id" });
  if (termsError) throw new Error(termsError.message);

  const property = await propertyFor(db, input.propertyId);
  const terms = (await loadTerms(db, kind, input.propertyId)) ?? (termsRow as unknown as FundingTerms);

  let issued = 0;
  for (const part of parts) {
    const amount = part.amountCents / 100;
    const { data: existing } = await db
      .from(kind.obligationsTable)
      .select("id, status")
      .eq("property_id", input.propertyId)
      .eq("buyer_account_id", part.buyerAccountId)
      .maybeSingle();

    // A funded obligation is never rewritten by a re-issue.
    if (existing?.status === "funded") continue;

    let obligationId = existing?.id as string | undefined;
    if (obligationId) {
      await db
        .from(kind.obligationsTable)
        .update({
          amount,
          shares: part.shares,
          funding_deadline: input.fundingDeadline,
          status: "pending",
          late_at: null,
          missed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", obligationId);
    } else {
      const { data: inserted } = await db
        .from(kind.obligationsTable)
        .insert({
          buyer_account_id: part.buyerAccountId,
          property_id: input.propertyId,
          amount,
          shares: part.shares,
          status: "pending",
          funding_deadline: input.fundingDeadline,
        })
        .select("id")
        .maybeSingle();
      obligationId = (inserted as { id: string } | null)?.id;
    }
    issued++;

    const buyer = await buyerRecipient(db, part.buyerAccountId);
    if (buyer) {
      const obligation: FundingObligation = {
        id: obligationId ?? "",
        buyer_account_id: part.buyerAccountId,
        property_id: input.propertyId,
        amount,
        shares: part.shares,
        status: "pending",
        funding_deadline: input.fundingDeadline,
        funded_at: null,
        funded_reference: null,
        late_at: null,
        missed_at: null,
        is_substitute: false,
      };
      await deliver(
        db,
        { authUserId: buyer.auth_user_id, email: buyer.email },
        {
          subject: `${kind.title} funding instruction`,
          message: `${kind.issueLead(label(property))} ${kind.instruction(obligation, terms)} ${kind.pra8Notice}`,
          link: kind.portalLink,
        },
      );
      const ra = await agentRecipient(db, buyer.tethered_resident_agent_id);
      if (ra)
        await deliver(
          db,
          { authUserId: ra.auth_user_id, email: ra.email },
          {
            subject: `${kind.title} instruction issued to your buyer`,
            message: `A ${kind.noun} funding instruction of ${money(amount)} has been issued for ${label(property)}, due ${new Date(input.fundingDeadline).toLocaleString("en-US")}. Funds go directly to the title/escrow company.`,
            link: "/agent/dashboard",
          },
        );
    }

    await audit(db, kind, {
      actorId,
      actionType: "obligation_issued",
      entityId: obligationId ?? null,
      metadata: {
        property_id: input.propertyId,
        buyer_account_id: part.buyerAccountId,
        shares: part.shares,
        amount,
        total_amount: input.totalAmount,
        shares_basis: sharesBasis,
        funding_deadline: input.fundingDeadline,
        custody: "direct_to_escrow_platform_never_holds",
      },
    });
  }

  return { issued, sharesBasis, reason: null, conflicts: [] };
}

// ---------------------------------------------------------------------------
// Funding and status
// ---------------------------------------------------------------------------

export async function markFunded(
  db: Db,
  kind: FundingKind,
  actorId: string | null,
  params: { obligationId: string; reference?: string | null; fundedAt?: string | null },
) {
  const { data: row } = await db.from(kind.obligationsTable).select("*").eq("id", params.obligationId).maybeSingle();
  if (!row) return { ok: false as const, reason: "not_found" as const };
  // A missed obligation has already been declared a Default and its slice
  // released to substitution — marking it funded would contradict that.
  if (row.status === "missed") return { ok: false as const, reason: "already_defaulted" as const };

  const fundedAt = params.fundedAt || new Date().toISOString();
  await db
    .from(kind.obligationsTable)
    .update({
      status: "funded",
      funded_at: fundedAt,
      funded_reference: params.reference ?? null,
      marked_by: actorId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.obligationId);

  await audit(db, kind, {
    actorId,
    actionType: "funded",
    entityId: params.obligationId,
    metadata: {
      property_id: row.property_id,
      buyer_account_id: row.buyer_account_id,
      amount: row.amount,
      funded_at: fundedAt,
      reference: params.reference ?? null,
      confirmed_by: "manager_record_of_escrow_confirmation",
    },
  });

  const buyer = await buyerRecipient(db, row.buyer_account_id);
  const property = await propertyFor(db, row.property_id);
  if (buyer)
    await deliver(
      db,
      { authUserId: buyer.auth_user_id, email: buyer.email },
      {
        subject: `${kind.title} receipt confirmed`,
        message: `The title/escrow company has confirmed receipt of your ${money(row.amount)} ${kind.noun} for ${label(property)}.`,
        link: kind.portalLink,
      },
    );

  return { ok: true as const };
}

/** Escalation on a missed obligation: Default under PRA Section 8. */
async function declareDefault(
  db: Db,
  kind: FundingKind,
  actorId: string | null,
  row: { id: string; property_id: string; buyer_account_id: string; amount: number },
) {
  const now = new Date().toISOString();
  await db
    .from(kind.obligationsTable)
    .update({ status: "missed", missed_at: now, updated_at: now })
    .eq("id", row.id);

  const property = await propertyFor(db, row.property_id);
  const terms = await loadTerms(db, kind, row.property_id);

  // The slice may already have been vacated (withdrawal, or a Default on a
  // different obligation) — then there is nothing left to substitute.
  const { data: reservation } = await db
    .from("pod_reservations")
    .select("id")
    .eq("property_id", row.property_id)
    .eq("buyer_account_id", row.buyer_account_id)
    .eq("status", "reserved")
    .maybeSingle();

  await audit(db, kind, {
    actorId,
    actorType: "system",
    actionType: "default_declared",
    entityId: row.id,
    metadata: {
      property_id: row.property_id,
      buyer_account_id: row.buyer_account_id,
      amount: row.amount,
      basis: "pra_section_8_default_failure_to_fund",
      slice_already_vacated: !reservation?.id,
    },
  });
  if (!reservation?.id) return;

  // Title/escrow company.
  if (terms?.escrow_contact_email)
    await deliver(
      db,
      { authUserId: null, email: terms.escrow_contact_email },
      {
        subject: `${kind.title} not funded by deadline`,
        message: `One Buyer Account in the buyer group for ${label(property)} did not fund its ${money(row.amount)} pro-rata ${kind.noun} by the deadline. This is a Default under PRA Section 8 and substitution of the affected share is now in progress.`,
      },
    );

  // Non-defaulting members and their tethered Resident Agents — no name, no
  // reason disclosed to members.
  const holders = await activeHolders(db, row.property_id);
  for (const h of holders) {
    if (h.buyer_account_id === row.buyer_account_id) continue;
    const buyer = await buyerRecipient(db, h.buyer_account_id);
    if (!buyer) continue;
    await deliver(
      db,
      { authUserId: buyer.auth_user_id, email: buyer.email },
      {
        subject: "A share in your pod is being substituted",
        message: `A ${kind.noun} obligation in your pod for ${label(property)} was not funded by the deadline. Substitution is in progress and we'll confirm as soon as the pod is complete again. Your own obligation and timeline are unchanged.`,
        link: kind.portalLink,
      },
    );
    const ra = await agentRecipient(db, buyer.tethered_resident_agent_id);
    if (ra)
      await deliver(
        db,
        { authUserId: ra.auth_user_id, email: ra.email },
        {
          subject: `${kind.title} Default in your buyer's pod`,
          message: `A ${kind.noun} obligation for ${label(property)} was not funded by the deadline — a Default under PRA Section 8. The Member Substitution Pipeline has been opened for the affected share.`,
          link: "/agent/dashboard",
        },
      );
  }

  // Defaulting Account's own tethered Resident Agent.
  const defaulting = await buyerRecipient(db, row.buyer_account_id);
  if (defaulting) {
    const ra = await agentRecipient(db, defaulting.tethered_resident_agent_id);
    if (ra)
      await deliver(
        db,
        { authUserId: ra.auth_user_id, email: ra.email },
        {
          subject: `Your buyer's ${kind.noun} was not funded`,
          message: `Your buyer's ${money(row.amount)} ${kind.noun} obligation for ${label(property)} was not funded by the deadline. This is a Default under PRA Section 8 and the share is being substituted.`,
          link: "/agent/dashboard",
        },
      );
  }

  // Release the slice; same bookkeeping as a withdrawal.
  await db.from("pod_reservations").update({ status: "defaulted", updated_at: now }).eq("id", reservation.id);
  await db
    .from("properties")
    .update({ listing_status: "forming" })
    .eq("id", row.property_id)
    .eq("listing_status", "system_lock");

  const { syncCapTable } = await import("@/lib/entity-genesis.server");
  await syncCapTable(db as never, {
    propertyId: row.property_id,
    actorId: actorId as string, // null for scheduled sweeps (system actor)
    reason: kind.defaultReason,
  });

  // Reuse the Member Substitution Pipeline as-is (best efforts).
  const { openSubstitution } = await import("@/lib/substitution-invite.server");
  await openSubstitution(db as never, {
    propertyId: row.property_id,
    vacatedReservationId: reservation.id,
    actorId,
    cause: "default",
  });

  await audit(db, kind, {
    actorId,
    actorType: "system",
    actionType: "substitution_opened",
    entityId: row.id,
    metadata: { property_id: row.property_id, vacated_reservation_id: reservation.id },
  });
}

/** Bounded, idempotent deadline sweep: pending → late → missed (Default). */
export async function runSweep(db: Db, kind: FundingKind, actorId: string | null = null, limit = 100) {
  const { graceHours } = await settings(db, kind);
  const now = Date.now();
  const { data: rows } = await db
    .from(kind.obligationsTable)
    .select("id, property_id, buyer_account_id, amount, status, funding_deadline, late_at")
    .in("status", ["pending", "late"])
    // Only past-deadline rows, oldest first — otherwise future-dated rows can
    // fill the batch and starve overdue ones.
    .lte("funding_deadline", new Date(now).toISOString())
    .order("funding_deadline", { ascending: true })
    .limit(limit);

  let markedLate = 0;
  let defaulted = 0;

  for (const row of (rows ?? []) as Array<{
    id: string;
    property_id: string;
    buyer_account_id: string;
    amount: number;
    status: string;
    funding_deadline: string;
    late_at: string | null;
  }>) {
    const deadline = Date.parse(row.funding_deadline);
    if (!Number.isFinite(deadline) || deadline > now) continue;

    if (row.status === "pending") {
      const at = new Date().toISOString();
      await db.from(kind.obligationsTable).update({ status: "late", late_at: at, updated_at: at }).eq("id", row.id);
      markedLate++;

      const buyer = await buyerRecipient(db, row.buyer_account_id);
      const property = await propertyFor(db, row.property_id);
      if (buyer)
        await deliver(
          db,
          { authUserId: buyer.auth_user_id, email: buyer.email },
          {
            subject: `${kind.title} past deadline`,
            message: `Your ${money(row.amount)} ${kind.noun} deposit for ${label(property)} has not been confirmed by the title/escrow company. ${kind.pra8Notice}`,
            link: kind.portalLink,
          },
        );

      await audit(db, kind, {
        actorId,
        actorType: "system",
        actionType: "late",
        entityId: row.id,
        metadata: {
          property_id: row.property_id,
          buyer_account_id: row.buyer_account_id,
          funding_deadline: row.funding_deadline,
          grace_hours: graceHours,
        },
      });
      continue;
    }

    const lateSince = row.late_at ? Date.parse(row.late_at) : deadline;
    if (now - lateSince < graceHours * 3600_000) continue;
    await declareDefault(db, kind, actorId, row);
    defaulted++;
  }

  return { markedLate, defaulted, checked: (rows ?? []).length };
}

// ---------------------------------------------------------------------------
// Substitute Members
// ---------------------------------------------------------------------------

/**
 * A Substitute Member funds their pro-rata share on the SAME timeline as the
 * member they replace. If that deadline has already passed, a short minimum
 * window applies so the obligation is actionable.
 */
export async function createSubstituteObligation(
  db: Db,
  kind: FundingKind,
  params: {
    propertyId: string;
    buyerAccountId: string;
    shares: number;
    actorId: string | null;
    replacesObligationId?: string | null;
  },
) {
  const terms = await loadTerms(db, kind, params.propertyId);
  if (!terms) return { created: false as const, reason: "no_terms" as const };

  const { substituteMinimumHours } = await settings(db, kind);
  const original = Date.parse(terms.funding_deadline);
  const minimum = Date.now() + substituteMinimumHours * 3600_000;
  const deadline = new Date(Number.isFinite(original) && original > Date.now() ? original : minimum).toISOString();

  const amount = Number((terms.per_share_amount * Math.max(1, params.shares)).toFixed(2));

  const { data: existing } = await db
    .from(kind.obligationsTable)
    .select("id")
    .eq("property_id", params.propertyId)
    .eq("buyer_account_id", params.buyerAccountId)
    .maybeSingle();

  let obligationId = (existing as { id: string } | null)?.id ?? null;
  if (obligationId) {
    await db
      .from(kind.obligationsTable)
      .update({
        amount,
        shares: params.shares,
        status: "pending",
        funding_deadline: deadline,
        late_at: null,
        missed_at: null,
        is_substitute: true,
        replaces_obligation_id: params.replacesObligationId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", obligationId);
  } else {
    const { data: inserted } = await db
      .from(kind.obligationsTable)
      .insert({
        buyer_account_id: params.buyerAccountId,
        property_id: params.propertyId,
        amount,
        shares: params.shares,
        status: "pending",
        funding_deadline: deadline,
        is_substitute: true,
        replaces_obligation_id: params.replacesObligationId ?? null,
      })
      .select("id")
      .maybeSingle();
    obligationId = (inserted as { id: string } | null)?.id ?? null;
  }

  const property = await propertyFor(db, params.propertyId);
  const buyer = await buyerRecipient(db, params.buyerAccountId);
  if (buyer) {
    const obligation: FundingObligation = {
      id: obligationId ?? "",
      buyer_account_id: params.buyerAccountId,
      property_id: params.propertyId,
      amount,
      shares: params.shares,
      status: "pending",
      funding_deadline: deadline,
      funded_at: null,
      funded_reference: null,
      late_at: null,
      missed_at: null,
      is_substitute: true,
    };
    await deliver(
      db,
      { authUserId: buyer.auth_user_id, email: buyer.email },
      {
        subject: `${kind.title} due for your new share`,
        message: `${kind.instruction(obligation, terms)} ${kind.substituteNotice} ${kind.pra8Notice}`,
        link: kind.portalLink,
      },
    );
    const ra = await agentRecipient(db, buyer.tethered_resident_agent_id);
    if (ra)
      await deliver(
        db,
        { authUserId: ra.auth_user_id, email: ra.email },
        {
          subject: `Substitute member ${kind.noun} issued`,
          message: `Your buyer's substitute share in ${label(property)} carries a ${money(amount)} ${kind.noun} obligation on the existing pod timeline.`,
          link: "/agent/dashboard",
        },
      );
  }

  await audit(db, kind, {
    actorId: params.actorId,
    actorType: "system",
    actionType: "substitute_obligation_created",
    entityId: obligationId,
    metadata: {
      property_id: params.propertyId,
      buyer_account_id: params.buyerAccountId,
      shares: params.shares,
      amount,
      funding_deadline: deadline,
      timeline: "inherited_from_replaced_member",
      condition: "installation_conditional_on_funding",
    },
  });

  return { created: true as const, obligationId, amount, deadline };
}
