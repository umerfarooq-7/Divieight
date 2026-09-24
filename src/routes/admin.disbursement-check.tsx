import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CheckCircle2, Scale, XCircle } from "lucide-react";
import {
  listDisbursementChecks,
  runDisbursementCheckNow,
  saveTitleFigures,
  type DisbursementCheckView,
} from "@/lib/disbursement-check.functions";
import { formatUsdCents } from "@/lib/commission-cascade";

export const Route = createFileRoute("/admin/disbursement-check")({
  head: () => ({
    meta: [
      { title: "Disbursement Check — divieight admin" },
      { name: "description", content: "Zero-Error gate: the platform's commission figures vs. the title company's, to the cent." },
      { property: "og:title", content: "Disbursement Check — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DisbursementCheckPage,
});

function DisbursementCheckPage() {
  const load = useServerFn(listDisbursementChecks);
  const { data, isLoading } = useQuery({ queryKey: ["disbursement-checks"], queryFn: () => load() });
  return (
    <div>
      <h1 className="flex items-center gap-2 font-display text-2xl font-semibold text-foreground">
        <Scale className="h-6 w-6 text-accent" /> Disbursement Check
      </h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        The Zero-Error gate. Each Broker of Record's amount in the Source of Truth is compared with the title company's
        final number — a difference of even $0.01 on any line fails the check and halts the Closing Ping Saga. Until a live
        title feed exists, enter the title company's numbers here (from its settlement statement); the newer of this entry
        and the funded webhook is used.
      </p>
      <div className="mt-6 space-y-5">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (data?.properties ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No transmitted Source of Truth yet — generate one under Settlement (CDA).</p>
        ) : (
          data!.properties.map((p) => <PropertyCheck key={p.propertyId} v={p} />)
        )}
      </div>
    </div>
  );
}

function PropertyCheck({ v }: { v: DisbursementCheckView }) {
  const qc = useQueryClient();
  const save = useServerFn(saveTitleFigures);
  const run = useServerFn(runDisbursementCheckNow);
  const initial = () =>
    Object.fromEntries(
      v.sot.payees.map((p) => {
        const t = v.title?.figures.find((f) => f.payeeReference === p.brokerId);
        return [p.brokerId, Math.round((t ? t.amount : p.amountCents / 100) * 100)];
      }),
    );
  const [cents, setCents] = useState<Record<string, number>>(initial);
  useEffect(() => setCents(initial()), [v.title?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => qc.invalidateQueries({ queryKey: ["disbursement-checks"] });

  const saveMut = useMutation({
    mutationFn: () =>
      save({
        data: {
          propertyId: v.propertyId,
          figures: v.sot.payees.map((p) => ({ payeeReference: p.brokerId, amount: (cents[p.brokerId] ?? 0) / 100 })),
          note: "Entered from the title company's settlement statement",
        },
      }),
    onSuccess: () => {
      toast.success("Title company's numbers saved.");
      void refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const runMut = useMutation({
    mutationFn: () => run({ data: { propertyId: v.propertyId } }),
    onSuccess: (r) => {
      (r.status === "pass" ? toast.success : toast.error)(r.status === "pass" ? "Check PASSED — every line matches." : "Check FAILED — see the discrepancy report.");
      void refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const latest = v.checks[0];
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-base font-semibold text-foreground">{v.label}</h2>
        <p className="text-xs text-muted-foreground">
          Source of Truth v{v.sot.version} · {formatUsdCents(v.sot.totalCents)} ·{" "}
          {v.title ? `title figures from ${v.title.source.replace("_", " ")} ${new Date(v.title.at).toLocaleString()}` : "no title figures yet"}
        </p>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="py-1 pr-2">Broker of Record</th>
            <th className="py-1 pr-2 text-right">Platform</th>
            <th className="py-1 pr-2 text-right">Title company (USD)</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {v.sot.payees.map((p) => {
            const c = cents[p.brokerId] ?? 0;
            const diff = c - p.amountCents;
            return (
              <tr key={p.brokerId} className="border-t border-border/60">
                <td className="py-1.5 pr-2">{p.brokerageName}</td>
                <td className="py-1.5 pr-2 text-right">{formatUsdCents(p.amountCents)}</td>
                <td className="py-1.5 pr-2 text-right">
                  <input
                    type="number"
                    step="0.01"
                    value={(c / 100).toFixed(2)}
                    onChange={(e) => setCents((s) => ({ ...s, [p.brokerId]: Math.round(Number(e.target.value) * 100) }))}
                    className="w-36 rounded-md border border-border bg-background px-2 py-1 text-right text-sm"
                  />
                  {diff !== 0 ? <span className="ml-2 text-xs text-destructive">{diff > 0 ? "+" : "−"}{formatUsdCents(Math.abs(diff))}</span> : null}
                </td>
                <td className="py-1.5 text-right">
                  <button
                    type="button"
                    onClick={() => setCents((s) => ({ ...s, [p.brokerId]: (s[p.brokerId] ?? 0) + 1 }))}
                    className="rounded border border-border px-2 py-0.5 text-xs"
                    title="Introduce a one-cent discrepancy"
                  >
                    +1¢
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} className="rounded-lg border border-border px-3 py-2 text-sm font-medium disabled:opacity-50">
          Save as title company's numbers
        </button>
        <button onClick={() => runMut.mutate()} disabled={runMut.isPending} className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          Run Disbursement Check
        </button>
      </div>

      {latest ? (
        <div className={`mt-4 rounded-lg border p-3 ${latest.status === "pass" ? "border-emerald-300 bg-emerald-50" : "border-destructive/40 bg-destructive/5"}`}>
          <p className={`flex items-center gap-1.5 text-sm font-semibold ${latest.status === "pass" ? "text-emerald-800" : "text-destructive"}`}>
            {latest.status === "pass" ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            Latest check {latest.status === "pass" ? "PASSED" : "FAILED"} · {new Date(latest.checked_at).toLocaleString()} · {latest.triggered_by?.replace("_", " ")}
          </p>
          {latest.report ? <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-foreground">{latest.report}</pre> : null}
        </div>
      ) : null}
      {v.checks.length > 1 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          History: {v.checks.map((c) => `${c.status} ${new Date(c.checked_at).toLocaleString()}`).join(" · ")}
        </p>
      ) : null}
    </section>
  );
}
