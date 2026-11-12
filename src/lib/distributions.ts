/**
 * Distributions (shared and pure): the split, the status words, the notice text, and the checks on a member's bank details.
 * The database (distributions.sql) does the real work and re-checks every line. Nothing here moves money.
 */
import { expenseMoney, fromCents, percentsProblem, splitByPercents, splitProRata, toCents, type SplitHolder, type SplitLine } from "@/lib/expenses";

export type DistributionStatus = "draft" | "authorized" | "executed" | "failed" | "voided" | "posted";
export type PaymentStatus = "pending" | "held" | "processing" | "sent" | "failed" | "cancelled";
export type SplitMethod = "pro_rata" | "oa_override";

export const DISTRIBUTION_STATUS_LABELS: Record<DistributionStatus, string> = {
  draft: "Draft: not authorized",
  authorized: "Authorized",
  executed: "Executed",
  failed: "Failed: nothing was posted",
  voided: "Voided",
  posted: "Notice posted",
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: "Waiting to be sent",
  held: "Held: no payout method yet",
  processing: "With the bank",
  sent: "Paid",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** ASSUMPTION (shown on the launch readiness page): until the Operating Agreement or the Manager sets one, every property keeps this much in Cash. */
export const DEFAULT_MINIMUM_RESERVE_CENTS = 100_000;
export const MINIMUM_RESERVE_ASSUMPTION = `ASSUMPTION: the minimum cash reserve a property keeps before it distributes is a placeholder (${expenseMoney(fromCents(DEFAULT_MINIMUM_RESERVE_CENTS))}). The Manager sets the real figure for each property.`;

export const DISTRIBUTION_RULES_TEXT =
  "Distributable cash is the Cash balance in the books, minus the property's minimum reserve, minus what authorized distributions still owe. A distribution above it is refused. The split uses the owners on the record date, rounded down to the cent with the leftover cents to rank 1. Neither the Retention Lock nor an overdue expense stops a distribution.";

export interface DistributionInput {
  totalCents: number;
  holders: SplitHolder[];
  method: SplitMethod;
  percents?: Record<string, number>;
}

/** The split of a distribution, in order of rank. Pro rata to shares, or the override's percentages; the cents rule is Prompt 8's. */
export function splitDistribution(input: DistributionInput): SplitLine[] {
  const total = fromCents(input.totalCents);
  if (input.method === "oa_override") return splitByPercents(total, input.holders, input.percents ?? {});
  return splitProRata(total, input.holders);
}

export { percentsProblem, toCents, fromCents };

/** A problem with a distribution's headline numbers, or null. */
export function distributionProblem(p: { totalCents: number; distributableCents: number; recordDate: string; today: string; reason: string }): string | null {
  if (!Number.isInteger(p.totalCents) || p.totalCents <= 0) return "The total must be above zero, with at most two decimal places.";
  if (!p.reason.trim()) return "Say why this distribution is being made.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.recordDate)) return "Enter a valid record date.";
  if (p.recordDate > p.today) return "The record date can't be in the future.";
  if (p.totalCents > Math.max(p.distributableCents, 0)) return `That is more than the distributable cash (${expenseMoney(fromCents(Math.max(p.distributableCents, 0)))}).`;
  return null;
}

/** The notice each owner gets, made from the distribution record (never typed by hand). */
export function distributionNoticeText(d: { totalCents: number; recordDate: string; reason: string | null; status: DistributionStatus }, line: { amountCents: number; shares: number }): string {
  const own = `Your amount is ${expenseMoney(fromCents(line.amountCents))} (${line.shares} ${line.shares === 1 ? "share" : "shares"}).`;
  const base = `A distribution of ${expenseMoney(fromCents(d.totalCents))} was authorized for record date ${d.recordDate}. ${own}`;
  const why = d.reason ? ` Reason: ${d.reason}.` : "";
  return `${base}${why} It is paid by ACH to the payout method on your account; you'll be told when it goes out. If you have no payout method yet, add one under your distributions and your payment is held until you do.`;
}

export const heldNoticeText = (amountCents: number, recordDate: string) =>
  `Your ${expenseMoney(fromCents(amountCents))} distribution (record date ${recordDate}) was not paid because you have no payout method. It is held for you: add a payout method under your distributions and it is sent. Nobody else's payment is waiting on yours.`;

export const paidNoticeText = (amountCents: number, last4: string | null) =>
  `Your distribution of ${expenseMoney(fromCents(amountCents))} was sent by ACH${last4 ? ` to the account ending ${last4}` : ""}.`;

// ---------------------------------------------------------------------------------------------------------
// A member's bank details, checked before they are tokenized. They are never stored.
// ---------------------------------------------------------------------------------------------------------
/** The ABA routing number check: nine digits and a weighted sum of 3-7-1 that divides by 10. */
export function routingNumberValid(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = routing.split("").map(Number);
  return (3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!)) % 10 === 0;
}

export function bankDetailsProblem(routing: string, account: string): string | null {
  if (!routingNumberValid(routing.replace(/\s/g, ""))) return "That routing number isn't valid. It is nine digits.";
  if (!/^\d{4,17}$/.test(account.replace(/\s/g, ""))) return "The account number is four to seventeen digits.";
  return null;
}

/** Everything an owner (or the Manager) sees of a payout method. Never a full number. */
export const maskedAccount = (last4: string) => `Account ending ${last4}`;
