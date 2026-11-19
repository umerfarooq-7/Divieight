/** Account Members: the two-member limit, status labels and each member's checklist. */

export const MAX_ACTIVE_MEMBERS = 2;
/** The acting-member choice clears after this long without activity. */
export const ACTING_MEMBER_IDLE_MS = 15 * 60 * 1000;

export type MemberEligibility = "eligible" | "held" | "not_eligible" | "pending";

export const ELIGIBILITY_LABELS: Record<MemberEligibility, string> = {
  eligible: "Eligible",
  held: "Held",
  not_eligible: "Not eligible",
  pending: "Pending",
};

/**
 * A member's eligibility from their vetting and, when given, their latest liveness result
 * (null = no attempt yet). A failed liveness makes that member — and only that member — not eligible.
 */
export function eligibilityOf(vettingStatus: string | null | undefined, livenessStatus?: string | null): MemberEligibility {
  if (livenessStatus !== undefined) {
    if (livenessStatus === "failed" || vettingStatus === "failed") return "not_eligible";
    const vetting = eligibilityOf(vettingStatus);
    if (livenessStatus === "inconclusive" || vetting === "held") return "held";
    return vetting === "eligible" && livenessStatus === "passed" ? "eligible" : "pending";
  }
  if (vettingStatus === "cleared") return "eligible";
  if (vettingStatus === "failed" || vettingStatus === "not_eligible") return "not_eligible";
  if (vettingStatus === "held") return "held";
  if (vettingStatus === "flagged_needs_review" || vettingStatus === "verification_pending" || vettingStatus === "held_for_review") return "held";
  return "pending";
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

/** Identity is in when the member's name, date of birth and address are on file. */
export const identityComplete = (m: { full_name: string | null; date_of_birth: string | null; address: string | null }) =>
  Boolean(m.full_name?.trim() && m.date_of_birth && m.address?.trim());

/** Same person: the same identity document number (spacing, dashes and case aside). */
export function samePerson(
  a: { full_name: string | null; date_of_birth: string | null; id_document_number: string | null },
  b: { full_name: string | null; date_of_birth: string | null; id_document_number: string | null },
): boolean {
  const norm = (v: string | null) => (v ?? "").replace(/[\s-]+/g, "").toUpperCase();
  // One identity document belongs to one person: the same ID number twice is the same person, whatever else was typed.
  return Boolean(norm(a.id_document_number)) && norm(a.id_document_number) === norm(b.id_document_number);
}

export const SAME_EMAIL_MESSAGE = "Each member needs their own email address.";
export const SAME_PERSON_MESSAGE = "These details match the other member on this account. Each member must be a different person.";
export const LOCKED_MESSAGE = "Account members can't be changed after the Golden Ticket is issued. Contact divieight support.";
export const LIMIT_MESSAGE = "A Buyer Account can have at most two members.";
export const POD_MESSAGE = "This person already belongs to another Buyer Account in the same pod.";

export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
}

export interface AccountMemberView {
  id: string;
  role: "primary" | "member";
  fullName: string;
  email: string | null;
  phone: string | null;
  eligibility: MemberEligibility;
  checklist: ChecklistItem[];
}

/**
 * One member at a time. With two members, the account holder completes every onboarding step first (identity, liveness,
 * agreement, vetting, consents); only then does the second member start their own, from the top. These are the member-level
 * steps the onboarding screens cover. The W-9 has its own page and is not part of this order.
 */
export const JOURNEY_KEYS = ["identity", "liveness", "standard", "pra", "hold_harmless", "declaration", "block1", "block2"] as const;

export const journeyDone = (m: Pick<AccountMemberView, "checklist">): boolean =>
  JOURNEY_KEYS.every((k) => m.checklist.some((c) => c.key === k && c.done));

/** The route that holds a checklist item, so a member can be sent to their first step that is still open. */
const JOURNEY_PATHS: Record<(typeof JOURNEY_KEYS)[number], "/buyer/onboarding/identity" | "/buyer/onboarding/liveness" | "/buyer/onboarding/eligibility" | "/buyer/onboarding/payment" | "/buyer/onboarding/vetting" | "/buyer/onboarding/liquidity"> = {
  identity: "/buyer/onboarding/identity",
  liveness: "/buyer/onboarding/liveness",
  standard: "/buyer/onboarding/eligibility",
  pra: "/buyer/onboarding/payment",
  hold_harmless: "/buyer/onboarding/vetting",
  declaration: "/buyer/onboarding/vetting",
  block1: "/buyer/onboarding/liquidity",
  block2: "/buyer/onboarding/liquidity",
};

/** The member whose turn it is: the first (account holder first) whose steps are not all done. Null with one member, or when everyone is done. */
export function journeyMember<T extends Pick<AccountMemberView, "role" | "checklist">>(members: T[]): T | null {
  if (members.length < 2) return null;
  const ordered = [...members].sort((a, b) => Number(b.role === "primary") - Number(a.role === "primary"));
  return ordered.find((m) => !journeyDone(m)) ?? null;
}

/** Where a member's first open step lives (identity for a member who has not started). Null when they are done. */
export function nextJourneyPath(m: Pick<AccountMemberView, "checklist">): (typeof JOURNEY_PATHS)[keyof typeof JOURNEY_PATHS] | null {
  const open = JOURNEY_KEYS.find((k) => !m.checklist.some((c) => c.key === k && c.done));
  return open ? JOURNEY_PATHS[open] : null;
}

/** Who to show in the picker: the name, or what they are if no name is on file yet. */
export const memberDisplayName = (m: { fullName: string; role: string }) =>
  m.fullName.trim() || (m.role === "primary" ? "Account holder" : "Second member");
