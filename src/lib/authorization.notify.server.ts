import { resendFrom } from "@/lib/email-sender";

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

function html(subject: string, body: string, link: string | null) {
  return `<!doctype html><html><body style="margin:0;background:#f6f8f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
      <tr><td style="background:#0b3d5c;padding:20px 28px;"><div style="color:#fff;font-size:20px;font-weight:600;"><span style="color:#46ACB4;">divi</span>eight</div></td></tr>
      <tr><td style="padding:28px;">
        <h1 style="margin:0 0 12px;font-size:19px;font-weight:600;">${subject}</h1>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#334155;">${body}</p>
        ${link ? `<a href="${link}" style="display:inline-block;background:#46ACB4;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:500;">Open the authorization request</a>` : ""}
      </td></tr>
      <tr><td style="padding:16px 28px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#64748b;">© ${new Date().getFullYear()} divieight</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

async function sendEmail(to: string, subject: string, body: string, link: string | null) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from: resendFrom(), to: [to], subject, html: html(subject, body, link) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

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
  },
) {
  let portal = false;
  if (recipient.authUserId) {
    const { error } = await db
      .from("notifications")
      .insert({
        seller_id: recipient.authUserId,
        message: args.message,
        type: args.type ?? "authorization",
      });
    portal = !error;
  }
  const emailed = recipient.email
    ? await sendEmail(recipient.email, args.subject, args.message, args.link ?? null)
    : false;

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
  return { portal, emailed };
}

export async function adminRecipients(db: Db): Promise<AuthorizationRecipient[]> {
  const { data } = await db.from("user_roles").select("user_id").eq("role", "admin");
  return ((data ?? []) as Array<{ user_id: string }>).map((r) => ({
    authUserId: r.user_id,
    email: null,
  }));
}
