import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatCents, reviewReasonLabel } from "@/lib/bank-feed-display";
import { getBankFeed, linkLlcOperatingAccount, revokeLlcOperatingAccount, runBankFeedFn } from "@/lib/bank-feed.functions";

export const Route = createFileRoute("/admin/bank-feed")({
  head: () => ({
    meta: [
      { title: "Bank feed — divieight admin" },
      { name: "description", content: "Link each LLC's operating account and reconcile the bank to the ledger." },
      { property: "og:title", content: "Bank feed — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminBankFeedPage,
});

const PRIMARY = "rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";
const SECONDARY = "rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50";
const KEY = ["admin-bank-feed"];

function AdminBankFeedPage() {
  const qc = useQueryClient();
  const load = useServerFn(getBankFeed);
  const link = useServerFn(linkLlcOperatingAccount);
  const revoke = useServerFn(revokeLlcOperatingAccount);
  const run = useServerFn(runBankFeedFn);
  const { data, isLoading, error } = useQuery({ queryKey: KEY, queryFn: () => load(), retry: false });
  const done = (message: string) => () => {
    toast.success(message);
    void qc.invalidateQueries({ queryKey: KEY });
  };
  const onError = (e: Error) => toast.error(e.message);
  const linkM = useMutation({ mutationFn: (propertyId: string) => link({ data: { propertyId } }), onSuccess: done("Operating account linked"), onError });
  const revokeM = useMutation({ mutationFn: (propertyId: string) => revoke({ data: { propertyId } }), onSuccess: done("Consent revoked. Nothing more will be ingested."), onError });
  const runM = useMutation({
    mutationFn: (propertyId?: string) => run({ data: { propertyId } }),
    onSuccess: (r) => {
      toast.success(`Run logged: ${r.properties.reduce((s, p) => s + p.fetched, 0)} transactions, ${r.properties.reduce((s, p) => s + p.posted, 0)} posted, ${r.properties.reduce((s, p) => s + p.needsReview, 0)} to review`);
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError,
  });

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Bank feed</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Each LLC's operating account is linked here, by divieight, LLC as Manager. This consent is separate from a buyer's Block 1 consent. The feed runs daily; a transaction that matches a rule is posted to the ledger,
        and anything else waits for you. Money in is never posted to income automatically, and nothing that looks like short-term-rental revenue is posted to the LLC. This is Plaid sandbox: no real bank.
      </p>
      <div className="mt-4">
        <button type="button" className={SECONDARY} disabled={runM.isPending} onClick={() => runM.mutate(undefined)}>
          Run the feed now for every linked LLC
        </button>
      </div>
      {isLoading ? <p className="mt-6 text-sm text-muted-foreground">Loading…</p> : null}
      {error ? <p className="mt-6 text-sm text-destructive">{(error as Error).message}</p> : null}
      <div className="mt-5 space-y-4">
        {(data ?? []).map((p) => (
          <section key={p.propertyId} className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-medium text-foreground">{p.label || p.propertyId}</h2>
                {p.consent ? (
                  <p className="text-xs text-muted-foreground">
                    Linked: {p.consent.institutionName ?? "Bank"} ····{p.consent.accountMask ?? ""} · consent by {p.consent.entity} · {new Date(p.consent.grantedAt).toLocaleDateString()}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">No operating account linked.</p>
                )}
              </div>
              <div className="flex gap-2">
                {p.consent ? (
                  <>
                    <button type="button" className={SECONDARY} disabled={runM.isPending} onClick={() => runM.mutate(p.propertyId)}>
                      Run now
                    </button>
                    <button type="button" className={SECONDARY} disabled={revokeM.isPending} onClick={() => revokeM.mutate(p.propertyId)}>
                      Revoke consent
                    </button>
                  </>
                ) : (
                  <button type="button" className={PRIMARY} disabled={linkM.isPending} onClick={() => linkM.mutate(p.propertyId)}>
                    Link operating account (sandbox)
                  </button>
                )}
              </div>
            </div>
            {p.reconciliation ? (
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-4">
                <div><dt className="text-xs text-muted-foreground">Bank balance</dt><dd>{p.reconciliation.bankBalanceCents == null ? "Not reported yet" : formatCents(p.reconciliation.bankBalanceCents)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Ledger Cash</dt><dd>{formatCents(p.reconciliation.ledgerCashCents)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Difference</dt><dd>{p.reconciliation.differenceCents == null ? "—" : formatCents(p.reconciliation.differenceCents)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Unexplained</dt><dd>{p.reconciliation.unreconciledCents == null ? "—" : formatCents(p.reconciliation.unreconciledCents)}</dd></div>
                <div className="sm:col-span-4 text-xs text-muted-foreground">
                  Unmatched: {p.reconciliation.unmatchedCount} ({formatCents(p.reconciliation.unmatchedInCents)} in, {formatCents(p.reconciliation.unmatchedOutCents)} out) · pending at the bank: {p.reconciliation.pendingCount}
                  {p.reconciliation.lastIngestedThrough ? ` · fed through ${p.reconciliation.lastIngestedThrough}` : ""}
                </div>
              </dl>
            ) : null}
            {p.review.length > 0 ? (
              <div className="mt-3">
                <h3 className="text-sm font-medium text-foreground">Needs your review ({p.review.length})</h3>
                <ul className="mt-1 divide-y divide-border text-sm">
                  {p.review.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                      <span>{t.postedDate} · {t.merchantName ?? t.description ?? "Bank transaction"}</span>
                      <span className="text-muted-foreground">{reviewReasonLabel(t.reason)}</span>
                      <span className={t.direction === "in" ? "text-foreground" : "text-muted-foreground"}>{t.direction === "in" ? "+" : "−"}{formatCents(t.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ))}
        {data && data.length === 0 ? <p className="text-sm text-muted-foreground">No properties yet.</p> : null}
      </div>
    </div>
  );
}
