import { createHash, randomBytes } from "node:crypto";
import { normalizeEmail } from "@/lib/account-members";
import { JOINT_MESSAGES } from "@/lib/joint-reservation";
import { checkInviteInput, CO_BUYER_MESSAGES, inviteLink, type CoBuyerStatus, type MyCoBuyer } from "@/lib/co-buyer";

/**
 * Co-buyers (server side). Each buyer keeps their own account; a link only says who invited whom and whether it was accepted.
 * Every write names the caller's own account. co-buyer-links.sql holds the same limits in the database.
 */

type Db = { from: (t: string) => any };

export interface AccountRow {
  id: string;
  email: string;
  auth_user_id: string;
  golden_ticket_issued?: boolean | null;
  liquidity_verified?: boolean | null;
  onboarding_status?: string | null;
}

export interface LinkRow {
  id: string;
  inviter_account_id: string;
  invitee_account_id: string | null;
  invitee_name: string;
  invitee_email: string;
  token_hash: string;
  status: CoBuyerStatus;
  invited_at: string;
  accepted_at: string | null;
}

const ACCOUNT_COLS = "id, email, auth_user_id, golden_ticket_issued, onboarding_status, liquidity_verified";
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const RESEND_AFTER_MS = 60_000;

export async function accountFor(db: Db, userId: string): Promise<AccountRow> {
  const { data } = await db.from("buyer_accounts").select(ACCOUNT_COLS).eq("auth_user_id", userId).maybeSingle();
  if (!data) throw new Error("No buyer account");
  return data as AccountRow;
}

export async function accountById(db: Db, id: string): Promise<AccountRow | null> {
  const { data } = await db.from("buyer_accounts").select(ACCOUNT_COLS).eq("id", id).maybeSingle();
  return (data as AccountRow | null) ?? null;
}

/** The name people know a buyer by: their account holder's name, or the start of their email. */
export async function nameOf(db: Db, account: AccountRow): Promise<string> {
  const { data } = await db.from("account_members").select("full_name").eq("buyer_account_id", account.id).eq("role", "primary").eq("status", "active").maybeSingle();
  const full = ((data as { full_name?: string | null } | null)?.full_name ?? "").trim();
  return full || account.email.split("@")[0] || "A buyer";
}

export async function audit(db: Db, userId: string, accountId: string, action: string, metadata: Record<string, unknown>) {
  await db.from("audit_log").insert({ actor_id: userId, actor_type: "buyer", action_type: action, entity_type: "buyer_account", entity_id: accountId, metadata });
}

/** The bell, and the email when a sender is configured. Never throws: a failed notice must not undo the link. */
export async function tell(db: Db, to: AccountRow, subject: string, message: string, link: string | null, label: string): Promise<boolean> {
  try {
    await db.from("notifications").insert({ seller_id: to.auth_user_id, message, type: "co_buyer" });
  } catch {
    /* the email below may still reach them */
  }
  try {
    const { sendEmail } = await import("@/lib/authorization.notify.server");
    return await sendEmail(to.email, subject, message, link, label);
  } catch {
    return false;
  }
}

async function openLinkOf(db: Db, accountId: string): Promise<LinkRow | null> {
  const { data } = await db.from("co_buyer_links").select("*").eq("inviter_account_id", accountId).in("status", ["invited", "active"]).maybeSingle();
  return (data as LinkRow | null) ?? null;
}

async function activeAsInvitee(db: Db, accountId: string): Promise<LinkRow | null> {
  const { data } = await db.from("co_buyer_links").select("*").eq("invitee_account_id", accountId).eq("status", "active").maybeSingle();
  return (data as LinkRow | null) ?? null;
}

/** An account already in an active link, on either side. */
export async function activeLinkOf(db: Db, accountId: string): Promise<LinkRow | null> {
  const mine = await openLinkOf(db, accountId);
  if (mine?.status === "active") return mine;
  return activeAsInvitee(db, accountId);
}

export async function inviteCoBuyer(db: Db, params: { userId: string; name: string; email: string }): Promise<{ id: string; emailed: boolean }> {
  const { name, email } = checkInviteInput(params);
  const account = await accountFor(db, params.userId);
  if (email === normalizeEmail(account.email)) throw new Error(CO_BUYER_MESSAGES.self);
  // A second member left over from the older one-account model is the same person as a co-buyer would be.
  const { data: legacy } = await db.from("account_members").select("email").eq("buyer_account_id", account.id).eq("status", "active");
  if (((legacy ?? []) as Array<{ email: string | null }>).some((m) => m.email && normalizeEmail(m.email) === email)) throw new Error(CO_BUYER_MESSAGES.self);

  if (await openLinkOf(db, account.id)) throw new Error(CO_BUYER_MESSAGES.alreadyLinked);
  if (await activeAsInvitee(db, account.id)) throw new Error(CO_BUYER_MESSAGES.youAreLinked);

  // They may already have an account: the invitation then waits on their dashboard as well as in their inbox.
  const { data: existing } = await db.from("buyer_accounts").select(ACCOUNT_COLS).eq("email", email).maybeSingle();
  const invitee = (existing as AccountRow | null) ?? null;
  if (invitee && (await activeLinkOf(db, invitee.id))) throw new Error(CO_BUYER_MESSAGES.theyAreLinked);

  const token = newToken();
  const { data, error } = await db
    .from("co_buyer_links")
    .insert({ inviter_account_id: account.id, invitee_account_id: null, invitee_name: name, invitee_email: email, token_hash: hashToken(token), status: "invited" })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    if (error?.code === "23505") throw new Error(CO_BUYER_MESSAGES.alreadyLinked);
    throw new Error("The invitation couldn't be saved. Run co-buyer-links.sql in Supabase, then try again.");
  }

  const inviterName = await nameOf(db, account);
  const emailed = await sendInvite(db, { to: email, toName: name, inviterName, token, existingAccount: invitee });
  await audit(db, params.userId, account.id, "buyer.co_buyer_invited", { link_id: data.id, invitee_email: email, emailed, invitee_has_account: Boolean(invitee) });
  return { id: data.id as string, emailed };
}

async function sendInvite(db: Db, p: { to: string; toName: string; inviterName: string; token: string; existingAccount: AccountRow | null }): Promise<boolean> {
  const subject = `${p.inviterName} invited you to buy together on divieight`;
  const body = p.existingAccount
    ? `${p.inviterName} would like you as a co-buyer on divieight. You already have an account: sign in and accept the invitation on your dashboard. Each of you keeps your own account, onboarding and payment, and when either of you reserves a share you can choose to take it together.`
    : `${p.inviterName} would like you as a co-buyer on divieight. Create your own account with this email address, complete your own onboarding and payment, and you will be linked automatically. When either of you reserves a share you can choose to take it together.`;
  try {
    const { sendEmail } = await import("@/lib/authorization.notify.server");
    const sent = await sendEmail(p.to, subject, body, inviteLink(p.token), p.existingAccount ? "Sign in and accept" : "Create your account");
    if (p.existingAccount) {
      await db.from("notifications").insert({ seller_id: p.existingAccount.auth_user_id, message: `${p.inviterName} invited you to be their co-buyer. Open your dashboard to accept or decline.`, type: "co_buyer" });
    }
    return sent;
  } catch {
    return false;
  }
}

/** Send the same invitation again with a fresh link (the old link stops working). */
export async function resendCoBuyerInvite(db: Db, params: { userId: string }): Promise<{ emailed: boolean }> {
  const account = await accountFor(db, params.userId);
  const link = await openLinkOf(db, account.id);
  if (!link || link.status !== "invited") throw new Error(CO_BUYER_MESSAGES.notFound);
  if (Date.now() - new Date(link.invited_at).getTime() < RESEND_AFTER_MS) throw new Error(CO_BUYER_MESSAGES.tooSoon);
  const token = newToken();
  await db.from("co_buyer_links").update({ token_hash: hashToken(token), invited_at: new Date().toISOString() }).eq("id", link.id).eq("status", "invited");
  const { data: existing } = await db.from("buyer_accounts").select(ACCOUNT_COLS).eq("email", link.invitee_email).maybeSingle();
  const emailed = await sendInvite(db, { to: link.invitee_email, toName: link.invitee_name, inviterName: await nameOf(db, account), token, existingAccount: (existing as AccountRow | null) ?? null });
  await audit(db, params.userId, account.id, "buyer.co_buyer_invite_resent", { link_id: link.id, emailed });
  return { emailed };
}

/** The inviter withdraws an invitation nobody has answered. */
export async function cancelCoBuyerInvite(db: Db, params: { userId: string }): Promise<void> {
  const account = await accountFor(db, params.userId);
  const link = await openLinkOf(db, account.id);
  if (!link || link.status !== "invited") throw new Error(CO_BUYER_MESSAGES.notFound);
  await db.from("co_buyer_links").update({ status: "revoked", ended_at: new Date().toISOString(), ended_by: params.userId }).eq("id", link.id).eq("status", "invited");
  await audit(db, params.userId, account.id, "buyer.co_buyer_invite_cancelled", { link_id: link.id });
}

/** What an invitation link shows before anyone has signed in: who is asking, and the address it was sent to. */
export async function previewCoBuyerInvite(db: Db, params: { token: string }): Promise<{ inviterName: string; inviteeEmail: string; inviteeName: string } | null> {
  if (!params.token || params.token.length < 20) return null;
  const { data } = await db.from("co_buyer_links").select("*").eq("token_hash", hashToken(params.token)).eq("status", "invited").maybeSingle();
  const link = data as LinkRow | null;
  if (!link) return null;
  const inviter = await accountById(db, link.inviter_account_id);
  return { inviterName: inviter ? await nameOf(db, inviter) : "A buyer", inviteeEmail: link.invitee_email, inviteeName: link.invitee_name };
}

/**
 * The invited person says yes, from their dashboard (by invitation) or straight after signing up from the email link (by token).
 * Their signed-in address must be the one the invitation went to.
 */
export async function acceptCoBuyerInvite(db: Db, params: { userId: string; linkId?: string; token?: string }): Promise<{ inviterName: string }> {
  const account = await accountFor(db, params.userId);
  let query = db.from("co_buyer_links").select("*").eq("status", "invited");
  query = params.linkId ? query.eq("id", params.linkId) : query.eq("token_hash", hashToken(params.token ?? ""));
  const { data } = await query.maybeSingle();
  const link = data as LinkRow | null;
  if (!link) throw new Error(CO_BUYER_MESSAGES.notFound);
  if (link.inviter_account_id === account.id) throw new Error(CO_BUYER_MESSAGES.notYours);
  if (normalizeEmail(link.invitee_email) !== normalizeEmail(account.email)) throw new Error(CO_BUYER_MESSAGES.wrongEmail);
  if (await activeLinkOf(db, account.id)) throw new Error(CO_BUYER_MESSAGES.youAreLinked);
  const inviter = await accountById(db, link.inviter_account_id);
  if (!inviter) throw new Error(CO_BUYER_MESSAGES.notFound);

  const { data: updated, error } = await db
    .from("co_buyer_links")
    .update({ status: "active", invitee_account_id: account.id, accepted_at: new Date().toISOString() })
    .eq("id", link.id)
    .eq("status", "invited")
    .select("id")
    .maybeSingle();
  if (error || !updated) throw new Error(error?.code === "23505" ? CO_BUYER_MESSAGES.youAreLinked : CO_BUYER_MESSAGES.notFound);

  const inviterName = await nameOf(db, inviter);
  const myName = await nameOf(db, account);
  await audit(db, params.userId, account.id, "buyer.co_buyer_accepted", { link_id: link.id, inviter_account_id: inviter.id });
  await tell(db, inviter, `${myName} accepted your invitation`, `${myName} is now your co-buyer. When either of you reserves a share, you can choose to take it together.`, "/buyer/dashboard", "Open your dashboard");
  return { inviterName };
}

export async function declineCoBuyerInvite(db: Db, params: { userId: string; linkId: string }): Promise<void> {
  const account = await accountFor(db, params.userId);
  const { data } = await db.from("co_buyer_links").select("*").eq("id", params.linkId).eq("status", "invited").maybeSingle();
  const link = data as LinkRow | null;
  if (!link) throw new Error(CO_BUYER_MESSAGES.notFound);
  if (normalizeEmail(link.invitee_email) !== normalizeEmail(account.email)) throw new Error(CO_BUYER_MESSAGES.notYours);
  await db.from("co_buyer_links").update({ status: "declined", ended_at: new Date().toISOString(), ended_by: params.userId }).eq("id", link.id).eq("status", "invited");
  await audit(db, params.userId, account.id, "buyer.co_buyer_declined", { link_id: link.id });
  const inviter = await accountById(db, link.inviter_account_id);
  if (inviter) await tell(db, inviter, "Co-buyer invitation declined", `${await nameOf(db, account)} declined your co-buyer invitation. You can invite someone else.`, "/buyer/dashboard", "Open your dashboard");
}

/** Either side ends an active link. */
export async function removeCoBuyer(db: Db, params: { userId: string }): Promise<void> {
  const account = await accountFor(db, params.userId);
  const link = await activeLinkOf(db, account.id);
  if (!link) throw new Error(CO_BUYER_MESSAGES.notFound);
  // A share held together, or a request still waiting, keeps the link in place until it is settled.
  const { hasOpenJoint } = await import("@/lib/joint-reservation.server");
  if (await hasOpenJoint(db, account.id)) throw new Error(JOINT_MESSAGES.openJoint);
  await db.from("co_buyer_links").update({ status: "revoked", ended_at: new Date().toISOString(), ended_by: params.userId }).eq("id", link.id).eq("status", "active");
  await audit(db, params.userId, account.id, "buyer.co_buyer_removed", { link_id: link.id });
  const otherId = link.inviter_account_id === account.id ? link.invitee_account_id : link.inviter_account_id;
  const other = otherId ? await accountById(db, otherId) : null;
  if (other) await tell(db, other, "Your co-buyer link ended", `${await nameOf(db, account)} ended the co-buyer link. Your account, onboarding and Golden Ticket are not affected.`, "/buyer/dashboard", "Open your dashboard");
}

/** The dashboard card: your link (if any) and invitations addressed to your email. */
export async function myCoBuyer(db: Db, params: { userId: string }): Promise<MyCoBuyer> {
  const account = await accountFor(db, params.userId);
  const progress = (a: AccountRow | null): "onboarding" | "ready" | null => (a ? (a.golden_ticket_issued ? "ready" : "onboarding") : null);

  let link: MyCoBuyer["link"] = null;
  const mine = await openLinkOf(db, account.id);
  if (mine) {
    const partner = mine.invitee_account_id ? await accountById(db, mine.invitee_account_id) : null;
    link = {
      id: mine.id,
      role: "inviter",
      status: mine.status === "active" ? "active" : "invited",
      partnerName: mine.invitee_name,
      partnerEmail: mine.invitee_email,
      invitedAt: mine.invited_at,
      acceptedAt: mine.accepted_at,
      partnerProgress: mine.status === "active" ? progress(partner) : null,
    };
  } else {
    const theirs = await activeAsInvitee(db, account.id);
    if (theirs) {
      const partner = await accountById(db, theirs.inviter_account_id);
      link = {
        id: theirs.id,
        role: "invitee",
        status: "active",
        partnerName: partner ? await nameOf(db, partner) : "Your co-buyer",
        partnerEmail: partner?.email ?? null,
        invitedAt: theirs.invited_at,
        acceptedAt: theirs.accepted_at,
        partnerProgress: progress(partner),
      };
    }
  }

  // Invitations sent to this account's address that nobody has answered. They go away once you are linked.
  const incoming: MyCoBuyer["incoming"] = [];
  if (!link || link.status !== "active") {
    const { data } = await db.from("co_buyer_links").select("*").eq("invitee_email", normalizeEmail(account.email)).eq("status", "invited");
    for (const row of (data ?? []) as LinkRow[]) {
      if (row.inviter_account_id === account.id) continue;
      const inviter = await accountById(db, row.inviter_account_id);
      incoming.push({ id: row.id, inviterName: inviter ? await nameOf(db, inviter) : "A buyer", invitedAt: row.invited_at });
    }
  }
  return { accountId: account.id, link, incoming };
}
