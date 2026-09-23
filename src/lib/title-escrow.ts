/**
 * Title/Escrow Real-Time Handshake — shared, client-safe definitions.
 *
 * The Title Certainty Monitor tracks the order through its milestones so no
 * one has to phone the title company for status.
 */

export const TITLE_MILESTONES = [
  "order_opened",
  "title_report_ready",
  "earnest_money_deposited",
  "closing_scheduled",
  "funded_and_recorded",
] as const;

export type TitleMilestone = (typeof TITLE_MILESTONES)[number];

export const MILESTONE_LABELS: Record<TitleMilestone, string> = {
  order_opened: "Title order opened",
  title_report_ready: "Title report ready",
  earnest_money_deposited: "Earnest money deposited",
  closing_scheduled: "Closing scheduled",
  funded_and_recorded: "Funded & recorded",
};

export const MILESTONE_DESCRIPTIONS: Record<TitleMilestone, string> = {
  order_opened: "The title/escrow company has opened the file for this purchase.",
  title_report_ready: "The title commitment is in — it's now in your due-diligence documents.",
  earnest_money_deposited: "Escrow confirms the earnest-money deposits it has received.",
  closing_scheduled: "A closing date is set with the title/escrow company.",
  funded_and_recorded: "The purchase is funded and the deed is recorded.",
};

export type TitleProvider = "qualia" | "softpro";

export interface TitleStatus {
  propertyId: string;
  provider: TitleProvider | null;
  orderOpenedAt: string | null;
  bundleSentAt: string | null;
  simulated: boolean;
  closingDate: string | null;
  milestones: Array<{ milestone: TitleMilestone; receivedAt: string | null }>;
}

export function nextMilestone(received: TitleMilestone[]): TitleMilestone | null {
  return TITLE_MILESTONES.find((m) => !received.includes(m)) ?? null;
}

export const DISCREPANCY_LABELS: Record<string, string> = {
  title_deposited_platform_unfunded: "Title reports a deposit the platform still shows as unfunded",
  platform_funded_title_missing: "Platform shows funded, but title reports no deposit",
  amount_mismatch: "Deposit amount differs between title and the platform",
  title_complete_platform_incomplete: "Title says all deposits are complete; the platform does not",
  no_platform_obligations: "Title reports deposits, but no earnest-money obligations were issued",
  funded_with_open_preconditions: "Title reports funding while disbursement preconditions were unmet",
};
