import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  PENDING_TETHER_ALERT_DAYS,
  TETHER_RESPONSE_HOURS,
  evaluateTetherResolution,
  pendingTetherOverdue,
  type TetherResolutionReason,
} from "@/lib/tether-resolution";

type Db = { from: (t: string) => any };

export interface TetherAlertRow {
  buyerAccountId: string;
  buyerEmail: string | null;
  market: string | null;
  designatedAgentName: string | null;
  designatedAgentEmail: string | null;
  goldenTicketIssuedAt: string | null;
  lastSuccessfulContactAt: string | null;
  notifiedAt: string | null;
  deliveryFailed: boolean;
  flaggedAt: string | null;
  reason: TetherResolutionReason | null;
  pendingTetherAlertAt: string | null;
  tetherStatus: string | null;
}

const SELECT =
  "id, auth_user_id, email, primary_target_market, tether_status, designation_expired, " +
  "designated_agent_name, designated_agent_email, designation_expiry_notified_at, " +
  "designation_notice_delivery_failed, last_successful_contact_at, golden_ticket_issued, " +
  "golden_ticket_issued_at, tether_resolution_flagged_at, tether_resolution_reason, " +
  "pending_tether_alert_at";

function toRow(r: any): TetherAlertRow {
  return {
    buyerAccountId: r.id,
    buyerEmail: r.email ?? null,
    market: r.primary_target_market ?? null,
    designatedAgentName: r.designated_agent_name ?? null,
    designatedAgentEmail: r.designated_agent_email ?? null,
    goldenTicketIssuedAt: r.golden_ticket_issued_at ?? null,
    lastSuccessfulContactAt: r.last_successful_contact_at ?? null,
    notifiedAt: r.designation_expiry_notified_at ?? null,
    deliveryFailed: Boolean(r.designation_notice_delivery_failed),
    flaggedAt: r.tether_resolution_flagged_at ?? null,
    reason: (r.tether_resolution_reason ?? null) as TetherResolutionReason | null,
    pendingTetherAlertAt: r.pending_tether_alert_at ?? null,
    tetherStatus: r.tether_status ?? null,
  };
}

/**
 * Detection sweep. Idempotent: flags are raised once, refreshed only when the
 * reason changes, and cleared automatically once the buyer resolves.
 */
export async function runTetherResolutionSweep(
  db: Db,
): Promise<{ scanned: number; flagged: number; cleared: number; overdue: number }> {
  const now = new Date();
  const { data: rows } = await db
    .from("buyer_accounts")
    .select(SELECT)
    .eq("golden_ticket_issued", true)
    .neq("tether_status", "tethered");

  let flagged = 0;
  let cleared = 0;
  let overdue = 0;

  for (const b of rows ?? []) {
    const verdict = evaluateTetherResolution({
      tetherStatus: b.tether_status ?? null,
      designationExpired: Boolean(b.designation_expired),
      designationExpiryNotifiedAt: b.designation_expiry_notified_at ?? null,
      designationNoticeDeliveryFailed: Boolean(b.designation_notice_delivery_failed),
      now,
    });

    if (verdict.flagged && b.tether_resolution_reason !== verdict.reason) {
      await db
        .from("buyer_accounts")
        .update({
          tether_resolution_flagged_at: b.tether_resolution_flagged_at ?? now.toISOString(),
          tether_resolution_reason: verdict.reason,
        })
        .eq("id", b.id);
      await db.from("audit_log").insert({
        actor_id: b.auth_user_id,
        actor_type: "system",
        action_type: "buyer.tether_resolution_flagged",
        entity_type: "buyer_account",
        entity_id: b.id,
        metadata: {
          reason: verdict.reason,
          designated_agent: b.designated_agent_name ?? b.designated_agent_email ?? null,
          notified_at: b.designation_expiry_notified_at ?? null,
          last_successful_contact_at: b.last_successful_contact_at ?? null,
          golden_ticket_issued_at: b.golden_ticket_issued_at ?? null,
          response_window_hours: TETHER_RESPONSE_HOURS,
        },
      });
      flagged += 1;
    } else if (!verdict.flagged && b.tether_resolution_flagged_at) {
      await db
        .from("buyer_accounts")
        .update({ tether_resolution_flagged_at: null, tether_resolution_reason: null })
        .eq("id", b.id);
      await db.from("audit_log").insert({
        actor_id: b.auth_user_id,
        actor_type: "system",
        action_type: "buyer.tether_resolution_cleared",
        entity_type: "buyer_account",
        entity_id: b.id,
        metadata: { previous_reason: b.tether_resolution_reason ?? null },
      });
      cleared += 1;
    }

    // Separate 14-day alert, raised regardless of the cause above.
    const isOverdue = pendingTetherOverdue(b.tether_status ?? null, b.golden_ticket_issued_at ?? null, now);
    if (isOverdue && !b.pending_tether_alert_at) {
      await db
        .from("buyer_accounts")
        .update({ pending_tether_alert_at: now.toISOString() })
        .eq("id", b.id);
      await db.from("audit_log").insert({
        actor_id: b.auth_user_id,
        actor_type: "system",
        action_type: "buyer.pending_tether_overdue",
        entity_type: "buyer_account",
        entity_id: b.id,
        metadata: {
          days_threshold: PENDING_TETHER_ALERT_DAYS,
          golden_ticket_issued_at: b.golden_ticket_issued_at ?? null,
          tether_status: b.tether_status ?? null,
        },
      });
      overdue += 1;
    } else if (!isOverdue && b.pending_tether_alert_at) {
      await db.from("buyer_accounts").update({ pending_tether_alert_at: null }).eq("id", b.id);
    }
  }

  return { scanned: (rows ?? []).length, flagged, cleared, overdue };
}

async function assertAdmin(supabase: any, userId: string) {
  const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (!isAdmin) throw new Error("Forbidden");
}

/** Admin dashboard feed: awaiting-tether-resolution and 14-day overdue alerts. */
export const getTetherAlerts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(
    async ({
      context,
    }): Promise<{ awaitingResolution: TetherAlertRow[]; pendingOverdue: TetherAlertRow[] }> => {
      const { supabase, userId } = context;
      await assertAdmin(supabase, userId);

      const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
      const db = supabaseAdmin as unknown as Db;

      const { data: rows } = await db
        .from("buyer_accounts")
        .select(SELECT)
        .eq("golden_ticket_issued", true)
        .neq("tether_status", "tethered")
        .or("tether_resolution_flagged_at.not.is.null,pending_tether_alert_at.not.is.null");

      const all: TetherAlertRow[] = (rows ?? []).map(toRow);
      return {
        awaitingResolution: all.filter((r: TetherAlertRow) => r.flaggedAt),
        pendingOverdue: all.filter((r: TetherAlertRow) => r.pendingTetherAlertAt),
      };
    },
  );

/** Manual admin trigger for the detection sweep. */
export const runTetherAlertSweep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
    return runTetherResolutionSweep(supabaseAdmin as unknown as Db);
  });
