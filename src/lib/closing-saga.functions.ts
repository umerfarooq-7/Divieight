import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabase } from "@/integrations/supabase/client";
import type { SagaOutcome } from "@/lib/saga/orchestrator.server";

/** Closing Ping Saga — admin monitor + resume, and the agent Commission Dashboard. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function requireAdmin(userId: string) {
  const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (!data) throw new Error("Not authorized");
}

export interface ClosingSagaView {
  propertyId: string;
  label: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  steps: Array<{ step_name: string; status: string; attempts: number; last_error: string | null }>;
  openFailure: { failed_step: string; error_detail: string; created_at: string } | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form jsonb
  lastCheck: { status: string; platform_total_cents: number; title_total_cents: number | null; differences: any[]; checked_at: string } | null;
}

export const listClosingSagas = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ sagas: ClosingSagaView[] }> => {
    await requireAdmin(context.claims?.sub as string);
    const db = await adminDb();
    const { CLOSING_SAGA_TYPE } = await import("@/lib/closing-saga.server");
    const { data: runs } = await db
      .from("saga_runs")
      .select("id, saga_key, status, started_at, completed_at")
      .eq("saga_type", CLOSING_SAGA_TYPE)
      .order("started_at", { ascending: false });
    const out: ClosingSagaView[] = [];
    for (const r of (runs ?? []) as Array<{ id: string; saga_key: string; status: string; started_at: string; completed_at: string | null }>) {
      const { data: p } = await db.from("properties").select("address, city, state").eq("id", r.saga_key).maybeSingle();
      const { data: steps } = await db
        .from("saga_step_executions")
        .select("step_name, status, attempts, last_error, started_at")
        .eq("run_id", r.id)
        .order("started_at", { ascending: true });
      const { data: fail } = await db
        .from("saga_failures")
        .select("failed_step, error_detail, created_at")
        .eq("saga_type", CLOSING_SAGA_TYPE)
        .eq("saga_key", r.saga_key)
        .is("resolved_at", null)
        .limit(1);
      const { data: check } = await db
        .from("disbursement_checks")
        .select("status, platform_total_cents, title_total_cents, differences, checked_at")
        .eq("property_id", r.saga_key)
        .order("checked_at", { ascending: false })
        .limit(1);
      out.push({
        propertyId: r.saga_key,
        label: p ? `${p.address}, ${p.city}, ${p.state}` : r.saga_key,
        status: r.status,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        steps: (steps ?? []) as ClosingSagaView["steps"],
        openFailure: ((fail ?? []) as ClosingSagaView["openFailure"][])[0] ?? null,
        lastCheck: ((check ?? []) as ClosingSagaView["lastCheck"][])[0] ?? null,
      });
    }
    return { sagas: out };
  });

/** Manual intervention: resume a dead-lettered closing saga after fixing the cause. */
export const resumeClosingSaga = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => {
    if (!input?.propertyId) throw new Error("Missing property");
    return input;
  })
  .handler(async ({ data, context }): Promise<SagaOutcome> => {
    const userId = context.claims?.sub as string;
    await requireAdmin(userId);
    const db = await adminDb();
    await db.from("audit_log").insert({
      actor_id: userId,
      actor_type: "admin",
      action_type: "closing_saga.manual_resume_requested",
      entity_type: "property",
      entity_id: data.propertyId,
      metadata: {},
    });
    const { startClosingSaga } = await import("@/lib/closing-saga.server");
    return startClosingSaga(db, data.propertyId, { resume: true });
  });

export interface CommissionLedgerRow {
  id: string;
  property_id: string;
  propertyLabel: string;
  share_number: number;
  role: string;
  gross_cents: number;
  premium_to_hla_cents: number;
  premium_received_cents: number;
  net_cents: number;
  brokerageName: string;
  status: string;
  unlocked_at: string;
}

/** The signed-in agent's Commission Dashboard. */
export const listMyCommissions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: CommissionLedgerRow[] }> => {
    const db = await adminDb();
    const { data: agent } = await db.from("agents").select("id").eq("auth_user_id", context.claims?.sub as string).maybeSingle();
    if (!agent) return { rows: [] };
    const { data } = await db
      .from("commission_ledger")
      .select("*")
      .eq("agent_id", agent.id)
      .order("unlocked_at", { ascending: false });
    const rows = (data ?? []) as Array<Omit<CommissionLedgerRow, "propertyLabel" | "brokerageName"> & { broker_id: string }>;
    const pids = [...new Set(rows.map((r) => r.property_id))];
    const bids = [...new Set(rows.map((r) => r.broker_id))];
    const { data: props } = pids.length ? await db.from("properties").select("id, address, city, state").in("id", pids) : { data: [] };
    const { data: brokers } = bids.length ? await db.from("brokers").select("id, brokerage_name").in("id", bids) : { data: [] };
    const pl = new Map(((props ?? []) as Array<{ id: string; address: string; city: string; state: string }>).map((p) => [p.id, `${p.address}, ${p.city}, ${p.state}`]));
    const bn = new Map(((brokers ?? []) as Array<{ id: string; brokerage_name: string }>).map((b) => [b.id, b.brokerage_name]));
    return {
      rows: rows.map((r) => ({ ...r, propertyLabel: pl.get(r.property_id) ?? "Property", brokerageName: bn.get(r.broker_id) ?? "Broker of Record" })),
    };
  });
