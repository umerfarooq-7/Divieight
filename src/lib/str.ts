/**
 * Short-term rental (COOA Section 10): the income from an owner's own weeks is the owner's, never the LLC's.
 * Pure helpers and wording. The owner's tracker is recordkeeping only; nothing here touches the ledger.
 */

export const LODGING_TAX_STATUSES = ["not_applicable", "owed", "remitted", "unknown"] as const;
export type LodgingTaxStatus = (typeof LODGING_TAX_STATUSES)[number];
export const isLodgingTaxStatus = (s: unknown): s is LodgingTaxStatus => typeof s === "string" && (LODGING_TAX_STATUSES as readonly string[]).includes(s);

export const LODGING_TAX_LABELS: Record<LodgingTaxStatus, string> = {
  not_applicable: "Not applicable",
  owed: "Owed",
  remitted: "Remitted",
  unknown: "Not sure",
};

/** Shown on the owner's tracker, word for word. */
export const OWNER_STR_NOTICE =
  "Short-term rental income from your own weeks is yours, not the LLC's. You are responsible for reporting it and any lodging taxes. divieight records it for your convenience and does not file or remit on your behalf.";

/** Shown on a bank deposit that looks like STR income. */
export const STR_LLC_WARNING = "STR income does not belong to the LLC";

/** The Intent profile of a pod is the property's usage. Only a short-term-rental home offers the tracker. */
export const strTrackerAllowed = (usageTag: string | null | undefined) => usageTag === "short_term_rental";

/** The flag on the CPA Cooperation Worksheet. Who recorded activity with tax owed or unknown; never an amount. */
export const LODGING_TAX_FLAG_TITLE = "State and local lodging-tax exposure";
export const LODGING_TAX_FLAG_NOTE = "These owners recorded short-term-rental activity with lodging tax owed or not known. No amounts are calculated and divieight remits nothing.";

export interface OwnerStrRecord {
  id: string;
  periodStart: string;
  periodEnd: string;
  nights: number;
  grossCents: number;
  feesCents: number;
  lodgingTaxStatus: LodgingTaxStatus;
  lodgingTaxNote: string | null;
}

export interface LodgingTaxExposureRow {
  member: string;
  statuses: LodgingTaxStatus[];
  recordCount: number;
}

/** A problem with a record before it goes to the database, or null. */
export function strRecordProblem(r: { periodStart: string; periodEnd: string; nights: number; grossCents: number; feesCents: number; lodgingTaxStatus: string }): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(r.periodEnd)) return "Enter the first and last day of the period.";
  if (r.periodEnd < r.periodStart) return "The period can't end before it starts.";
  if (!Number.isInteger(r.nights) || r.nights < 0) return "Nights is a whole number.";
  const days = Math.round((Date.parse(r.periodEnd) - Date.parse(r.periodStart)) / 86_400_000) + 1;
  if (r.nights > days) return "That's more nights than the period has days.";
  if (!Number.isSafeInteger(r.grossCents) || r.grossCents < 0) return "Gross income is an amount of zero or more.";
  if (!Number.isSafeInteger(r.feesCents) || r.feesCents < 0) return "Platform fees are an amount of zero or more.";
  if (r.feesCents > r.grossCents) return "Platform fees can't be more than the gross income.";
  if (!isLodgingTaxStatus(r.lodgingTaxStatus)) return "Choose a lodging-tax status.";
  return null;
}
