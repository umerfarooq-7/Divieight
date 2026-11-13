import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { exportAdminReport, getAdminReport } from "@/lib/analytics.functions";
import { COMPLIANCE_LABELS, INQUIRY_STALE_DAYS, REPORT_KINDS, REPORT_LABELS, type ReportKind } from "@/lib/analytics";

export const Route = createFileRoute("/admin/reports")({
  head: () => ({ meta: [{ title: "Admin reports — Manager" }, { name: "robots", content: "noindex" }] }),
  component: AdminReports,
});

const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

function AdminReports() {
  const [kind, setKind] = useState<ReportKind>("pod_activity");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [state, setState] = useState("");
  const [inquiryDays, setInquiryDays] = useState(INQUIRY_STALE_DAYS);
  const filters = { from: from || null, to: to || null, state: state || null };
  const { data, isLoading, error } = useQuery({ queryKey: ["admin-report", kind, from, to, state, inquiryDays], queryFn: () => getAdminReport({ data: { kind, filters, inquiryDays } }), retry: false });

  const exportMut = useMutation({
    mutationFn: () => exportAdminReport({ data: { kind, filters, inquiryDays } }),
    onSuccess: (r) => {
      const url = URL.createObjectURL(new Blob([r.csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast.success(`Exported ${r.rows} rows. The export is logged.`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const field = "mt-1 block rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
  const th = "px-3 py-2 text-left text-sm font-semibold text-foreground";
  const td = "px-3 py-2 text-base text-foreground";

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="font-display text-2xl font-semibold text-foreground">Admin reports</h1>
      <p className="mt-1 text-base text-muted-foreground">Read-only. Anonymous references and aggregates: no names, emails, phone numbers or tax identifiers. Every export is logged.</p>

      <div role="tablist" aria-label="Reports" className="mt-4 flex flex-wrap gap-2">
        {REPORT_KINDS.map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)} className={`h-10 rounded-md border px-4 text-sm font-medium ${kind === k ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-muted"}`}>
            {REPORT_LABELS[k]}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="text-sm font-medium text-foreground">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
        </label>
        <label className="text-sm font-medium text-foreground">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={field} />
        </label>
        <label className="text-sm font-medium text-foreground">
          Market
          <select value={state} onChange={(e) => setState(e.target.value)} className={field}>
            <option value="">All markets</option>
            {(data?.markets ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        {kind === "compliance" ? (
          <label className="text-sm font-medium text-foreground">
            Inquiry open longer than (days)
            <input type="number" min={1} max={365} value={inquiryDays} onChange={(e) => setInquiryDays(Number(e.target.value) || INQUIRY_STALE_DAYS)} className={`${field} w-28`} />
          </label>
        ) : null}
        <button type="button" disabled={exportMut.isPending || !data} onClick={() => exportMut.mutate()} className="inline-flex h-11 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
          {exportMut.isPending ? "Preparing…" : "Export CSV"}
        </button>
      </div>

      {isLoading ? <p className="mt-6 text-base text-muted-foreground">Loading…</p> : null}
      {error ? <p role="alert" className="mt-6 text-base text-destructive">{(error as Error).message === "Not authorized" ? "403: only the Manager and the founder can see this page." : (error as Error).message}</p> : null}

      {data?.kind === "pod_activity" ? (
        <section className="mt-6">
          <p className="text-base text-foreground">
            {Object.entries(data.report.counts).map(([k, v]) => `${k.replace("_", "-")}: ${v}`).join(" · ")}
          </p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-border">
            <table className="min-w-full divide-y divide-border">
              <thead className="bg-muted/50">
                <tr>
                  {["Pod", "Status", "Live", "8/8", "Closed", "Days live to 8/8", "8/8 to closed"].map((h) => (
                    <th key={h} className={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.report.rows.map((r) => (
                  <tr key={r.property}>
                    <td className={td}>{r.property}</td>
                    <td className={td}>{r.status ?? ""}</td>
                    <td className={td}>{r.liveOn}</td>
                    <td className={td}>{r.filledOn}</td>
                    <td className={td}>{r.closedOn}</td>
                    <td className={td}>{r.liveToFull ?? ""}</td>
                    <td className={td}>{r.fullToClosed ?? ""}</td>
                  </tr>
                ))}
                {data.report.rows.length === 0 ? <tr><td colSpan={7} className={`${td} text-muted-foreground`}>No pods in this range.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {data?.kind === "revenue" ? (
        <section className="mt-6 space-y-4">
          <div className="rounded-xl border border-border bg-card p-5">
            <p className="text-sm text-muted-foreground">{data.report.platformRevenue.label}</p>
            <p className="font-display text-3xl font-semibold text-foreground">{usd(data.report.platformRevenue.cents)}</p>
            <p className="text-sm text-muted-foreground">
              {data.report.platformRevenue.count} cleared fee{data.report.platformRevenue.count === 1 ? "" : "s"} ({data.report.platformRevenue.buyerFees} buyer, {data.report.platformRevenue.sellerFees} seller). Test-mode payments ({usd(data.report.testMode.cents)}, {data.report.testMode.count}) are not revenue.
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-5">
            <p className="text-base font-semibold text-foreground">{data.report.agentPayouts.label}</p>
            <p className="text-sm text-muted-foreground">{data.report.agentPayouts.note}</p>
            {data.report.agentPayouts.recorded ? (
              <dl className="mt-2 text-base">
                <div className="flex justify-between"><dt>Heavy Lifter Premium</dt><dd>{usd(data.report.agentPayouts.heavyLifterPremiumCents)}</dd></div>
                <div className="flex justify-between"><dt>Participating Agent Yield</dt><dd>{usd(data.report.agentPayouts.participatingAgentYieldCents)}</dd></div>
              </dl>
            ) : (
              <p className="mt-2 text-base text-muted-foreground">Not yet recorded.</p>
            )}
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="min-w-full divide-y divide-border">
              <thead className="bg-muted/50"><tr>{["Month", "Buyer fees", "Seller fees", "Platform revenue"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-border">
                {data.report.byMonth.map((m) => (
                  <tr key={m.month}><td className={td}>{m.month}</td><td className={td}>{m.buyer}</td><td className={td}>{m.seller}</td><td className={td}>{usd(m.cents)}</td></tr>
                ))}
                {data.report.byMonth.length === 0 ? <tr><td colSpan={4} className={`${td} text-muted-foreground`}>No cleared fees in this range.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {data?.kind === "compliance" ? (
        <section className="mt-6">
          <ul className="flex flex-wrap gap-3 text-sm text-foreground">
            {(Object.keys(COMPLIANCE_LABELS) as Array<keyof typeof COMPLIANCE_LABELS>).map((k) => (
              <li key={k} className="rounded-full border border-border bg-card px-3 py-1">
                {COMPLIANCE_LABELS[k]}: <strong>{data.report.byFlag[k]}</strong>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-muted-foreground">With a market chosen, only flags that belong to a market are shown (a broker&apos;s tax form and an agent&apos;s E&amp;O have none).</p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-border">
            <table className="min-w-full divide-y divide-border">
              <thead className="bg-muted/50"><tr>{["Flag", "Reference", "Market", "Since", "Days", "Detail"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-border">
                {data.report.rows.map((r, i) => (
                  <tr key={i}><td className={td}>{r.label}</td><td className={td}>{r.ref}</td><td className={td}>{r.market ?? ""}</td><td className={td}>{r.since ? r.since.slice(0, 10) : ""}</td><td className={td}>{r.ageDays ?? ""}</td><td className={td}>{r.detail}</td></tr>
                ))}
                {data.report.rows.length === 0 ? <tr><td colSpan={6} className={`${td} text-muted-foreground`}>Nothing flagged.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
