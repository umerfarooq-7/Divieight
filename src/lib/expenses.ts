/**
 * Expense Management: the pro-rata split, the capital call rules and status labels.
 * Nothing here moves money: an owner marks a payment and an admin confirms it.
 */

export type ExpenseStatus = "draft" | "posted" | "voided";
export type ExpenseAllocationStatus = "due" | "paid" | "waived";
export type CapitalCallStatus = "draft" | "issued" | "closed";
export type CapitalCallAllocationStatus = "due" | "marked_paid" | "confirmed" | "overdue";
export type PaymentKind = "expense" | "capital_call";

/**
 * PLACEHOLDER pending the Operating Agreement: a capital call above this total
 * needs a passed owner vote before it can be issued. Exactly this amount doesn't.
 */
export const CAPITAL_CALL_VOTE_THRESHOLD = 10_000;
export const CAPITAL_CALL_VOTE_THRESHOLD_IS_PLACEHOLDER = true;
/** PLACEHOLDER: OA 3.3 asks for "member approval" without naming a threshold. */
export const CAPITAL_CALL_VOTE_TYPE = "major" as const;

export const capitalCallNeedsVote = (totalAmount: number) => toCents(totalAmount) > toCents(CAPITAL_CALL_VOTE_THRESHOLD);

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
 */
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
