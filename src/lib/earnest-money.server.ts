/**
 * Earnest Money Coordination — server side (Prompt 5).
 *
 * The platform issues funding instructions and tracks status only. Funds move
 * directly from each Buyer Account to the title/escrow company; there is no
 * custody mechanism here by design. The lifecycle (issue → funded / late →
 * Default under PRA Section 8 → Member Substitution Pipeline → substitute
 * obligation) is the shared funding-obligations engine.
 */

import {
  DEFAULT_PRA8_NOTICE,
  SUBSTITUTE_CONDITION_NOTICE,
  fundingInstruction,
  type EarnestTerms,
} from "@/lib/earnest-money";
import {
  createSubstituteObligation as createSubstitute,
  issueObligations,
  loadTerms as loadKindTerms,
  markFunded,
  runSweep,
  type FundingKind,
  type IssueFundingInput,
} from "@/lib/funding-obligations.server";

type Db = { from: (t: string) => any };

export const EARNEST_KIND: FundingKind = {
  termsTable: "earnest_money_terms",
  obligationsTable: "earnest_money_obligations",
  auditPrefix: "earnest",
  entityType: "earnest_money_obligation",
  settingsKey: "earnest_money",
  portalLink: "/buyer/earnest-money",
  noun: "earnest money",
  title: "Earnest money",
  defaultReason: "earnest_money_default",
  instruction: fundingInstruction,
  pra8Notice: DEFAULT_PRA8_NOTICE,
  substituteNotice: SUBSTITUTE_CONDITION_NOTICE,
  issueLead: (where) => `The seller has accepted the Buyer Group's offer for ${where}.`,
};

export type IssueEarnestInput = IssueFundingInput;

export function loadTerms(db: Db, propertyId: string): Promise<EarnestTerms | null> {
  return loadKindTerms(db, EARNEST_KIND, propertyId);
}

/** Split the accepted offer's earnest money pro-rata and issue instructions. */
export function issueEarnestObligations(db: Db, actorId: string | null, input: IssueEarnestInput) {
  return issueObligations(db, EARNEST_KIND, actorId, input);
}

export function markObligationFunded(
  db: Db,
  actorId: string | null,
  params: { obligationId: string; reference?: string | null; fundedAt?: string | null },
) {
  return markFunded(db, EARNEST_KIND, actorId, params);
}

export function runEarnestMoneySweep(db: Db, actorId: string | null = null, limit = 100) {
  return runSweep(db, EARNEST_KIND, actorId, limit);
}

export function createSubstituteObligation(
  db: Db,
  params: {
    propertyId: string;
    buyerAccountId: string;
    shares: number;
    actorId: string | null;
    replacesObligationId?: string | null;
  },
) {
  return createSubstitute(db, EARNEST_KIND, params);
}
