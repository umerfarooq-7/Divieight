import { createServerFn } from "@tanstack/react-start";
import {
  GRACE_DAYS,
  STALL_DAYS,
  evaluateMaintenance,
  type MaintenanceAction,
} from "@/lib/enrollment-maintenance";

export interface MaintenanceResultRow {
  buyerAccountId: string;
  email: string;
  action: MaintenanceAction;
  daysInactive: number;
  graceDaysLeft: number;
}

export interface MaintenanceRunResult {
  scanned: number;
  warned: number;
  forfeited: number;
  rows: MaintenanceResultRow[];
}

function warningEmail(subject: string, body: string, recipient: string) {
  return `<!doctype html>
<html><body style="margin:0;background:#f6f8f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#0b3d5c;padding:20px 28px;">
          <div style="color:#ffffff;font-size:20px;font-weight:600;">
            <span style="color:#46ACB4;">divi</span><span>eight</span>
          </div>
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;">${subject}</h1>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#334155;">Hi ${recipient.split("@")[0]},</p>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#334155;">${body}</p>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#64748b;">
          © ${new Date().getFullYear()} divieight — Fractional real estate co-ownership
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** The account's address, and each active member's own: they have no logins, so this is how they hear. */
async function reminderAddresses(a: { auth_user_id: string; email: string }): Promise<string[]> {
  const { memberEmailsFor, uniqueEmails } = await import("@/lib/authorization.notify.server");
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return uniqueEmails([a.email, ...(await memberEmailsFor(supabaseAdmin as never, a.auth_user_id))]);
}

async function sendEmail(recipient: string, subject: string, body: string) {
  const { resendFrom } = await import("@/lib/email-sender");
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[enrollment] RESEND_API_KEY not set — skipping email", { recipient, subject });
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: resendFrom(),
      to: [recipient],
      subject,
      html: warningEmail(subject, body, recipient),
    }),
  });
  if (!res.ok) {
    console.error("[enrollment] Resend rejected the send", {
      status: res.status,
      recipient,
      subject,
      response: await res.text(),
    });
  }
}

/**
 * Scans every buyer account for stalled enrollments, sends the 30-day warning
 * and applies Priority Forfeiture after the grace period.
 *
 * TODO(cron): wire this to a real scheduler. Once pg_cron/pg_net are enabled,
 * schedule a daily POST to /api/public/enrollment-maintenance instead of
 * relying on the manual admin trigger.
 */
export const runEnrollmentMaintenance = createServerFn({ method: "POST" }).handler(
  async (): Promise<MaintenanceRunResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");

    const { data: accounts, error } = await supabaseAdmin
      .from("buyer_accounts")
      .select(
        "id, auth_user_id, email, onboarding_status, golden_ticket_issued, last_activity_at, stall_warning_sent_at",
      )
      .eq("golden_ticket_issued", false);
    if (error || !accounts) throw new Error(error?.message ?? "Failed to load buyer accounts");

    const { data: payments } = await supabaseAdmin
      .from("buyer_enrollment_payments")
      .select("buyer_account_id, status")
      .eq("status", "paid");
    const paidIds = new Set((payments ?? []).map((p) => p.buyer_account_id));

    const rows: MaintenanceResultRow[] = [];
    let warned = 0;
    let forfeited = 0;

    // A held member holds the whole account: held is not a failure and no automatic action may follow from it.
    const { heldAccountIds } = await import("@/lib/account-rollup");
    const held = await heldAccountIds(supabaseAdmin as never, accounts.map((x) => x.id));

    for (const a of accounts) {
      if (held.has(a.id)) {
        rows.push({ buyerAccountId: a.id, email: a.email, action: "none", daysInactive: 0, graceDaysLeft: 0 });
        continue;
      }
      const verdict = evaluateMaintenance({
        goldenTicketIssued: a.golden_ticket_issued,
        onboardingStatus: a.onboarding_status,
        paid: paidIds.has(a.id),
        lastActivityAt: a.last_activity_at,
        stallWarningSentAt: a.stall_warning_sent_at,
      });

      if (verdict.action === "warn") {
        const message = `Your enrollment has stalled for ${STALL_DAYS} days. Complete your verification within ${GRACE_DAYS} days or your priority rank will be reset.`;
        await supabaseAdmin
          .from("buyer_accounts")
          .update({ stall_warning_sent_at: new Date().toISOString() })
          .eq("id", a.id);
        await supabaseAdmin
          .from("notifications")
          .insert({ seller_id: a.auth_user_id, message, type: "enrollment_warning" });
        for (const to of await reminderAddresses(a)) await sendEmail(to, "Your divieight enrollment has stalled", message);
        warned += 1;
      }

      if (verdict.action === "forfeit") {
        const message =
          "Your priority position has been forfeited after the grace period expired. Your Platform Enrollment Fee remains non-refundable. You can re-activate at any time by resuming onboarding — a new priority timestamp is issued when you do.";
        await supabaseAdmin
          .from("buyer_accounts")
          .update({
            onboarding_status: "archived",
            priority_rank_timestamp: null,
            priority_rank: null,
            priority_forfeited_at: new Date().toISOString(),
          })
          .eq("id", a.id);
        await supabaseAdmin
          .from("notifications")
          .insert({ seller_id: a.auth_user_id, message, type: "priority_forfeited" });
        await supabaseAdmin.from("audit_log").insert({
          actor_id: a.auth_user_id,
          actor_type: "buyer",
          action_type: "buyer.priority_forfeited",
          entity_type: "buyer_account",
          entity_id: a.id,
          metadata: {
            days_inactive: verdict.daysInactive,
            stall_days: STALL_DAYS,
            grace_days: GRACE_DAYS,
          },
        });
        for (const to of await reminderAddresses(a)) await sendEmail(to, "Your divieight priority position was forfeited", message);
        forfeited += 1;
      }

      rows.push({
        buyerAccountId: a.id,
        email: a.email,
        action: verdict.action,
        daysInactive: verdict.daysInactive,
        graceDaysLeft: verdict.graceDaysLeft,
      });
    }

    return { scanned: accounts.length, warned, forfeited, rows };
  },
);
