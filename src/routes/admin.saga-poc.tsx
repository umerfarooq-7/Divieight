import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { FlaskConical, RotateCcw, Play, Repeat } from "lucide-react";
import { listSagaPoc, runSagaPoc } from "@/lib/saga/poc.functions";

export const Route = createFileRoute("/admin/saga-poc")({
  head: () => ({
    meta: [
      { title: "Saga proof of concept — divieight admin" },
      { name: "description", content: "Validate saga orchestration: idempotency, retries and the dead-letter table." },
      { property: "og:title", content: "Saga proof of concept — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SagaPocPage,
});

type Scenario = "full_success" | "retry_success" | "permanent_failure" | "crash_after_effect";
const SCENARIOS: Array<[Scenario, string]> = [
  ["full_success", "Full success"],
  ["retry_success", "Step D fails twice, succeeds on retry"],
  ["permanent_failure", "Step D fails permanently"],
  ["crash_after_effect", "Step C crashes after writing"],
];

const STATUS_TONE: Record<string, string> = {
  completed: "bg-emerald-100 text-emerald-800",
  succeeded: "bg-emerald-100 text-emerald-800",
  running: "bg-amber-100 text-amber-800",
  failed: "bg-destructive/10 text-destructive",
};

function SagaPocPage() {
  const qc = useQueryClient();
  const load = useServerFn(listSagaPoc);
  const run = useServerFn(runSagaPoc);
  const { data, isLoading } = useQuery({ queryKey: ["saga-poc"], queryFn: () => load() });
  const [lastKey, setLastKey] = useState<{ key: string; scenario: Scenario } | null>(null);

  const mut = useMutation({
    mutationFn: (v: { scenario: Scenario; sagaKey: string; resume?: boolean }) => run({ data: v }),
    onSuccess: (r, v) => {
      setLastKey({ key: v.sagaKey, scenario: v.scenario });
      const msg =
        r.status === "completed"
          ? `Completed — executed [${r.executedSteps.join(", ")}]${r.skippedSteps.length ? `, skipped already-done [${r.skippedSteps.join(", ")}]` : ""}`
          : r.status === "failed"
            ? `Failed at step ${r.failedStep} after retries — sent to saga_failures`
            : r.status === "already_completed"
              ? "Already completed — nothing re-executed (idempotent)"
              : r.status === "needs_manual_intervention"
                ? "In saga_failures — resume it after fixing the cause"
                : "Another runner holds this saga";
      (r.status === "failed" ? toast.error : toast.success)(msg);
      void qc.invalidateQueries({ queryKey: ["saga-poc"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const fresh = (scenario: Scenario) => mut.mutate({ scenario, sagaKey: `poc-${scenario}-${Date.now().toString(36)}` });

  return (
    <div>
      <h1 className="flex items-center gap-2 font-display text-2xl font-semibold text-foreground">
        <FlaskConical className="h-6 w-6 text-accent" /> Saga proof of concept
      </h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Four trivial steps (A, B, C, D) that only write a line to a test log — no property, commission or closing data.
        Validates idempotency keys, retries, and the saga_failures dead letter before the real Closing Ping Saga.
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        {SCENARIOS.map(([s, label]) => (
          <button
            key={s}
            disabled={mut.isPending}
            onClick={() => fresh(s)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            <Play className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>
      {lastKey ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-mono text-xs text-muted-foreground">{lastKey.key}</span>
          <button
            disabled={mut.isPending}
            onClick={() => mut.mutate({ scenario: lastKey.scenario, sagaKey: lastKey.key })}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium"
          >
            <Repeat className="h-3.5 w-3.5" /> Run again with the same key
          </button>
        </div>
      ) : null}

      <h2 className="mt-8 text-sm font-semibold text-foreground">saga_failures (dead letter)</h2>
      <ul className="mt-2 space-y-2">
        {(data?.failures ?? []).length === 0 ? (
          <li className="text-sm text-muted-foreground">Empty.</li>
        ) : (
          data!.failures.map((f) => (
            <li key={f.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border bg-card p-3 text-sm">
              <div>
                <p className="font-medium text-foreground">
                  Step {f.failed_step} · <span className="font-mono text-xs">{f.saga_key}</span>
                </p>
                <p className="text-xs text-muted-foreground">{f.error_detail}</p>
                <p className="text-xs text-muted-foreground">{f.resolved_at ? `Resolved — ${f.resolution_note}` : "Open — needs manual intervention"}</p>
              </div>
              {!f.resolved_at ? (
                <button
                  disabled={mut.isPending}
                  onClick={() => mut.mutate({ scenario: "permanent_failure", sagaKey: f.saga_key, resume: true })}
                  className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Fix &amp; resume
                </button>
              ) : null}
            </li>
          ))
        )}
      </ul>

      <h2 className="mt-8 text-sm font-semibold text-foreground">Recent runs</h2>
      <div className="mt-2 space-y-2">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {(data?.runs ?? []).map((r) => (
          <div key={r.id} className="rounded-lg border border-border bg-card p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p>
                <span className="font-mono text-xs">{r.saga_key}</span> · {r.scenario}
              </p>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_TONE[r.status] ?? ""}`}>{r.status}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {r.steps.map((s) => (
                <span key={s.step_name} title={s.last_error ?? ""} className={`rounded px-2 py-0.5 text-xs ${STATUS_TONE[s.status] ?? ""}`}>
                  {s.step_name}: {s.status} · {s.attempts} attempt{s.attempts === 1 ? "" : "s"}
                </span>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Test-log lines written: {r.logLines} (one per succeeded step — never more)</p>
          </div>
        ))}
      </div>
    </div>
  );
}
