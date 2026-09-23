/**
 * Insurance Procurement by the Manager (Rev 48) — shared, client-safe logic.
 *
 * divieight, LLC procures homeowners/hazard coverage for every property under
 * the authority granted at Block 2; no separate consent is needed. There is no
 * Strategic Insurance Partner path. Buyer Accounts keep a Right to Shop.
 */

export type DeclaredUse = "personal_use" | "short_term_rental";
export type PolicyStatus = "pending" | "bound" | "lapsed";
export type ProcurementMethod = "default" | "buyer_alternative";
export type ProposalStatus = "submitted" | "approved" | "rejected" | "selected" | "not_selected";

export const PLACEHOLDER_WARNING =
  "PLACEHOLDER VALUES — must be replaced with real minimums from platform compliance before the first live closing.";

export const BLOCK2_AUTHORITY_NOTICE =
  "divieight, LLC procures this coverage as Manager under the authority you granted at Block 2 of the Required Buyer Authorizations. The premium is an operating expense of the property's LLC, paid from its operating account.";

export const RIGHT_TO_SHOP_NOTICE =
  "You may propose an alternative carrier. If it meets the coverage requirements it is approved, and the Manager procures it instead of the default policy. If members propose different approved alternatives, the pod decides by a simple vote — one vote per Buyer Account; a tie keeps the Manager's default policy.";

export const DECLARED_USE_LABELS: Record<DeclaredUse, string> = {
  personal_use: "Personal use",
  short_term_rental: "Short-term rental",
};

export interface CoverageRule {
  min_replacement_cost: number;
  max_replacement_cost: number | null;
  declared_use: DeclaredUse;
  min_dwelling_coverage: number;
  min_liability_coverage: number;
}

export interface CoverageRequirementVersion {
  id: string;
  version: number;
  rules: CoverageRule[];
  is_placeholder: boolean;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  activated_at: string | null;
}

export interface InsurancePolicy {
  id: string;
  property_id: string;
  carrier_name: string;
  policy_number: string;
  coverage_amount: number;
  liability_coverage: number | null;
  premium: number;
  effective_date: string;
  renews_at: string | null;
  procured_by: "manager";
  procurement_method: ProcurementMethod;
  status: PolicyStatus;
  declared_use: DeclaredUse | null;
  replacement_cost: number | null;
  requirement_version: number | null;
  alternative_proposal_id: string | null;
  renewed_from_policy_id: string | null;
  premium_paid_from: string;
  premium_expense_category: string;
  premium_paid_at: string | null;
  bound_at: string | null;
  lapsed_at: string | null;
  created_at: string;
}

export interface AlternativeProposal {
  id: string;
  property_id: string;
  buyer_account_id: string;
  carrier_name: string;
  policy_summary: string | null;
  coverage_amount: number;
  liability_coverage: number;
  premium: number;
  status: ProposalStatus;
  meets_requirements: boolean | null;
  review_notes: string | null;
  created_at: string;
}

/** Property usage tag → the declared use the requirements are keyed on. */
export function declaredUseFor(usageTag: string | null | undefined): DeclaredUse {
  return usageTag === "short_term_rental" ? "short_term_rental" : "personal_use";
}

/** The rule covering a replacement cost and declared use, if any. */
export function findRule(
  rules: CoverageRule[],
  replacementCost: number,
  use: DeclaredUse,
): CoverageRule | null {
  return (
    rules.find(
      (r) =>
        r.declared_use === use &&
        replacementCost >= r.min_replacement_cost &&
        (r.max_replacement_cost == null || replacementCost < r.max_replacement_cost),
    ) ?? null
  );
}

export interface CoverageCheck {
  meets: boolean;
  rule: CoverageRule | null;
  shortfalls: string[];
}

export function checkCoverage(
  rules: CoverageRule[],
  input: { replacementCost: number | null; use: DeclaredUse; coverage: number; liability: number | null },
): CoverageCheck {
  if (input.replacementCost == null || !(input.replacementCost > 0))
    return { meets: false, rule: null, shortfalls: ["Replacement cost is required to look up the minimums."] };
  const rule = findRule(rules, input.replacementCost, input.use);
  if (!rule)
    return { meets: false, rule: null, shortfalls: ["No coverage requirement matches this replacement cost and use."] };
  const shortfalls: string[] = [];
  if (input.coverage < rule.min_dwelling_coverage)
    shortfalls.push(`Dwelling coverage ${usd(input.coverage)} is below the ${usd(rule.min_dwelling_coverage)} minimum.`);
  if ((input.liability ?? 0) < rule.min_liability_coverage)
    shortfalls.push(
      `Liability coverage ${usd(input.liability ?? 0)} is below the ${usd(rule.min_liability_coverage)} minimum.`,
    );
  return { meets: shortfalls.length === 0, rule, shortfalls };
}

/** Validate an admin-edited rule set before it becomes a new version. */
export function validateRules(rules: CoverageRule[]): string | null {
  if (!Array.isArray(rules) || rules.length === 0) return "Add at least one rule.";
  for (const [i, r] of rules.entries()) {
    const n = i + 1;
    if (r.declared_use !== "personal_use" && r.declared_use !== "short_term_rental")
      return `Rule ${n}: choose a declared use.`;
    if (!(r.min_replacement_cost >= 0)) return `Rule ${n}: minimum replacement cost must be 0 or more.`;
    if (r.max_replacement_cost != null && !(r.max_replacement_cost > r.min_replacement_cost))
      return `Rule ${n}: maximum must be above the minimum (or blank for no maximum).`;
    if (!(r.min_dwelling_coverage > 0) || !(r.min_liability_coverage > 0))
      return `Rule ${n}: coverage minimums must be positive.`;
  }
  for (const use of ["personal_use", "short_term_rental"] as const) {
    const sorted = rules
      .filter((r) => r.declared_use === use)
      .sort((a, b) => a.min_replacement_cost - b.min_replacement_cost);
    for (let i = 1; i < sorted.length; i++) {
      const prevMax = sorted[i - 1]!.max_replacement_cost;
      if (prevMax == null || prevMax > sorted[i]!.min_replacement_cost)
        return `${DECLARED_USE_LABELS[use]}: replacement-cost ranges overlap.`;
    }
  }
  return null;
}

export interface VoteTally {
  counts: Record<string, number>;
  winnerId: string | null;
  tie: boolean;
  totalVotes: number;
}

/** Plurality among approved alternatives; a tie (or no votes) selects nothing. */
export function tallyVotes(proposalIds: string[], votes: Array<{ proposal_id: string }>): VoteTally {
  const counts: Record<string, number> = Object.fromEntries(proposalIds.map((id) => [id, 0]));
  for (const v of votes) if (v.proposal_id in counts) counts[v.proposal_id]! += 1;
  const totalVotes = Object.values(counts).reduce((a, b) => a + b, 0);
  const max = Math.max(0, ...Object.values(counts));
  const leaders = Object.keys(counts).filter((id) => counts[id] === max);
  if (totalVotes === 0) return { counts, winnerId: null, tie: false, totalVotes };
  if (leaders.length > 1) return { counts, winnerId: null, tie: true, totalVotes };
  return { counts, winnerId: leaders[0]!, tie: false, totalVotes };
}

export function usd(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
