/**
 * Documented authority (server side). The grantor signs the grant as themselves (typed full name,
 * checked against their own full_name); the grantee is emailed. Every action taken under a grant
 * records who acted, for whom and under which grant, writes to the audit log, and emails the grantor.
 * Authority can be revoked; after that nothing new can use it and past records stay as they were.
 */
import { requireActingMember, type RequestContext } from "@/lib/account-members.server";
import { deliver } from "@/lib/authorization.notify.server";
import { sha256 } from "@/lib/entity-genesis-stage2.server";
import {
  AUTHORITY_SCOPES,
  AUTHORITY_SCOPE_LABELS,
  NEVER_DELEGATED,
  authorityGrantText,
  authorityRefusal,
  isAuthorityScope,
  type AuthorityGrantView,
  type AuthorityScope,
  type AuthorityUse,
} from "@/lib/member-authority";
import { assertTypedSignature } from "@/lib/signature-check";

type Db = { from: (t: string) => any };

const TABLE = "member_authority_grants";
const MISSING_SCHEMA = "Database is missing the authority tables — run signature-authority.sql in Supabase.";

// ---------------------------------------------------------------------------
// What can never be delegated
// ---------------------------------------------------------------------------

function assertGrantableScopes(scope: unknown): AuthorityScope[] {
  const list = Array.isArray(scope) ? scope.map(String) : [];
  if (list.length === 0) throw new Error("Choose what the authority covers.");
  for (const s of list) {
    const never = NEVER_DELEGATED.find((n) => n.key === s);
    if (never) throw new Error(authorityRefusal(never.label));
    if (!isAuthorityScope(s)) throw new Error(`"${s}" isn't something authority can cover. It can cover: ${AUTHORITY_SCOPES.join(", ")}.`);
  }
  return [...new Set(list)] as AuthorityScope[];
}

// ---------------------------------------------------------------------------
// Grant, revoke, list
// ---------------------------------------------------------------------------

async function memberRow(db: Db, id: string) {
  const { data } = await db.from("account_members").select("id, buyer_account_id, full_name, email, role, status").eq("id", id).maybeSingle();
  return data as { id: string; buyer_account_id: string; full_name: string | null; email: string | null; role: string; status: string } | null;
}

const nameOf = (m: { full_name: string | null; role: string }) => m.full_name?.trim() || (m.role === "primary" ? "the account holder" : "the second member");

async function notifyMember(db: Db, member: { email: string | null }, subject: string, message: string) {
  if (!member.email) return false;
  try {
    const r = await deliver(db as never, { authUserId: null, email: member.email }, { subject, message, link: "/buyer/dashboard", type: "authorization" });
    return Boolean(r?.emailed);
  } catch {
    return false;
  }
}

export async function grantAuthority(
  db: Db,
  params: { userId: string; actingMemberId: string; granteeMemberId: string; scope: unknown; typedName: string; request: RequestContext },
): Promise<{ grant: AuthorityGrantView; granteeEmailed: boolean }> {
  const scope = assertGrantableScopes(params.scope);
  // The grantor signs as themselves: the acting member, through the picker.
  const { account, member: grantor } = await requireActingMember(db, params.userId, params.actingMemberId);
  assertTypedSignature({ typed: params.typedName, fullName: grantor.full_name });
  const grantee = await memberRow(db, params.granteeMemberId);
  if (!grantee || grantee.buyer_account_id !== account.id || grantee.status !== "active") throw new Error("That member isn't on your account.");
  if (grantee.id === grantor.id) throw new Error("You can't give yourself authority.");

  // One live grant per pair (the database enforces it too): to change what it covers, revoke and grant again.
  const { data: live } = await db.from(TABLE).select("id").eq("grantor_member_id", grantor.id).eq("grantee_member_id", grantee.id).is("revoked_at", null);
  if (((live ?? []) as unknown[]).length > 0) throw new Error("There is already live authority between these two members. Revoke it first to change it.");

  const text = authorityGrantText(grantor.full_name ?? "", grantee.full_name ?? "", scope);
  const hash = sha256(text);
  const { data, error } = await db
    .from(TABLE)
    .insert({
      buyer_account_id: account.id,
      grantor_member_id: grantor.id,
      grantee_member_id: grantee.id,
      scope,
      granted_at: new Date().toISOString(),
      revoked_at: null,
      grantor_typed_name: params.typedName.trim(),
      document_hash: hash,
      ip: params.request.ip,
      user_agent: params.request.userAgent,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") throw new Error("There is already live authority between these two members. Revoke it first to change it.");
    throw new Error(error.message?.includes(TABLE) ? MISSING_SCHEMA : error.message || MISSING_SCHEMA);
  }
  const grant = data as AuthorityGrantView;
  await db.from("audit_log").insert({
    actor_id: params.userId,
    actor_type: "buyer",
    action_type: "authority.granted",
    entity_type: "buyer_account",
    entity_id: account.id,
    metadata: { authority_grant_id: grant.id, grantor_member_id: grantor.id, grantee_member_id: grantee.id, acted_by_member_id: grantor.id, scope, document_hash: hash, ip_address: params.request.ip, user_agent: params.request.userAgent },
  });
  const granteeEmailed = await notifyMember(
    db,
    grantee,
    `${nameOf(grantor)} has given you authority to act for them`,
    `${nameOf(grantor)} signed documented authority for you on your shared divieight Buyer Account. It covers: ${scope.map((s) => AUTHORITY_SCOPE_LABELS[s]).join("; ")}. It never covers the Eligibility Declaration, ID scan, liveness check, account linking consent, Hold Harmless or W-9. ${nameOf(grantor)} can revoke it at any time.`,
  );
  return { grant, granteeEmailed };
}

/** Only the grantor revokes. Afterwards nothing new can use it; what was signed under it stays. */
export async function revokeAuthority(db: Db, params: { userId: string; actingMemberId: string; grantId: string; request: RequestContext }) {
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);
  const { data: g } = await db.from(TABLE).select("*").eq("id", params.grantId).maybeSingle();
  const grant = g as AuthorityGrantView & { buyer_account_id: string } | null;
  if (!grant || grant.buyer_account_id !== account.id) throw new Error("That authority isn't on your account.");
  if (grant.grantor_member_id !== member.id) throw new Error("Only the member who gave the authority can revoke it.");
  if (grant.revoked_at) throw new Error("That authority was already revoked.");
  const at = new Date().toISOString();
  const { error } = await db.from(TABLE).update({ revoked_at: at }).eq("id", grant.id).is("revoked_at", null);
  if (error) throw new Error(MISSING_SCHEMA);
  await db.from("audit_log").insert({
    actor_id: params.userId,
    actor_type: "buyer",
    action_type: "authority.revoked",
    entity_type: "buyer_account",
    entity_id: account.id,
    metadata: { authority_grant_id: grant.id, grantor_member_id: grant.grantor_member_id, grantee_member_id: grant.grantee_member_id, acted_by_member_id: member.id, revoked_at: at, ip_address: params.request.ip },
  });
  const grantee = await memberRow(db, grant.grantee_member_id);
  if (grantee) await notifyMember(db, grantee, `${nameOf(member)} has revoked your authority`, `${nameOf(member)} revoked the authority they gave you. You can no longer act for them. Anything already signed under it stays on record.`);
  return { revokedAt: at };
}

/** The grants this member gave or received (own account only). */
export async function listMyGrants(db: Db, params: { userId: string; actingMemberId: string }) {
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);
  const { data, error } = await db.from(TABLE).select("*").eq("buyer_account_id", account.id);
  if (error) throw new Error(MISSING_SCHEMA);
  const others = ((await db.from("account_members").select("id, full_name, role, status").eq("buyer_account_id", account.id)).data ?? []) as Array<{ id: string; full_name: string | null; role: string; status: string }>;
  const label = (id: string) => nameOf(others.find((o) => o.id === id) ?? { full_name: null, role: "member" });
  const grants = ((data ?? []) as AuthorityGrantView[])
    .filter((g) => g.grantor_member_id === member.id || g.grantee_member_id === member.id)
    .map((g) => ({ ...g, grantorName: label(g.grantor_member_id), granteeName: label(g.grantee_member_id), gaveIt: g.grantor_member_id === member.id }));
  return { memberId: member.id, grants, otherMembers: others.filter((o) => o.id !== member.id && o.status === "active").map((o) => ({ id: o.id, name: nameOf(o) })) };
}

// ---------------------------------------------------------------------------
// Using authority
// ---------------------------------------------------------------------------

/**
 * Finds the live grant that lets `actingMemberId` act for `onBehalfOfMemberId` on `scope`, or refuses.
 * This is the only place an on-behalf action learns whether it is allowed.
 */
export async function resolveAuthority(db: Db, params: { accountId: string; actingMemberId: string; onBehalfOfMemberId: string; scope: AuthorityScope }): Promise<AuthorityUse & { grant: AuthorityGrantView }> {
  if (!isAuthorityScope(params.scope)) throw new Error("Authority can't cover that.");
  if (params.onBehalfOfMemberId === params.actingMemberId) throw new Error("You are acting as yourself; no authority is needed.");
  const grantor = await memberRow(db, params.onBehalfOfMemberId);
  if (!grantor || grantor.buyer_account_id !== params.accountId || grantor.status !== "active") throw new Error("That member isn't on your account.");
  const { data, error } = await db
    .from(TABLE)
    .select("*")
    .eq("buyer_account_id", params.accountId)
    .eq("grantor_member_id", params.onBehalfOfMemberId)
    .eq("grantee_member_id", params.actingMemberId)
    .is("revoked_at", null);
  if (error) throw new Error(MISSING_SCHEMA);
  const grant = ((data ?? []) as AuthorityGrantView[]).find((g) => g.scope.includes(params.scope));
  if (!grant) {
    throw new Error(`${nameOf(grantor)} hasn't given you live authority for ${AUTHORITY_SCOPE_LABELS[params.scope]}. They can give it from Delegate authority on the dashboard.`);
  }
  return { grant, actedByMemberId: params.actingMemberId, onBehalfOfMemberId: params.onBehalfOfMemberId, authorityGrantId: grant.id };
}

/** After an action under authority: the audit log (the Audit Vault) and an email to the grantor. */
export async function recordAuthorityUse(
  db: Db,
  params: { userId: string; accountId: string; use: AuthorityUse; scope: AuthorityScope; what: string; record: { table: string; id: string | null }; request: RequestContext },
) {
  await db.from("audit_log").insert({
    actor_id: params.userId,
    actor_type: "buyer",
    action_type: "authority.used",
    entity_type: "buyer_account",
    entity_id: params.accountId,
    metadata: {
      acted_by_member_id: params.use.actedByMemberId,
      on_behalf_of_member_id: params.use.onBehalfOfMemberId,
      authority_grant_id: params.use.authorityGrantId,
      scope: params.scope,
      what: params.what,
      record_table: params.record.table,
      record_id: params.record.id,
      ip_address: params.request.ip,
      user_agent: params.request.userAgent,
    },
  });
  const [actor, grantor] = await Promise.all([memberRow(db, params.use.actedByMemberId), memberRow(db, params.use.onBehalfOfMemberId)]);
  if (grantor)
    await notifyMember(
      db,
      grantor,
      `${actor ? nameOf(actor) : "A member"} acted for you: ${params.what}`,
      `${actor ? nameOf(actor) : "Another member"} used the authority you gave them to act for you: ${params.what}. This is recorded with the authority grant and the time. You can revoke their authority at any time from Delegate authority on your dashboard.`,
    );
}
