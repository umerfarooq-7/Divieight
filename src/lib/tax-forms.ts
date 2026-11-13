/**
 * Tax forms (shared and pure): which form a Broker of Record must have, when a W-8 lapses, how a TIN is checked, and where a broker stands for the
 * payout gate. The database (tax-forms.sql) enforces the same rules; nothing here touches a TIN beyond checking its shape.
 */
export const TAX_FORM_TYPES = ["W-9", "W-8BEN", "W-8BEN-E"] as const;
export type TaxFormType = (typeof TAX_FORM_TYPES)[number];
export type EntityKind = "individual" | "entity";
export type GateCode = "tax_form_missing" | "tax_form_expired" | "tax_form_rejected";

export const TAX_FORM_LABELS: Record<TaxFormType, string> = {
  "W-9": "W-9 (a US person or entity)",
  "W-8BEN": "W-8BEN (a non-US individual)",
  "W-8BEN-E": "W-8BEN-E (a non-US entity)",
};

/** Where a broker fixes a missing, expired or rejected form. */
export const BROKER_TAX_FORM_LINK = "/broker/tax-form";
export const TAX_FORM_MISSING_REASON = "Tax form missing";

/** US persons and entities use a W-9; a non-US individual a W-8BEN; a non-US entity a W-8BEN-E. */
export function requiredFormType(isUsPerson: boolean, entityKind: EntityKind): TaxFormType {
  if (isUsPerson) return "W-9";
  return entityKind === "individual" ? "W-8BEN" : "W-8BEN-E";
}

/** A W-8 is good until the end of the third calendar year after the one it was signed in. A W-9 doesn't lapse. */
export function formExpiry(form: TaxFormType, signedAt: string | Date): string | null {
  if (form === "W-9") return null;
  const year = (typeof signedAt === "string" ? new Date(signedAt) : signedAt).getUTCFullYear();
  return `${year + 3}-12-31`;
}

export const digitsOnly = (s: string) => s.replace(/\D/g, "");

/** A problem with a US TIN (SSN, ITIN or EIN) or a foreign tax ID, or null. The value is never put in the message. */
export function tinProblem(kind: "ssn" | "ein" | "itin" | "foreign_tin", raw: string): string | null {
  if (kind === "foreign_tin") return /^[A-Za-z0-9][A-Za-z0-9 .\-/]{2,29}$/.test(raw.trim()) ? null : "Enter the foreign tax ID as it appears on your tax documents.";
  const d = digitsOnly(raw);
  if (d.length !== 9) return "A US tax ID has nine digits.";
  if (kind === "itin" && d[0] !== "9") return "An ITIN starts with 9.";
  if (kind === "ssn" && (d.startsWith("000") || d.startsWith("666") || d[0] === "9" || d.slice(3, 5) === "00" || d.slice(5) === "0000")) return "That isn't a valid Social Security number.";
  if (kind === "ein" && (d.startsWith("00") || /^(07|08|09|17|18|19|28|29|49|69|70|78|79|89|96|97)/.test(d))) return "That isn't a valid EIN.";
  return null;
}

/** What is kept in the clear: the last four characters. */
export const last4Of = (raw: string, kind: "ssn" | "ein" | "itin" | "foreign_tin") => (kind === "foreign_tin" ? raw.replace(/[^A-Za-z0-9]/g, "").slice(-4) : digitsOnly(raw).slice(-4));
/** What is encrypted: US IDs as nine digits, a foreign ID as typed (trimmed). */
export const tinToSeal = (raw: string, kind: "ssn" | "ein" | "itin" | "foreign_tin") => (kind === "foreign_tin" ? raw.trim() : digitsOnly(raw));

export interface FormRow {
  id: string;
  form_type: TaxFormType;
  status: "valid" | "rejected" | "superseded";
  expiry_date: string | null;
  created_at?: string;
}

export interface GateState {
  allowed: boolean;
  state: "valid" | "missing" | "expired" | "rejected";
  code?: GateCode;
  formType: TaxFormType | null;
  expiry: string | null;
}

/** The gate: a valid, unexpired form, or the reason there isn't one. Mirrors broker_tax_form_state in the database. */
export function gateStateFromForms(forms: FormRow[], today: string): GateState {
  const valid = forms.find((f) => f.status === "valid");
  if (valid) {
    if (valid.expiry_date && valid.expiry_date.slice(0, 10) < today) return { allowed: false, state: "expired", code: "tax_form_expired", formType: valid.form_type, expiry: valid.expiry_date.slice(0, 10) };
    return { allowed: true, state: "valid", formType: valid.form_type, expiry: valid.expiry_date?.slice(0, 10) ?? null };
  }
  const rejected = forms.filter((f) => f.status === "rejected").sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0];
  if (rejected) return { allowed: false, state: "rejected", code: "tax_form_rejected", formType: rejected.form_type, expiry: null };
  return { allowed: false, state: "missing", code: "tax_form_missing", formType: null, expiry: null };
}

/** The message shown where a payout is refused. */
export function gateMessage(code: GateCode, expiry?: string | null): string {
  if (code === "tax_form_expired") return `Tax form expired${expiry ? ` on ${expiry}` : ""}: the Broker of Record must submit a new one before any payout is released.`;
  if (code === "tax_form_rejected") return "Tax form rejected: the Broker of Record must submit a corrected one before any payout is released.";
  return `${TAX_FORM_MISSING_REASON}: no payout is released to a Broker of Record until a valid W-9 (or W-8BEN / W-8BEN-E for a non-US broker) is on file.`;
}

// ---------------------------------------------------------------------------------------------------------
// Influencers: paid directly, never through a Broker of Record
// ---------------------------------------------------------------------------------------------------------
/** A payee paid this much or more in a calendar year is a 1099-NEC payee: $600.00. */
export const INFLUENCER_THRESHOLD_CENTS = 60_000;
export type InfluencerTreatment = "1099_nec" | "w8_flag_for_cpa" | "below_threshold";

export const TREATMENT_LABELS: Record<InfluencerTreatment, string> = {
  "1099_nec": "1099-NEC",
  w8_flag_for_cpa: "Non-US payee: no 1099-NEC, flagged for the CPA",
  below_threshold: "Below $600",
};

/** ASSUMPTION (flagged on the launch readiness page): the platform records and exports the data. It does not file with the IRS. */
export const INFLUENCER_FILING_ASSUMPTION =
  "ASSUMPTION: divieight records influencer payments and exports the 1099-NEC data, but does not file with the IRS or send forms to payees. The CPA or a filing service does that from the export.";
