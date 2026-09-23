/**
 * Closing-Cost Funding Coordination — shared, client-safe logic (Prompt 7).
 *
 * Each Buyer Account wires its pro-rata closing-table funds DIRECTLY to the
 * title/escrow company. divieight never receives, holds or distributes them.
 *
 * The Platform Enrollment Fee is NOT a closing-cost contribution. It pays for
 * the platform's own services only; everything at the closing table is the
 * Buyer Account's own cost. These two lists are the single source of truth for
 * that distinction and are rendered verbatim in the Closing Funds Notice.
 */
import { money, formatDeadline, DEFAULT_FUNDING_METHODS, type EarnestObligation, type EarnestTerms } from "@/lib/earnest-money";

export type ClosingObligation = EarnestObligation;
export type ClosingTerms = EarnestTerms;

/** What the Platform Enrollment Fee DOES fund. */
export const ENROLLMENT_FEE_FUNDS = [
  "Manager compensation (divieight, LLC)",
  "Third-party API and vendor costs",
  "The appraisal",
  "The inspection",
] as const;

/** What the Platform Enrollment Fee does NOT fund — the Buyer Account's own closing-table costs. */
export const ENROLLMENT_FEE_DOES_NOT_FUND = [
  "The purchase price",
  "Property taxes",
  "Title fees and title insurance",
  "Recording fees",
  "Escrow fees",
  "Lender fees",
  "Prepaid items",
] as const;

export const ENROLLMENT_FEE_SCOPE_NOTICE = `Your Platform Enrollment Fee funds only: ${ENROLLMENT_FEE_FUNDS.join(", ").toLowerCase()}. It does NOT fund ${ENROLLMENT_FEE_DOES_NOT_FUND.join(", ").toLowerCase()} — those are your Buyer Account's own closing-table costs, covered by the amount in this notice.`;

export const CLOSING_DIRECT_TO_ESCROW_NOTICE =
  "Wire these funds directly to the title/escrow company named below. divieight never receives, holds, or distributes closing funds.";

export const CLOSING_PRA8_NOTICE =
  "Failure to fund by the wire deadline is a Default under PRA Section 8. The title/escrow company, the non-defaulting members and the tethered Resident Agents are notified, and the Member Substitution Pipeline is opened for the affected share on a best-efforts basis.";

export const CLOSING_SUBSTITUTE_NOTICE =
  "Funding this pro-rata closing-table amount on the existing pod timeline is a condition precedent to your installation into the Buyer Group.";

export const CLOSING_STATUS_LABELS: Record<ClosingObligation["status"], string> = {
  pending: "Awaiting wire",
  funded: "Received by escrow",
  late: "Past wire deadline",
  missed: "Not funded — Default",
};

/** The Closing Funds Notice for one Buyer Account. */
export function closingFundsInstruction(o: ClosingObligation, t: ClosingTerms): string {
  const methods = (t.funding_methods ?? DEFAULT_FUNDING_METHODS).join(", ");
  return [
    `Closing Funds Notice: your Buyer Account is acquiring ${o.shares} of eight shares, so your pro-rata closing-table funding obligation is exactly ${money(o.amount)} of the ${money(t.total_amount)} total.`,
    `Wire it to ${t.escrow_company}${t.escrow_reference ? ` (reference ${t.escrow_reference})` : ""} by ${formatDeadline(o.funding_deadline)}.`,
    `Accepted methods: ${methods}.`,
    CLOSING_DIRECT_TO_ESCROW_NOTICE,
    ENROLLMENT_FEE_SCOPE_NOTICE,
  ].join(" ");
}
