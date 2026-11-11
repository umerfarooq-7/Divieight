/**
 * Know Your Owner (KYO) record (shared, no server imports).
 *
 * The KYO record holds, per Account Member: the eligibility result and the version of the Participant
 * Eligibility Standard it was determined against (from eligibility_results), and the declaration's hash,
 * Standard version and date (admin only). It has no field for the outcome of a report: the platform does
 * not obtain a consumer report in the ordinary course.
 */

/**
 * The most sensitive PII the platform holds about an Account Member. Access to each is limited and
 * logged (the PII Sub-Vault and the Audit Vault are unchanged).
 */
export const KYO_MOST_SENSITIVE_PII = [
  "the government-issued ID image",
  "the ID document number",
  "the date of birth",
  "the liveness selfie",
  "the W-9 taxpayer identification number",
  "linked financial account data",
  "any consumer report obtained under the Block 4 authorization",
] as const;

export const CORRECTION_FIELDS = [
  { value: "full_name", label: "Full name" },
  { value: "date_of_birth", label: "Date of birth" },
  { value: "address", label: "Address" },
  { value: "id_document_number", label: "ID document number" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "w9", label: "W-9 details" },
  { value: "other", label: "Something else" },
] as const;
export type CorrectionField = (typeof CORRECTION_FIELDS)[number]["value"];
export const isCorrectionField = (v: unknown): v is CorrectionField => CORRECTION_FIELDS.some((f) => f.value === v);

/** Answers to the declaration are corrected through "Correct and resubmit", which recomputes the result. */
export const DECLARATION_CORRECTION_NOTE =
  "To correct an answer in your Eligibility Declaration, use Correct and resubmit on The Eligibility Check. That is a correction of fact, and your result is recomputed.";

export interface KyoDeclaration {
  id: string;
  status: "incomplete" | "complete";
  standardVersion: string;
  declaredAt: string;
  declarationHash: string;
  /** How many versions this member has made (earlier ones are kept). */
  versions: number;
}

export interface KyoEligibility {
  result: "eligible" | "held" | "not_eligible";
  /** The version of the Participant Eligibility Standard against which the result was determined. */
  standardVersion: string;
  determinedAt: string;
}

/** Shown to admins on the KYO screens until compliance has reviewed the list. */
export const KYO_REVIEW_BANNER = "Sensitive-data list and retention wording pending compliance review";

export interface MemberKyo {
  memberId: string;
  name: string;
  role: string;
  eligibility: KyoEligibility | null;
  declaration: KyoDeclaration | null;
}
