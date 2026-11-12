import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getHlaBooksView } from "@/lib/books.functions";
import { formatCents } from "@/lib/bank-feed-display";

/**
 * Books, coordination view: the pod's Heavy Lifting Agent reads the property's ledger at property level. Read-only, and
 * nothing personal: no member names, no per-member balances, no memos, merchants or receipts.
 */
export const Route = createFileRoute("/agent/pods/$id/books")({
  head: () => ({
    meta: [
      { title: "Books (read-only) — divieight Professional Portal" },
      { name: "description", content: "Read-only, property-level view of the LLC's books for the pod's Heavy Lifting Agent." },
      { property: "og:title", content: "Books (read-only) — divieight Professional Portal" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: HlaBooksPage,
});

function HlaBooksPage() {
  const { id } = Route.useParams();
  const load = useServerFn(getHlaBooksView);
  const { data, isLoading, error } = useQuery({ queryKey: ["hla-books", id], queryFn: () => load({ data: { propertyId: id } }), retry: false });

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <Link to="/agent/pods/$id" params={{ id }} className="text-xs text-muted-foreground hover:underline">
          ← Pod view
        </Link>
        <h1 className="mt-1 font-display text-2xl font-semibold text-foreground">Books (read-only)</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          The LLC's ledger at property level, for coordination. It shows accounts and amounts only: no member names, no individual capital balances, no memos or merchants. The Manager keeps the books.
        </p>
      </div>
      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {error ? <p className="text-sm text-destructive">{(error as Error).message}</p> : null}
      {data ? (
        <>
          <section className="grid gap-3 sm:grid-cols-4">
            {[
              ["Waiting for the Manager's review", String(data.needsReviewCount)],
              ["Pending at the bank", String(data.pendingBankCount)],
              ["Recurring expenses set up", String(data.openRecurring)],
              ["Closed months", String(data.closedPeriods.length)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-border bg-card p-4">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="mt-1 text-xl font-semibold text-foreground">{value}</div>
              </div>
            ))}
          </section>
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold text-foreground">Trial balance</h2>
            <table className="mt-2 w-full text-sm">
              <tbody className="divide-y divide-border">
                {data.trial.map((r) => (
                  <tr key={r.code + r.name}>
                    <td className="py-1.5 text-muted-foreground">{r.code}</td>
                    <td className="py-1.5">{r.name}</td>
                    <td className="py-1.5 text-right">{formatCents(r.balanceCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted-foreground">
              Debits {formatCents(data.totals.debitCents)} · credits {formatCents(data.totals.creditCents)} · {data.totals.balanced ? "balanced" : "NOT balanced"}
            </p>
          </section>
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold text-foreground">Recent entries</h2>
            <ul className="mt-2 divide-y divide-border text-sm">
              {data.entries.map((e, i) => (
                <li key={i} className="py-2">
                  <div className="text-xs text-muted-foreground">
                    {e.date} · {e.source}
                    {e.reversal ? " · reversal" : ""}
                  </div>
                  {e.lines.map((l, j) => (
                    <div key={j} className="flex justify-between gap-3">
                      <span>{l.account}</span>
                      <span className="text-muted-foreground">{l.debitCents ? `Dr ${formatCents(l.debitCents)}` : `Cr ${formatCents(l.creditCents)}`}</span>
                    </div>
                  ))}
                </li>
              ))}
              {data.entries.length === 0 ? <li className="py-2 text-muted-foreground">No entries yet.</li> : null}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}
