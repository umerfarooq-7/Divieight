import { createHash, randomBytes } from "node:crypto";
import { normalizeEmail } from "@/lib/account-members";
import { accountFor } from "@/lib/account-members.server";
import { checkInviteInput, CO_BUYER_MESSAGES, inviteLink, type CoBuyerChoice, type CoBuyerView } from "@/lib/co-buyer-members";

/**
 * Co-buyers as limited sub-accounts (server side). The main buyer invites; the co-buyer signs up with their own login and becomes an Account Member of
 * that buyer's account. co-buyer-members.sql holds the same limits in the database.
 */

type Db = { from: (t: string) => any };

interface MemberRow {
  id: string;
  buyer_account_id: string;
  role: "primary" | "member";
  status: "active" | "removed";
  full_name: string | null;
  email: string | null;
  auth_user_id: string | null;
  invite_token_hash: string | null;
  invited_at: string | null;
  joined_at: string | null;
}

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const RESEND_AFTER_MS = 60_000;
const COLS = "id, buyer_account_id, role, status, full_name, email, auth_user_id, invite_token_hash, invited_at, joined_at";

async function audit(db: Db, userId: string, accountId: string, action: string, metadata: Record<string, unknown>) {
  await db.from("audit_log").insert({ actor_id: userId, actor_type: "buyer", action_type: action, entity_type: "buyer_account", entity_id: accountId, metadata });
}

/** The bell, and the email when a mail transport is set up. Never throws: a failed notice must not undo the change. */
async function tell(db: Db, authUserId: string | null, email: string | null, subject: string, message: string, link: string | null, label: string): Promise<boolean> {
  if (authUserId) {
    try {
      await db.from("notifications").insert({ seller_id: authUserId, message, type: "co_buyer" });
    } catch {
      /* the email below may still reach them */
    }
  }
  if (!email) return false;
  try {
    const { sendEmail } = await import("@/lib/authorization.notify.server");
    return await sendEmail(email, subject, message, link, label);
  } catch {
    return false;
  }
}

async function accountHolder(db: Db, accountId: string): Promise<{ authUserId: string; email: string; name: string }> {
  const { data: acct } = await db.from("buyer_accounts").select("auth_user_id, email").eq("id", accountId).maybeSingle();
  const { data: primary } = await db.from("account_members").select("full_name").eq("buyer_account_id", accountId).eq("role", "primary").eq("status", "active").maybeSingle();
  const a = acct as { auth_user_id: string; email: string } | null;
  return { authUserId: a?.auth_user_id ?? "", email: a?.email ?? "", name: ((primary as { full_name?: string } | null)?.full_name ?? "").trim() || (a?.email.split("@")[0] ?? "A buyer") };
}

/** The account's co-buyer, whether invited or signed up. */
export async function coBuyerOf(db: Db, accountId: string): Promise<MemberRow | null> {
  const { data } = await db.from("account_members").select(COLS).eq("buyer_account_id", accountId).eq("role", "member").eq("status", "active");
  return (((data ?? []) as MemberRow[]).find((m) => m.auth_user_id || m.invite_token_hash) ?? null) as MemberRow | null;
}

async function sendInvite(db: Db, p: { to: string; toName: string; holderName: string; token: string }): Promise<boolean> {
  const subject = `${p.holderName} invited you to buy together on divieight`;
  const body = `${p.holderName} would like you as their co-buyer on divieight. Create your own login with this email address. You will complete your own identity, verification and signatures, and you will see only the shares ${p.holderName} chooses to buy with you. ${p.holderName} keeps the account, the money and the agent.`;
  const { sendEmail } = await import("@/lib/authorization.notify.server");
  try {
    return await sendEmail(p.to, subject, body, inviteLink(p.token), "Create your login");
  } catch {
    return false;
  }
}

/** The account holder invites a co-buyer by name and email. */
export async function inviteCoBuyer(db: Db, params: { userId: string; name: string; email: string }): Promise<{ memberId: string; emailed: boolean }> {
  const { name, email } = checkInviteInput(params);
  const account = await accountFor(db, params.userId);
  if (account.viaMemberId) throw new Error(CO_BUYER_MESSAGES.onlyHolder);
  if (email === normalizeEmail(account.email)) throw new Error(CO_BUYER_MESSAGES.self);
  if (await coBuyerOf(db, account.id)) throw new Error(CO_BUYER_MESSAGES.haveOne);
  const { data: members } = await db.from("account_members").select("email").eq("buyer_account_id", account.id).eq("status", "active");
  if (((members ?? []) as Array<{ email: string | null }>).some((m) => m.email && normalizeEmail(m.email) === email)) throw new Error(CO_BUYER_MESSAGES.self);
  // They sign in with a login of their own, so the address can't already be a buyer's.
  const { data: existing } = await db.from("buyer_accounts").select("id").eq("email", email).maybeSingle();
  if (existing) throw new Error(CO_BUYER_MESSAGES.hasAccount);

  const token = newToken();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("account_members")
    .insert({ buyer_account_id: account.id, role: "member", status: "active", full_name: name, email, invite_token_hash: hashToken(token), invited_at: now, added_at: now })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    if (/at most two/i.test(error?.message ?? "")) throw new Error(CO_BUYER_MESSAGES.haveOne);
    throw new Error("The invitation couldn't be saved. Run co-buyer-members.sql in Supabase, then try again.");
  }
  const holder = await accountHolder(db, account.id);
  const emailed = await sendInvite(db, { to: email, toName: name, holderName: holder.name, token });
  await audit(db, params.userId, account.id, "buyer.co_buyer_invited", { member_id: data.id, invitee_email: email, emailed });
  return { memberId: data.id as string, emailed };
}

/** A fresh invitation link (the old one stops working). */
export async function resendCoBuyerInvite(db: Db, params: { userId: string }): Promise<{ emailed: boolean }> {
  const account = await accountFor(db, params.userId);
  if (account.viaMemberId) throw new Error(CO_BUYER_MESSAGES.onlyHolder);
  const member = await coBuyerOf(db, account.id);
  if (!member || member.auth_user_id || !member.email) throw new Error(CO_BUYER_MESSAGES.notFound);
  if (member.invited_at && Date.now() - new Date(member.invited_at).getTime() < RESEND_AFTER_MS) throw new Error(CO_BUYER_MESSAGES.tooSoon);
  const token = newToken();
  await db.from("account_members").update({ invite_token_hash: hashToken(token), invited_at: new Date().toISOString() }).eq("id", member.id);
  const holder = await accountHolder(db, account.id);
  const emailed = await sendInvite(db, { to: member.email, toName: member.full_name ?? "", holderName: holder.name, token });
  await audit(db, params.userId, account.id, "buyer.co_buyer_invite_resent", { member_id: member.id, emailed });
  return { emailed };
}

/** What an invitation link shows before anyone has signed up: who is asking, and the address it was sent to. */
export async function previewCoBuyerInvite(db: Db, params: { token: string }): Promise<{ holderName: string; name: string; email: string } | null> {
  if (!params.token || params.token.length < 20) return null;
  const { data } = await db.from("account_members").select(COLS).eq("invite_token_hash", hashToken(params.token)).eq("status", "active").maybeSingle();
  const m = data as MemberRow | null;
  if (!m || m.auth_user_id || !m.email) return null;
  return { holderName: (await accountHolder(db, m.buyer_account_id)).name, name: m.full_name ?? "", email: m.email };
}

/**
 * The invited person has signed up (or signed in): the invitation becomes their login. Their signed-in address must be the one it was sent to,
 * and they must not already be a buyer of their own.
 */
export async function claimCoBuyerInvite(db: Db, params: { userId: string; email: string; token: string }): Promise<{ holderName: string }> {
  const { data } = await db.from("account_members").select(COLS).eq("invite_token_hash", hashToken(params.token)).eq("status", "active").maybeSingle();
  const m = data as MemberRow | null;
  if (!m || m.auth_user_id) throw new Error(CO_BUYER_MESSAGES.notFound);
  if (!m.email || normalizeEmail(m.email) !== normalizeEmail(params.email)) throw new Error(CO_BUYER_MESSAGES.wrongEmail);
  const { data: own } = await db.from("buyer_accounts").select("id").eq("auth_user_id", params.userId).maybeSingle();
  if (own) throw new Error(CO_BUYER_MESSAGES.hasAccount);

  const { data: updated, error } = await db
    .from("account_members")
    .update({ auth_user_id: params.userId, joined_at: new Date().toISOString(), invite_token_hash: null })
    .eq("id", m.id)
    .is("auth_user_id", null)
    .select("id")
    .maybeSingle();
  if (error || !updated) throw new Error(CO_BUYER_MESSAGES.notFound);
  const holder = await accountHolder(db, m.buyer_account_id);
  await audit(db, params.userId, m.buyer_account_id, "buyer.co_buyer_joined", { member_id: m.id });
  await tell(db, holder.authUserId, holder.email, `${m.full_name ?? "Your co-buyer"} joined`, `${m.full_name ?? "Your co-buyer"} created their login. When you reserve a share you can choose to buy it with them.`, "/buyer/dashboard", "Open your dashboard");
  return { holderName: holder.name };
}

/** The account holder takes the co-buyer off the account. Not while they are on a share. */
export async function removeCoBuyer(db: Db, params: { userId: string }): Promise<void> {
  const account = await accountFor(db, params.userId);
  if (account.viaMemberId) throw new Error(CO_BUYER_MESSAGES.onlyHolder);
  const member = await coBuyerOf(db, account.id);
  if (!member) throw new Error(CO_BUYER_MESSAGES.notFound);
  const { data: onShares } = await db.from("reservation_co_members").select("reservation_id").eq("account_member_id", member.id);
  if (((onShares ?? []) as unknown[]).length > 0) throw new Error(CO_BUYER_MESSAGES.onShares);
  await db.from("account_members").update({ status: "removed", removed_at: new Date().toISOString(), invite_token_hash: null }).eq("id", member.id);
  await audit(db, params.userId, account.id, "buyer.co_buyer_removed", { member_id: member.id });
  if (member.auth_user_id) await tell(db, member.auth_user_id, member.email, "You were removed as a co-buyer", "You were removed as a co-buyer. You no longer have access to that account.", null, "OK");
}

/** The account holder's view: the co-buyer, how far they are, and the shares they are on. */
export async function myCoBuyer(db: Db, params: { userId: string }): Promise<CoBuyerView | null> {
  const account = await accountFor(db, params.userId);
  if (account.viaMemberId) return null;
  const member = await coBuyerOf(db, account.id);
  if (!member) return null;
  const { myAccountMembers } = await import("@/lib/account-members.server");
  const cv = (await myAccountMembers(db, params.userId)).coBuyer;
  const total = cv?.checklist.length ?? 0;
  const doneSteps = cv?.checklist.filter((c) => c.done).length ?? 0;
  const { data: links } = await db.from("reservation_co_members").select("reservation_id, property_id").eq("account_member_id", member.id);
  const shares: CoBuyerView["shares"] = [];
  for (const l of (links ?? []) as Array<{ reservation_id: string; property_id: string }>) {
    const { data: p } = await db.from("properties").select("address, city, state").eq("id", l.property_id).maybeSingle();
    const prop = p as { address?: string; city?: string; state?: string } | null;
    shares.push({ reservationId: l.reservation_id, propertyId: l.property_id, address: [prop?.address, prop?.city, prop?.state].filter(Boolean).join(", ") });
  }
  return {
    memberId: member.id,
    name: member.full_name ?? "",
    email: member.email,
    state: member.auth_user_id ? "joined" : "invited",
    invitedAt: member.invited_at,
    joinedAt: member.joined_at,
    progress: { done: doneSteps, total },
    shares,
  };
}

// ---------------------------------------------------------------------------------------------------------
// A share bought together
// ---------------------------------------------------------------------------------------------------------

/** What the reserve screen offers: null when the account has no co-buyer. */
export async function coBuyerChoice(db: Db, params: { accountId: string }): Promise<CoBuyerChoice | null> {
  const member = await coBuyerOf(db, params.accountId);
  if (!member) return null;
  if (!member.auth_user_id) return { memberId: member.id, name: member.full_name ?? "Your co-buyer", available: false, unavailableReason: CO_BUYER_MESSAGES.notJoined };
  return { memberId: member.id, name: member.full_name ?? "Your co-buyer", available: true, unavailableReason: null };
}

/** The main buyer buys this share with their co-buyer: the share shows up for the co-buyer, and they are named on it and sign for it. */
export async function attachCoBuyerToReservation(db: Db, params: { userId: string; reservationId: string }): Promise<{ memberId: string; name: string }> {
  const account = await accountFor(db, params.userId);
  if (account.viaMemberId) throw new Error(CO_BUYER_MESSAGES.onlyHolder);
  const { data: res } = await db.from("pod_reservations").select("id, property_id, buyer_account_id, status").eq("id", params.reservationId).maybeSingle();
  const r = res as { id: string; property_id: string; buyer_account_id: string; status: string } | null;
  if (!r || r.buyer_account_id !== account.id || r.status !== "reserved") throw new Error(CO_BUYER_MESSAGES.notYours);
  const choice = await coBuyerChoice(db, { accountId: account.id });
  if (!choice) throw new Error("You don't have a co-buyer.");
  if (!choice.available) throw new Error(choice.unavailableReason ?? CO_BUYER_MESSAGES.notJoined);
  const { data: genesis } = await db.from("entity_genesis").select("cap_table_locked_at").eq("property_id", r.property_id).maybeSingle();
  if ((genesis as { cap_table_locked_at?: string | null } | null)?.cap_table_locked_at) throw new Error(CO_BUYER_MESSAGES.locked);

  const { error } = await db.from("reservation_co_members").upsert({ reservation_id: r.id, property_id: r.property_id, buyer_account_id: account.id, account_member_id: choice.memberId }, { onConflict: "reservation_id" });
  if (error) throw new Error("The co-buyer couldn't be added to this share. Run co-buyer-members.sql in Supabase, then try again.");
  await syncAfterChange(db, params.userId, r.property_id, "co_buyer_added");
  const { data: m } = await db.from("account_members").select("auth_user_id, email").eq("id", choice.memberId).maybeSingle();
  const { data: p } = await db.from("properties").select("address, city, state").eq("id", r.property_id).maybeSingle();
  const prop = p as { address?: string; city?: string; state?: string } | null;
  const where = [prop?.address, prop?.city, prop?.state].filter(Boolean).join(", ");
  await tell(db, (m as { auth_user_id?: string } | null)?.auth_user_id ?? null, (m as { email?: string } | null)?.email ?? null, "A share to sign for", `You are buying a 1/8th share of ${where} together with the account holder. Open your portal to see what you need to sign.`, "/buyer/co/dashboard", "Open your portal");
  await audit(db, params.userId, account.id, "buyer.co_buyer_added_to_share", { reservation_id: r.id, property_id: r.property_id, member_id: choice.memberId });
  return { memberId: choice.memberId, name: choice.name };
}

/** The main buyer takes the co-buyer off this share (before the cap table is locked). */
export async function detachCoBuyerFromReservation(db: Db, params: { userId: string; reservationId: string }): Promise<void> {
  const account = await accountFor(db, params.userId);
  if (account.viaMemberId) throw new Error(CO_BUYER_MESSAGES.onlyHolder);
  const { data: link } = await db.from("reservation_co_members").select("reservation_id, property_id, buyer_account_id").eq("reservation_id", params.reservationId).maybeSingle();
  const l = link as { reservation_id: string; property_id: string; buyer_account_id: string } | null;
  if (!l || l.buyer_account_id !== account.id) throw new Error(CO_BUYER_MESSAGES.notYours);
  const { data: genesis } = await db.from("entity_genesis").select("cap_table_locked_at").eq("property_id", l.property_id).maybeSingle();
  if ((genesis as { cap_table_locked_at?: string | null } | null)?.cap_table_locked_at) throw new Error(CO_BUYER_MESSAGES.locked);
  await db.from("reservation_co_members").delete().eq("reservation_id", l.reservation_id);
  await syncAfterChange(db, params.userId, l.property_id, "co_buyer_removed");
  await audit(db, params.userId, account.id, "buyer.co_buyer_removed_from_share", { reservation_id: l.reservation_id, property_id: l.property_id });
}

async function syncAfterChange(db: Db, userId: string, propertyId: string, reason: string) {
  try {
    const { syncCapTable } = await import("@/lib/entity-genesis.server");
    await syncCapTable(db as never, { propertyId, actorId: userId, reason });
  } catch {
    // the share stands; the cap table is rewritten on its next sync
  }
}

// ---------------------------------------------------------------------------------------------------------
// Who is on a property (the rest of the platform asks)
// ---------------------------------------------------------------------------------------------------------

/** The co-buyer members of this account who are on a share on this property. */
export async function coBuyersOnProperty(db: Db, accountId: string, propertyId: string): Promise<string[]> {
  const { data } = await db.from("reservation_co_members").select("account_member_id").eq("buyer_account_id", accountId).eq("property_id", propertyId);
  return [...new Set(((data ?? []) as Array<{ account_member_id: string }>).map((r) => r.account_member_id))];
}

/** The properties a co-buyer is on, and the reservation behind each. */
export async function sharesOfCoBuyer(db: Db, memberId: string): Promise<Array<{ reservationId: string; propertyId: string; buyerAccountId: string }>> {
  const { data } = await db.from("reservation_co_members").select("reservation_id, property_id, buyer_account_id").eq("account_member_id", memberId);
  return ((data ?? []) as Array<{ reservation_id: string; property_id: string; buyer_account_id: string }>).map((r) => ({ reservationId: r.reservation_id, propertyId: r.property_id, buyerAccountId: r.buyer_account_id }));
}

/** The signed-in co-buyer's own portal (null when this login is not a co-buyer). */
export async function coBuyerSelf(db: Db, params: { userId: string }): Promise<import("@/lib/co-buyer-members").CoBuyerSelf | null> {
  const { data } = await db.from("account_members").select("*").eq("auth_user_id", params.userId).eq("status", "active").maybeSingle();
  const m = data as (MemberRow & { enrollment_paid_at?: string | null }) | null;
  if (!m) return null;
  const { loadMemberSteps } = await import("@/lib/account-rollup");
  const steps = (await loadMemberSteps(db, m.buyer_account_id)).find((s) => s.memberId === m.id);
  const holder = await accountHolder(db, m.buyer_account_id);
  const shares: import("@/lib/co-buyer-members").CoBuyerSelf["shares"] = [];
  for (const l of await sharesOfCoBuyer(db, m.id)) {
    const { data: p } = await db.from("properties").select("address, city, state").eq("id", l.propertyId).maybeSingle();
    const prop = p as { address?: string; city?: string; state?: string } | null;
    shares.push({ reservationId: l.reservationId, propertyId: l.propertyId, address: [prop?.address, prop?.city, prop?.state].filter(Boolean).join(", ") });
  }
  return {
    memberId: m.id,
    name: m.full_name ?? "",
    email: m.email,
    holderName: holder.name,
    identityDone: Boolean(steps?.idScan),
    w9Done: Boolean(steps?.w9),
    feePaid: Boolean(m.enrollment_paid_at),
    shares,
  };
}

/** The few account fields the shared onboarding screens need for a co-buyer's login (never the rest of the holder's account). */
export async function accountRowForLogin(db: Db, params: { userId: string }): Promise<{ id: string; onboarding_status: string; priority_rank_timestamp: string | null; intent: string | null; primary_target_market: string | null; coBuyer: boolean } | null> {
  const account = await accountFor(db, params.userId);
  const { data } = await db.from("buyer_accounts").select("id, onboarding_status, priority_rank_timestamp, intent, primary_target_market").eq("id", account.id).maybeSingle();
  if (!data) return null;
  return { ...(data as { id: string; onboarding_status: string; priority_rank_timestamp: string | null; intent: string | null; primary_target_market: string | null }), coBuyer: Boolean(account.viaMemberId) };
}

/** The co-buyer's own Independent Professional Advice acknowledgment (Block 5), recorded on the server for them alone. */
export async function acceptAdviceNotice(db: Db, params: { userId: string; actingMemberId: string; documentHash: string; documentVersion: string; ip: string | null }): Promise<void> {
  const { requireActingMember } = await import("@/lib/account-members.server");
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);
  const { data: existing } = await db.from("signed_documents").select("id").eq("buyer_account_id", account.id).eq("account_member_id", member.id).eq("document_type", "block_5_independent_advice").limit(1);
  if (((existing ?? []) as unknown[]).length > 0) return;
  const { error } = await db.from("signed_documents").insert({
    buyer_account_id: account.id,
    account_member_id: member.id,
    document_type: "block_5_independent_advice",
    document_version: params.documentVersion,
    signed_name: (member.full_name ?? "Account Member").trim(),
    document_hash: params.documentHash,
    ip_address: params.ip,
  });
  if (error) throw new Error(error.message);
  await audit(db, params.userId, account.id, "buyer.pra_signed", { block: "block_5_independent_advice", document_hash: params.documentHash, account_member_id: member.id, ip_address: params.ip });
}

/** Whether this member has acknowledged the Independent Professional Advice notice (the member's own record). */
export async function adviceNoticeState(db: Db, params: { userId: string; actingMemberId: string }): Promise<{ accepted: boolean }> {
  const { requireActingMember } = await import("@/lib/account-members.server");
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);
  const { data } = await db.from("signed_documents").select("id").eq("buyer_account_id", account.id).eq("account_member_id", member.id).eq("document_type", "block_5_independent_advice").limit(1);
  return { accepted: ((data ?? []) as unknown[]).length > 0 };
}
