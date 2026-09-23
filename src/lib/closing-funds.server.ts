/**
 * Closing-Cost Funding Coordination — server side (Prompt 7). Same lifecycle
 * as earnest money via the shared funding-obligations engine.
 */
import {
  CLOSING_PRA8_NOTICE,
  CLOSING_SUBSTITUTE_NOTICE,
  closingFundsInstruction,
} from "@/lib/closing-funds";
import {
  createSubstituteObligation,
  issueObligations,
  markFunded,
  runSweep,
  type FundingKind,
  type IssueFundingInput,
} from "@/lib/funding-obligations.server";

type Db = { from: (t: string) => any };

export const CLOSING_KIND: FundingKind = {
  termsTable: "closing_funds_terms",
  obligationsTable: "closing_funds_obligations",
  auditPrefix: "closing_funds",
  entityType: "closing_funds_obligation",
  settingsKey: "closing_funds",
  portalLink: "/buyer/closing-funds",
  noun: "closing funds",
  title: "Closing funds",
  defaultReason: "closing_funds_default",
  instruction: closingFundsInstruction,
  pra8Notice: CLOSING_PRA8_NOTICE,
  substituteNotice: CLOSING_SUBSTITUTE_NOTICE,
  issueLead: (where) => `Closing for ${where} is approaching.`,
};

export const issueClosingObligations = (db: Db, actorId: string | null, input: IssueFundingInput) =>
  issueObligations(db, CLOSING_KIND, actorId, input);

export const markClosingFunded = (
  db: Db,
  actorId: string | null,
  params: { obligationId: string; reference?: string | null },
) => markFunded(db, CLOSING_KIND, actorId, params);

export const runClosingFundsSweep = (db: Db, actorId: string | null = null, limit = 100) =>
  runSweep(db, CLOSING_KIND, actorId, limit);

export const createClosingSubstituteObligation = (
  db: Db,
  params: {
    propertyId: string;
    buyerAccountId: string;
    shares: number;
    actorId: string | null;
    replacesObligationId?: string | null;
  },
) => createSubstituteObligation(db, CLOSING_KIND, params);
