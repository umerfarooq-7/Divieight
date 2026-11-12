/**
 * Expense Management: the pro-rata split, the capital call rules and status labels.
 * Nothing here moves money: an owner marks a payment and an admin confirms it.
 */
import { GOVERNANCE_DEFAULTS } from "@/lib/governance-config";

export type ExpenseStatus = "draft" | "posted" | "voided";
export type ExpenseAllocationStatus = "due" | "paid" | "waived";
export type CapitalCallStatus = "draft" | "issued" | "closed";
export type CapitalCallAllocationStatus = "due" | "marked_paid" | "confirmed" | "overdue";
export type PaymentKind = "expense" | "capital_call";

/**
 * A capital call strictly above the threshold needs a passed Major vote before it can be issued. Exactly the
 * threshold doesn't. The number is the governance config's (src/lib/governance-config.ts); this is its default,
 * for callers with no config in hand.
 */
export const CAPITAL_CALL_VOTE_THRESHOLD = GOVERNANCE_DEFAULTS.capitalCallVoteThresholdUsd;
export const CAPITAL_CALL_VOTE_THRESHOLD_IS_PLACEHOLDER = false;
/** PLACEHOLDER: OA 3.3 asks for "member approval" without naming a threshold. */
export const CAPITAL_CALL_VOTE_TYPE = "major" as const;

export const capitalCallNeedsVote = (totalAmount: number, thresholdUsd: number = CAPITAL_CALL_VOTE_THRESHOLD) => toCents(totalAmount) > toCents(thresholdUsd);

export const EXPENSE_CATEGORIES = [
  "Plumbing",
  "Electrical",
  "HVAC",
  "Appliance",
  "Structure & roof",
  "Exterior & landscaping",
  "Pest",
  "Insurance",
  "Property tax",
  "Utilities",
  "Management",
  "Other",
];

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = { draft: "Draft", posted: "Posted", voided: "Voided" };
export const CAPITAL_CALL_STATUS_LABELS: Record<CapitalCallStatus, string> = { draft: "Draft", issued: "Issued", closed: "Closed" };

/** Works in whole cents, so a split can't drift the way decimals do. */
export function toCents(amount: number): number {
  return Math.round(Number(amount) * 100);
}

export const fromCents = (cents: number) => cents / 100;

/** Two decimal places at most, above zero: what the database can store exactly. */
export function isValidMoney(amount: number): boolean {
  return Number.isFinite(amount) && amount > 0 && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;
}

export interface SplitHolder {
  holderKey: string;
  shares: number;
  rank: number;
}

export interface SplitLine {
  holder_key: string;
  share_count: number;
  amount: number;
}

/**
 * total × (holder shares / issued shares), each rounded down to the cent. The
 * cents left over all go to the lowest rank number, so the lines add up to the
 * total exactly and the same inputs always give the same split. Rounding down
 * means no line can go negative. Lines come back in rank order.
 *
 * THE ROUNDING RULE (decided, do not change without the CPA): every line is rounded DOWN to the cent; the cents that
 * are left over all go to the holder with rank 1. A property has at most eight holders, so at most 7 cents are left
 * over (each of up to 8 lines loses less than one cent). Rank 1 is the lowest rank number, the top-priority holder.
 */
export const ROUNDING_RULE_TEXT =
  "Each owner's share is rounded down to the cent. The cents left over (at most 7) go to the holder with rank 1, so the lines add up to the total exactly.";
export function splitProRata(totalAmount: number, holders: SplitHolder[]): SplitLine[] {
  const issued = holders.reduce((sum, h) => sum + h.shares, 0);
  if (issued <= 0) throw new Error("This property has no issued shares to allocate to.");
  const ordered = [...holders].sort((a, b) => a.rank - b.rank || a.holderKey.localeCompare(b.holderKey));
  const totalCents = toCents(totalAmount);
  const cents = ordered.map((h) => Math.floor((totalCents * h.shares) / issued));
  cents[0]! += totalCents - cents.reduce((sum, c) => sum + c, 0);
  if (cents.some((c) => c <= 0)) throw new Error("This amount is too small to split across every holder.");
  return ordered.map((h, i) => ({ holder_key: h.holderKey, share_count: h.shares, amount: fromCents(cents[i]!) }));
}

// ---------------------------------------------------------------------------
// Operating Agreement overrides (Month 6, Prompt 8). If one applies the allocation follows it; otherwise the default
// pro-rata split above applies. The rounding rule is the same: down to the cent, leftover cents to rank 1.
// ---------------------------------------------------------------------------
export const OVERRIDE_METHODS = ["custom_percent", "usage_adjusted"] as const;
export type OverrideMethod = (typeof OVERRIDE_METHODS)[number];
export const OVERRIDE_METHOD_LABELS: Record<OverrideMethod, string> = {
  custom_percent: "Custom percentages",
  usage_adjusted: "Usage-adjusted (percentages entered by the Manager)",
};
/** ASSUMPTION (shown on the launch readiness page): the Operating Agreement hasn't defined a usage-adjusted formula, so the platform calculates nothing; the Manager enters the percentages. */
export const USAGE_ADJUSTED_ASSUMPTION = "Usage-adjusted expense allocation is entered as manual percentages. The platform calculates no usage formula until the Operating Agreement defines one.";

export interface AllocationOverride {
  id: string;
  expenseCategory: string | null;
  expenseId: string | null;
  method: OverrideMethod;
  percents: Record<string, number>;
  sourceOaSection: string;
  effectiveFrom: string;
}

/** A problem with a set of percentages (holder key to percent), or null. Each above zero, at most two decimals, adding up to exactly 100. */
export function percentsProblem(percents: Record<string, number>): string | null {
  const entries = Object.entries(percents);
  if (entries.length === 0) return "Enter a percentage for every holder.";
  let bp = 0;
  for (const [, p] of entries) {
    if (!Number.isFinite(p) || p <= 0) return "Each percentage must be above zero.";
    if (Math.abs(p * 100 - Math.round(p * 100)) > 1e-6) return "Use at most two decimal places.";
    bp += Math.round(p * 100);
  }
  return bp === 10_000 ? null : "The percentages must add up to exactly 100.";
}

/** The override in force for an expense: one named for that expense beats one for its category; the latest effective date wins. */
export function pickOverride(overrides: AllocationOverride[], expense: { id: string; category: string; incurredOn: string }): AllocationOverride | null {
  const applies = overrides.filter((o) => o.effectiveFrom <= expense.incurredOn && (o.expenseId === expense.id || (o.expenseId === null && o.expenseCategory === expense.category)));
  applies.sort((a, b) => Number(b.expenseId !== null) - Number(a.expenseId !== null) || (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0));
  return applies[0] ?? null;
}

/**
 * total × percent, each rounded DOWN to the cent; the leftover cents go to the holder with rank 1 (the same rule as the default
 * split). The override must name every current holder, once each. Lines come back in rank order.
 */
export function splitByPercents(totalAmount: number, holders: SplitHolder[], percents: Record<string, number>): SplitLine[] {
  const problem = percentsProblem(percents);
  if (problem) throw new Error(problem);
  const keys = new Set(holders.map((h) => h.holderKey));
  const named = Object.keys(percents);
  if (named.length !== keys.size || named.some((k) => !keys.has(k))) throw new Error("The Operating Agreement override doesn't cover every current holder. Retire it or enter a new one.");
  const ordered = [...holders].sort((a, b) => a.rank - b.rank || a.holderKey.localeCompare(b.holderKey));
  const totalCents = toCents(totalAmount);
  const cents = ordered.map((h) => Math.floor((totalCents * Math.round(percents[h.holderKey]! * 100)) / 10_000));
  cents[0]! += totalCents - cents.reduce((sum, c) => sum + c, 0);
  if (cents.some((c) => c <= 0)) throw new Error("This amount is too small to split across every holder.");
  return ordered.map((h, i) => ({ holder_key: h.holderKey, share_count: h.shares, amount: fromCents(cents[i]!) }));
}

/** Calendar dates in UTC, the same way on every server. */
export const todayIso = (now = new Date()) => now.toISOString().slice(0, 10);

export const isPastDue = (dueDate: string, now = new Date()) => dueDate < todayIso(now);

export const expenseMoney = (amount: number) =>
  Number(amount).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** What an owner sees for their own allocation. */
export function paymentLabel(kind: PaymentKind, status: string, paidMarkedAt: string | null): string {
  if (kind === "expense") {
    if (status === "paid") return "Paid";
    if (status === "waived") return "Waived";
    return paidMarkedAt ? "Marked paid: waiting for confirmation" : "Due";
  }
  if (status === "confirmed") return "Paid";
  if (status === "marked_paid") return "Marked paid: waiting for confirmation";
  if (status === "overdue") return "Overdue";
  return "Due";
}

export const canMarkPaid = (kind: PaymentKind, status: string, paidMarkedAt: string | null) =>
  kind === "expense" ? status === "due" && !paidMarkedAt : status === "due" || status === "overdue";
