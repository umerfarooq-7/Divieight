/**
 * Hard preconditions for the Disbursement Check (Prompt 16).
 *
 * The Disbursement Check MUST call `assertDisbursementAllowed()` and must not
 * clear while any blocker is returned. These are not soft warnings.
 */

type Db = { from: (t: string) => any };

export interface DisbursementBlocker {
  code: "insurance_not_bound" | "llc_tin_not_verified";
  message: string;
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

/**
 * Coverage must be bound AND effective from the moment of closing: a policy
 * with status 'bound', effective on or before the closing date, and not due
 * for renewal before it.
 */
export async function insuranceGate(
  db: Db,
  propertyId: string,
  closingDate?: string | null,
): Promise<{ ok: boolean; policyId: string | null; message: string }> {
  const { data: property } = await db
    .from("properties")
    .select("anticipated_closing_date")
    .eq("id", propertyId)
    .maybeSingle();
  const closing = (closingDate ?? property?.anticipated_closing_date ?? isoDate(new Date())).slice(0, 10);

  const { data: policies } = await db
    .from("insurance_policies")
    .select("id, status, effective_date, renews_at")
    .eq("property_id", propertyId)
    .eq("status", "bound");
  const valid = ((policies ?? []) as Array<{ id: string; effective_date: string; renews_at: string | null }>).find(
    (p) => p.effective_date.slice(0, 10) <= closing && (!p.renews_at || p.renews_at.slice(0, 10) > closing),
  );
  if (valid) return { ok: true, policyId: valid.id, message: "Bound coverage is effective at closing." };
  return {
    ok: false,
    policyId: null,
    message: `No bound homeowners/hazard policy effective on the closing date (${closing}). Disbursement cannot clear until the Manager binds coverage.`,
  };
}

export async function disbursementPreconditions(
  db: Db,
  propertyId: string,
  closingDate?: string | null,
): Promise<DisbursementBlocker[]> {
  const blockers: DisbursementBlocker[] = [];
  const insurance = await insuranceGate(db, propertyId, closingDate);
  if (!insurance.ok) blockers.push({ code: "insurance_not_bound", message: insurance.message });
  // Disbursement is a financial transaction of the LLC: IRS TIN match required.
  const { llcTinGate } = await import("@/lib/entity-genesis-stage2.server");
  const tin = await llcTinGate(db, propertyId);
  if (!tin.ok) blockers.push({ code: "llc_tin_not_verified", message: tin.message });
  return blockers;
}

/** Throws (hard stop) if the Disbursement Check may not clear. */
export async function assertDisbursementAllowed(db: Db, propertyId: string, closingDate?: string | null) {
  const blockers = await disbursementPreconditions(db, propertyId, closingDate);
  if (blockers.length > 0) {
    await db.from("audit_log").insert({
      actor_id: null,
      actor_type: "system",
      action_type: "disbursement.blocked",
      entity_type: "property",
      entity_id: propertyId,
      metadata: { blockers },
    });
    throw new Error(blockers.map((b) => b.message).join(" "));
  }
}
