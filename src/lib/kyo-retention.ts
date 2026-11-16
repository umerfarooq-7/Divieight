/**
 * Know Your Owner retention: the rules, with no database. Which class a record is in, when its retention ends, and what a request to delete it gets.
 *
 * ASSUMPTION (flagged on the launch readiness page): these periods and this wording are pending compliance review.
 *   active_property  tied to an LLC: kept for the life of the LLC, then 7 years after it dissolves
 *   archived         the account ended: kept 7 years from the day it was archived
 *   in_use           not ended and not tied to a property: no clock yet
 */

export const RETENTION_YEARS = 7;
export const REVIEW_AGAIN_AFTER_DAYS = 365;

export type RetentionClass = "in_use" | "active_property" | "archived";
export type ArchiveReason = "not_eligible" | "withdrawn" | "rejected" | "abandoned" | "member_removed" | "login_deleted";
export type RetentionStatus = "in_use" | "retained" | "past_retention" | "erased";

export const CLASS_LABELS: Record<RetentionClass, string> = { in_use: "In use (no clock yet)", active_property: "Active property", archived: "Archived" };
export const REASON_LABELS: Record<ArchiveReason, string> = {
  not_eligible: "Not eligible",
  withdrawn: "Withdrawn",
  rejected: "Rejected",
  abandoned: "Abandoned",
  member_removed: "Member removed",
  login_deleted: "Login deleted",
};
export const STATUS_LABELS: Record<RetentionStatus, string> = { in_use: "In use", retained: "Retained", past_retention: "Past retention", erased: "Erased" };

export const RETENTION_ASSUMPTION =
  "ASSUMPTION: the Know Your Owner retention periods (the life of the LLC plus 7 years after dissolution for active-property data; 7 years from archival for archived accounts) and the wording of the deletion answers are pending compliance review. The platform never deletes anything on its own: a founder approves each erasure, with a reason, and a legal hold blocks it.";

// ---------------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------------
/** YYYY-MM-DD plus whole years (29 February lands on 28 February in a common year). */
export function addYears(day: string, years: number): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  const month = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  if (d.getUTCMonth() !== month) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
export const addDays = (day: string, days: number) => new Date(new Date(`${day.slice(0, 10)}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
export const dayOf = (iso: string | Date) => (typeof iso === "string" ? iso.slice(0, 10) : iso.toISOString().slice(0, 10));

/** 7 years from the day an account was archived. */
export const retainUntilArchived = (archivedAt: string) => addYears(dayOf(archivedAt), RETENTION_YEARS);

/** The life of the LLC plus 7 years after dissolution. Empty while any LLC the record is tied to is alive: the period has not started, and it is never guessed. */
export function retainUntilForLlcs(llcs: Array<{ dissolvedAt: string | null }>): string | null {
  if (llcs.length === 0) return null;
  if (llcs.some((l) => !l.dissolvedAt)) return null;
  const last = llcs.map((l) => dayOf(l.dissolvedAt!)).sort().at(-1)!;
  return addYears(last, RETENTION_YEARS);
}

// ---------------------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------------------
export interface Llc {
  propertyId: string;
  dissolvedAt: string | null;
}
export interface Classification {
  retentionClass: RetentionClass;
  archiveReason: ArchiveReason | null;
  archivedAt: string | null;
  retainUntil: string | null;
  basis: string;
}

export interface MemberFacts {
  /** The member was removed from the account. */
  removed: boolean;
  removedAt: string | null;
  /** The LLCs this member's account holds, or held, shares in. */
  accountLlcs: Llc[];
  /** The LLCs whose documents this member signed. */
  signedLlcs: Llc[];
  /** Why and when the whole account ended, if it did (not eligible, withdrawn, abandoned, login deleted). */
  accountEnd: { reason: ArchiveReason; at: string | null } | null;
}

/**
 * Order matters. A removed member is archived (7 years from removal), and kept longer only if they signed an LLC's documents. Anyone else tied to an LLC is under the
 * active-property rule whatever else has happened to the account (an owner whose login was deleted is still an owner). Only then does an ended account archive.
 */
export function classifyMember(f: MemberFacts, now: string): Classification {
  if (f.removed) {
    const at = f.removedAt ?? now;
    const own = retainUntilArchived(at);
    if (f.signedLlcs.length === 0) return { retentionClass: "archived", archiveReason: "member_removed", archivedAt: at, retainUntil: own, basis: "Removed member: 7 years from removal" };
    const llc = retainUntilForLlcs(f.signedLlcs);
    if (llc === null) return { retentionClass: "archived", archiveReason: "member_removed", archivedAt: at, retainUntil: null, basis: "Removed member who signed the documents of a living LLC: kept for the life of the LLC, then 7 years" };
    return { retentionClass: "archived", archiveReason: "member_removed", archivedAt: at, retainUntil: llc > own ? llc : own, basis: "Removed member: the later of 7 years from removal and 7 years after the LLC they signed for dissolved" };
  }
  if (f.accountLlcs.length > 0) {
    const until = retainUntilForLlcs(f.accountLlcs);
    return { retentionClass: "active_property", archiveReason: null, archivedAt: null, retainUntil: until, basis: until ? "LLC dissolved: 7 years after dissolution" : "Tied to a living LLC: kept for the life of the LLC, then 7 years" };
  }
  if (f.accountEnd) {
    const at = f.accountEnd.at ?? now;
    return { retentionClass: "archived", archiveReason: f.accountEnd.reason, archivedAt: at, retainUntil: retainUntilArchived(at), basis: "Archived account: 7 years from archival" };
  }
  return { retentionClass: "in_use", archiveReason: null, archivedAt: null, retainUntil: null, basis: "Account in use: no retention clock yet" };
}

export interface SellerFacts {
  /** The LLCs this seller's listings became (a seller who sold all eight shares is still tied to the LLC). */
  llcs: Llc[];
  ended: { reason: ArchiveReason; at: string | null } | null;
}
export function classifySeller(f: SellerFacts, now: string): Classification {
  if (f.llcs.length > 0) {
    const until = retainUntilForLlcs(f.llcs);
    return { retentionClass: "active_property", archiveReason: null, archivedAt: null, retainUntil: until, basis: until ? "LLC dissolved: 7 years after dissolution" : "Seller of a property whose LLC is alive: kept for the life of the LLC, then 7 years" };
  }
  if (f.ended) {
    const at = f.ended.at ?? now;
    return { retentionClass: "archived", archiveReason: f.ended.reason, archivedAt: at, retainUntil: retainUntilArchived(at), basis: "Archived account: 7 years from archival" };
  }
  return { retentionClass: "in_use", archiveReason: null, archivedAt: null, retainUntil: null, basis: "Account in use: no retention clock yet" };
}

export function statusFor(c: Pick<Classification, "retentionClass" | "retainUntil">, today: string, erased = false): RetentionStatus {
  if (erased) return "erased";
  if (c.retentionClass === "in_use") return "in_use";
  if (c.retainUntil === null) return "retained";
  return today > c.retainUntil ? "past_retention" : "retained";
}

// ---------------------------------------------------------------------------------------------------------
// A request to delete
// ---------------------------------------------------------------------------------------------------------
export type DeletionCode = "inside_retention" | "legal_hold" | "account_active";
export interface DeletionDecision {
  outcome: "declined" | "queued";
  code: DeletionCode | null;
  /** The reason as recorded. Plain, and safe to show the member. */
  reason: string;
}

/** A request inside the retention period, under a legal hold, or from an account still in use is declined, with the reason. Past the period it goes to a founder. */
export function deletionDecision(rec: { retentionClass: RetentionClass; retainUntil: string | null; legalHold: boolean }, today: string): DeletionDecision {
  if (rec.legalHold) return { outcome: "declined", code: "legal_hold", reason: "This record is under a legal hold, so it cannot be deleted while the hold lasts." };
  if (rec.retentionClass === "in_use") {
    return { outcome: "declined", code: "account_active", reason: "Your account is still active, so there is nothing to delete yet. If you withdraw, your data is kept for 7 years from then, as required, and is deleted after that." };
  }
  if (rec.retainUntil === null) {
    return { outcome: "declined", code: "inside_retention", reason: "This record is tied to an LLC that has not dissolved. Records are kept for the life of the LLC and for 7 years after it dissolves." };
  }
  if (today <= rec.retainUntil) return { outcome: "declined", code: "inside_retention", reason: `Inside the retention period: this record is kept until ${rec.retainUntil}, and can be deleted after that date.` };
  return { outcome: "queued", code: null, reason: "Past the retention period. A request to delete has gone to the founder for a decision." };
}

/** The personal data that sits under each KYO record, by the sub-vault item it belongs to (what retention_erase() anonymizes or removes). */
export const KYO_ITEM_KINDS = [
  { kind: "kyo_record", label: "The KYO record (name, date of birth, address, ID number, contact details)", table: "account_members", key: "id", subject: "account_member" },
  { kind: "identity_document", label: "The government ID image", table: "account_members", key: "id", subject: "account_member", storage: "identity-documents" },
  { kind: "liveness_selfie", label: "The liveness selfie", table: "member_liveness_checks", key: "account_member_id", subject: "account_member", storage: "liveness-selfies" },
  { kind: "w9", label: "The W-9 details", table: "member_w9", key: "account_member_id", subject: "account_member" },
  // The encrypted value is filed with the W-9 (one for one), so it is counted from the W-9 rows: client-safe code never names the encrypted table.
  { kind: "w9_encrypted_value", label: "The encrypted taxpayer identification number", table: "member_w9", key: "account_member_id", subject: "account_member" },
  { kind: "eligibility_declaration", label: "The eligibility declaration answers", table: "eligibility_declarations", key: "account_member_id", subject: "account_member" },
  { kind: "sanctions_screening", label: "Sanctions screening names", table: "member_sanctions_screenings", key: "account_member_id", subject: "account_member" },
  { kind: "correction_requests", label: "Correction requests", table: "kyo_correction_requests", key: "account_member_id", subject: "account_member" },
  { kind: "seller_record", label: "The seller record", table: "sellers", key: "id", subject: "seller" },
  { kind: "seller_identity_document", label: "The seller's ID image", table: "sellers", key: "id", subject: "seller", storage: "identity-documents" },
  { kind: "seller_eligibility_declaration", label: "The seller's eligibility declaration answers", table: "seller_eligibility_declarations", key: "seller_id", subject: "seller" },
] as const;
export type KyoItemKind = (typeof KYO_ITEM_KINDS)[number]["kind"];

/** What retention never touches: executed legal documents (kept for the life of the LLC under their own rules), the Audit Vault (append-only by design) and the ledger. */
export const RETENTION_EXCLUSIONS = [
  "Executed documents (the Operating Agreement signatures, the PRA, the Listing Agreement): kept as signed, for the life of the LLC and after.",
  "The Audit Vault: append-only. An erasure is logged there with counts and dates, never with the erased data.",
  "The books and ledgers, tax records and payment records: kept under their own tax-law periods.",
];
