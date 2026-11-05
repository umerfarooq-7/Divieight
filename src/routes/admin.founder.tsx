import type { ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { when } from "@/lib/admin";
import { founderCsv, UNIT_STATUS_LABELS, type FounderDashboard, type FounderWidget, type UnitStatus } from "@/lib/founder";
import { getFounderDashboard, refreshFounderDashboard } from "@/lib/founder.functions";

export const Route = createFileRoute("/admin/founder")({
  head: () => ({
    meta: [
      { title: "Founder dashboard — divieight admin" },
      { name: "description", content: "Read-only aggregates across GTV, revenue streams, velocity, referrals, demand and retention." },
      { property: "og:title", content: "Founder dashboard — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: FounderPage,
});

const FIELD = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal";
const NO_DATA = "No data yet";
const KEY = "founder-dashboard";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdCents = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const days = (n: number | null) => (n == null ? "—" : `${n} d`);

function FounderPage() {
  const load = useServerFn(getFounderDashboard);
  const refresh = useServerFn(refreshFounderDashboard);
  const qc = useQueryClient();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [state, setState] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: [KEY, from, to, state],
    retry: false,
    queryFn: () => load({ data: { from: from || null, to: to || null, state: state || null } }),
  });
  const refreshMut = useMutation({
    mutationFn: () => refresh(),
    onSuccess: () => {
      toast.success("Dashboard refreshed.");
      void qc.invalidateQueries({ queryKey: [KEY] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-foreground">Founder dashboard</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Read-only totals from recorded data, refreshed nightly. Last refreshed: {data?.refreshedAt ? when(data.refreshedAt) : "—"}.
          </p>
        </div>
        <button
          type="button"
          disabled={refreshMut.isPending}
          onClick={() => refreshMut.mutate()}
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50"
        >
          {refreshMut.isPending ? "Refreshing…" : "Refresh now"}
        </button>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <label className="block text-sm font-medium text-foreground">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={FIELD} />
        </label>
        <label className="block text-sm font-medium text-foreground">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={FIELD} />
        </label>
        <label className="block text-sm font-medium text-foreground">
          Market (state)
          <select value={state} onChange={(e) => setState(e.target.value)} className={FIELD}>
            <option value="">All markets</option>
            {data?.states.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-6 space-y-5">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : !data ? null : (
          <>
            <Gtv d={data} />
            <Revenue d={data} />
            <Velocity d={data} />
            <Referrals d={data} />
            <Demand d={data} />
            <Retention d={data} />
          </>
        )}
      </div>
    </div>
  );
}

function exportCsv(widget: FounderWidget, d: FounderDashboard) {
  const url = URL.createObjectURL(new Blob([founderCsv(widget, d)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `divieight-founder-${widget}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Widget({ title, hint, widget, d, children }: { title: string; hint: string; widget: FounderWidget; d: FounderDashboard; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        </div>
        <button
          type="button"
          onClick={() => exportCsv(widget, d)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary"
        >
          <Download className="h-4 w-4" aria-hidden /> CSV
        </button>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="break-words font-display text-2xl font-semibold text-foreground">{value}</p>
      {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

const Empty = () => <p className="text-sm text-muted-foreground">{NO_DATA}</p>;

function Table({ head, rows, min = 480 }: { head: string[]; rows: Array<Array<ReactNode>>; min?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: min }}>
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            {head.map((h, i) => (
              <th key={h} scope="col" className={`border-b border-border py-2 pr-3 font-medium ${i ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={`py-2 pr-3 ${j ? "text-right tabular-nums" : "break-words"} text-foreground`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Gtv({ d }: { d: FounderDashboard }) {
  const g = d.gtv;
  const empty = !g.closedCount && !g.simulatedCount && !g.missingPriceCount;
  return (
    <Widget title="Total GTV" hint="Listing price of every property with a recorded deed, by recording date." widget="gtv" d={d}>
      {empty ? (
        <Empty />
      ) : (
        <>
          <Stat label={`${g.closedCount} ${g.closedCount === 1 ? "property" : "properties"} closed`} value={usd(g.total)} />
          {g.simulatedCount ? <p className="mt-2 text-xs text-muted-foreground">Simulated test closings, not included: {usd(g.simulatedTotal)} across {g.simulatedCount}.</p> : null}
          {g.missingPriceCount ? <p className="mt-1 text-xs text-muted-foreground">{g.missingPriceCount} closed with no price recorded, not included.</p> : null}
        </>
      )}
    </Widget>
  );
}

function Revenue({ d }: { d: FounderDashboard }) {
  const s = d.streams;
  const notRecorded = "Not yet recorded";
  const test = (cents: number) => (cents ? `Test, not included: ${usdCents(cents)}` : undefined);
  return (
    <Widget title="Triple-Stream Revenue Tracker" hint="PEF by clearing date; the other two as recorded at closing. Kept separate, because they aren't all paid to divieight." widget="revenue" d={d}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label={`Platform Enrollment Fee (${s.pef.realCount} cleared)`}
          value={s.pef.realCount || s.pef.testCount ? usdCents(s.pef.realCents) : NO_DATA}
          note={s.pef.testCount ? `Test-mode, not included: ${usdCents(s.pef.testCents)} across ${s.pef.testCount}` : undefined}
        />
        <Stat label="Heavy Lifter Premium" value={s.recorded ? usdCents(s.premium.realCents) : notRecorded} note={s.recorded ? test(s.premium.testCents) : undefined} />
        <Stat label="Participating Agent Yield" value={s.recorded ? usdCents(s.agentYield.realCents) : notRecorded} note={s.recorded ? test(s.agentYield.testCents) : undefined} />
      </div>
    </Widget>
  );
}

function Velocity({ d }: { d: FounderDashboard }) {
  const v = d.velocity;
  return (
    <Widget title="Unit Velocity" hint="Status counts are as of now. Times are for properties that went live in the date range." widget="velocity" d={d}>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        {(Object.keys(UNIT_STATUS_LABELS) as UnitStatus[]).map((s) => (
          <Stat key={s} label={UNIT_STATUS_LABELS[s]} value={String(v.counts[s])} />
        ))}
      </div>
      <div className="mt-4 grid gap-4 border-t border-border pt-4 sm:grid-cols-3">
        <Stat label="Average: live → 8/8" value={days(v.averages.liveToFull)} />
        <Stat label="Average: 8/8 → closing" value={days(v.averages.fullToClosed)} />
        <Stat label="Average: live → closing" value={days(v.averages.liveToClosed)} />
      </div>
      <div className="mt-4">
        {v.rows.length === 0 ? (
          <Empty />
        ) : (
          <Table
            min={560}
            head={["Property", "Status", "Live → 8/8", "8/8 → closing", "Live → closing"]}
            rows={v.rows.map((r) => [r.property, r.status ? UNIT_STATUS_LABELS[r.status] : "—", days(r.liveToFull), days(r.fullToClosed), days(r.liveToClosed)])}
          />
        )}
      </div>
    </Widget>
  );
}

function Referrals({ d }: { d: FounderDashboard }) {
  const r = d.referrals;
  return (
    <Widget title="Referral Map" hint="Buyers who registered in the date range, by their target market. A buyer counts once per agent." widget="referrals" d={d}>
      {r.topAgents.length === 0 ? (
        <Empty />
      ) : (
        <>
          <p className="text-sm text-foreground">
            <span className="font-semibold">{r.attributedBuyers}</span> of {r.totalBuyers} buyers came through an agent.
          </p>
          <div className="mt-3 grid gap-5 lg:grid-cols-2">
            <Table min={360} head={["Top agents", "Buyers", "Link", "QR"]} rows={r.topAgents.map((a) => [a.agent, a.buyers, a.viaLink, a.viaQr])} />
            <Table min={360} head={["Top tokens", "Agent", "Buyers"]} rows={r.topTokens.map((t) => [`${t.label || t.token} (${t.kind})`, t.agent, t.buyers])} />
          </div>
        </>
      )}
    </Widget>
  );
}

/** One hue, light to dark: darker means more buyers. The number stays in the cell. */
function heat(count: number, max: number) {
  if (!count || !max) return undefined;
  return { background: `color-mix(in oklab, var(--accent) ${Math.round(10 + (count / max) * 45)}%, transparent)` };
}

function Demand({ d }: { d: FounderDashboard }) {
  const { rows, buckets } = d.demand;
  const max = Math.max(0, ...rows.flatMap((r) => buckets.map((b) => r.buyers[b.id] ?? 0)));
  return (
    <Widget title="Market Demand Heatmap" hint="Buyers by state and budget range, beside open listings. Darker means more buyers." widget="demand" d={d}>
      {rows.length === 0 ? (
        <Empty />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: 640 }}>
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="border-b border-border py-2 pr-3 text-left font-medium">
                  Market
                </th>
                {buckets.map((b) => (
                  <th key={b.id} scope="col" className="border-b border-border px-1 py-2 text-center font-medium">
                    {b.label}
                  </th>
                ))}
                <th scope="col" className="border-b border-border px-2 py-2 text-right font-medium">
                  Buyers
                </th>
                <th scope="col" className="border-b border-border py-2 pl-2 text-right font-medium">
                  Listings
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.market}>
                  <th scope="row" className="py-1 pr-3 text-left font-medium text-foreground">
                    {r.market}
                  </th>
                  {buckets.map((b) => {
                    const n = r.buyers[b.id] ?? 0;
                    return (
                      <td key={b.id} className="px-1 py-1">
                        <div title={`${r.market}, ${b.label}: ${n} ${n === 1 ? "buyer" : "buyers"}`} style={heat(n, max)} className="rounded py-1.5 text-center tabular-nums text-foreground">
                          {n || <span className="text-muted-foreground">·</span>}
                        </div>
                      </td>
                    );
                  })}
                  <td className="px-2 py-1 text-right font-semibold tabular-nums text-foreground">{r.totalBuyers}</td>
                  <td className="py-1 pl-2 text-right font-semibold tabular-nums text-foreground">{r.listings}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Widget>
  );
}

function Retention({ d }: { d: FounderDashboard }) {
  const r = d.retention;
  const none = !r.totalShares && !r.exceptions && !r.resaleListings;
  return (
    <Widget title="Retention Pulse" hint="Shares are as of now. Exceptions and resale listings were created in the date range." widget="retention" d={d}>
      {none ? (
        <Empty />
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <Stat label="Within Retention Lock" value={r.pctWithin == null ? "—" : `${r.pctWithin}%`} note={`${r.withinLock} of ${r.totalShares} shares`} />
          <Stat label="Past or released" value={r.pctPast == null ? "—" : `${r.pctPast}%`} note={`${r.pastLock} of ${r.totalShares} shares`} />
          <Stat label="Retention exceptions" value={String(r.exceptions)} note={`${r.exceptionsPending} pending, ${r.exceptionsApproved} approved`} />
          <Stat label="Resale listings" value={String(r.resaleListings)} note={`${r.resaleLive} live`} />
          <Stat label="ROFR open" value={String(r.rofrOpen)} />
        </div>
      )}
    </Widget>
  );
}
