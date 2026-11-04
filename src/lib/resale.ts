/** Resale Shop: the right-of-first-refusal window, the fee and the status labels. */

export const RESALE_ROFR_HOURS = 240;
/** Disclosed at listing, collected at sale. The listing's own flat_fee is the record. */
export const RESALE_FLAT_FEE = 500;

export type ResaleStatus = "rofr_open" | "rofr_exercised" | "open_market" | "sold" | "withdrawn" | "expired";
export type RofrPosition = "exercise" | "decline";

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

export function rofrCloseAt(opensAt: Date): Date {
  return new Date(opensAt.getTime() + RESALE_ROFR_HOURS * 3_600_000);
}

export const resaleMoney = (amount: number) =>
  Number(amount).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
