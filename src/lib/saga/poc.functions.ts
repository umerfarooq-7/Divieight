import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabase } from "@/integrations/supabase/client";
import type { SagaOutcome } from "@/lib/saga/orchestrator.server";
import type { PocScenario } from "@/lib/saga/poc.server";

/** Admin-only controls for the saga proof of concept. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function requireAdmin(userId: string) {
  const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (!data) throw new Error("Not authorized");
}

const SCENARIOS: PocScenario[] = ["full_success", "retry_success", "permanent_failure", "crash_after_effect"];

export const runSagaPoc = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { scenario: PocScenario; sagaKey: string; resume?: boolean }) => {
    if (!SCENARIOS.includes(input?.scenario)) throw new Error("Unknown scenario");
    if (!input.sagaKey?.trim()) throw new Error("Missing saga key");
    return { ...input, sagaKey: input.sagaKey.trim() };
  })
  .handler(async ({ data, context }): Promise<SagaOutcome> => {
    const userId = context.claims?.sub as string;
    await requireAdmin(userId);
    const db = await adminDb();
    const poc = await import("@/lib/saga/poc.server");
    const outcome = data.resume
      ? await poc.resumePocSaga(db, data.scenario, data.sagaKey)
      : await poc.runPocSaga(db, data.scenario, data.sagaKey);
    await db.from("audit_log").insert({
      actor_id: userId,
      actor_type: "admin",
      action_type: data.resume ? "saga.poc_resumed" : "saga.poc_triggered",
      entity_type: "saga",
      entity_id: null,
      metadata: { scenario: data.scenario, saga_key: data.sagaKey, outcome: outcome.status },
    });
    return outcome;
  });

export interface PocRunView {
  id: string;
  saga_key: string;
  scenario: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  steps: Array<{ step_name: string; status: string; attempts: number; last_error: string | null }>;
  logLines: number;
}

export const listSagaPoc = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context.claims?.sub as string);
    const db = await adminDb();
    const { POC_SAGA_TYPE } = await import("@/lib/saga/poc.server");
    const { data: runs } = await db
      .from("saga_runs")
      .select("id, saga_key, status, payload, started_at, completed_at")
      .eq("saga_type", POC_SAGA_TYPE)
      .order("started_at", { ascending: false })
      .limit(20);
    const list = (runs ?? []) as Array<{ id: string; saga_key: string; status: string; payload: { scenario?: string }; started_at: string; completed_at: string | null }>;
    const out: PocRunView[] = [];
    for (const r of list) {
      const { data: steps } = await db
        .from("saga_step_executions")
        .select("step_name, status, attempts, last_error, started_at")
        .eq("run_id", r.id)
        .order("started_at", { ascending: true });
      const { data: logs } = await db.from("saga_test_log").select("id").eq("saga_key", r.saga_key);
      out.push({
        id: r.id,
        saga_key: r.saga_key,
        scenario: r.payload?.scenario ?? "—",
        status: r.status,
        started_at: r.started_at,
        completed_at: r.completed_at,
        steps: (steps ?? []) as PocRunView["steps"],
        logLines: ((logs ?? []) as unknown[]).length,
      });
    }
    const { data: failures } = await db
      .from("saga_failures")
      .select("id, saga_key, failed_step, error_detail, created_at, resolved_at, resolution_note")
      .eq("saga_type", POC_SAGA_TYPE)
      .order("created_at", { ascending: false })
      .limit(20);
    return {
      runs: out,
      failures: (failures ?? []) as Array<{ id: string; saga_key: string; failed_step: string; error_detail: string; created_at: string; resolved_at: string | null; resolution_note: string | null }>,
    };
  });
