/**
 * Buyer-Authorization Workflow — shared constants and pure helpers.
 *
 * Express, per-action consent for the transaction lifecycle's key moments.
 * Nothing here ever grants authorization implicitly: a request that runs past
 * its deadline escalates, it does not convert into consent. The Manager has no
 * authority to act without every Preferred Member's express confirmation.
 *
 * This module only READS the Due Diligence Acknowledgment Gate's completion
 * status as a precondition — it never touches that gate's own logic.
 */

export const AUTHORIZATION_ACTIONS = [
  "offer_tender",
  "offer_revision",
  "counter_offer_acceptance",
  "final_repa_acceptance",
  "contingency_waiver",
] as const;

export type AuthorizationAction = (typeof AUTHORIZATION_ACTIONS)[number];

export const AUTHORIZATION_ACTION_LABELS: Record<AuthorizationAction, string> = {
  offer_tender: "Tender of an offer to purchase",
  offer_revision: "Modification, counter-offer or revision to a tendered offer",
  counter_offer_acceptance: "Acceptance of a seller counter-offer",
  final_repa_acceptance: "Acceptance of final Real Estate Purchase Agreement terms",
  contingency_waiver: "Waiver of a contingency",
};

/** Actions that run against a seller-controlled clock. */
export const MARKET_DRIVEN_ACTIONS: AuthorizationAction[] = [
  "counter_offer_acceptance",
  "final_repa_acceptance",
];

/** Instruments that normally carry a buyer-side commission provision. */
export const COMMISSION_BEARING_ACTIONS: AuthorizationAction[] = [
  "offer_tender",
  "offer_revision",
  "counter_offer_acceptance",
  "final_repa_acceptance",
];

export const CONSEQUENCE_TEXT: Record<AuthorizationAction, string> = {
  offer_tender:
    "If you do not confirm by the deadline, no offer will be tendered on your behalf. Nothing is submitted without your express confirmation, and the Manager has no authority to act for you.",
  offer_revision:
    "If you do not confirm by the deadline, the offer stands on its current terms and the proposed revision is not submitted. The Manager has no authority to revise it for you.",
  counter_offer_acceptance:
    "If you do not confirm by the deadline, the seller's counter-offer may expire on the seller's own clock and the opportunity may be lost. Non-response is never treated as acceptance.",
  final_repa_acceptance:
    "If you do not confirm by the deadline, the Real Estate Purchase Agreement is not executed on your behalf and closing cannot proceed. Non-response is never treated as acceptance.",
  contingency_waiver:
    "If you do not confirm by the deadline, the contingency remains in force and is not waived. No one can waive it on your behalf.",
};

export const DEFAULT_AUTHORIZATION_SETTINGS = {
  /** Response window when the request does not carry its own market deadline. */
  default_response_hours: 48,
  /** Gap between the first escalation and the wider second escalation. */
  second_escalation_hours: 24,
};

export type AuthorizationSettings = typeof DEFAULT_AUTHORIZATION_SETTINGS;

export const AUTHORIZATION_SETTINGS_KEY = "authorization_escalation";

export const RECOMMENDATION_KINDS = [
  { value: "recommend", label: "I recommend proceeding" },
  { value: "recommend_against", label: "I recommend against proceeding" },
  { value: "no_recommendation", label: "No recommendation" },
] as const;

export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number]["value"];

export const CONFIRMATION_TEXT =
  "I expressly authorize divieight, LLC as Manager to take the action described above on the terms shown, on behalf of my Buyer Account.";

export const DECLINE_TEXT =
  "I decline to authorize the action described above. No action is to be taken on my Buyer Account's behalf.";

export interface AuthorizationTerms {
  [label: string]: string;
}

export interface AuthorizationRequestRow {
  id: string;
  property_id: string;
  buyer_account_id: string;
  action_type: AuthorizationAction;
  headline: string;
  terms: AuthorizationTerms;
  prior_terms: AuthorizationTerms | null;
  prior_request_id: string | null;
  market_driven: boolean;
  /** Instrument carries a buyer-side commission provision (Rev 42). */
  commission_expected?: boolean;
  deadline_at: string;
  consequence_text: string;
  status: "pending" | "authorized" | "declined" | "withdrawn";
  agent_id: string | null;
  recommendation_kind: RecommendationKind | null;
  recommendation_text: string | null;
  recommendation_at: string | null;
  escalated_at: string | null;
  escalated_second_at: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface AuthorizationResponseRow {
  id: string;
  request_id: string;
  account_member_id: string;
  decision: "confirmed" | "declined";
  signed_name: string;
  on_behalf_of_member_id: string | null;
  authority_basis: string | null;
  responded_at: string;
}

export interface AuthorizationMember {
  id: string;
  full_name: string | null;
  role: string | null;
}

export type TermDiffKind = "unchanged" | "changed" | "added" | "removed";

export interface TermDiffLine {
  label: string;
  value: string;
  priorValue: string | null;
  kind: TermDiffKind;
}

/** Line-by-line diff of proposed terms against the prior version, if any. */
export function diffTerms(
  terms: AuthorizationTerms,
  prior: AuthorizationTerms | null,
): TermDiffLine[] {
  const labels = new Set([...Object.keys(terms ?? {}), ...Object.keys(prior ?? {})]);
  const lines: TermDiffLine[] = [];
  for (const label of labels) {
    const value = terms?.[label];
    const priorValue = prior?.[label];
    if (value === undefined) {
      lines.push({ label, value: "—", priorValue: priorValue ?? null, kind: "removed" });
    } else if (!prior) {
      lines.push({ label, value, priorValue: null, kind: "unchanged" });
    } else if (priorValue === undefined) {
      lines.push({ label, value, priorValue: null, kind: "added" });
    } else {
      lines.push({
        label,
        value,
        priorValue,
        kind: priorValue === value ? "unchanged" : "changed",
      });
    }
  }
  return lines.sort((a, b) => a.label.localeCompare(b.label));
}

export interface AuthorizationState {
  /** Members whose express confirmation the request still needs. */
  outstanding: AuthorizationMember[];
  confirmed: string[];
  declined: string[];
  /** Every member accounted for, whether directly or under documented authority. */
  complete: boolean;
  anyDeclined: boolean;
  overdue: boolean;
  hoursRemaining: number;
}

/**
 * Who still has to answer. A member is accounted for by their own response, or
 * by another member responding under documented authority for them (the same
 * rule the PRA and ID Scan use).
 */
export function authorizationState(
  request: Pick<AuthorizationRequestRow, "deadline_at">,
  responses: AuthorizationResponseRow[],
  members: AuthorizationMember[],
  now: number = Date.now(),
): AuthorizationState {
  const answered = new Set<string>();
  const confirmed: string[] = [];
  const declined: string[] = [];
  for (const r of responses) {
    const ids = [r.account_member_id, r.on_behalf_of_member_id].filter(Boolean) as string[];
    for (const id of ids) {
      answered.add(id);
      if (r.decision === "confirmed") confirmed.push(id);
      else declined.push(id);
    }
  }
  const outstanding = members.filter((m) => !answered.has(m.id));
  const deadline = new Date(request.deadline_at).getTime();
  return {
    outstanding,
    confirmed,
    declined,
    complete: members.length > 0 && outstanding.length === 0,
    anyDeclined: declined.length > 0,
    overdue: deadline < now,
    hoursRemaining: Math.max(0, Math.round((deadline - now) / 36e5)),
  };
}

/** Terminal disposition once every member is accounted for. */
export function dispositionFor(state: AuthorizationState): "authorized" | "declined" | null {
  if (state.anyDeclined) return "declined";
  if (state.complete) return "authorized";
  return null;
}

export function authorizationStatusLabel(row: AuthorizationRequestRow): string {
  switch (row.status) {
    case "authorized":
      return "Authorized";
    case "declined":
      return "Declined";
    case "withdrawn":
      return "Withdrawn";
    default:
      return new Date(row.deadline_at).getTime() < Date.now()
        ? "Awaiting response — past deadline"
        : "Awaiting your authorization";
  }
}

export function recommendationLabel(kind: RecommendationKind | null): string {
  if (!kind) return "Your Resident Agent has not responded yet";
  return RECOMMENDATION_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

export function formatDeadline(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
