import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { mailTransport, sendMail } from "@/lib/mailer.server";

type EmailKind = "identity_submitted" | "listing_live" | "enrollment_fee_paid";

const SUBJECTS: Record<EmailKind, string> = {
  identity_submitted: "Your identity verification was submitted",
  listing_live: "Your property listing is now live",
  enrollment_fee_paid: "Your Platform Enrollment Fee payment was successful",
};

const BODIES: Record<EmailKind, string> = {
  identity_submitted:
    "Thanks for submitting your identity verification. Our team will review your documents shortly. You can continue your onboarding in the meantime.",
  listing_live:
    "Congratulations! Your property listing is now live on divieight. You can manage it anytime from your Seller Dashboard.",
  enrollment_fee_paid:
    "We've received your Platform Enrollment Fee payment. Your Legacy Seat and retained shares are secured. Thank you for joining divieight.",
};

function renderHtml(subject: string, body: string, recipient: string) {
  // Brand colors: primary teal #46ACB4, accent navy blue
  return `<!doctype html>
<html><body style="margin:0;background:#f6f8f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#0b3d5c;padding:20px 28px;">
          <div style="color:#ffffff;font-size:20px;font-weight:600;letter-spacing:-0.01em;">
            <span style="color:#46ACB4;">divi</span><span>eight</span>
          </div>
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;color:#0f172a;">${subject}</h1>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#334155;">Hi ${recipient.split("@")[0]},</p>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#334155;">${body}</p>
          <a href="#" style="display:inline-block;background:#46ACB4;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:500;">Open dashboard</a>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#64748b;">
          © ${new Date().getFullYear()} divieight — Fractional real estate co-ownership
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export const sendNotificationEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { kind: EmailKind }) => {
    if (!input || !SUBJECTS[input.kind]) throw new Error("Invalid kind");
    return input;
  })
  .handler(async ({ data, context }) => {
    const recipient = context.claims?.email as string | undefined;
    if (!recipient) return { sent: false, reason: "no_email" as const };

    if (mailTransport() === "none") {
      console.warn("[email] no mail transport is set up (SMTP_HOST/SMTP_USER/SMTP_PASS or RESEND_API_KEY) — skipping email send", {
        kind: data.kind,
      });
      return { sent: false, reason: "no_api_key" as const };
    }

    const subject = SUBJECTS[data.kind];
    const html = renderHtml(subject, BODIES[data.kind], recipient);

    const accepted = await sendMail({ to: recipient, subject, html });
    if (!accepted) {
      console.error("[email] the mail server refused the send", { kind: data.kind });
      return { sent: false, reason: "provider_error" as const, status: 502 };
    }
    return { sent: true as const };
  });
