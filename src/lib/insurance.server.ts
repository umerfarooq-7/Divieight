/**
 * Insurance Procurement by the Manager — server side (Prompt 8).
 *
 * Every procurement, alternative-selection, vote and renewal event is written
 * to audit_log under the `insurance.` prefix.
 */
import { deliver } from "@/lib/authorization.notify.server";
import {
  checkCoverage,
  declaredUseFor,
  tallyVotes,
  validateRules,
  type CoverageRequirementVersion,
  type CoverageRule,
  type DeclaredUse,
  type ProcurementMethod,
} from "@/lib/insurance";

type Db = { from: (t: string) => any };

export async function audit(
  db: Db,
  row: { actorId: string | null; actorType?: string; actionType: string; entityId?: string | null; metadata?: Record<string, unknown> },
) {
  await db.from("audit_log").insert({
    actor_id: row.actorId,
    actor_type: row.actorType ?? "admin",
    action_type: `insurance.${row.actionType}`,
    entity_type: "insurance",
    entity_id: row.entityId ?? null,
    metadata: row.metadata ?? {},
  });
}

async function property(db: Db, id: string) {
  const { data } = await db
    .from("properties")
    .select("id, address, city, state, usage_tag, listing_price, anticipated_closing_date")
    .eq("id", id)
    .maybeSingle();
  return data as {
    id: string;
    address: string;
    city: string;
    state: string;
    usage_tag: string | null;
    listing_price: number | null;
    anticipated_closing_date: string | null;
  } | null;
}

const labelOf = (p: { address: string; city: string; state: string } | null) =>
  p ? `${p.address}, ${p.city}, ${p.state}` : "your property";

async function podBuyers(db: Db, propertyId: string) {
  const { data: res } = await db
    .from("pod_reservations")
    .select("buyer_account_id")
    .eq("property_id", propertyId)
    .eq("status", "reserved");
  const ids = [...new Set(((res ?? []) as Array<{ buyer_account_id: string }>).map((r) => r.buyer_account_id))];
  if (ids.length === 0) return [];
  const { data } = await db.from("buyer_accounts").select("id, auth_user_id, email").in("id", ids);
  return (data ?? []) as Array<{ id: string; auth_user_id: string; email: string | null }>;
}

async function notifyPod(db: Db, propertyId: string, subject: string, message: string) {
  for (const b of await podBuyers(db, propertyId))
    await deliver(db, { authUserId: b.auth_user_id, email: b.email }, { subject, message, link: "/buyer/insurance", type: "insurance" });
}

// ---------------------------------------------------------------------------
// Coverage requirements (versioned)
// ---------------------------------------------------------------------------

export async function activeRequirements(db: Db): Promise<CoverageRequirementVersion | null> {
  const { data } = await db.from("coverage_requirements").select("*").eq("is_active", true).maybeSingle();
  return (data as CoverageRequirementVersion) ?? null;
}

/** Saving always creates a new version and activates it; history is kept. */
export async function saveRequirementVersion(
  db: Db,
  actorId: string,
  input: { rules: CoverageRule[]; notes?: string | null; isPlaceholder: boolean },
) {
  const problem = validateRules(input.rules);
  if (problem) throw new Error(problem);
  const { data: latest } = await db
    .from("coverage_requirements")
    .select("version")
    .order("version", { ascending: false })
    .limit(1);
  const version = (((latest ?? []) as Array<{ version: number }>)[0]?.version ?? 0) + 1;
  const previous = await activeRequirements(db);

  await db.from("coverage_requirements").update({ is_active: false }).eq("is_active", true);
  const { data: created, error } = await db
    .from("coverage_requirements")
    .insert({
      version,
      rules: input.rules,
      is_placeholder: input.isPlaceholder,
      is_active: true,
      notes: input.notes ?? null,
      created_by: actorId,
      activated_at: new Date().toISOString(),
    })
    .select("id, version")
    .maybeSingle();
  if (error || !created) {
    // Put the previous version back so there is always an active one.
    if (previous) await db.from("coverage_requirements").update({ is_active: true }).eq("id", previous.id);
    throw new Error(error?.message ?? "Could not save the requirements");
  }
  await audit(db, {
    actorId,
    actionType: "requirements_versioned",
    entityId: created.id,
    metadata: {
      version,
      previous_version: previous?.version ?? null,
      is_placeholder: input.isPlaceholder,
      rules: input.rules,
    },
  });
  return { version };
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export interface RecordPolicyInput {
  propertyId: string;
  carrierName: string;
  policyNumber: string;
  coverageAmount: number;
  liabilityCoverage: number | null;
  premium: number;
  effectiveDate: string;
  renewsAt?: string | null;
  replacementCost: number;
  method: ProcurementMethod;
  alternativeProposalId?: string | null;
  renewedFromPolicyId?: string | null;
}

/** The Manager records a procured policy (pending until bound). */
export async function recordPolicy(db: Db, actorId: string, input: RecordPolicyInput) {
  const prop = await property(db, input.propertyId);
  if (!prop) throw new Error("Property not found");
  const req = await activeRequirements(db);
  if (!req) throw new Error("No active coverage requirements — save a version first.");
  const use: DeclaredUse = declaredUseFor(prop.usage_tag);

  if (input.method === "buyer_alternative") {
    const { data: proposal } = await db
      .from("insurance_alternative_proposals")
      .select("id, property_id, status")
      .eq("id", input.alternativeProposalId ?? "")
      .maybeSingle();
    if (!proposal || proposal.property_id !== input.propertyId || proposal.status !== "selected")
      throw new Error("A buyer-alternative policy must come from the pod's selected alternative.");
  }

  const check = checkCoverage(req.rules, {
    replacementCost: input.replacementCost,
    use,
    coverage: input.coverageAmount,
    liability: input.liabilityCoverage,
  });
  if (!check.meets) throw new Error(`Policy does not meet coverage requirements: ${check.shortfalls.join(" ")}`);

  const { data: created, error } = await db
    .from("insurance_policies")
    .insert({
      property_id: input.propertyId,
      carrier_name: input.carrierName,
      policy_number: input.policyNumber,
      coverage_amount: input.coverageAmount,
      liability_coverage: input.liabilityCoverage,
      premium: input.premium,
      effective_date: input.effectiveDate,
      renews_at: input.renewsAt ?? null,
      procured_by: "manager",
      procurement_method: input.method,
      status: "pending",
      declared_use: use,
      replacement_cost: input.replacementCost,
      requirement_version: req.version,
      alternative_proposal_id: input.alternativeProposalId ?? null,
      renewed_from_policy_id: input.renewedFromPolicyId ?? null,
      premium_paid_from: "llc_operating_account",
      premium_expense_category: "insurance_premium",
      created_by: actorId,
    })
    .select("id")
    .maybeSingle();
  if (error || !created) throw new Error(error?.message ?? "Could not record the policy");

  await audit(db, {
    actorId,
    actionType: input.renewedFromPolicyId ? "renewal_recorded" : "procured",
    entityId: created.id,
    metadata: {
      property_id: input.propertyId,
      carrier_name: input.carrierName,
      policy_number: input.policyNumber,
      procurement_method: input.method,
      procured_by: "manager",
      authority: "block_2_required_buyer_authorizations",
      premium: input.premium,
      premium_paid_from: "llc_operating_account",
      requirement_version: req.version,
      requirement_is_placeholder: req.is_placeholder,
      renewed_from_policy_id: input.renewedFromPolicyId ?? null,
    },
  });
  return { id: created.id as string, requirementVersion: req.version, placeholder: req.is_placeholder };
}

export async function bindPolicy(db: Db, actorId: string, policyId: string) {
  const { data: pol } = await db.from("insurance_policies").select("*").eq("id", policyId).maybeSingle();
  if (!pol) throw new Error("Policy not found");
  if (pol.status !== "pending") throw new Error(`Only a pending policy can be bound (this one is ${pol.status}).`);
  const now = new Date().toISOString();
  await db
    .from("insurance_policies")
    .update({ status: "bound", bound_at: now, bound_by: actorId, updated_at: now })
    .eq("id", policyId);
  await audit(db, {
    actorId,
    actionType: "bound",
    entityId: policyId,
    metadata: { property_id: pol.property_id, effective_date: pol.effective_date, renews_at: pol.renews_at },
  });
  const prop = await property(db, pol.property_id);
  await notifyPod(
    db,
    pol.property_id,
    "Homeowners coverage bound",
    `Homeowners/hazard coverage for ${labelOf(prop)} is bound with ${pol.carrier_name} (policy ${pol.policy_number}), effective ${pol.effective_date}. The premium is paid from the property LLC's operating account.`,
  );
}

export async function markPremiumPaid(db: Db, actorId: string, policyId: string) {
  const now = new Date().toISOString();
  const { data: pol } = await db.from("insurance_policies").select("id, property_id, premium").eq("id", policyId).maybeSingle();
  if (!pol) throw new Error("Policy not found");
  // Paid from the LLC's operating account — blocked until the LLC's EIN is TIN-matched.
  const { assertLlcFinancialsAllowed } = await import("@/lib/entity-genesis-stage2.server");
  await assertLlcFinancialsAllowed(db, pol.property_id, "insurance_premium_payment");
  await db.from("insurance_policies").update({ premium_paid_at: now, updated_at: now }).eq("id", policyId);
  await audit(db, {
    actorId,
    actionType: "premium_paid",
    entityId: policyId,
    metadata: {
      property_id: pol.property_id,
      premium: pol.premium,
      paid_from: "llc_operating_account",
      expense_category: "insurance_premium",
      note: "Recorded manually until Module 22's LLC operating account exists.",
    },
  });
}

export async function lapsePolicy(db: Db, actorId: string | null, policyId: string, reason: string) {
  const now = new Date().toISOString();
  const { data: pol } = await db.from("insurance_policies").select("id, property_id, status").eq("id", policyId).maybeSingle();
  if (!pol) throw new Error("Policy not found");
  await db.from("insurance_policies").update({ status: "lapsed", lapsed_at: now, updated_at: now }).eq("id", policyId);
  await audit(db, {
    actorId,
    actorType: actorId ? "admin" : "system",
    actionType: "lapsed",
    entityId: policyId,
    metadata: { property_id: pol.property_id, previous_status: pol.status, reason },
  });
}

/** Renewal: a new pending policy linked to the one it renews. */
export async function renewPolicy(
  db: Db,
  actorId: string,
  policyId: string,
  terms: Pick<RecordPolicyInput, "policyNumber" | "coverageAmount" | "liabilityCoverage" | "premium" | "effectiveDate" | "renewsAt"> & {
    carrierName?: string;
    replacementCost?: number;
  },
) {
  const { data: prev } = await db.from("insurance_policies").select("*").eq("id", policyId).maybeSingle();
  if (!prev) throw new Error("Policy not found");
  return recordPolicy(db, actorId, {
    propertyId: prev.property_id,
    carrierName: terms.carrierName ?? prev.carrier_name,
    policyNumber: terms.policyNumber,
    coverageAmount: terms.coverageAmount,
    liabilityCoverage: terms.liabilityCoverage,
    premium: terms.premium,
    effectiveDate: terms.effectiveDate,
    renewsAt: terms.renewsAt ?? null,
    replacementCost: terms.replacementCost ?? prev.replacement_cost,
    method: prev.procurement_method,
    alternativeProposalId: prev.alternative_proposal_id,
    renewedFromPolicyId: prev.id,
  });
}

/** Bound policies past their renewal date with no bound renewal become lapsed. */
export async function runInsuranceLapseSweep(db: Db) {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await db
    .from("insurance_policies")
    .select("id, property_id, renews_at")
    .eq("status", "bound")
    .lt("renews_at", today);
  let lapsed = 0;
  for (const p of (data ?? []) as Array<{ id: string; property_id: string; renews_at: string }>) {
    const { data: renewal } = await db
      .from("insurance_policies")
      .select("id")
      .eq("renewed_from_policy_id", p.id)
      .eq("status", "bound")
      .limit(1);
    if (((renewal ?? []) as unknown[]).length > 0) continue;
    await lapsePolicy(db, null, p.id, "renewal_date_passed_without_bound_renewal");
    const { data: admins } = await db.from("user_roles").select("user_id").eq("role", "admin");
    for (const a of (admins ?? []) as Array<{ user_id: string }>)
      await deliver(
        db,
        { authUserId: a.user_id, email: null },
        {
          subject: "Insurance lapsed",
          message: `A bound homeowners policy passed its renewal date (${p.renews_at}) without a bound renewal and is now lapsed. Rebind coverage for the property.`,
          link: `/admin/properties/${p.property_id}/insurance`,
          type: "insurance",
        },
      );
    lapsed++;
  }
  return { checked: (data ?? []).length, lapsed };
}

// ---------------------------------------------------------------------------
// Right to Shop
// ---------------------------------------------------------------------------

export interface ProposalInput {
  propertyId: string;
  carrierName: string;
  policySummary?: string | null;
  coverageAmount: number;
  liabilityCoverage: number;
  premium: number;
}

export async function proposeAlternative(db: Db, authUserId: string, buyerAccountId: string, input: ProposalInput) {
  const { data: res } = await db
    .from("pod_reservations")
    .select("id")
    .eq("property_id", input.propertyId)
    .eq("buyer_account_id", buyerAccountId)
    .eq("status", "reserved")
    .limit(1);
  if (!((res ?? []) as unknown[]).length) throw new Error("Only Buyer Accounts reserved into this property can propose a carrier.");

  const { data: created, error } = await db
    .from("insurance_alternative_proposals")
    .insert({
      property_id: input.propertyId,
      buyer_account_id: buyerAccountId,
      carrier_name: input.carrierName,
      policy_summary: input.policySummary ?? null,
      coverage_amount: input.coverageAmount,
      liability_coverage: input.liabilityCoverage,
      premium: input.premium,
      status: "submitted",
    })
    .select("id")
    .maybeSingle();
  if (error || !created) throw new Error(error?.message ?? "Could not submit the proposal");

  await audit(db, {
    actorId: authUserId,
    actorType: "buyer",
    actionType: "alternative_proposed",
    entityId: created.id,
    metadata: { property_id: input.propertyId, buyer_account_id: buyerAccountId, carrier_name: input.carrierName },
  });
  const { data: admins } = await db.from("user_roles").select("user_id").eq("role", "admin");
  for (const a of (admins ?? []) as Array<{ user_id: string }>)
    await deliver(
      db,
      { authUserId: a.user_id, email: null },
      {
        subject: "Alternative insurance carrier proposed",
        message: `A Buyer Account proposed ${input.carrierName} as an alternative carrier. Review it against the coverage requirements.`,
        link: `/admin/properties/${input.propertyId}/insurance`,
        type: "insurance",
      },
    );
  return { id: created.id as string };
}

/** Manual admin review. Approval is only possible when requirements are met. */
export async function reviewProposal(
  db: Db,
  actorId: string,
  params: { proposalId: string; approve: boolean; replacementCost: number; notes?: string | null },
) {
  const { data: prop0 } = await db.from("insurance_alternative_proposals").select("*").eq("id", params.proposalId).maybeSingle();
  if (!prop0) throw new Error("Proposal not found");
  if (prop0.status !== "submitted") throw new Error("This proposal has already been reviewed.");
  const req = await activeRequirements(db);
  if (!req) throw new Error("No active coverage requirements.");
  const prop = await property(db, prop0.property_id);
  const check = checkCoverage(req.rules, {
    replacementCost: params.replacementCost,
    use: declaredUseFor(prop?.usage_tag),
    coverage: Number(prop0.coverage_amount),
    liability: Number(prop0.liability_coverage),
  });
  if (params.approve && !check.meets)
    throw new Error(`Cannot approve — requirements not met: ${check.shortfalls.join(" ")}`);

  const status = params.approve ? "approved" : "rejected";
  await db
    .from("insurance_alternative_proposals")
    .update({
      status,
      meets_requirements: check.meets,
      review_notes: params.notes ?? (check.meets ? null : check.shortfalls.join(" ")),
      reviewed_by: actorId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", params.proposalId);
  await audit(db, {
    actorId,
    actionType: "alternative_reviewed",
    entityId: params.proposalId,
    metadata: {
      property_id: prop0.property_id,
      decision: status,
      meets_requirements: check.meets,
      shortfalls: check.shortfalls,
      requirement_version: req.version,
    },
  });

  const { data: buyer } = await db
    .from("buyer_accounts")
    .select("auth_user_id, email")
    .eq("id", prop0.buyer_account_id)
    .maybeSingle();
  if (buyer)
    await deliver(
      db,
      { authUserId: buyer.auth_user_id, email: buyer.email },
      {
        subject: `Your proposed carrier was ${status}`,
        message: params.approve
          ? `${prop0.carrier_name} meets the coverage requirements and was approved as an alternative.`
          : `${prop0.carrier_name} was not approved. ${params.notes ?? check.shortfalls.join(" ")}`,
        link: "/buyer/insurance",
        type: "insurance",
      },
    );

  if (params.approve) {
    const { data: approved } = await db
      .from("insurance_alternative_proposals")
      .select("id")
      .eq("property_id", prop0.property_id)
      .eq("status", "approved");
    if (((approved ?? []) as unknown[]).length === 2)
      await notifyPod(
        db,
        prop0.property_id,
        "Vote on your pod's insurance carrier",
        `More than one alternative carrier has been approved for ${labelOf(prop)}. Cast your Buyer Account's vote — a tie keeps the Manager's default policy.`,
      );
  }
  return { status, check };
}

export async function castVote(
  db: Db,
  authUserId: string,
  buyerAccountId: string,
  params: { propertyId: string; proposalId: string },
) {
  const { data: res } = await db
    .from("pod_reservations")
    .select("id")
    .eq("property_id", params.propertyId)
    .eq("buyer_account_id", buyerAccountId)
    .eq("status", "reserved")
    .limit(1);
  if (!((res ?? []) as unknown[]).length) throw new Error("Only Buyer Accounts in this pod can vote.");
  const { data: proposal } = await db
    .from("insurance_alternative_proposals")
    .select("id, property_id, status")
    .eq("id", params.proposalId)
    .maybeSingle();
  if (!proposal || proposal.property_id !== params.propertyId || proposal.status !== "approved")
    throw new Error("You can only vote for an approved alternative that is still open.");

  const { error } = await db
    .from("insurance_votes")
    .upsert(
      { property_id: params.propertyId, proposal_id: params.proposalId, buyer_account_id: buyerAccountId, created_at: new Date().toISOString() },
      { onConflict: "property_id,buyer_account_id" },
    );
  if (error) throw new Error(error.message);
  await audit(db, {
    actorId: authUserId,
    actorType: "buyer",
    actionType: "vote_cast",
    entityId: params.proposalId,
    metadata: { property_id: params.propertyId, buyer_account_id: buyerAccountId },
  });
}

/**
 * Settle the Right to Shop: one approved alternative is selected outright;
 * several go to the member vote (plurality). A tie or no votes selects none,
 * and the Manager's default procurement stands.
 */
export async function resolveAlternatives(db: Db, actorId: string, propertyId: string) {
  const { data } = await db
    .from("insurance_alternative_proposals")
    .select("id, carrier_name")
    .eq("property_id", propertyId)
    .eq("status", "approved");
  const approved = (data ?? []) as Array<{ id: string; carrier_name: string }>;
  if (approved.length === 0) return { selectedId: null, reason: "none_approved" as const };

  let winnerId: string | null;
  let tally: ReturnType<typeof tallyVotes> | null = null;
  if (approved.length === 1) {
    winnerId = approved[0]!.id;
  } else {
    const { data: votes } = await db.from("insurance_votes").select("proposal_id").eq("property_id", propertyId);
    tally = tallyVotes(approved.map((a) => a.id), (votes ?? []) as Array<{ proposal_id: string }>);
    winnerId = tally.winnerId;
    await audit(db, {
      actorId,
      actionType: "vote_closed",
      entityId: winnerId,
      metadata: { property_id: propertyId, counts: tally.counts, tie: tally.tie, total_votes: tally.totalVotes },
    });
  }

  if (!winnerId) {
    await audit(db, {
      actorId,
      actionType: "default_retained",
      entityId: null,
      metadata: { property_id: propertyId, reason: tally?.tie ? "tie" : "no_votes" },
    });
    return { selectedId: null, reason: (tally?.tie ? "tie" : "no_votes") as "tie" | "no_votes", tally };
  }

  for (const a of approved)
    await db
      .from("insurance_alternative_proposals")
      .update({ status: a.id === winnerId ? "selected" : "not_selected" })
      .eq("id", a.id);
  const winner = approved.find((a) => a.id === winnerId)!;
  await audit(db, {
    actorId,
    actionType: "alternative_selected",
    entityId: winnerId,
    metadata: { property_id: propertyId, carrier_name: winner.carrier_name, via: approved.length === 1 ? "sole_approved" : "member_vote" },
  });
  const prop = await property(db, propertyId);
  await notifyPod(
    db,
    propertyId,
    "Alternative carrier selected",
    `${winner.carrier_name} was selected for ${labelOf(prop)}. The Manager will procure that policy instead of the default.`,
  );
  return { selectedId: winnerId, reason: "selected" as const, tally };
}

