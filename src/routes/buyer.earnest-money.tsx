import { createFileRoute } from "@tanstack/react-router";
import { PropertyScopeBanner } from "@/components/PropertyScopeBanner";
import { propertySearch } from "@/lib/property-scope";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Banknote, ShieldAlert } from "lucide-react";
import { listBuyerEarnestMoney } from "@/lib/earnest-money.functions";
import {
  DEFAULT_FUNDING_METHODS,
  DEFAULT_PRA8_NOTICE,
  DIRECT_TO_ESCROW_NOTICE,
  EARNEST_STATUS_LABELS,
  NOT_ENROLLMENT_FEE_NOTICE,
  SUBSTITUTE_CONDITION_NOTICE,
  formatDeadline,
  money,
  type EarnestStatus,
} from "@/lib/earnest-money";

export const Route = createFileRoute("/buyer/earnest-money")({
  head: () => ({
    meta: [
      { title: "Earnest money — divieight" },
      {
        name: "description",
        content:
          "Your pro-rata earnest-money obligation, escrow funding instructions and funding status.",
      },
      { property: "og:title", content: "Earnest money — divieight" },
      {
        property: "og:description",
        content: "Pro-rata earnest-money funding instructions for your share of the pod.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  validateSearch: propertySearch,
  component: BuyerEarnestMoney,
});

const BADGE: Record<EarnestStatus, string> = {
  pending: "bg-amber-100 text-amber-800",
  funded: "bg-emerald-100 text-emerald-800",
  late: "bg-orange-100 text-orange-800",
  missed: "bg-destructive/10 text-destructive",
};

function BuyerEarnestMoney() {
  const fetchRows = useServerFn(listBuyerEarnestMoney);
  const { property } = Route.useSearch();
  const { data, isLoading } = useQuery({
    queryKey: ["buyer-earnest-money", property ?? "all"],
    queryFn: () => fetchRows({ data: { propertyId: property ?? null } }),
  });
  const rows = data?.rows ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-foreground">Earnest money</h1>
        <p className="mt-1 text-sm text-muted-foreground">{DIRECT_TO_ESCROW_NOTICE}</p>
        <p className="mt-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          {NOT_ENROLLMENT_FEE_NOTICE}
        </p>
        <PropertyScopeBanner to="/buyer/earnest-money" property={property} label={data?.rows[0]?.propertyLabel} />
      </header>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading your funding instructions…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No earnest-money obligation yet. One is issued once the seller accepts your Buyer
          Group's offer.
        </div>
      ) : (
        <div className="space-y-5">
          {rows.map(({ obligation: o, terms, propertyLabel }) => (
            <section key={o.id} className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
                    Funding instruction
                  </p>
                  <h2 className="font-display text-lg font-semibold text-foreground">
                    {propertyLabel}
                  </h2>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${BADGE[o.status]}`}
                >
                  {EARNEST_STATUS_LABELS[o.status]}
                </span>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border bg-background p-4">
                  <p className="text-xs text-muted-foreground">Your pro-rata amount</p>
                  <p className="font-display text-2xl font-semibold text-foreground">
                    {money(o.amount)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Based on {o.shares} of eight shares
                    {terms ? ` · ${money(terms.total_amount)} total for the buyer group` : ""}
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-background p-4">
                  <p className="text-xs text-muted-foreground">Funding deadline</p>
                  <p className="text-sm font-medium text-foreground">
                    {formatDeadline(o.funding_deadline)}
                  </p>
                  {o.funded_at ? (
                    <p className="mt-1 text-xs text-emerald-700">
                      Receipt confirmed {formatDeadline(o.funded_at)}
                      {o.funded_reference ? ` · ref ${o.funded_reference}` : ""}
                    </p>
                  ) : null}
                </div>
              </div>

              {terms ? (
                <div className="mt-4 rounded-lg border border-border bg-background p-4 text-sm">
                  <p className="flex items-center gap-2 font-medium text-foreground">
                    <Banknote className="h-4 w-4 text-accent" />
                    {terms.escrow_company}
                  </p>
                  <pre className="mt-2 whitespace-pre-wrap font-sans text-xs text-muted-foreground">
                    {terms.escrow_account_details}
                  </pre>
                  {terms.escrow_reference ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Reference: {terms.escrow_reference}
                    </p>
                  ) : null}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Accepted funding methods:{" "}
                    {(terms.funding_methods ?? DEFAULT_FUNDING_METHODS).join(", ")}
                  </p>
                </div>
              ) : null}

              {o.is_substitute ? (
                <p className="mt-4 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                  {SUBSTITUTE_CONDITION_NOTICE}
                </p>
              ) : null}

              <p className="mt-4 flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{DEFAULT_PRA8_NOTICE}</span>
              </p>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
