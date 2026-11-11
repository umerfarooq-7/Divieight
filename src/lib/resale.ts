/** Resale Shop: the right-of-first-refusal window, the fee and the status labels. */
import { GOVERNANCE_DEFAULTS } from "@/lib/governance-config";

/** The default window; the live value is the governance config's rofrWindowHours. */
export const RESALE_ROFR_HOURS = GOVERNANCE_DEFAULTS.rofrWindowHours;
/** Disclosed at listing, collected at sale. The listing's own flat_fee is the record. */
export const RESALE_FLAT_FEE = 500;

export type ResaleStatus = "rofr_open" | "rofr_exercised" | "open_market" | "sold" | "withdrawn" | "expired";
export type RofrPosition = "exercise" | "decline";

/** Said on the listing and on the sale: what already allocated to the seller does not move. */
export const RESALE_UNPAID_NOTICE = "Any amounts already allocated to you stay with you after this sale.";

/** Statuses in which a share is still on offer. */
export const RESALE_LIVE_STATUSES: ResaleStatus[] = ["rofr_open", "rofr_exercised", "open_market"];

export const RESALE_STATUS_LABELS: Record<ResaleStatus, string> = {
  rofr_open: "Co-owner right of first refusal",
  rofr_exercised: "Exercised: resolving co-owner elections",
  open_market: "On the open market",
  sold: "Sold",
  withdrawn: "Withdrawn",
  expired: "Expired",
};

export type ResaleTransactionStatus = "pending_closing" | "completed" | "cancelled";

export const ROFR_WINNER_RULE = "Higher priority rank wins";

export interface RofrCandidate {
  id: string;
  priority_rank_at_election: number | null;
  elected_at: string;
}

/** Statuses of a co-owner's election. 'offered' is the one holding the offer after a cancelled sale. */
export type ElectionStatus = "active" | "won" | "lost" | "withdrawn" | "offered";

/** Best (lowest) rank wins. A tie shouldn't occur; if it does, the earliest election wins. */
export function pickRofrWinner<T extends RofrCandidate>(elections: T[]): T | null {
  const rank = (e: T) => e.priority_rank_at_election ?? Number.POSITIVE_INFINITY;
  return (
    [...elections].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        new Date(a.elected_at).getTime() - new Date(b.elected_at).getTime() ||
        a.id.localeCompare(b.id),
    )[0] ?? null
  );
}

export function rofrCloseAt(opensAt: Date, hours: number = RESALE_ROFR_HOURS): Date {
  return new Date(opensAt.getTime() + hours * 3_600_000);
}

/** When an open-market listing expires: this many days after it reached the open market. */
export const openMarketExpiresAt = (openedAt: Date, days: number): Date => new Date(openedAt.getTime() + days * 86_400_000);

/**
 * After a cancelled sale: the next best-ranked co-owner who elected and has not yet been offered the share.
 * Same rule as the first time (best rank, then the earliest election), minus whoever already had it.
 */
export function pickNextElector<T extends RofrCandidate & { holder_key: string }>(elections: T[], alreadyOffered: string[]): T | null {
  return pickRofrWinner(elections.filter((e) => !alreadyOffered.includes(e.holder_key)));
}

export const resaleMoney = (amount: number) =>
  Number(amount).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
