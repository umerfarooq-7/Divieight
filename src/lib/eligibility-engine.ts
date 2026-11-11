/**
 * The eligibility result engine (Participant Eligibility Standard v1.1, Part One G and Part Two).
 *
 * Deterministic and pure: nobody at divieight weighs anything, and the same answers and the same
 * screening facts always return the same result. Results are per Account Member.
 *
 *  - not_eligible: Q1, Q2 or Q4 = No; a confirmed sanctions/watchlist match; a declaration found untrue;
 *    a failed liveness check (the ID document isn't the member's); or a disclosed charge that ended in a
 *    conviction disqualifying under Standard A or B.
 *  - held: Q3 = No (a disclosed pending charge that would disqualify on conviction), until the fact of its
 *    disposition is recorded. Held is its own result: never refused, never unpaid.
 *  - eligible: Q1–Q6 all Yes (or Q3's charge resolved without a disqualifying conviction), the declaration
 *    complete, and identity, liveness and sanctions all clear.
 *  - no result: the declaration is missing or Q5 = No (incomplete), or a screening is still pending.
 */

import { block4Questions, decisionPageCopy } from "@/constants/eligibilityCopy";
import type { DeclarationAnswers } from "@/lib/eligibility-declaration";

export type EligibilityResult = "eligible" | "held" | "not_eligible";

export const RESULT_LABELS: Record<EligibilityResult, string> = {
  eligible: "Eligible",
  held: "Held",
  not_eligible: "Not eligible",
};

/** Held has its own colour everywhere: never the destructive (refused) or warning (unpaid) tones. */
export const RESULT_TONES: Record<EligibilityResult | "pending", string> = {
  eligible: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  held: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  not_eligible: "border-slate-500/40 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  pending: "border-border bg-muted text-muted-foreground",
};

export const HELD_BUYER_TEXT = "Your application is held until the disclosed charge is resolved.";

export type SanctionsStatus = "clear" | "possible_match" | "confirmed_match" | "pending";

/** The facts of how a disclosed charge ended. The admin records only these; the engine applies the Standard. */
export type DispositionOutcome = "convicted" | "dismissed" | "withdrawn" | "acquitted" | "nolle_prosequi" | "expunged_sealed_or_pardoned" | "juvenile_adjudication";

export const DISPOSITION_LABELS: Record<DispositionOutcome, string> = {
  convicted: "Convicted",
  dismissed: "Dismissed",
  withdrawn: "Withdrawn",
  acquitted: "Acquitted",
  nolle_prosequi: "Nolle prosequi",
  expunged_sealed_or_pardoned: "Expunged, sealed, vacated, set aside or pardoned",
  juvenile_adjudication: "Juvenile adjudication",
};

/** The offense of a conviction, named from the Standard's own lists (A1–A4, B1–B6) or neither. */
export const OFFENSES: Array<{ key: string; list: "A" | "B" | "none"; label: string }> = [
  ...decisionPageCopy.partOne.A.items.map((label, i) => ({ key: `A${i + 1}`, list: "A" as const, label })),
  ...decisionPageCopy.partOne.B.items.map((label, i) => ({ key: `B${i + 1}`, list: "B" as const, label })),
  { key: "none", list: "none", label: "Another offense, not listed in A or B" },
];

export interface Disposition {
  outcome: DispositionOutcome;
  /** Required for a conviction: which offense, from OFFENSES. */
  offenseKey: string | null;
  /** The date of conviction or other disposition (YYYY-MM-DD). */
  dispositionDate: string;
}

export interface Screening {
  /** The member's identity (name, date of birth, address and ID document) is on file. */
  identityComplete: boolean;
  /** Latest liveness result; null = none yet. */
  liveness: "passed" | "failed" | "inconclusive" | "pending" | null;
  /** Latest sanctions/watchlist screening; null = not yet screened. */
  sanctions: SanctionsStatus | null;
  /** A declaration by this member has been found untrue (Part F). */
  declarationFoundUntrue: boolean;
  /** The recorded disposition of the charge disclosed at Q3, if any. */
  disposition: Disposition | null;
  /** When the member applied (their declaration), for Standard B's ten-year window. YYYY-MM-DD or ISO. */
  appliedAt: string;
}

export interface Evaluation {
  /** Null when there is no result yet (incomplete, or a screening is pending). No result row is written then. */
  result: EligibilityResult | null;
  reason_codes: string[];
}

const TEN_YEARS_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;

/** Standard A, B and C applied to the fact of a disposition. True = the conviction disqualifies. */
export function dispositionDisqualifies(d: Disposition, appliedAt: string): { disqualifies: boolean; reason: string } {
  if (d.outcome !== "convicted") return { disqualifies: false, reason: `charge_resolved_${d.outcome}` };
  const offense = OFFENSES.find((o) => o.key === d.offenseKey);
  if (!offense) return { disqualifies: false, reason: "disposition_offense_missing" };
  if (offense.list === "A") return { disqualifies: true, reason: `conviction_standard_a_${offense.key}` };
  if (offense.list === "B") {
    // The ten years run from the date of conviction, and count back from when the member applied.
    const within = new Date(d.dispositionDate).getTime() > new Date(appliedAt).getTime() - TEN_YEARS_MS;
    return within ? { disqualifies: true, reason: `conviction_standard_b_${offense.key}` } : { disqualifies: false, reason: `conviction_standard_b_${offense.key}_outside_ten_years` };
  }
  return { disqualifies: false, reason: "conviction_not_listed_standard_c" };
}

export function evaluateEligibility(answers: DeclarationAnswers | null, screening: Screening): Evaluation {
  // Incomplete: no declaration, or no Question 5 authorization. Not a result.
  if (!answers) return { result: null, reason_codes: ["declaration_missing"] };
  // Part F and Part E disqualify whatever else was answered.
  const overriding = [
    ...(screening.declarationFoundUntrue ? ["declaration_found_untrue"] : []),
    ...(screening.sanctions === "confirmed_match" ? ["sanctions_confirmed_match"] : []),
  ];
  if (answers.q5 !== "yes") return overriding.length ? { result: "not_eligible", reason_codes: overriding } : { result: null, reason_codes: ["q5_authorization_not_given"] };

  const out: string[] = [];
  if (answers.q1 === "no") out.push("q1_no");
  if (answers.q2 === "no") out.push("q2_no");
  if (answers.q4 === "no") out.push("q4_no");
  if (screening.sanctions === "confirmed_match") out.push("sanctions_confirmed_match");
  if (screening.declarationFoundUntrue) out.push("declaration_found_untrue");
  if (screening.liveness === "failed") out.push("liveness_failed");

  let q3Resolved = answers.q3 === "yes";
  if (answers.q3 === "no" && screening.disposition) {
    const d = dispositionDisqualifies(screening.disposition, screening.appliedAt);
    if (d.disqualifies) out.push(d.reason);
    else if (d.reason !== "disposition_offense_missing") q3Resolved = true;
  }
  if (out.length) return { result: "not_eligible", reason_codes: out };

  if (!q3Resolved) return { result: "held", reason_codes: ["q3_pending_charge_disclosed"] };

  // Q6 is the ten-day change undertaking; "No" means the member hasn't given it, so there is no complete declaration.
  if (answers.q6 !== "yes") return { result: null, reason_codes: ["q6_undertaking_not_given"] };

  const pending: string[] = [];
  if (!screening.identityComplete) pending.push("identity_pending");
  if (screening.liveness !== "passed") pending.push(screening.liveness === "inconclusive" ? "liveness_inconclusive" : "liveness_pending");
  if (screening.sanctions !== "clear") pending.push(screening.sanctions === "possible_match" ? "sanctions_possible_match" : "sanctions_pending");
  if (pending.length) return { result: null, reason_codes: pending };

  const reasons = ["all_clear"];
  if (answers.q3 === "no" && screening.disposition) reasons.push(dispositionDisqualifies(screening.disposition, screening.appliedAt).reason);
  return { result: "eligible", reason_codes: reasons };
}

// The questions the engine reads are the copy file's six; a seventh would need a new rule here.
export const ENGINE_QUESTION_COUNT = block4Questions.length;

/**
 * A member's current result: their latest result row, if it was determined on their current
 * (complete) declaration. A correction or a reported change makes earlier results stale.
 */
export function currentResultOf<R extends { account_member_id: string; declaration_id: string; determined_at: string; result: string }>(
  results: R[],
  memberId: string,
  currentDeclarationId: string | null,
): R | null {
  if (!currentDeclarationId) return null;
  const mine = results.filter((r) => r.account_member_id === memberId && r.declaration_id === currentDeclarationId);
  return mine.sort((a, b) => (a.determined_at < b.determined_at ? -1 : a.determined_at > b.determined_at ? 1 : 0)).at(-1) ?? null;
}

/** The vetting status label the engine's result sets on the member. */
export const VETTING_STATUS_FOR: Record<EligibilityResult, string> = { eligible: "cleared", held: "held", not_eligible: "not_eligible" };

/**
 * How a money view shows a payment or fee status for an account. A held account is never shown as
 * unpaid, refused or failed: anything short of "paid" reads "held" (with the Held colour).
 */
export function moneyStatusFor(status: string, held: boolean): { label: string; held: boolean } {
  if (!held) return { label: status, held: false };
  return { label: status === "paid" ? "paid" : "held", held: true };
}

/**
 * The binary vetting display (Vetted / Pending / Failed), fed from eligibility_results.
 * Held is its own display: it is never merged into Pending or Failed, and has its own colour.
 */
export type VettingKey = "vetted" | "pending" | "failed" | "held";
export interface VettingDisplay {
  key: VettingKey;
  label: string;
  tone: string;
}

const VETTING: Record<VettingKey, VettingDisplay> = {
  vetted: { key: "vetted", label: "Vetted", tone: RESULT_TONES.eligible },
  pending: { key: "pending", label: "Pending", tone: RESULT_TONES.pending },
  failed: { key: "failed", label: "Failed", tone: RESULT_TONES.not_eligible },
  held: { key: "held", label: "Held", tone: RESULT_TONES.held },
};

/** One member: from their current engine result (null = no result yet). */
export function vettingDisplay(result: EligibilityResult | null | undefined): VettingDisplay {
  return VETTING[result === "eligible" ? "vetted" : result === "not_eligible" ? "failed" : result === "held" ? "held" : "pending"];
}

/** The account: held if any member is held; failed if any is not eligible; vetted only when every member is. */
export function accountVettingDisplay(results: Array<EligibilityResult | null | undefined>): VettingDisplay {
  if (results.length === 0) return VETTING.pending;
  if (results.some((r) => r === "held")) return VETTING.held;
  if (results.some((r) => r === "not_eligible")) return VETTING.failed;
  return results.every((r) => r === "eligible") ? VETTING.vetted : VETTING.pending;
}
