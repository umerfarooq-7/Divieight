/**
 * Earnest Money Coordination — server side.
 *
 * The platform issues funding instructions and tracks status only. Funds move
 * directly from each Buyer Account to the title/escrow company; there is no
 * custody mechanism here by design.
 *
 * A missed obligation is a Default under PRA Section 8 and opens the existing
 * Member Substitution Pipeline — that pipeline is reused verbatim, never
 * reimplemented.
 */

import { deliver } from "@/lib/authorization.notify.server";
import {
  DEFAULT_FUNDING_METHODS,
  DEFAULT_PRA8_NOTICE,
  SUBSTITUTE_CONDITION_NOTICE,
  fundingInstruction,
  money,
  splitProRata,
  toCents,
  type EarnestObligation,
  type EarnestTerms,
} from "@/lib/earnest-money";

type Db = { from: (t: string) => any };

const SETTINGS_KEY = "earnest_money";
const DEFAULT_GRACE_HOURS = 24;
const DEFAULT_SUBSTITUTE_MIN_HOURS = 24;

export async function audit(
  db: Db,
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
    action_type: row.actionType,
    entity_type: "earnest_money_obligation",
    entity_id: row.entityId ?? null,
    metadata: row.metadata ?? {},
  });
}

async function settings(db: Db) {
  const { data } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", SETTINGS_KEY)
    .maybeSingle();
  const v = (data?.value ?? {}) as Record<string, number>;
  return {
    graceHours: Number(v["grace_hours"] ?? DEFAULT_GRACE_HOURS),
    substituteMinimumHours: Number(
      v["substitute_minimum_hours"] ?? DEFAULT_SUBSTITUTE_MIN_HOURS,
    ),
  };
}

export async function loadTerms(db: Db, propertyId: string): Promise<EarnestTerms | null> {
  const { data } = await db
    .from("earnest_money_terms")
    .select("*")
    .eq("property_id", propertyId)
    .maybeSingle();
  return (data as EarnestTerms) ?? null;
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
    .eq("status", "reserved");
  return (data ?? []) as Array<{
    id: string;
    buyer_account_id: string;
    shares_reserved: number | null;
  }>;
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
  const { data } = await db
    .from("agents")
    .select("auth_user_id, email")
    .eq("id", agentId)
    .maybeSingle();
  return (data ?? null) as { auth_user_id: string; email: string | null } | null;
}

// ---------------------------------------------------------------------------
// Issuing the obligations
// ---------------------------------------------------------------------------

export interface IssueEarnestInput {
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

/**
 * Split the accepted offer's earnest money pro-rata across the Buyer Accounts
 * holding shares in the pod and issue each one a funding instruction.
 */
export async function issueEarnestObligations(
  db: Db,
  actorId: string | null,
  input: IssueEarnestInput,
) {
  const holders = await activeHolders(db, input.propertyId);
  if (holders.length === 0) return { issued: 0, reason: "no_active_reservations" as const };

  const sharesBasis = holders.reduce((s, h) => s + (h.shares_reserved ?? 1), 0);
  const parts = splitProRata(
    toCents(input.totalAmount),
    holders.map((h) => ({
      buyerAccountId: h.buyer_account_id,
      shares: h.shares_reserved ?? 1,
    })),
  );
  const perShareAmount = sharesBasis > 0 ? input.totalAmount / sharesBasis : 0;
  const methods =
    input.fundingMethods && input.fundingMethods.length > 0
      ? input.fundingMethods
      : DEFAULT_FUNDING_METHODS;

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
  await db.from("earnest_money_terms").upsert(termsRow, { onConflict: "property_id" });

  const property = await propertyFor(db, input.propertyId);
  const terms = (await loadTerms(db, input.propertyId)) ?? (termsRow as unknown as EarnestTerms);

  let issued = 0;
  for (const part of parts) {
    const amount = part.amountCents / 100;
    const { data: existing } = await db
      .from("earnest_money_obligations")
      .select("id, status")
      .eq("property_id", input.propertyId)
      .eq("buyer_account_id", part.buyerAccountId)
      .maybeSingle();

    // A funded obligation is never rewritten by a re-issue.
    if (existing?.status === "funded") continue;

    let obligationId = existing?.id as string | undefined;
    if (obligationId) {
      await db
        .from("earnest_money_obligations")
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
        .from("earnest_money_obligations")
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
      const obligation = {
        id: obligationId ?? "",
        buyer_account_id: part.buyerAccountId,
        property_id: input.propertyId,
        amount,
        shares: part.shares,
        status: "pending" as const,
        funding_deadline: input.fundingDeadline,
        funded_at: null,
        funded_reference: null,
        late_at: null,
        missed_at: null,
        is_substitute: false,
      } satisfies EarnestObligation;
      await deliver(
        db,
        { authUserId: buyer.auth_user_id, email: buyer.email },
        {
          subject: "Earnest money funding instruction",
          message: `The seller has accepted the Buyer Group's offer for ${label(property)}. ${fundingInstruction(obligation, terms)} ${DEFAULT_PRA8_NOTICE}`,
          link: "/buyer/earnest-money",
        },
      );
      const ra = await agentRecipient(db, buyer.tethered_resident_agent_id);
      if (ra)
        await deliver(
          db,
          { authUserId: ra.auth_user_id, email: ra.email },
          {
            subject: "Earnest money instruction issued to your buyer",
            message: `An earnest-money funding instruction of ${money(amount)} has been issued for ${label(property)}, due ${new Date(input.fundingDeadline).toLocaleString("en-US")}. Funds go directly to the title/escrow company.`,
            link: "/agent/dashboard",
          },
        );
    }

    await audit(db, {
      actorId,
      actionType: "earnest.obligation_issued",
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

  return { issued, sharesBasis };
}

// ---------------------------------------------------------------------------
// Funding and status
// ---------------------------------------------------------------------------

export async function markObligationFunded(
  db: Db,
  actorId: string | null,
  params: { obligationId: string; reference?: string | null; fundedAt?: string | null },
) {
  const { data: row } = await db
    .from("earnest_money_obligations")
    .select("*")
    .eq("id", params.obligationId)
    .maybeSingle();
  if (!row) return { ok: false as const, reason: "not_found" as const };
  // A missed obligation has already been declared a Default and its slice
  // released to substitution — marking it funded would contradict that.
  if (row.status === "missed") return { ok: false as const, reason: "already_defaulted" as const };

  const fundedAt = params.fundedAt || new Date().toISOString();
  await db
    .from("earnest_money_obligations")
    .update({
      status: "funded",
      funded_at: fundedAt,
      funded_reference: params.reference ?? null,
      marked_by: actorId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.obligationId);

  await audit(db, {
    actorId,
    actionType: "earnest.funded",
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
        subject: "Earnest money receipt confirmed",
        message: `The title/escrow company has confirmed receipt of your ${money(row.amount)} earnest-money deposit for ${label(property)}.`,
        link: "/buyer/earnest-money",
      },
    );

  return { ok: true as const };
}

/** Escalation on a missed obligation: Default under PRA Section 8. */
async function declareDefault(
  db: Db,
  actorId: string | null,
  row: {
    id: string;
    property_id: string;
    buyer_account_id: string;
    amount: number;
  },
) {
  const now = new Date().toISOString();
  await db
    .from("earnest_money_obligations")
    .update({ status: "missed", missed_at: now, updated_at: now })
    .eq("id", row.id);

  const property = await propertyFor(db, row.property_id);
  const terms = await loadTerms(db, row.property_id);

  // Title/escrow company.
  if (terms?.escrow_contact_email)
    await deliver(
      db,
      { authUserId: null, email: terms.escrow_contact_email },
      {
        subject: "Earnest money not funded by deadline",
        message: `One Buyer Account in the buyer group for ${label(property)} did not fund its ${money(row.amount)} pro-rata earnest money by the deadline. This is a Default under PRA Section 8 and substitution of the affected share is now in progress.`,
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
        message: `An earnest-money obligation in your pod for ${label(property)} was not funded by the deadline. Substitution is in progress and we'll confirm as soon as the pod is complete again. Your own obligation and timeline are unchanged.`,
        link: "/buyer/earnest-money",
      },
    );
    const ra = await agentRecipient(db, buyer.tethered_resident_agent_id);
    if (ra)
      await deliver(
        db,
        { authUserId: ra.auth_user_id, email: ra.email },
        {
          subject: "Earnest money Default in your buyer's pod",
          message: `An earnest-money obligation for ${label(property)} was not funded by the deadline — a Default under PRA Section 8. The Member Substitution Pipeline has been opened for the affected share.`,
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
          subject: "Your buyer's earnest money was not funded",
          message: `Your buyer's ${money(row.amount)} earnest-money obligation for ${label(property)} was not funded by the deadline. This is a Default under PRA Section 8 and the share is being substituted.`,
          link: "/agent/dashboard",
        },
      );
  }

  await audit(db, {
    actorId,
    actorType: "system",
    actionType: "earnest.default_declared",
    entityId: row.id,
    metadata: {
      property_id: row.property_id,
      buyer_account_id: row.buyer_account_id,
      amount: row.amount,
      basis: "pra_section_8_default_failure_to_fund",
    },
  });

  // Release the slice and reuse the Member Substitution Pipeline as-is.
  const { data: reservation } = await db
    .from("pod_reservations")
    .select("id")
    .eq("property_id", row.property_id)
    .eq("buyer_account_id", row.buyer_account_id)
    .eq("status", "reserved")
    .maybeSingle();

  if (reservation?.id) {
    await db
      .from("pod_reservations")
      .update({ status: "defaulted", updated_at: now })
      .eq("id", reservation.id);

    // Same bookkeeping as a withdrawal: a vacated slice reopens a fully
    // locked pod, and the cap table must drop the defaulting holder.
    await db
      .from("properties")
      .update({ listing_status: "forming" })
      .eq("id", row.property_id)
      .eq("listing_status", "system_lock");

    const { syncCapTable } = await import("@/lib/entity-genesis.server");
    await syncCapTable(db as never, {
      propertyId: row.property_id,
      actorId: actorId as string, // null for scheduled sweeps (system actor)
      reason: "earnest_money_default",
    });
  }

  const { openSubstitution } = await import("@/lib/substitution-invite.server");
  await openSubstitution(db as never, {
    propertyId: row.property_id,
    vacatedReservationId: reservation?.id ?? null,
    actorId,
    cause: "default",
  });

  await audit(db, {
    actorId,
    actorType: "system",
    actionType: "earnest.substitution_opened",
    entityId: row.id,
    metadata: {
      property_id: row.property_id,
      vacated_reservation_id: reservation?.id ?? null,
    },
  });
}

/** Bounded, idempotent deadline sweep: pending → late → missed (Default). */
export async function runEarnestMoneySweep(db: Db, actorId: string | null = null, limit = 100) {
  const { graceHours } = await settings(db);
  const now = Date.now();
  const { data: rows } = await db
    .from("earnest_money_obligations")
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
      await db
        .from("earnest_money_obligations")
        .update({ status: "late", late_at: at, updated_at: at })
        .eq("id", row.id);
      markedLate++;

      const buyer = await buyerRecipient(db, row.buyer_account_id);
      const property = await propertyFor(db, row.property_id);
      if (buyer)
        await deliver(
          db,
          { authUserId: buyer.auth_user_id, email: buyer.email },
          {
            subject: "Earnest money past deadline",
            message: `Your ${money(row.amount)} earnest-money deposit for ${label(property)} has not been confirmed by the title/escrow company. ${DEFAULT_PRA8_NOTICE}`,
            link: "/buyer/earnest-money",
          },
        );

      await audit(db, {
        actorId,
        actorType: "system",
        actionType: "earnest.late",
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
    await declareDefault(db, actorId, row);
    defaulted++;
  }

  return { markedLate, defaulted, checked: (rows ?? []).length };
}

// ---------------------------------------------------------------------------
// Substitute Members
// ---------------------------------------------------------------------------

/**
 * A Substitute Member installed through the Substitution Pipeline funds their
 * pro-rata earnest money on the SAME timeline as the member they replace. If
 * that deadline has already passed, a short minimum window applies so the
 * obligation is actionable.
 */
export async function createSubstituteObligation(
  db: Db,
  params: {
    propertyId: string;
    buyerAccountId: string;
    shares: number;
    actorId: string | null;
    replacesObligationId?: string | null;
  },
) {
  const terms = await loadTerms(db, params.propertyId);
  if (!terms) return { created: false as const, reason: "no_terms" as const };

  const { substituteMinimumHours } = await settings(db);
  const original = Date.parse(terms.funding_deadline);
  const minimum = Date.now() + substituteMinimumHours * 3600_000;
  const deadline = new Date(
    Number.isFinite(original) && original > Date.now() ? original : minimum,
  ).toISOString();

  const amount = Number((terms.per_share_amount * Math.max(1, params.shares)).toFixed(2));

  const { data: existing } = await db
    .from("earnest_money_obligations")
    .select("id")
    .eq("property_id", params.propertyId)
    .eq("buyer_account_id", params.buyerAccountId)
    .maybeSingle();

  let obligationId = (existing as { id: string } | null)?.id ?? null;
  if (obligationId) {
    await db
      .from("earnest_money_obligations")
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
      .from("earnest_money_obligations")
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
    const obligation = {
      id: obligationId ?? "",
      buyer_account_id: params.buyerAccountId,
      property_id: params.propertyId,
      amount,
      shares: params.shares,
      status: "pending" as const,
      funding_deadline: deadline,
      funded_at: null,
      funded_reference: null,
      late_at: null,
      missed_at: null,
      is_substitute: true,
    } satisfies EarnestObligation;
    await deliver(
      db,
      { authUserId: buyer.auth_user_id, email: buyer.email },
      {
        subject: "Earnest money due for your new share",
        message: `${fundingInstruction(obligation, terms)} ${SUBSTITUTE_CONDITION_NOTICE} ${DEFAULT_PRA8_NOTICE}`,
        link: "/buyer/earnest-money",
      },
    );
    const ra = await agentRecipient(db, buyer.tethered_resident_agent_id);
    if (ra)
      await deliver(
        db,
        { authUserId: ra.auth_user_id, email: ra.email },
        {
          subject: "Substitute member earnest money issued",
          message: `Your buyer's substitute share in ${label(property)} carries a ${money(amount)} earnest-money obligation on the existing pod timeline.`,
          link: "/agent/dashboard",
        },
      );
  }

  await audit(db, {
    actorId: params.actorId,
    actorType: "system",
    actionType: "earnest.substitute_obligation_created",
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
