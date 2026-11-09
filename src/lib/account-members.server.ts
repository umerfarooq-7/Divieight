/**
 * Account Members (server side). One login per Buyer Account; up to two people on it.
 * Every member-level write names an active member of the caller's own account, and is
 * audited with who was acting, the IP and the user agent. account-members.sql holds
 * the same limits in the database.
 */

import {
  ELIGIBILITY_LABELS,
  eligibilityOf,
  identityComplete,
  isValidEmail,
  LIMIT_MESSAGE,
  LOCKED_MESSAGE,
  MAX_ACTIVE_MEMBERS,
  normalizeEmail,
  POD_MESSAGE,
  SAME_EMAIL_MESSAGE,
  SAME_PERSON_MESSAGE,
  samePerson,
  type AccountMemberView,
} from "@/lib/account-members";

type Db = { from: (t: string) => any };

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

interface MemberRow {
  id: string;
  buyer_account_id: string;
  role: "primary" | "member";
  status: "active" | "removed";
  full_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  date_of_birth: string | null;
  id_document_number: string | null;
  vetting_status: string | null;
  fcra_consent_at: string | null;
  background_check_result: string | null;
}

interface AccountRow {
  id: string;
  email: string;
  golden_ticket_issued: boolean;
}

async function accountFor(db: Db, userId: string): Promise<AccountRow> {
  const { data } = await db.from("buyer_accounts").select("id, email, golden_ticket_issued").eq("auth_user_id", userId).maybeSingle();
  if (!data) throw new Error("No buyer account");
  return data as AccountRow;
}

async function activeMembers(db: Db, accountId: string): Promise<MemberRow[]> {
  const { data } = await db.from("account_members").select("*").eq("buyer_account_id", accountId).eq("status", "active").order("created_at", { ascending: true });
  return ((data ?? []) as MemberRow[]).sort((a, b) => Number(b.role === "primary") - Number(a.role === "primary"));
}

/** Golden Ticket issued, or the account sits on a locked cap table. */
export async function membersLocked(db: Db, account: AccountRow): Promise<boolean> {
  if (account.golden_ticket_issued) return true;
  const { data: cap } = await db.from("cap_table_entries").select("property_id").eq("buyer_account_id", account.id);
  const properties = [...new Set(((cap ?? []) as Array<{ property_id: string }>).map((c) => c.property_id))];
  if (properties.length === 0) return false;
  const { data: locked } = await db.from("entity_genesis").select("property_id, cap_table_locked_at").in("property_id", properties);
  return ((locked ?? []) as Array<{ cap_table_locked_at: string | null }>).some((g) => g.cap_table_locked_at);
}

/**
 * The server rule: the member must belong to this login's account and be active.
 * Anything else is refused, with the same message whether it exists or not.
 */
export async function requireActingMember(db: Db, userId: string, memberId: string, opts: { primary?: boolean } = {}) {
  const account = await accountFor(db, userId);
  const { data } = await db.from("account_members").select("*").eq("id", memberId).maybeSingle();
  const member = data as MemberRow | null;
  if (!member || member.buyer_account_id !== account.id || member.status !== "active") throw new Error("That member isn't on your account.");
  if (opts.primary && member.role !== "primary") throw new Error("Only the account holder can change who is on the account.");
  return { account, member };
}

async function audit(db: Db, params: { userId: string; action: string; accountId: string; actingMemberId: string | null; request: RequestContext; extra?: Record<string, unknown> }) {
  await db.from("audit_log").insert({
    actor_id: params.userId,
    actor_type: "buyer",
    action_type: params.action,
    entity_type: "buyer_account",
    entity_id: params.accountId,
    metadata: { acted_by_member_id: params.actingMemberId, ip_address: params.request.ip, user_agent: params.request.userAgent, at: new Date().toISOString(), ...params.extra },
  });
}

/** "I am <Full Name>": recorded every time someone takes over the keyboard. */
export async function recordActingMember(db: Db, params: { userId: string; memberId: string; step: string; request: RequestContext }) {
  const { account, member } = await requireActingMember(db, params.userId, params.memberId);
  await audit(db, { userId: params.userId, action: "buyer.member_acting", accountId: account.id, actingMemberId: member.id, request: params.request, extra: { step: params.step } });
}

// ---------------------------------------------------------------------------
// The account's members, with each one's checklist
// ---------------------------------------------------------------------------

export async function myAccountMembers(db: Db, userId: string): Promise<{ accountId: string; locked: boolean; canAdd: boolean; members: AccountMemberView[] }> {
  const account = await accountFor(db, userId);
  const members = await activeMembers(db, account.id);
  const { data: docs } = await db.from("signed_documents").select("document_type, account_member_id, signed_name").eq("buyer_account_id", account.id);
  const signed = (docs ?? []) as Array<{ document_type: string; account_member_id: string | null; signed_name: string | null }>;
  // Signatures from before members were named on them belong to the account holder.
  const signedBy = (type: string, m: MemberRow) =>
    signed.some((d) => d.document_type === type && (d.account_member_id === m.id || (!d.account_member_id && (m.role === "primary" || (d.signed_name ?? "").trim().toLowerCase() === (m.full_name ?? "").trim().toLowerCase()))));
  const locked = await membersLocked(db, account);
  return {
    accountId: account.id,
    locked,
    canAdd: !locked && members.length < MAX_ACTIVE_MEMBERS,
    members: members.map((m) => ({
      id: m.id,
      role: m.role,
      fullName: m.full_name ?? "",
      email: m.email,
      phone: m.phone,
      eligibility: eligibilityOf(m.vetting_status),
      checklist: [
        { key: "identity", label: "Identity", done: identityComplete(m) },
        { key: "fcra", label: "Background check consent", done: Boolean(m.fcra_consent_at) },
        { key: "background", label: "Background check", done: Boolean(m.background_check_result) },
        { key: "hold_harmless", label: "Hold harmless", done: signedBy("HOLD_HARMLESS", m) },
        { key: "independent_advice", label: "Independent advice notice", done: signedBy("block_5_independent_advice", m) },
      ],
    })),
  };
}

// ---------------------------------------------------------------------------
// Adding, editing and removing the second member (the account holder, before the lock)
// ---------------------------------------------------------------------------

/** The same person in another account that shares a pod with this one. */
async function inAnotherAccountOfPod(db: Db, accountId: string, email: string): Promise<boolean> {
  const { data: mine } = await db.from("pod_reservations").select("property_id").eq("buyer_account_id", accountId).eq("status", "reserved");
  const properties = [...new Set(((mine ?? []) as Array<{ property_id: string }>).map((r) => r.property_id))];
  if (properties.length === 0) return false;
  const { data: others } = await db.from("pod_reservations").select("buyer_account_id").in("property_id", properties).eq("status", "reserved");
  const accounts = [...new Set(((others ?? []) as Array<{ buyer_account_id: string }>).map((r) => r.buyer_account_id))].filter((a) => a !== accountId);
  if (accounts.length === 0) return false;
  const { data: people } = await db.from("account_members").select("email").in("buyer_account_id", accounts).eq("status", "active");
  return ((people ?? []) as Array<{ email: string | null }>).some((p) => p.email && normalizeEmail(p.email) === email);
}

async function checkEmail(db: Db, account: AccountRow, members: MemberRow[], email: string, exceptId: string | null) {
  const clean = normalizeEmail(email);
  if (!isValidEmail(clean)) throw new Error("Enter a valid email address.");
  if (clean === normalizeEmail(account.email) || members.some((m) => m.id !== exceptId && m.email && normalizeEmail(m.email) === clean)) throw new Error(SAME_EMAIL_MESSAGE);
  if (await inAnotherAccountOfPod(db, account.id, clean)) throw new Error(POD_MESSAGE);
  return clean;
}

const friendly = (error: { code?: string; message?: string }) => {
  const m = error.message ?? "";
  if (/at most two/i.test(m)) return LIMIT_MESSAGE;
  if (/own email|one_email/i.test(m)) return SAME_EMAIL_MESSAGE;
  if (/different person/i.test(m)) return SAME_PERSON_MESSAGE;
  if (/same pod/i.test(m)) return POD_MESSAGE;
  if (/Golden Ticket/i.test(m)) return LOCKED_MESSAGE;
  if (/status|column/i.test(m)) return "Database is missing the member columns — run account-members.sql in Supabase.";
  return m || "That didn't save. Please try again.";
};

export async function addSecondMember(db: Db, params: { userId: string; actingMemberId: string; fullName: string; email: string; phone: string | null; request: RequestContext }) {
  const { account, member: acting } = await requireActingMember(db, params.userId, params.actingMemberId, { primary: true });
  if (await membersLocked(db, account)) throw new Error(LOCKED_MESSAGE);
  const members = await activeMembers(db, account.id);
  if (members.length >= MAX_ACTIVE_MEMBERS) throw new Error(LIMIT_MESSAGE);
  const email = await checkEmail(db, account, members, params.email, null);
  const { data, error } = await db
    .from("account_members")
    .insert({ buyer_account_id: account.id, role: "member", status: "active", full_name: params.fullName, email, phone: params.phone, added_at: new Date().toISOString() })
    .select("id")
    .maybeSingle();
  if (error || !data) throw new Error(friendly(error ?? {}));
  await audit(db, { userId: params.userId, action: "buyer.member_added", accountId: account.id, actingMemberId: acting.id, request: params.request, extra: { member_id: data.id } });
  return { id: data.id as string };
}

export async function updateSecondMember(db: Db, params: { userId: string; actingMemberId: string; memberId: string; fullName: string; email: string; phone: string | null; request: RequestContext }) {
  const { account, member: acting } = await requireActingMember(db, params.userId, params.actingMemberId, { primary: true });
  if (await membersLocked(db, account)) throw new Error(LOCKED_MESSAGE);
  const members = await activeMembers(db, account.id);
  const target = members.find((m) => m.id === params.memberId && m.role === "member");
  if (!target) throw new Error("That member isn't on your account.");
  const email = await checkEmail(db, account, members, params.email, target.id);
  const { error } = await db.from("account_members").update({ full_name: params.fullName, email, phone: params.phone }).eq("id", target.id).eq("status", "active");
  if (error) throw new Error(friendly(error));
  await audit(db, { userId: params.userId, action: "buyer.member_updated", accountId: account.id, actingMemberId: acting.id, request: params.request, extra: { member_id: target.id } });
}

/** Soft remove: the row and everything it signed stay. */
export async function removeSecondMember(db: Db, params: { userId: string; actingMemberId: string; memberId: string; request: RequestContext }) {
  const { account, member: acting } = await requireActingMember(db, params.userId, params.actingMemberId, { primary: true });
  if (await membersLocked(db, account)) throw new Error(LOCKED_MESSAGE);
  const members = await activeMembers(db, account.id);
  const target = members.find((m) => m.id === params.memberId && m.role === "member");
  if (!target) throw new Error("That member isn't on your account.");
  const { data, error } = await db
    .from("account_members")
    .update({ status: "removed", removed_at: new Date().toISOString() })
    .eq("id", target.id)
    .eq("status", "active")
    .select("id")
    .maybeSingle();
  if (error) throw new Error(friendly(error));
  if (!data) throw new Error("This member was just changed. Reload and try again.");
  await audit(db, { userId: params.userId, action: "buyer.member_removed", accountId: account.id, actingMemberId: acting.id, request: params.request, extra: { member_id: target.id } });
}

// ---------------------------------------------------------------------------
// Identity (Step 2), per member
// ---------------------------------------------------------------------------

export async function saveMemberIdentity(
  db: Db,
  params: { userId: string; actingMemberId: string; fullName: string; address: string; dateOfBirth: string; idDocumentNumber: string; idDocumentPath: string | null; request: RequestContext },
): Promise<{ pending: string[] }> {
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);
  if (member.role === "member" && (await membersLocked(db, account))) throw new Error(LOCKED_MESSAGE);
  const members = await activeMembers(db, account.id);
  const next = { full_name: params.fullName, date_of_birth: params.dateOfBirth, id_document_number: params.idDocumentNumber };
  if (members.some((m) => m.id !== member.id && samePerson(next, m))) throw new Error(SAME_PERSON_MESSAGE);

  const { error } = await db
    .from("account_members")
    .update({
      full_name: params.fullName,
      address: params.address,
      date_of_birth: params.dateOfBirth,
      id_document_number: params.idDocumentNumber,
      vetting_status: "identity_submitted",
      ...(params.idDocumentPath ? { id_document_url: params.idDocumentPath } : {}),
    })
    .eq("id", member.id)
    .eq("status", "active");
  if (error) throw new Error(friendly(error));
  await audit(db, { userId: params.userId, action: "buyer.identity_submitted", accountId: account.id, actingMemberId: member.id, request: params.request, extra: { member_id: member.id, has_document: Boolean(params.idDocumentPath) } });

  const after = await activeMembers(db, account.id);
  return { pending: after.filter((m) => !identityComplete(m)).map((m) => m.full_name?.trim() || (m.role === "primary" ? "Account holder" : "Second member")) };
}

// ---------------------------------------------------------------------------
// Admin: after the lock, changes go through divieight
// ---------------------------------------------------------------------------

export async function adminChangeMember(
  db: Db,
  params: { adminId: string; memberId: string; fullName?: string; email?: string; phone?: string | null; remove?: boolean; reason: string; request: RequestContext },
) {
  const { data } = await db.from("account_members").select("*").eq("id", params.memberId).maybeSingle();
  const member = data as MemberRow | null;
  if (!member) throw new Error("Member not found");
  if (member.status !== "active") throw new Error("This member was already removed.");
  if (params.remove && member.role === "primary") throw new Error("The account holder can't be removed.");
  const patch: Record<string, unknown> = {};
  if (params.remove) Object.assign(patch, { status: "removed", removed_at: new Date().toISOString() });
  if (params.fullName !== undefined) patch["full_name"] = params.fullName;
  if (params.phone !== undefined) patch["phone"] = params.phone;
  if (params.email !== undefined) {
    const { data: account } = await db.from("buyer_accounts").select("id, email, golden_ticket_issued").eq("id", member.buyer_account_id).maybeSingle();
    const others = (await activeMembers(db, member.buyer_account_id)).filter((m) => m.id !== member.id);
    const clean = normalizeEmail(params.email);
    if (!isValidEmail(clean)) throw new Error("Enter a valid email address.");
    if ((member.role !== "primary" && clean === normalizeEmail((account as AccountRow).email)) || others.some((m) => m.email && normalizeEmail(m.email) === clean)) throw new Error(SAME_EMAIL_MESSAGE);
    patch["email"] = clean;
  }
  const { error } = await db.from("account_members").update(patch).eq("id", member.id).eq("status", "active");
  if (error) throw new Error(friendly(error));
  await db.from("audit_log").insert({
    actor_id: params.adminId,
    actor_type: "admin",
    action_type: params.remove ? "admin.member_removed" : "admin.member_updated",
    entity_type: "buyer_account",
    entity_id: member.buyer_account_id,
    metadata: { member_id: member.id, reason: params.reason, fields: Object.keys(patch), ip_address: params.request.ip, user_agent: params.request.userAgent },
  });
}

export { ELIGIBILITY_LABELS };
