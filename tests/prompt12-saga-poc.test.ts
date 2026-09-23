/**
 * Prompt 12 — Closing Ping Saga proof of concept. The three required
 * scenarios plus the edge cases the real saga will depend on.
 */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { runSaga } from "@/lib/saga/orchestrator.server";
import { runPocSaga, resumePocSaga, POC_SAGA_TYPE } from "@/lib/saga/poc.server";

const db = () => harness.db;
const fast = { retryDelayMs: 0 };
const logLines = (key: string) => db().table("saga_test_log").filter((l) => l.saga_key === key);
const steps = () =>
  Object.fromEntries(db().table("saga_step_executions").map((s) => [s.step_name, { status: s.status, attempts: s.attempts }]));

describe("Scenario 1 — full success", () => {
  it("runs A→D once; running again with the same key executes nothing", async () => {
    const r = await runPocSaga(db(), "full_success", "k1", fast);
    expect(r).toMatchObject({ status: "completed", executedSteps: ["A", "B", "C", "D"], skippedSteps: [] });
    expect(logLines("k1").map((l) => l.step_name)).toEqual(["A", "B", "C", "D"]);
    expect(Object.values(steps()).every((s) => s.status === "succeeded" && s.attempts === 1)).toBe(true);

    const again = await runPocSaga(db(), "full_success", "k1", fast);
    expect(again.status).toBe("already_completed");
    expect(logLines("k1")).toHaveLength(4);
    expect(db().table("saga_step_executions")).toHaveLength(4);
    expect(db().table("saga_runs")).toHaveLength(1);
    expect(db().table("saga_failures")).toHaveLength(0);
  });
});

describe("Scenario 2 — single-step failure, successful retry", () => {
  it("retries D until it succeeds; no step runs twice, nothing dead-lettered", async () => {
    const r = await runPocSaga(db(), "retry_success", "k2", fast);
    expect(r.status).toBe("completed");
    expect(steps().D).toEqual({ status: "succeeded", attempts: 3 });
    expect(steps().A).toEqual({ status: "succeeded", attempts: 1 });
    expect(logLines("k2").map((l) => l.step_name)).toEqual(["A", "B", "C", "D"]);
    expect(db().table("saga_failures")).toHaveLength(0);
  });

  it("a step that crashes AFTER its side effect doesn't duplicate it on retry", async () => {
    const r = await runPocSaga(db(), "crash_after_effect", "k2b", fast);
    expect(r.status).toBe("completed");
    expect(steps().C).toEqual({ status: "succeeded", attempts: 2 });
    expect(logLines("k2b").filter((l) => l.step_name === "C")).toHaveLength(1);
    expect(logLines("k2b")).toHaveLength(4);
  });
});

describe("Scenario 3 — permanent failure → manual intervention", () => {
  it("exhausts retries, lands in saga_failures, and leaves state consistent", async () => {
    const r = await runPocSaga(db(), "permanent_failure", "k3", fast);
    expect(r).toMatchObject({ status: "failed", failedStep: "D", executedSteps: ["A", "B", "C"] });
    expect(steps().D).toEqual({ status: "failed", attempts: 3 });
    expect(db().table("saga_runs")[0].status).toBe("failed");
    const f = db().table("saga_failures");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ saga_type: POC_SAGA_TYPE, saga_key: "k3", failed_step: "D" });
    expect(f[0].error_detail).toMatch(/After 3 attempt\(s\): Simulated permanent failure/);
    expect(logLines("k3").map((l) => l.step_name)).toEqual(["A", "B", "C"]);
  });

  it("re-triggering a dead-lettered saga does nothing until someone resumes it", async () => {
    await runPocSaga(db(), "permanent_failure", "k3", fast);
    const again = await runPocSaga(db(), "permanent_failure", "k3", fast);
    expect(again.status).toBe("needs_manual_intervention");
    expect(steps().D.attempts).toBe(3);
    expect(db().table("saga_failures")).toHaveLength(1);
  });

  it("manual resume after fixing: completed steps are skipped, only D runs, the failure is resolved", async () => {
    await runPocSaga(db(), "permanent_failure", "k3", fast);
    const r = await resumePocSaga(db(), "permanent_failure", "k3", fast);
    expect(r).toMatchObject({ status: "completed", executedSteps: ["D"], skippedSteps: ["A", "B", "C"] });
    expect(steps().D).toEqual({ status: "succeeded", attempts: 4 });
    expect(logLines("k3").map((l) => l.step_name)).toEqual(["A", "B", "C", "D"]);
    expect(db().table("saga_failures")[0].resolved_at).toBeTruthy();
  });

  it("a failure in the middle stops the saga — later steps never run", async () => {
    const ran: string[] = [];
    const r = await runSaga(db(), {
      sagaType: "t",
      sagaKey: "mid",
      retryDelayMs: 0,
      steps: [
        { name: "A", run: async () => void ran.push("A") },
        { name: "B", maxAttempts: 2, run: async () => { throw new Error("boom"); } },
        { name: "C", run: async () => void ran.push("C") },
      ],
    });
    expect(r).toMatchObject({ status: "failed", failedStep: "B" });
    expect(ran).toEqual(["A"]);
    expect(db().table("saga_step_executions").map((s) => s.step_name)).toEqual(["A", "B"]);
  });
});

describe("concurrency and crashed runners", () => {
  it("two simultaneous triggers with the same key execute the saga once", async () => {
    const [a, b] = await Promise.all([runPocSaga(db(), "full_success", "k4", fast), runPocSaga(db(), "full_success", "k4", fast)]);
    expect([a.status, b.status].sort()).toEqual(["completed", "in_progress"]);
    expect(logLines("k4")).toHaveLength(4);
  });

  it("a runner that died mid-saga is taken over once its lease expires, resuming after the last done step", async () => {
    db().seed("saga_runs", [{ id: "run-x", saga_type: POC_SAGA_TYPE, saga_key: "k5", status: "running", payload: {}, lease_expires_at: new Date(Date.now() - 1000).toISOString() }]);
    db().seed("saga_step_executions", [{ run_id: "run-x", step_name: "A", idempotency_key: `${POC_SAGA_TYPE}:k5:A`, status: "succeeded", attempts: 1 }]);
    db().seed("saga_test_log", [{ idempotency_key: `${POC_SAGA_TYPE}:k5:A`, saga_key: "k5", step_name: "A", message: "log step A" }]);
    const r = await runPocSaga(db(), "full_success", "k5", fast);
    expect(r).toMatchObject({ status: "completed", skippedSteps: ["A"], executedSteps: ["B", "C", "D"] });
    expect(logLines("k5")).toHaveLength(4);
  });

  it("a live lease is respected", async () => {
    db().seed("saga_runs", [{ saga_type: POC_SAGA_TYPE, saga_key: "k6", status: "running", payload: {}, lease_expires_at: new Date(Date.now() + 60_000).toISOString() }]);
    expect((await runPocSaga(db(), "full_success", "k6", fast)).status).toBe("in_progress");
    expect(logLines("k6")).toHaveLength(0);
  });
});
