import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/audit";
import { notifyBuyer } from "@/lib/notify";
import { tetherResidentAgent } from "@/lib/tethering.functions";
import { loadMemberSteps, type MemberSteps, type RequiredStep } from "@/lib/account-rollup";

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
  /** Every active Account Member's steps (account-rollup.ts). */
  members: MemberSteps[];
}

/** Each condition is checked for every active member; the ticket belongs to the account. */
const PER_MEMBER: Array<{ step: RequiredStep; message: string }> = [
  { step: "idScan", message: "Every Account Member must complete their ID scan" },
  { step: "liveness", message: "Every Account Member must pass the liveness check" },
  { step: "standardRead", message: "Every Account Member must read the Participant Eligibility Standard" },
  { step: "declaration", message: "Every Account Member must make their Eligibility Declaration" },
  { step: "block1", message: "Every Account Member must consent to account linking (Block 1)" },
  { step: "pra", message: "Priority Reservation Agreement must be signed by every Account Member" },
  { step: "holdHarmless", message: "Every Account Member must sign the Hold Harmless" },
  { step: "w9", message: "Every Account Member must complete their W-9" },
];

/**
 * Pure eligibility rule so it stays testable. For every active Account Member: an eligible result
 * from the engine (a held member blocks the account), and every required member step done. Plus,
 * for the account: liquidity auto-verified OR manually approved by a Broker of Record.
 */
export function evaluateGoldenTicket(input: GoldenTicketInputs): GoldenTicketStatus {
  const missing: string[] = [];
  const results = input.members.map((m) => m.result);

  if (input.members.length === 0) {
    missing.push("Add at least one Account Member");
  } else if (results.some((r) => r === "held")) {
    // A held member keeps the whole account from the Golden Ticket until the charge is resolved.
    missing.push("An Account Member's application is held until the disclosed charge is resolved");
  } else if (results.some((r) => r !== "eligible")) {
    missing.push("All Account Members must be eligible under the Participant Eligibility Standard");
  }
  for (const c of PER_MEMBER) if (input.members.some((m) => !m[c.step])) missing.push(c.message);

  const liquidityOk =
    input.liquidityVerified || input.liquidityStatus === "manually_approved";
  if (!liquidityOk) missing.push("Liquidity verification must be complete");

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
}): Promise<GoldenTicketStatus & { issuedNow: boolean; issuedAt: string | null; members: MemberSteps[] }> {
  const { authUserId, buyerAccountId } = params;

  const { data: account } = await supabase
    .from("buyer_accounts")
    .select("id, golden_ticket_issued, golden_ticket_issued_at, liquidity_verified, liquidity_status")
    .eq("id", buyerAccountId)
    .maybeSingle();

  if (!account) {
    return { issued: false, eligible: false, missing: ["Buyer account not found"], issuedNow: false, issuedAt: null, members: [] };
  }
  const members = await loadMemberSteps(supabase, buyerAccountId);

  const status = evaluateGoldenTicket({
    goldenTicketIssued: account.golden_ticket_issued,
    liquidityVerified: account.liquidity_verified,
    liquidityStatus: account.liquidity_status,
    members,
  });

  if (account.golden_ticket_issued) {
    return { ...status, issued: true, issuedNow: false, issuedAt: account.golden_ticket_issued_at, members };
  }
  if (!status.eligible) return { ...status, issuedNow: false, issuedAt: null, members };

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("buyer_accounts")
    .update({
      golden_ticket_issued: true,
      golden_ticket_issued_at: now,
      onboarding_status: "active",
    })
    .eq("id", buyerAccountId);

  if (error) return { ...status, issuedNow: false, issuedAt: null, members };

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

  return { ...status, issued: true, issuedNow: true, issuedAt: now, members };
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
