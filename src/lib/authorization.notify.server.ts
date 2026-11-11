import { resendFrom } from "@/lib/email-sender";
import { isMandatoryNotification, isOwnerNotificationType } from "@/lib/owner-notifications";

/**
 * Notification fan-out for the Buyer-Authorization Workflow.
 *
 * Every authorization touchpoint reaches the recipient in their portal (the
 * `notifications` row) and by email. The platform has no SMS sender wired up,
 * so the portal + email pair is the delivery channel today; adding SMS later
 * only means extending `deliver()`.
 */

type Db = { from: (t: string) => any };

export interface AuthorizationRecipient {
  authUserId: string | null;
  email: string | null;
  name?: string | null;
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** An email can't follow a relative link. */
const absoluteLink = (link: string) => (link.startsWith("/") ? `${process.env.SITE_URL ?? "https://divieight.vercel.app"}${link}` : link);

function html(subject: string, rawBody: string, link: string | null, linkLabel: string) {
  // Messages can carry text people typed, such as a maintenance title.
  const body = escapeHtml(rawBody);
  const heading = escapeHtml(subject);
  return `<!doctype html><html><body style="margin:0;background:#f6f8f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
      <tr><td style="background:#0b3d5c;padding:20px 28px;"><div style="color:#fff;font-size:20px;font-weight:600;"><span style="color:#46ACB4;">divi</span>eight</div></td></tr>
      <tr><td style="padding:28px;">
        <h1 style="margin:0 0 12px;font-size:19px;font-weight:600;">${heading}</h1>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#334155;">${body}</p>
        ${link ? `<a href="${escapeHtml(absoluteLink(link))}" style="display:inline-block;background:#46ACB4;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:500;">${linkLabel}</a>` : ""}
      </td></tr>
      <tr><td style="padding:16px 28px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#64748b;">© ${new Date().getFullYear()} divieight</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

export async function sendEmail(to: string, subject: string, body: string, link: string | null, linkLabel: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from: resendFrom(), to: [to], subject, html: html(subject, body, link, linkLabel) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** An owner who switched this type's email off. Required notices ignore the setting. */
async function emailSwitchedOff(db: Db, userId: string | null, type: string | undefined) {
  if (!userId || !type || !isOwnerNotificationType(type) || isMandatoryNotification(type)) return false;
  const { data } = await db.from("owner_notification_preferences").select("email_enabled").eq("user_id", userId).eq("type", type).maybeSingle();
  return data?.email_enabled === false;
}

/**
 * The emails of every active Account Member of the Buyer Account this login belongs to. Members have no logins of
 * their own, so a notice to the account has to reach each of them at their own address. Empty for anyone who isn't
 * a Buyer Account's login (agents, sellers, admins).
 */
export async function memberEmailsFor(db: Db, authUserId: string | null | undefined): Promise<string[]> {
  if (!authUserId) return [];
  const { data: acct } = await db.from("buyer_accounts").select("id").eq("auth_user_id", authUserId).maybeSingle();
  if (!acct) return [];
  const { data } = await db.from("account_members").select("email").eq("buyer_account_id", (acct as { id: string }).id).eq("status", "active");
  return ((data ?? []) as Array<{ email: string | null }>).map((m) => (m.email ?? "").trim()).filter(Boolean);
}

/** The addresses to write to, once each (case and spacing aside). */
export const uniqueEmails = (list: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of list) {
    const v = (e ?? "").trim();
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
};

/** Portal notification + email. Delivery failures are audited, never thrown. */
export async function deliver(
  db: Db,
  recipient: AuthorizationRecipient,
  args: {
    subject: string;
    message: string;
    link?: string | null;
    requestId?: string | null;
    /** Portal notification type; defaults to "authorization". */
    type?: string;
    /** The property this is about: the bell groups by it. */
    propertyId?: string | null;
    /** Makes this one notification per person for this event, however often it's sent. */
    dedupeKey?: string | null;
  },
) {
  let portal = false;
  if (recipient.authUserId) {
    const row = { seller_id: recipient.authUserId, message: args.message, type: args.type ?? "authorization" };
    const scoped = {
      ...row,
      ...(args.propertyId ? { property_id: args.propertyId } : {}),
      ...(args.dedupeKey ? { dedupe_key: args.dedupeKey } : {}),
    };
    let { error } = await db.from("notifications").insert(scoped);
    // Already told about this event: no second notification, and no second email.
    if (error?.code === "23505") return { portal: false, emailed: false, duplicate: true };
    // Before owner-notifications.sql is run, still reach them.
    if (error && /property_id|dedupe_key/.test(error.message ?? "")) ({ error } = await db.from("notifications").insert(row));
    portal = !error;
  }
  let email = recipient.email;
  // A retained seller's address is on their seller row.
  if (!email && recipient.authUserId && args.type && isOwnerNotificationType(args.type)) {
    const { data } = await db.from("sellers").select("email").eq("id", recipient.authUserId).maybeSingle();
    email = (data?.email as string | null | undefined) ?? null;
  }
  // A Buyer Account's notice goes to the login's address and to each member's own address.
  const addresses = uniqueEmails([email, ...(await memberEmailsFor(db, recipient.authUserId))]);
  let emailed = false;
  if (addresses.length > 0 && !(await emailSwitchedOff(db, recipient.authUserId, args.type))) {
    for (const to of addresses) {
      const ok = await sendEmail(to, args.subject, args.message, args.link ?? null, args.type && (isOwnerNotificationType(args.type) || args.type === "former_seller_weeks") ? "Open in divieight" : "Open the authorization request");
      emailed = emailed || ok;
    }
  }

  if (!portal && !emailed) {
    await db.from("audit_log").insert({
      actor_id: null,
      actor_type: "system",
      action_type: "authorization.notification_failed",
      entity_type: "authorization_request",
      entity_id: args.requestId ?? null,
      metadata: { recipient: recipient.authUserId, subject: args.subject },
    });
  }
  return { portal, emailed, duplicate: false };
}

export async function adminRecipients(db: Db): Promise<AuthorizationRecipient[]> {
  const { data } = await db.from("user_roles").select("user_id").eq("role", "admin");
  return ((data ?? []) as Array<{ user_id: string }>).map((r) => ({
    authUserId: r.user_id,
    email: null,
  }));
}
