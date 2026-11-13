/** Client-safe shapes and wording for the document-access stages and Member Documents. */

export type DocKind = "pra" | "hold_harmless" | "block5" | "operating_agreement" | "listing_agreement" | "nar_referral" | "commission_authorization" | "other";

export const TITLES: Record<DocKind, string> = {
  pra: "Priority Reservation Agreement",
  hold_harmless: "Hold Harmless",
  block5: "Independent Professional Advice Acknowledgment",
  operating_agreement: "LLC Operating Agreement",
  listing_agreement: "Listing Agreement",
  nar_referral: "Standard NAR Referral Agreement",
  commission_authorization: "Commission Authorization",
  other: "Executed document",
};

export const PRE_PAYMENT_BLOCKED = "Read the Priority Reservation Agreement to the bottom and tick the acknowledgment on the Pre-Payment Review screen before paying.";

export interface ExecutedDoc {
  /** "sd:<signed document id>" or "oa:<property id>". */
  id: string;
  kind: DocKind;
  title: string;
  /** The version executed: pinned to the version in force when it was signed. */
  version: string;
  executedAt: string;
  signers: Array<{ name: string; at: string; note: string | null }>;
  /** The document hash stored with the signature. */
  hash: string | null;
  /** The Audit Vault entry that records the execution. */
  auditRef: { id: string; action: string; at: string } | null;
  copyAvailable: boolean;
  copyNote: string | null;
}

export interface ExecutedCopy {
  doc: ExecutedDoc;
  text: string;
  textSha256: string;
}

/** "AV-1a2b3c4d": the short form of an Audit Vault entry id. */
export const auditRefLabel = (id: string) => `AV-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
