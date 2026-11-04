import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatDate } from "@/lib/format-date";
import { resaleMoney, ROFR_WINNER_RULE } from "@/lib/resale";
import { cancelResaleSale, completeResaleSale, listResaleForAdmin } from "@/lib/resale.functions";
import type { AdminResaleListing, AdminResaleSale } from "@/lib/resale.server";

export const Route = createFileRoute("/admin/resale")({
  head: () => ({
    meta: [
      { title: "Resale Shop — divieight admin" },
      { name: "description", content: "Resale listings, co-owner elections and buyer interest." },
      { property: "og:title", content: "Resale Shop — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminResalePage,
});

function AdminResalePage() {
  const load = useServerFn(listResaleForAdmin);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-resale"],
    queryFn: () => load(),
    retry: false,
  });
  const rows = data?.rows ?? [];
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Resale Shop</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Listings, co-owner elections and open-market interest. {ROFR_WINNER_RULE}. Contact interested open-market buyers directly:
        buying through onboarding isn't built yet.
      </p>
      <div className="mt-3 max-w-3xl space-y-1 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        <p>Title and escrow are simulated. Marking a sale complete moves no money, and the platform never disburses.</p>
        <p>
          <span className="font-semibold text-foreground">OPEN QUESTION for Mark:</span> a resale buyer gets a fresh 12-month Retention Lock on the share.
          Confirm this is intended.
        </p>
      </div>
      <div className="mt-6 space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">No resale listings yet.</p>
        ) : (
          rows.map((row) => <ListingCard key={row.id} row={row} />)
        )}
      </div>
    </div>
  );
}

function ListingCard({ row }: { row: AdminResaleListing }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 font-display text-base font-semibold text-foreground">
          {row.propertyLabel} · Share #{row.shareNumber}
        </h2>
        <span className="rounded-full bg-muted px-3 py-1 text-xs text-foreground">{row.statusLabel}</span>
      </div>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Seller" value={row.seller} />
        <Fact label="Asking price" value={resaleMoney(row.askingPrice)} />
        <Fact label="Fee at sale" value={resaleMoney(row.flatFee)} />
        <Fact label="ROFR closes" value={formatDate(row.rofrClosesAt)} />
      </dl>
      {row.elections.length > 0 ? (
        <div className="mt-3 text-sm">
          <p className="font-medium text-foreground">Elections</p>
          <ul className="mt-1 space-y-1 text-muted-foreground">
            {row.elections.map((e) => (
              <li key={e.holderKey} className="break-words">
                {formatDate(e.electedAt)} · priority {e.rank ?? "—"} · {e.status} · {e.holderKey}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {row.interested.length > 0 ? (
        <div className="mt-3 text-sm">
          <p className="font-medium text-foreground">Interested buyers</p>
          <ul className="mt-1 space-y-1 text-muted-foreground">
            {row.interested.map((i, index) => (
              <li key={index} className="break-words">
                {i.email ?? "Buyer"} · {formatDate(i.at)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {row.sales.map((s) => (
        <SalePanel key={s.id} sale={s} />
      ))}
      {row.cpaFlags.length > 0 ? (
        <div className="mt-3 rounded-lg border border-border p-3 text-sm">
          <p className="font-medium text-foreground">CPA worksheet flags</p>
          <ul className="mt-1 space-y-1 text-muted-foreground">
            {row.cpaFlags.map((f, index) => (
              <li key={index} className="break-words">
                {f.flagType} · {formatDate(f.createdAt)}: {f.note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function SalePanel({ sale: s }: { sale: AdminResaleSale }) {
  const qc = useQueryClient();
  const complete = useServerFn(completeResaleSale);
  const cancel = useServerFn(cancelResaleSale);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const onSettled = () => {
    setConfirming(false);
    void qc.invalidateQueries({ queryKey: ["admin-resale"] });
  };
  const completeMut = useMutation({
    mutationFn: () => complete({ data: { transactionId: s.id } }),
    onSuccess: () => toast.success("Sale complete. The cap table is updated."),
    onError: (e: Error) => toast.error(e.message),
    onSettled,
  });
  const cancelMut = useMutation({
    mutationFn: () => cancel({ data: { transactionId: s.id, reason } }),
    onSuccess: () => toast.success("Sale cancelled. The cap table wasn't changed."),
    onError: (e: Error) => toast.error(e.message),
    onSettled,
  });
  const busy = completeMut.isPending || cancelMut.isPending;
  return (
    <div className="mt-3 rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 break-words font-medium text-foreground">
          Sale to {s.buyerEmail ?? s.buyerHolderKey} · {resaleMoney(s.price)}
        </p>
        <span className="rounded-full bg-muted px-3 py-1 text-xs capitalize text-foreground">{s.status.replace("_", " ")}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {resaleMoney(s.flatFee)} technology-service fee (ledger line).
        {s.completedAt ? ` Completed ${formatDate(s.completedAt)}.` : ""}
        {s.cancelReason ? ` Cancelled: ${s.cancelReason}` : ""}
      </p>
      {s.status === "pending_closing" ? (
        <div className="mt-3 space-y-2">
          {confirming ? (
            <div className="space-y-2">
              <p className="text-foreground">This moves the share to the buyer on the cap table, starts their Retention Lock and can't be undone here.</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => completeMut.mutate()} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
                  {completeMut.isPending ? "Completing…" : "Confirm complete"}
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50">
                  Back
                </button>
              </div>
            </div>
          ) : (
            <button type="button" disabled={busy} onClick={() => setConfirming(true)} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              Mark complete
            </button>
          )}
          <div className="flex flex-wrap gap-2">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={2000}
              placeholder="Reason for cancelling (required)"
              aria-label="Reason for cancelling"
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
            <button type="button" disabled={busy || !reason.trim()} onClick={() => cancelMut.mutate()} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50">
              Cancel sale
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words font-medium text-foreground">{value}</dd>
    </div>
  );
}
