/**
 * Saga proof of concept (Prompt 12) — trivial steps that only write to
 * `saga_test_log`. Deliberately NOT connected to property, commission or
 * closing data.
 */
import { runSaga, type SagaStep, type SagaStepContext } from "./orchestrator.server";

type Db = { from: (t: string) => any };

export const POC_SAGA_TYPE = "poc_closing_ping";

export type PocScenario = "full_success" | "retry_success" | "permanent_failure" | "crash_after_effect";

export const POC_SCENARIOS: Record<PocScenario, string> = {
  full_success: "All four steps succeed first time",
  retry_success: "Step D fails twice, then succeeds on the 3rd attempt",
  permanent_failure: "Step D always fails — retries exhaust, saga lands in saga_failures",
  crash_after_effect: "Step C writes its log line, then crashes; the retry must not write it twice",
};

/** Side effect of every PoC step: one log line, deduped by the step's idempotency key. */
async function writeLog(db: Db, ctx: SagaStepContext, message: string) {
  const { error } = await db.from("saga_test_log").insert({
    idempotency_key: ctx.idempotencyKey,
    saga_key: ctx.sagaKey,
    step_name: ctx.stepName,
    message,
  });
  // Already written by an earlier attempt that crashed afterwards — that's the point.
  if (error && !/duplicate|unique/i.test(error.message)) throw new Error(error.message);
}

export function pocSteps(db: Db, scenario: PocScenario, opts: { fixed?: boolean } = {}): SagaStep[] {
  const log = (name: string): SagaStep => ({
    name,
    run: async (ctx) => {
      await writeLog(db, ctx, `log step ${name}`);
      return { logged: true };
    },
  });
  const stepC: SagaStep =
    scenario === "crash_after_effect"
      ? {
          name: "C",
          run: async (ctx) => {
            await writeLog(db, ctx, "log step C");
            if (ctx.attempt === 1) throw new Error("Simulated crash after writing (before the step was recorded)");
            return { logged: true };
          },
        }
      : log("C");
  const stepD: SagaStep =
    scenario === "retry_success"
      ? {
          name: "D",
          maxAttempts: 3,
          run: async (ctx) => {
            if (ctx.attempt < 3) throw new Error(`Simulated transient failure on attempt ${ctx.attempt}`);
            await writeLog(db, ctx, "log step D (after retries)");
            return { recoveredOnAttempt: ctx.attempt };
          },
        }
      : scenario === "permanent_failure" && !opts.fixed
        ? {
            name: "D",
            maxAttempts: 3,
            run: async () => {
              throw new Error("Simulated permanent failure on step D");
            },
          }
        : log("D");
  return [log("A"), log("B"), stepC, stepD];
}

export function runPocSaga(db: Db, scenario: PocScenario, sagaKey: string, opts: { retryDelayMs?: number } = {}) {
  return runSaga(db, {
    sagaType: POC_SAGA_TYPE,
    sagaKey,
    steps: pocSteps(db, scenario),
    payload: { scenario, trivial: true },
    retryDelayMs: opts.retryDelayMs ?? 200,
  });
}

/** Manual intervention: resume a dead-lettered PoC saga after "fixing" the cause. */
export function resumePocSaga(db: Db, scenario: PocScenario, sagaKey: string, opts: { retryDelayMs?: number } = {}) {
  return runSaga(db, {
    sagaType: POC_SAGA_TYPE,
    sagaKey,
    steps: pocSteps(db, scenario, { fixed: true }),
    payload: { scenario, trivial: true },
    retryDelayMs: opts.retryDelayMs ?? 200,
    resumeFailed: true,
  });
}
