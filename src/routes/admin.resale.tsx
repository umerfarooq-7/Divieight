import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { formatDate } from "@/lib/format-date";
import { resaleMoney } from "@/lib/resale";
import { listResaleForAdmin } from "@/lib/resale.functions";
import type { AdminResaleListing } from "@/lib/resale.server";

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
        Listings, co-owner elections and open-market interest. Contact interested buyers directly: buying through onboarding
        isn't built yet.
      </p>
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
    </section>
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
