/**
 * Member-level onboarding steps (server side): Block 1 (Plaid consent) and Block 2 (LPOA) per
 * member, the account-level Plaid link with combined assets, and the per-member typed-name
 * signatures for the PRA and the Hold Harmless. Every write names the acting member and touches
 * only that member's own records.
 */
import { BLOCK1_VERSION, BLOCK2_VERSION, block1ConsentText, block2AuthorizationText } from "@/constants/authorizationsCopy";
import { requireActingMember, type RequestContext } from "@/lib/account-members.server";
import { legalNamesMatch } from "@/lib/eligibility-declaration";
import { sha256 } from "@/lib/entity-genesis-stage2.server";
import { PLAID_SANDBOX, meetsLiquidityThreshold, sandboxBalanceFor, totalAvailableBalance, type PlaidAccountBalance } from "@/lib/liquidity";

type Db = { from: (t: string) => any };

const MISSING_SCHEMA = "Database is missing the member step tables — run member-steps.sql in Supabase.";
export const SIGNATURE_MISMATCH = "The signature must be this member's full legal name, exactly as it is on their account.";

const nameOf = (m: { full_name: string | null; role: string }) => m.full_name?.trim() || (m.role === "primary" ? "the account holder" : "the second member");

async function activeMembers(db: Db, accountId: string) {
  const { data } = await db.from("account_members").select("id, full_name, role").eq("buyer_account_id", accountId).eq("status", "active");
  return (data ?? []) as Array<{ id: string; full_name: string | null; role: string }>;
}

async function audit(db: Db, userId: string, action: string, accountId: string, metadata: Record<string, unknown>) {
  await db.from("audit_log").insert({ actor_id: userId, actor_type: "buyer", action_type: action, entity_type: "buyer_account", entity_id: accountId, metadata });
}

// ---------------------------------------------------------------------------
// Blocks 1 and 2: one acceptance per member per version
// ---------------------------------------------------------------------------

const BLOCKS = {
  block1: { table: "member_plaid_consents", version: BLOCK1_VERSION, text: block1ConsentText, action: "buyer.plaid_consent_given" },
  block2: { table: "member_block2_authorizations", version: BLOCK2_VERSION, text: block2AuthorizationText, action: "buyer.block2_lpoa_accepted" },
} as const;
export type AuthorizationBlock = keyof typeof BLOCKS;

export async function acceptAuthorization(db: Db, params: { userId: string; actingMemberId: string; block: AuthorizationBlock; request: RequestContext }) {
  const spec = BLOCKS[params.block];
  if (!spec) throw new Error("Unknown authorization");
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);
  const { data: existing, error: readError } = await db.from(spec.table).select("id, accepted_at").eq("account_member_id", member.id).eq("text_version", spec.version).maybeSingle();
  if (readError) throw new Error(MISSING_SCHEMA);
  if (existing) return { acceptedAt: (existing as { accepted_at: string }).accepted_at, waitingOn: await waitingOnBlock(db, account.id, params.block) };
  const acceptedAt = new Date().toISOString();
  const hash = sha256(spec.text);
  const { error } = await db.from(spec.table).insert({
    account_member_id: member.id,
    buyer_account_id: account.id,
    text_version: spec.version,
    text_hash: hash,
    accepted_at: acceptedAt,
    ip: params.request.ip,
    user_agent: params.request.userAgent,
  });
  if (error && error.code !== "23505") throw new Error(MISSING_SCHEMA);
  // Kept for the account-level code that reads it: set once every active member has consented.
  const waitingOn = await waitingOnBlock(db, account.id, params.block);
  if (params.block === "block1" && waitingOn.length === 0) await db.from("buyer_accounts").update({ plaid_consent_at: acceptedAt }).eq("id", account.id).is("plaid_consent_at", null);
  await audit(db, params.userId, spec.action, account.id, { account_member_id: member.id, acted_by_member_id: member.id, text_version: spec.version, text_hash: hash, ip_address: params.request.ip, user_agent: params.request.userAgent });
  return { acceptedAt, waitingOn };
}

/** Names of active members who haven't accepted this block yet. */
export async function waitingOnBlock(db: Db, accountId: string, block: AuthorizationBlock): Promise<string[]> {
  const spec = BLOCKS[block];
  const members = await activeMembers(db, accountId);
  const { data } = await db.from(spec.table).select("account_member_id").eq("buyer_account_id", accountId).eq("text_version", spec.version);
  const done = new Set(((data ?? []) as Array<{ account_member_id: string }>).map((r) => r.account_member_id));
  return members.filter((m) => !done.has(m.id)).map(nameOf);
}

export async function authorizationState(db: Db, params: { userId: string; actingMemberId: string }) {
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);
  const out: Record<AuthorizationBlock, { acceptedAt: string | null; waitingOn: string[] }> = { block1: { acceptedAt: null, waitingOn: [] }, block2: { acceptedAt: null, waitingOn: [] } };
  for (const block of Object.keys(BLOCKS) as AuthorizationBlock[]) {
    const { data } = await db.from(BLOCKS[block].table).select("accepted_at").eq("account_member_id", member.id).eq("text_version", BLOCKS[block].version).maybeSingle();
    out[block] = { acceptedAt: (data as { accepted_at: string } | null)?.accepted_at ?? null, waitingOn: await waitingOnBlock(db, account.id, block) };
  }
  return out;
}

/** Entity Genesis Stage 2 gate: every active member of every buyer account given has accepted Block 2. */
export async function block2MissingFor(db: Db, accountIds: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const id of accountIds) missing.push(...(await waitingOnBlock(db, id, "block2")));
  return missing;
}

// ---------------------------------------------------------------------------
// The Plaid link: account-level, either member, assets combined
// ---------------------------------------------------------------------------

/** The account's combined available assets across every linked account, whoever linked it. */
export function combinedAvailable(links: Array<{ balances: PlaidAccountBalance[] }>): number {
  return links.reduce((sum, l) => sum + totalAvailableBalance(l.balances), 0);
}

/** Whether the account's combined assets across every link meet the liquidity threshold for its budget. */
export function combinedLiquidityPasses(links: Array<{ balances: PlaidAccountBalance[] }>, budget: number | null): boolean {
  return meetsLiquidityThreshold(links.flatMap((l) => l.balances ?? []), budget);
}

/**
 * Records one Plaid link for the account (simulated sandbox balances) and re-runs the liquidity
 * check on the combined total. Allowed only once every active member has given Block 1 consent.
 * Balances are kept server-side only; nobody but this check ever sees a figure.
 */
export async function recordPlaidLink(db: Db, params: { userId: string; actingMemberId: string; request: RequestContext }) {
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);
  const waiting = await waitingOnBlock(db, account.id, "block1");
  if (waiting.length) throw new Error(`Every member must consent to account linking first. Waiting on: ${waiting.join(" and ")}.`);
  const { data: acct } = await db.from("buyer_accounts").select("id, target_budget").eq("id", account.id).maybeSingle();
  const budget = (acct as { target_budget: number | null } | null)?.target_budget ?? null;
  const balances = sandboxBalanceFor(budget);
  const { error } = await db.from("account_liquidity_links").insert({ buyer_account_id: account.id, linked_by_member_id: member.id, institution: PLAID_SANDBOX.institution, balances, linked_at: new Date().toISOString() });
  if (error) throw new Error(MISSING_SCHEMA);
  const { data: links } = await db.from("account_liquidity_links").select("balances").eq("buyer_account_id", account.id);
  const passed = combinedLiquidityPasses((links ?? []) as Array<{ balances: PlaidAccountBalance[] }>, budget);
  const now = new Date().toISOString();
  await db
    .from("buyer_accounts")
    .update({
      liquidity_verified: passed,
      liquidity_verified_at: passed ? now : null,
      liquidity_status: passed ? "verified" : "insufficient",
      liquidity_institution: PLAID_SANDBOX.institution,
      last_activity_at: now,
      stall_warning_sent_at: null,
      onboarding_status: passed ? "golden_ticket_pending" : "liquidity_pending",
    })
    .eq("id", account.id);
  // Binary outcome only: no balance, total or threshold figure in the audit trail.
  await audit(db, params.userId, passed ? "buyer.liquidity_verified" : "buyer.liquidity_insufficient", account.id, { institution: PLAID_SANDBOX.institution, result: passed ? "verified" : "insufficient", linked_by_member_id: member.id, links: ((links ?? []) as unknown[]).length, simulated: true });
  return { passed };
}

// ---------------------------------------------------------------------------
// Per-member signatures: the PRA and the Hold Harmless
// ---------------------------------------------------------------------------

export type MemberDocument = "PRA" | "HOLD_HARMLESS";

/**
 * Whether one member may sign a document on another's behalf. Always false until the
 * member_authority_grants table is added by the authority prompt (M4).
 */
export function canSignOnBehalf(_grantorMemberId: string, _granteeMemberId: string, _document: "pra" | "hold_harmless"): boolean {
  return false;
}

export async function signMemberDocument(
  db: Db,
  params: { userId: string; actingMemberId: string; documentType: MemberDocument; documentVersion: string; documentHash: string; typedName: string; request: RequestContext },
): Promise<{ id: string; waitingOn: string[] }> {
  if (params.documentType !== "PRA" && params.documentType !== "HOLD_HARMLESS") throw new Error("Unknown document");
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);
  const typed = params.typedName.trim();
  if (!legalNamesMatch(typed, member.full_name ?? "")) throw new Error(SIGNATURE_MISMATCH);
  const { data: existing } = await db.from("signed_documents").select("id").eq("buyer_account_id", account.id).eq("document_type", params.documentType).eq("account_member_id", member.id).limit(1);
  let id = ((existing ?? []) as Array<{ id: string }>)[0]?.id ?? null;
  if (!id) {
    const { data, error } = await db
      .from("signed_documents")
      .insert({ buyer_account_id: account.id, account_member_id: member.id, document_type: params.documentType, document_version: params.documentVersion, signed_name: typed, document_hash: params.documentHash, ip_address: params.request.ip })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    id = (data as { id: string }).id;
    await audit(db, params.userId, params.documentType === "PRA" ? "buyer.pra_signed" : "buyer.hold_harmless_signed", account.id, {
      document_hash: params.documentHash,
      document_version: params.documentVersion,
      account_member_id: member.id,
      acted_by_member_id: member.id,
      ip_address: params.request.ip,
      user_agent: params.request.userAgent,
    });
  }
  const waitingOn = await waitingOnSignature(db, account.id, params.documentType);
  if (params.documentType === "PRA" && waitingOn.length === 0) {
    // The PRA is executed once every member has signed: the account moves on to vetting.
    await db.from("buyer_accounts").update({ onboarding_status: "vetting_pending", last_activity_at: new Date().toISOString(), stall_warning_sent_at: null }).eq("id", account.id).eq("onboarding_status", "payment_pending");
  }
  return { id, waitingOn };
}

export async function waitingOnSignature(db: Db, accountId: string, documentType: MemberDocument): Promise<string[]> {
  const members = await activeMembers(db, accountId);
  const { data } = await db.from("signed_documents").select("account_member_id").eq("buyer_account_id", accountId).eq("document_type", documentType);
  const signed = new Set(((data ?? []) as Array<{ account_member_id: string | null }>).map((r) => r.account_member_id));
  return members.filter((m) => !signed.has(m.id)).map(nameOf);
}

export async function signatureState(db: Db, params: { userId: string; actingMemberId: string; documentType: MemberDocument }) {
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);
  const { data } = await db.from("signed_documents").select("id").eq("buyer_account_id", account.id).eq("document_type", params.documentType).eq("account_member_id", member.id).limit(1);
  return { signed: ((data ?? []) as unknown[]).length > 0, memberName: member.full_name ?? "", waitingOn: await waitingOnSignature(db, account.id, params.documentType) };
}
