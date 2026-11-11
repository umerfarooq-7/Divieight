/**
 * Draft Operating Agreement clauses that are NOT yet counsel-approved. They are written into the generated draft
 * and final Operating Agreement text, each marked "DRAFT: pending counsel review", and listed in the admin note on
 * the Entity Genesis page so counsel can edit the wording. Edit the wording here, in one place; nothing else in the
 * Operating Agreement template, its hashing or its signing is touched by changing this file.
 *
 * The numbers (the release-vote length, the right-of-first-refusal window) come from the governance settings, so the
 * agreement never disagrees with what the platform enforces. The $500 fee is the Resale Shop's flat fee.
 */
import { GOVERNANCE_DEFAULTS, hoursAsText } from "@/lib/governance-config";

export const OA_DRAFT_MARKER = "DRAFT: pending counsel review";

/** The numbers the clauses quote. Defaults are the governance defaults. */
export interface OaTerms {
  retentionReleaseVoteDays: number;
  rofrWindowHours: number;
  resaleFlatFeeUsd: number;
}

export const oaTermsFrom = (config: { retentionReleaseVoteDays: number; rofrWindowHours: number } = GOVERNANCE_DEFAULTS, resaleFlatFeeUsd = 500): OaTerms => ({
  retentionReleaseVoteDays: config.retentionReleaseVoteDays,
  rofrWindowHours: config.rofrWindowHours,
  resaleFlatFeeUsd,
});

export interface OaDraftClause {
  id: "retention_exceptions" | "right_of_first_refusal";
  /** Where it sits in the agreement. */
  article: string;
  number: string;
  title: string;
  /** The clause as it appears in the agreement: a marker line, then the numbered paragraphs. */
  render: (terms: OaTerms) => string;
}

const days = (hours: number) => hoursAsText(hours);

export const OA_DRAFT_CLAUSES: OaDraftClause[] = [
  {
    id: "retention_exceptions",
    article: "IV",
    number: "4.4",
    title: "Retention Lock: hardship and unanimous-consent exceptions",
    render: (t) => `4.4 [${OA_DRAFT_MARKER}] Exceptions to the Retention Lock. The Retention
    Lock on a unit ends early only in one of two ways, each applying to the
    requesting member's unit alone:
    (a) Hardship. On a member's written request, supported by documents, the
        Manager may release the Retention Lock where continuing it would cause
        that member undue hardship. The Manager records the decision and its
        reason.
    (b) Unanimous consent. The Retention Lock is released if every issued unit
        votes in favour in a vote of the members that stays open for
        ${t.retentionReleaseVoteDays} days.`,
  },
  {
    id: "right_of_first_refusal",
    article: "VI",
    number: "6.2",
    title: "Right of first refusal and the resale fee",
    render: (t) => `6.2 [${OA_DRAFT_MARKER}] Right of first refusal. A member who wishes to sell
    a unit after the Retention Lock must first offer it to the other members
    at the asking price, for ${days(t.rofrWindowHours)} (${t.rofrWindowHours} hours). If more than one member elects to buy, the
    member with the higher priority rank is preferred. A unit not taken up
    within that period may be offered on the open market. A flat technology-
    service fee of $${t.resaleFlatFeeUsd} applies to a sale, disclosed when the unit is listed and
    collected at sale.`,
  },
];

export const oaDraftClause = (id: OaDraftClause["id"]) => OA_DRAFT_CLAUSES.find((c) => c.id === id)!;

/** What the admin note tells counsel. */
export const OA_DRAFT_CLAUSES_NOTE =
  "These clauses are drafts. Each is marked \"" + OA_DRAFT_MARKER + "\" in the Operating Agreement text it appears in. To change the wording, edit src/constants/oaDraftClauses.ts: nothing else in the agreement, its hash or its signing changes.";
