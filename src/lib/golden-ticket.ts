import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/audit";
import { notifyBuyer } from "@/lib/notify";
import { tetherResidentAgent } from "@/lib/tethering.functions";

/** Enrollment period covered by the Digital Key. */
export const ENROLLMENT_DAYS = 365;

export interface GoldenTicketStatus {
  issued: boolean;
  eligible: boolean;
  /** Human-readable list of what is still outstanding. */
  missing: string[];
}

export interface GoldenTicketInputs {
  goldenTicketIssued: boolean;
  liquidityVerified: boolean;
  liquidityStatus: string;
  praSigned: boolean;
  memberStatuses: string[];
}

/**
 * Pure eligibility rule so it stays testable:
 * - every Account Member cleared vetting
 * - liquidity auto-verified OR manually approved by a Broker of Record
 *   ('manually_approved' is stubbed today — the broker review UI ships with
 *   the Month 3 Agent/Broker Module)
 * - the Priority Reservation Agreement is signed
 */
export function evaluateGoldenTicket(input: GoldenTicketInputs): GoldenTicketStatus {
  const missing: string[] = [];

  if (input.memberStatuses.length === 0) {
    missing.push("Add at least one Account Member");
  } else if (input.memberStatuses.some((s) => s !== "cleared")) {
    missing.push("All Account Members must clear vetting");
  }

  const liquidityOk =
    input.liquidityVerified || input.liquidityStatus === "manually_approved";
  if (!liquidityOk) missing.push("Liquidity verification must be complete");

  if (!input.praSigned) missing.push("Priority Reservation Agreement must be signed");

  return { issued: input.goldenTicketIssued, eligible: missing.length === 0, missing };
}

/**
 * Loads the current state for a buyer account, and issues the Golden Ticket
 * when every gate is satisfied. Safe to call repeatedly — issuance is a no-op
 * once `golden_ticket_issued` is true.
 */
export async function issueGoldenTicketIfEligible(params: {
  authUserId: string;
  buyerAccountId: string;
}): Promise<GoldenTicketStatus & { issuedNow: boolean; issuedAt: string | null }> {
  const { authUserId, buyerAccountId } = params;

  const [{ data: account }, { data: members }, { data: pra }] = await Promise.all([
    supabase
      .from("buyer_accounts")
      .select(
        "id, golden_ticket_issued, golden_ticket_issued_at, liquidity_verified, liquidity_status",
      )
      .eq("id", buyerAccountId)
      .maybeSingle(),
    supabase
      .from("account_members")
      .select("vetting_status")
      .eq("buyer_account_id", buyerAccountId)
      .eq("status", "active"),
    supabase
      .from("signed_documents")
      .select("id")
      .eq("buyer_account_id", buyerAccountId)
      .eq("document_type", "PRA")
      .limit(1),
  ]);

  if (!account) {
    return { issued: false, eligible: false, missing: ["Buyer account not found"], issuedNow: false, issuedAt: null };
  }

  const status = evaluateGoldenTicket({
    goldenTicketIssued: account.golden_ticket_issued,
    liquidityVerified: account.liquidity_verified,
    liquidityStatus: account.liquidity_status,
    praSigned: (pra?.length ?? 0) > 0,
    memberStatuses: (members ?? []).map((m) => m.vetting_status),
  });

  if (account.golden_ticket_issued) {
    return { ...status, issued: true, issuedNow: false, issuedAt: account.golden_ticket_issued_at };
  }
  if (!status.eligible) return { ...status, issuedNow: false, issuedAt: null };

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("buyer_accounts")
    .update({
      golden_ticket_issued: true,
      golden_ticket_issued_at: now,
      onboarding_status: "active",
    })
    .eq("id", buyerAccountId);

  if (error) return { ...status, issuedNow: false, issuedAt: null };

  await logAudit({
    actorId: authUserId,
    actionType: "buyer.golden_ticket_issued",
    entityType: "buyer_account",
    entityId: buyerAccountId,
    metadata: { issued_at: now },
  });
  await notifyBuyer(authUserId, "golden_ticket_issued");

  // Resident Agent Selection Logic runs immediately after issuance.
  try {
    await tetherResidentAgent({ data: { buyerAccountId } });
  } catch (e) {
    console.error("[golden-ticket] resident agent tethering failed", e);
  }

  return { ...status, issued: true, issuedNow: true, issuedAt: now };
}

/** Days left in the 12-month enrollment period. */
export function enrollmentDaysRemaining(startIso: string | null): number | null {
  if (!startIso) return null;
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return null;
  const end = start + ENROLLMENT_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((end - Date.now()) / (24 * 60 * 60 * 1000)));
}

export function enrollmentEndDate(startIso: string | null): Date | null {
  if (!startIso) return null;
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return null;
  return new Date(start + ENROLLMENT_DAYS * 24 * 60 * 60 * 1000);
}
