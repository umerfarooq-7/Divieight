import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { RotateCcw, ShieldAlert } from "lucide-react";
import { listClosingSagas, resumeClosingSaga, type ClosingSagaView } from "@/lib/closing-saga.functions";
import { formatUsdCents } from "@/lib/commission-cascade";

export const Route = createFileRoute("/admin/closing")({
  head: () => ({
    meta: [
      { title: "Closing Ping Saga — divieight admin" },
      { name: "description", content: "Monitor and resume the Closing Ping Saga for funded and recorded properties." },
      { property: "og:title", content: "Closing Ping Saga — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminClosing,
});

const STEP_LABELS: Record<string, string> = {
  "1_verify_source_of_truth": "1 · Verify Source of Truth & gates",
  "2_unlock_commissions": "2 · Unlock commissions",
  "3_disbursement_check": "3 · Disbursement Check",
  "4_activate_governance": "4 · Activate governance & keys",
  "5_recordation_ping": "5 · Recordation & Retention Lock",
  "6_deal_closed_notifications": "6 · Deal Closed notices",
  "7_records_vault": "7 · Deed & Closing Statement",
};
const TONE: Record<string, string> = {
  completed: "bg-emerald-100 text-emerald-800",
  succeeded: "bg-emerald-100 text-emerald-800",
  running: "bg-amber-100 text-amber-800",
  failed: "bg-destructive/10 text-destructive",
};

function AdminClosing() {
  const load = useServerFn(listClosingSagas);
  const { data, isLoading } = useQuery({ queryKey: ["admin-closing"], queryFn: () => load() });
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Closing Ping Saga</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Starts automatically when title reports "funded and recorded". Each step is idempotent and retried; a failure
        stops the saga and lands in saga_failures for manual review. Resuming skips every completed step, so nothing is
        activated or announced twice. Commissions are marked payable by title/escrow — divieight never disburses funds.
      </p>
      <div className="mt-6 space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (data?.sagas ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No closing has started yet.</p>
        ) : (
          data!.sagas.map((s) => <SagaCard key={s.propertyId} s={s} />)
        )}
      </div>
    </div>
  );
}

function SagaCard({ s }: { s: ClosingSagaView }) {
  const qc = useQueryClient();
  const resume = useServerFn(resumeClosingSaga);
  const mut = useMutation({
    mutationFn: () => resume({ data: { propertyId: s.propertyId } }),
    onSuccess: (r) => {
      (r.status === "completed" ? toast.success : toast.error)(
        r.status === "completed" ? "Closing completed." : r.status === "failed" ? `Still failing at ${r.failedStep}.` : `Saga ${r.status}.`,
      );
      void qc.invalidateQueries({ queryKey: ["admin-closing"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-base font-semibold text-foreground">{s.label}</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[s.status] ?? ""}`}>{s.status}</span>
      </div>
      <ol className="mt-3 grid gap-1.5 sm:grid-cols-2">
        {Object.entries(STEP_LABELS).map(([name, label]) => {
          const st = s.steps.find((x) => x.step_name === name);
          return (
            <li key={name} title={st?.last_error ?? ""} className={`rounded px-2 py-1 text-xs ${st ? TONE[st.status] ?? "" : "bg-muted text-muted-foreground"}`}>
              {label} — {st ? `${st.status} · ${st.attempts} attempt${st.attempts === 1 ? "" : "s"}` : "not reached"}
            </li>
          );
        })}
      </ol>

      {s.lastCheck ? (
        <div className={`mt-3 rounded-lg border p-3 text-xs ${s.lastCheck.status === "pass" ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-destructive/40 bg-destructive/5 text-destructive"}`}>
          <p className="font-semibold">
            Disbursement Check {s.lastCheck.status === "pass" ? "passed" : "FAILED"} — platform {formatUsdCents(s.lastCheck.platform_total_cents)} vs title{" "}
            {s.lastCheck.title_total_cents == null ? "—" : formatUsdCents(s.lastCheck.title_total_cents)}
          </p>
          {s.lastCheck.differences.map((d, i) => (
            <p key={i} className="font-mono">
              {d.kind}
              {d.brokerage ? ` · ${d.brokerage}` : ""}
              {d.platformCents != null ? ` · platform ${formatUsdCents(d.platformCents)}` : ""}
              {d.titleCents != null ? ` · title ${formatUsdCents(d.titleCents)}` : ""}
            </p>
          ))}
        </div>
      ) : null}

      {s.openFailure ? (
        <div className="mt-3 flex flex-wrap items-start justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <div>
            <p className="flex items-center gap-1.5 font-semibold text-destructive">
              <ShieldAlert className="h-4 w-4" /> In saga_failures — {STEP_LABELS[s.openFailure.failed_step] ?? s.openFailure.failed_step}
            </p>
            <p className="text-xs text-destructive">{s.openFailure.error_detail}</p>
            <p className="mt-1 text-xs text-muted-foreground">Fix the cause (e.g. regenerate the Source of Truth, reconcile with title), then resume.</p>
          </div>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending}
            className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Resume saga
          </button>
        </div>
      ) : null}
    </section>
  );
}
