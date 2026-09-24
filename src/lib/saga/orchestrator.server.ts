/**
 * Minimal saga orchestrator (Prompt 12 proof of concept; the real Closing
 * Ping Saga in Prompt 13 builds on this).
 *
 * Guarantees:
 *  - Idempotency: one run per (sagaType, sagaKey). Re-running a completed saga
 *    executes nothing; re-running a running/failed one resumes and skips every
 *    step already recorded as succeeded.
 *  - Each step gets a stable idempotency key (`type:key:step`) so its external
 *    effect can dedupe even if it crashed after acting but before being marked
 *    succeeded.
 *  - Retries: a failing step is retried up to `maxAttempts` with backoff.
 *  - Dead letter: when retries are exhausted the run is marked failed and a
 *    `saga_failures` row is written for manual review. Later steps never run
 *    on a failed saga, so state is never half-advanced silently.
 */

type Db = { from: (t: string) => any };

/**
 * Throw from a step when retrying can't help (a business rule blocks it, not a
 * transient fault). The saga goes straight to saga_failures with this message.
 */
export class NonRetryableError extends Error {
  readonly retryable = false;
}

export interface SagaStepContext {
  sagaType: string;
  sagaKey: string;
  stepName: string;
  idempotencyKey: string;
  attempt: number;
  payload: Record<string, unknown>;
}

export interface SagaStep {
  name: string;
  run: (ctx: SagaStepContext) => Promise<Record<string, unknown> | void>;
  /** Total tries including the first (default 3). */
  maxAttempts?: number;
}

export interface SagaOptions {
  sagaType: string;
  sagaKey: string;
  steps: SagaStep[];
  payload?: Record<string, unknown>;
  /** Base backoff between attempts; doubles each retry (default 250ms). */
  retryDelayMs?: number;
  /** How long a runner may hold the saga before another may take over (default 5 min). */
  leaseMs?: number;
  /** Resume a saga that previously landed in the dead letter (manual intervention). */
  resumeFailed?: boolean;
  /** Observer for every transition (used for audit logging); errors in it are swallowed. */
  onEvent?: (event: SagaEvent) => Promise<void> | void;
}

export type SagaEvent =
  | { type: "saga_started" | "saga_resumed"; runId: string }
  | { type: "step_skipped"; runId: string; step: string }
  | { type: "step_attempt"; runId: string; step: string; attempt: number }
  | { type: "step_retry"; runId: string; step: string; attempt: number; error: string }
  | { type: "step_succeeded"; runId: string; step: string; attempt: number }
  | { type: "step_failed"; runId: string; step: string; attempts: number; error: string }
  | { type: "saga_dead_lettered"; runId: string; step: string; error: string }
  | { type: "saga_completed"; runId: string };

export type SagaOutcome =
  | { status: "completed"; runId: string; executedSteps: string[]; skippedSteps: string[] }
  | { status: "already_completed"; runId: string }
  | { status: "failed"; runId: string; failedStep: string; error: string; executedSteps: string[]; skippedSteps: string[] }
  | { status: "needs_manual_intervention"; runId: string }
  | { status: "in_progress"; runId: string };

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

async function claimRun(db: Db, opts: SagaOptions, leaseMs: number) {
  const now = Date.now();
  const lease = new Date(now + leaseMs).toISOString();
  const { data: created, error } = await db
    .from("saga_runs")
    .insert({
      saga_type: opts.sagaType,
      saga_key: opts.sagaKey,
      status: "running",
      payload: opts.payload ?? {},
      lease_expires_at: lease,
    })
    .select("id")
    .maybeSingle();
  if (created) return { runId: created.id as string, claimed: true as const, resumed: false };
  if (error && !/duplicate|unique/i.test(error.message)) throw new Error(error.message);

  const { data: run } = await db
    .from("saga_runs")
    .select("id, status, lease_expires_at")
    .eq("saga_type", opts.sagaType)
    .eq("saga_key", opts.sagaKey)
    .maybeSingle();
  if (!run) throw new Error("Saga run vanished while claiming");
  if (run.status === "completed") return { runId: run.id as string, claimed: false as const, reason: "already_completed" as const };
  if (run.status === "failed" && !opts.resumeFailed)
    return { runId: run.id as string, claimed: false as const, reason: "needs_manual_intervention" as const };
  if (run.status === "running" && run.lease_expires_at && Date.parse(run.lease_expires_at) > now)
    return { runId: run.id as string, claimed: false as const, reason: "in_progress" as const };

  // Take over: a failed run being resumed, or a running run whose lease expired.
  // The status/lease guard makes the take-over a compare-and-set.
  let q = db
    .from("saga_runs")
    .update({ status: "running", lease_expires_at: lease, updated_at: new Date().toISOString() })
    .eq("id", run.id)
    .eq("status", run.status);
  if (run.lease_expires_at) q = q.eq("lease_expires_at", run.lease_expires_at);
  const { data: taken } = await q.select("id");
  if (!((taken ?? []) as unknown[]).length) return { runId: run.id as string, claimed: false as const, reason: "in_progress" as const };
  return { runId: run.id as string, claimed: true as const, resumed: true };
}

export async function runSaga(db: Db, opts: SagaOptions): Promise<SagaOutcome> {
  const leaseMs = opts.leaseMs ?? 5 * 60_000;
  const retryDelay = opts.retryDelayMs ?? 250;
  const claim = await claimRun(db, opts, leaseMs);
  if (!claim.claimed) return { status: claim.reason, runId: claim.runId } as SagaOutcome;
  const runId = claim.runId;
  const emit = async (e: SagaEvent) => {
    try {
      await opts.onEvent?.(e);
    } catch {
      // Observers must never break the saga.
    }
  };
  await emit({ type: claim.resumed ? "saga_resumed" : "saga_started", runId });

  const executed: string[] = [];
  const skipped: string[] = [];

  for (const step of opts.steps) {
    const idempotencyKey = `${opts.sagaType}:${opts.sagaKey}:${step.name}`;
    const { data: prior } = await db
      .from("saga_step_executions")
      .select("id, status, attempts")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (prior?.status === "succeeded") {
      skipped.push(step.name);
      await emit({ type: "step_skipped", runId, step: step.name });
      continue;
    }

    let execId = prior?.id as string | undefined;
    let attempts = Number(prior?.attempts ?? 0);
    if (!execId) {
      const { data: row, error } = await db
        .from("saga_step_executions")
        .insert({ run_id: runId, step_name: step.name, idempotency_key: idempotencyKey, status: "running", attempts: 0 })
        .select("id")
        .maybeSingle();
      if (error || !row) throw new Error(error?.message ?? "Could not record step");
      execId = row.id;
    } else {
      await db.from("saga_step_executions").update({ status: "running" }).eq("id", execId);
    }

    const max = Math.max(1, step.maxAttempts ?? 3);
    let lastError = "";
    let ok = false;
    // A resumed step gets a fresh retry budget, but its attempt counter keeps climbing.
    for (let i = 0; i < max; i++) {
      attempts += 1;
      await emit({ type: "step_attempt", runId, step: step.name, attempt: attempts });
      try {
        const result = await step.run({
          sagaType: opts.sagaType,
          sagaKey: opts.sagaKey,
          stepName: step.name,
          idempotencyKey,
          attempt: attempts,
          payload: opts.payload ?? {},
        });
        await db
          .from("saga_step_executions")
          .update({ status: "succeeded", attempts, result: result ?? {}, last_error: null, completed_at: new Date().toISOString() })
          .eq("id", execId);
        ok = true;
        await emit({ type: "step_succeeded", runId, step: step.name, attempt: attempts });
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        await db.from("saga_step_executions").update({ attempts, last_error: lastError }).eq("id", execId);
        if ((e as { retryable?: boolean })?.retryable === false) break;
        if (i < max - 1) {
          await emit({ type: "step_retry", runId, step: step.name, attempt: attempts, error: lastError });
          await sleep(retryDelay * 2 ** i);
        }
      }
    }

    if (!ok) {
      await db.from("saga_step_executions").update({ status: "failed" }).eq("id", execId);
      await db
        .from("saga_runs")
        .update({ status: "failed", lease_expires_at: null, updated_at: new Date().toISOString() })
        .eq("id", runId);
      await db.from("saga_failures").insert({
        saga_type: opts.sagaType,
        saga_key: opts.sagaKey,
        failed_step: step.name,
        error_detail: `After ${attempts} attempt(s): ${lastError}`,
      });
      await emit({ type: "step_failed", runId, step: step.name, attempts, error: lastError });
      await emit({ type: "saga_dead_lettered", runId, step: step.name, error: lastError });
      return { status: "failed", runId, failedStep: step.name, error: lastError, executedSteps: executed, skippedSteps: skipped };
    }
    executed.push(step.name);
  }

  const now = new Date().toISOString();
  await db.from("saga_runs").update({ status: "completed", completed_at: now, lease_expires_at: null, updated_at: now }).eq("id", runId);
  if (opts.resumeFailed)
    await db
      .from("saga_failures")
      .update({ resolved_at: now, resolution_note: "Resumed after manual intervention and completed." })
      .eq("saga_type", opts.sagaType)
      .eq("saga_key", opts.sagaKey)
      .is("resolved_at", null);
  await emit({ type: "saga_completed", runId });
  return { status: "completed", runId, executedSteps: executed, skippedSteps: skipped };
}
