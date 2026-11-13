import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getAnalyticsBoard } from "@/lib/analytics.functions";

export const Route = createFileRoute("/admin/analytics")({
  head: () => ({ meta: [{ title: "Platform analytics — Manager" }, { name: "robots", content: "noindex" }] }),
  component: AdminAnalytics,
});

const num = (n: number | null | undefined) => (n == null ? "Not recorded" : n.toLocaleString());
const days = (n: number | null | undefined) => (n == null ? "Not enough data" : `${n} days`);

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="font-display text-lg font-semibold text-foreground">{title}</h2>
      <div className="mt-3 text-base text-foreground">{children}</div>
    </section>
  );
}
const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 last:border-0">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="font-medium text-foreground">{value}</dd>
  </div>
);

function AdminAnalytics() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [state, setState] = useState("");
  const filters = { from: from || null, to: to || null, state: state || null };
  const { data, isLoading, error } = useQuery({ queryKey: ["analytics-board", from, to, state], queryFn: () => getAnalyticsBoard({ data: filters }), retry: false });
  const field = "mt-1 block rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="font-display text-2xl font-semibold text-foreground">Platform analytics</h1>
      <p className="mt-1 text-base text-muted-foreground">Aggregates only: counts and averages, no names or contact details. Read-only. For detail, see the <Link to="/admin/reports" className="font-medium text-primary underline">reports</Link>.</p>

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
      </div>

      {isLoading ? <p className="mt-6 text-base text-muted-foreground">Loading…</p> : null}
      {error ? <p role="alert" className="mt-6 text-base text-destructive">{(error as Error).message === "Not authorized" ? "403: only the Manager and the founder can see this page." : (error as Error).message}</p> : null}

      {data ? (
        <>
          <p className="mt-4 text-sm text-muted-foreground">
            Pod, resale and revenue figures use the Founder Dashboard&apos;s own calculation and its snapshot{data.refreshedAt ? ` (refreshed ${new Date(data.refreshedAt).toLocaleString()})` : " (not refreshed yet)"}. The date filter applies to when each thing happened (registration date, publish date, deadline).
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Card title="Users by role">
              <dl>
                <Row label="Buyer accounts" value={num(data.users.buyerAccounts)} />
                <Row label="Co-owner accounts (hold a share)" value={num(data.users.coOwnerAccounts)} />
                <Row label="Sellers" value={num(data.users.sellers)} />
                <Row label="Agents" value={num(data.users.agents)} />
                <Row label="Brokers of Record" value={num(data.users.brokers)} />
                <Row label="Designated CPAs (active)" value={num(data.users.designatedCpas)} />
                <Row label="Managers" value={num(data.users.admins)} />
              </dl>
            </Card>

            <Card title="Onboarding funnel (buyer accounts)">
              <ol className="space-y-2">
                {data.funnel.map((s) => (
                  <li key={s.key}>
                    <div className="flex justify-between text-base">
                      <span>{s.label}</span>
                      <span className="font-medium">
                        {num(s.count)}
                        {s.pctOfRegistered != null ? <span className="font-normal text-muted-foreground"> · {s.pctOfRegistered}%</span> : null}
                      </span>
                    </div>
                    <div className="mt-1 h-2 rounded bg-muted" role="presentation">
                      <div className="h-2 rounded bg-primary" style={{ width: `${Math.min(100, s.pctOfRegistered ?? 0)}%` }} />
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-sm text-muted-foreground">Eligibility page read and declaration complete count an account when at least one of its members has done it.</p>
            </Card>

            <Card title="Pods by status">
              <dl>
                {Object.entries(data.pods.labels).map(([k, label]) => (
                  <Row key={k} label={label} value={num((data.pods.counts as Record<string, number>)[k])} />
                ))}
              </dl>
            </Card>

            <Card title="Average days between milestones">
              <dl>
                <Row label="Registered to fee paid" value={days(data.milestones.registeredToFeePaid)} />
                <Row label="Fee paid to Golden Ticket" value={days(data.milestones.feePaidToGoldenTicket)} />
                <Row label="Listed to 8 of 8 shares" value={days(data.milestones.listedToEightOfEight)} />
                <Row label="8 of 8 to closed" value={days(data.milestones.eightOfEightToClosed)} />
                <Row label="Listed to closed" value={days(data.milestones.listedToClosed)} />
              </dl>
            </Card>

            <Card title="Resale activity">
              <dl>
                <Row label="Resale listings" value={num(data.resale.listings)} />
                <Row label="Live now" value={num(data.resale.live)} />
                <Row label="Right of first refusal open" value={num(data.resale.rofrOpen)} />
              </dl>
            </Card>

            <Card title="Monthly statements">
              <dl>
                <Row label="Issued on time" value={`${num(data.statements.issuedOnTime)}${data.statements.pctOnTime != null ? ` (${data.statements.pctOnTime}%)` : ""}`} />
                <Row label="Issued late" value={num(data.statements.issuedLate)} />
                <Row label="Still drafts past the deadline" value={num(data.statements.overdueDrafts)} />
                <Row label="Statements due" value={num(data.statements.total)} />
              </dl>
            </Card>

            <Card title="Held and verification">
              <dl>
                <Row label="Held accounts" value={num(data.heldAccounts)} />
                <Row label="Open verification requests" value={num(data.openVerificationRequests)} />
              </dl>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
