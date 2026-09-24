/**
 * Due Diligence Acknowledgment Gate — shared constants and pure helpers.
 *
 * Every Required due-diligence document must carry BOTH the Account Member's
 * acknowledgment and the tethered Resident Agent's parallel acknowledgment,
 * pinned to the same `content_hash`, before any Buyer-Authorization action can
 * proceed for that Buyer Account.
 */

export const DD_CATEGORIES = [
  "sellers_disclosure",
  "inspection",
  "appraisal",
  "title_commitment",
  "operating_agreement",
  "real_estate_purchase_agreement",
  "other",
] as const;

export type DdCategory = (typeof DD_CATEGORIES)[number];

export const DD_CATEGORY_LABELS: Record<DdCategory, string> = {
  sellers_disclosure: "Seller's Disclosure",
  inspection: "Inspection report",
  appraisal: "Appraisal",
  title_commitment: "Title commitment",
  operating_agreement: "Operating Agreement",
  real_estate_purchase_agreement: "Real Estate Purchase Agreement",
  other: "Other due-diligence material",
};

/** Categories that are governing instruments by default (Rev 43). */
export const GOVERNING_CATEGORIES: DdCategory[] = [
  "operating_agreement",
  "real_estate_purchase_agreement",
  "title_commitment",
];

/** Independent-Review Notice (Rev 43) — shown above the acknowledgment control. */
export const INDEPENDENT_REVIEW_NOTICE =
  "This is a legal document with consequences personal to you. Neither divieight nor your real estate agent provides legal or tax advice. You have been advised to have your own attorney review this document before you acknowledge it.";

export const MEMBER_ACK_TEXT = "I have reviewed this document.";

export const AGENT_ACK_TEXT =
  "I confirm that I have reviewed the foregoing Due Diligence Material in connection with my representation of the Buyer Account, and have addressed my client's questions concerning this document to my professional satisfaction.";

export const AGENT_ACK_DEADLINE_DAYS = 7;

export const SECONDARY_VERIFICATION_OPTIONS = [
  { value: "typed_initials", label: "Typed initials" },
  { value: "email_on_file", label: "Email address on file" },
  { value: "phone_on_file", label: "Phone number on file" },
] as const;

export interface DdDocument {
  id: string;
  property_id: string;
  document_title: string;
  category: DdCategory;
  file_url: string;
  signed_url: string | null;
  content_hash: string;
  placed_at: string;
  required: boolean;
  superseded_by: string | null;
  is_governing_instrument: boolean;
}

export interface DdAcknowledgment {
  id: string;
  document_id: string;
  actor_role: "account_member" | "resident_agent";
  account_member_id: string | null;
  agent_id: string | null;
  signed_name: string;
  content_hash: string;
  acknowledged_at: string;
  independent_review_notice_shown_at: string | null;
}

export interface DdMember {
  id: string;
  full_name: string | null;
  role: string | null;
}

export interface DdDocumentState {
  document: DdDocument;
  /** Member ids whose acknowledgment is pinned to the current content hash. */
  memberAcked: string[];
  agentAcked: boolean;
  /** Prior acknowledgments retained in the Audit Vault but no longer current. */
  staleAcks: number;
  clear: boolean;
  agentDueAt: string;
  agentOverdue: boolean;
}

export function hashDocumentContent(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) & 0xffffffff;
  return `djb2_${(h >>> 0).toString(16)}_${input.length}`;
}

/** Content hash of an uploaded file's bytes — same djb2 scheme as text. */
export async function hashFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let h = 5381;
  for (let i = 0; i < bytes.length; i++) h = ((h << 5) + h + bytes[i]) & 0xffffffff;
  return `djb2_${(h >>> 0).toString(16)}_${bytes.length}`;
}

/** Categories an admin may place (the Seller's Disclosure is seller-only). */
export const ADMIN_DD_CATEGORIES: DdCategory[] = [
  "inspection",
  "appraisal",
  "title_commitment",
  "operating_agreement",
  "real_estate_purchase_agreement",
  "other",
];

/**
 * Governing by default when the admin hasn't overridden the toggle — the same
 * set as GOVERNING_CATEGORIES (Rev 43: OA, REPA and title commitment/exception
 * documents). Amendments are flagged with the toggle.
 */
export const AUTO_GOVERNING_CATEGORIES: DdCategory[] = GOVERNING_CATEGORIES;

/** Low-entropy, non-identifying device fingerprint captured with each ack. */
export function deviceFingerprint(): string {
  if (typeof window === "undefined") return "server";
  const parts = [
    navigator.userAgent,
    navigator.language,
    String(screen.width),
    String(screen.height),
    String(new Date().getTimezoneOffset()),
  ].join("|");
  return hashDocumentContent(parts);
}

export function agentDeadline(placedAt: string): Date {
  const d = new Date(placedAt);
  d.setDate(d.getDate() + AGENT_ACK_DEADLINE_DAYS);
  return d;
}

/** Combine documents + acknowledgments into per-document gate state. */
export function buildGateState(
  documents: DdDocument[],
  acks: DdAcknowledgment[],
  members: DdMember[],
): DdDocumentState[] {
  const now = Date.now();
  return documents.map((document) => {
    const forDoc = acks.filter((a) => a.document_id === document.id);
    const current = forDoc.filter((a) => a.content_hash === document.content_hash);
    const memberAcked = current
      .filter((a) => a.actor_role === "account_member" && a.account_member_id)
      .map((a) => a.account_member_id as string);
    const agentAcked = current.some((a) => a.actor_role === "resident_agent");
    const allMembers = members.length > 0 && members.every((m) => memberAcked.includes(m.id));
    const due = agentDeadline(document.placed_at);
    return {
      document,
      memberAcked,
      agentAcked,
      staleAcks: forDoc.length - current.length,
      clear: allMembers && agentAcked,
      agentDueAt: due.toISOString(),
      agentOverdue: !agentAcked && due.getTime() < now,
    };
  });
}

/** Required + not superseded documents are the ones that gate authorization. */
export function gatingDocuments(states: DdDocumentState[]): DdDocumentState[] {
  return states.filter((s) => s.document.required && !s.document.superseded_by);
}

export function gateClear(states: DdDocumentState[]): boolean {
  return gatingDocuments(states).every((s) => s.clear);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
