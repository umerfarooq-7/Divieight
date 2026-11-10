/**
 * Documented authority (shared, no server imports). One Account Member can grant another the
 * authority to act for them on a short list of documents. Grants are signed by the grantor, kept
 * forever, and can be revoked; nothing else can ever be delegated.
 */

export const AUTHORITY_SCOPES = ["pra", "due_diligence_ack", "authorizations", "block3", "closing_docs"] as const;
export type AuthorityScope = (typeof AUTHORITY_SCOPES)[number];

export const AUTHORITY_SCOPE_LABELS: Record<AuthorityScope, string> = {
  pra: "Priority Reservation Agreement",
  due_diligence_ack: "Due-diligence acknowledgments",
  authorizations: "Buyer authorizations (offers and other actions)",
  block3: "Block 3 (lifestyle perks consent)",
  closing_docs: "Closing documents (the Operating Agreement)",
};

/** Things authority can never cover. These are not scopes, and the server rejects any attempt. */
export const NEVER_DELEGATED = [
  { key: "block4", label: "Block 4 (the Eligibility Declaration)" },
  { key: "id_scan", label: "the ID scan" },
  { key: "liveness", label: "the liveness check" },
  { key: "block1", label: "Block 1 (account linking consent)" },
  { key: "block2", label: "Block 2 (the entity formation authorization)" },
  { key: "hold_harmless", label: "the Hold Harmless" },
  { key: "w9", label: "the W-9" },
] as const;
export type NeverDelegated = (typeof NEVER_DELEGATED)[number]["key"];

export const authorityRefusal = (what: string) => `Authority can never cover ${what}. This member has to do it themselves.`;

export const isAuthorityScope = (s: unknown): s is AuthorityScope => typeof s === "string" && (AUTHORITY_SCOPES as readonly string[]).includes(s);

/** The statement the grantor signs. Its hash is stored with the grant. */
export function authorityGrantText(grantorName: string, granteeName: string, scope: readonly AuthorityScope[]): string {
  return [
    "divieight — Documented Authority",
    `I, ${grantorName}, authorize ${granteeName}, an Account Member on my Buyer Account, to act for me on the following only:`,
    ...scope.map((s) => `- ${AUTHORITY_SCOPE_LABELS[s]}`),
    "",
    "This authority never covers my Eligibility Declaration, my ID scan, my liveness check, my account linking consent, my entity formation authorization, my Hold Harmless or my W-9. I can revoke it at any time, and what was signed under it before then stays on record.",
  ].join("\n");
}

export interface AuthorityGrantView {
  id: string;
  grantor_member_id: string;
  grantee_member_id: string;
  scope: AuthorityScope[];
  granted_at: string;
  revoked_at: string | null;
  grantor_typed_name: string;
  document_hash: string;
}

export interface AuthorityUse {
  actedByMemberId: string;
  onBehalfOfMemberId: string;
  authorityGrantId: string;
}

/**
 * Called by every server function that must be done by the member themselves (Block 4, ID scan,
 * liveness, Block 1, Block 2, Hold Harmless, W-9). Any sign of an attempt to act for someone else is refused.
 */
export function rejectAuthorityAttempt(input: unknown, what: NeverDelegated): void {
  const i = (input ?? {}) as Record<string, unknown>;
  if (i.onBehalfOfMemberId || i.authorityGrantId || i.authorityBasis || i.scope) {
    throw new Error(authorityRefusal(NEVER_DELEGATED.find((n) => n.key === what)!.label));
  }
}
