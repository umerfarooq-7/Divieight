import { adminRecipients, deliver } from "@/lib/authorization.notify.server";
import {
  AUTHORIZATION_ACTION_LABELS,
  AUTHORIZATION_SETTINGS_KEY,
  DEFAULT_AUTHORIZATION_SETTINGS,
  authorizationState,
  type AuthorizationAction,
  type AuthorizationRequestRow,
} from "@/lib/authorization";

/**
 * Time-out and escalation for the Buyer-Authorization Workflow.
 *
 * Escalation NEVER grants authorization. A request that passes its deadline
 * stays pending and is escalated with a follow-up notification; for
 * market-driven windows the Heavy Lifting Agent and the Manager are alerted
 * too. divieight, LLC as Manager has no authority to act without every
 * Preferred Member's express confirmation.
 */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function audit(db: Db, actionType: string, entityId: string, metadata: object, actorId: string | null) {
  await db.from("audit_log").insert({
    actor_id: actorId,
    actor_type: actorId ? "admin" : "system",
    action_type: actionType,
    entity_type: "authorization_request",
    entity_id: entityId,
    metadata,
  });
}

export interface AuthorizationSweepResult {
  checked: number;
  escalated: number;
  secondEscalations: number;
}

export async function runAuthorizationEscalationSweep(
  actorId: string | null = null,
): Promise<AuthorizationSweepResult> {
  const db = await adminDb();
  const now = Date.now();

  const { data: setting } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", AUTHORIZATION_SETTINGS_KEY)
    .maybeSingle();
  const settings = { ...DEFAULT_AUTHORIZATION_SETTINGS, ...((setting?.value as object) ?? {}) };

  const { data } = await db
    .from("authorization_requests")
    .select("*")
    .eq("status", "pending")
    .lt("deadline_at", new Date(now).toISOString())
    .order("deadline_at", { ascending: true })
    .limit(100);

  const rows = (data ?? []) as AuthorizationRequestRow[];
  let escalated = 0;
  let secondEscalations = 0;

  for (const row of rows) {
    const { data: members } = await db
      .from("account_members")
      .select("id, full_name, role")
      .eq("buyer_account_id", row.buyer_account_id)
      .eq("status", "active");
    const { data: responses } = await db
      .from("authorization_responses")
      .select(
        "id, request_id, account_member_id, decision, signed_name, on_behalf_of_member_id, authority_basis, responded_at",
      )
      .eq("request_id", row.id);

    const state = authorizationState(row, (responses ?? []) as any, (members ?? []) as any, now);
    if (state.outstanding.length === 0) continue; // resolution runs on response

    const firstDue = !row.escalated_at;
    const secondDue =
      !firstDue &&
      !row.escalated_second_at &&
      new Date(row.escalated_at as string).getTime() +
        settings.second_escalation_hours * 36e5 <
        now;
    if (!firstDue && !secondDue) continue;

    const { data: property } = await db
      .from("properties")
      .select("address, city, state")
      .eq("id", row.property_id)
      .maybeSingle();
    const where = property
      ? `${property.address}, ${property.city}, ${property.state}`
      : "your subject property";
    const label = AUTHORIZATION_ACTION_LABELS[row.action_type as AuthorizationAction];

    const { data: buyer } = await db
      .from("buyer_accounts")
      .select("auth_user_id, email")
      .eq("id", row.buyer_account_id)
      .maybeSingle();

    if (buyer) {
      await deliver(
        db,
        { authUserId: buyer.auth_user_id, email: buyer.email },
        {
          subject: `Still awaiting your authorization — ${label}`,
          message: `The response deadline for ${label} on ${where} has passed and your Buyer Account's express authorization is still outstanding (${state.outstanding.length} member${state.outstanding.length === 1 ? "" : "s"} yet to respond). ${row.consequence_text} No action has been or will be taken without your confirmation.`,
          link: `/buyer/authorizations/${row.id}`,
          requestId: row.id,
        },
      );
    }

    if (row.agent_id) {
      const { data: agent } = await db
        .from("agents")
        .select("auth_user_id, email")
        .eq("id", row.agent_id)
        .maybeSingle();
      if (agent)
        await deliver(
          db,
          { authUserId: agent.auth_user_id, email: agent.email },
          {
            subject: `Buyer authorization overdue — ${label}`,
            message: `Your buyer has not yet authorized ${label} on ${where}. The deadline has passed; the request remains pending and cannot proceed without express confirmation.`,
            link: "/agent/authorizations",
            requestId: row.id,
          },
        );
    }

    // Market-driven windows (and every second escalation) widen to the Heavy
    // Lifting Agent and the Manager.
    const widen = row.market_driven || secondDue;
    if (widen) {
      const { data: pod } = await db
        .from("pods")
        .select("heavy_lifting_agent_id")
        .eq("property_id", row.property_id)
        .maybeSingle();
      if (pod?.heavy_lifting_agent_id) {
        const { data: hla } = await db
          .from("agents")
          .select("auth_user_id, email")
          .eq("id", pod.heavy_lifting_agent_id)
          .maybeSingle();
        if (hla)
          await deliver(
            db,
            { authUserId: hla.auth_user_id, email: hla.email },
            {
              subject: `Market-driven authorization window at risk — ${where}`,
              message: `A buyer authorization for ${label} on ${where} is past its response deadline. The window is market-driven and may lapse. No authorization can be granted on the buyer's behalf.`,
              link: "/agent/authorizations",
              requestId: row.id,
            },
          );
      }
      for (const admin of await adminRecipients(db)) {
        await deliver(db, admin, {
          subject: `Authorization overdue — Manager alert`,
          message: `${label} on ${where} is past its response deadline with ${state.outstanding.length} outstanding member response(s). The Manager has no authority to act; the request stays pending.`,
          link: "/admin/authorizations",
          requestId: row.id,
        });
      }
    }

    await db
      .from("authorization_requests")
      .update(
        firstDue
          ? { escalated_at: new Date(now).toISOString() }
          : { escalated_second_at: new Date(now).toISOString() },
      )
      .eq("id", row.id);

    await audit(
      db,
      "authorization.non_response",
      row.id,
      {
        stage: firstDue ? "first" : "second",
        deadline_at: row.deadline_at,
        outstanding_members: state.outstanding.length,
        market_driven: row.market_driven,
        notified_hla_and_manager: widen,
        auto_granted: false,
      },
      actorId,
    );
    await audit(
      db,
      "authorization.escalated",
      row.id,
      { stage: firstDue ? "first" : "second", action: row.action_type },
      actorId,
    );

    if (firstDue) escalated += 1;
    else secondEscalations += 1;
  }

  return { checked: rows.length, escalated, secondEscalations };
}
