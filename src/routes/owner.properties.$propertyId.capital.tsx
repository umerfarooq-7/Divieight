import { useEffect } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import { formatCents } from "@/lib/bank-feed-display";
import { getOwnerCapitalAccount } from "@/lib/capital.functions";
import type { RollForwardRow } from "@/lib/capital.server";

export const Route = createFileRoute("/owner/properties/$propertyId/capital")({
  head: () => ({
    meta: [
      { title: "Capital account — divieight" },
      { name: "description", content: "Your capital account in this home's LLC, year by year." },
      { property: "og:title", content: "Capital account — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerCapitalPage,
});

const LINES: Array<[keyof RollForwardRow, string]> = [
  ["beginningCents", "Beginning capital"],
  ["openingCents", "Opening capital from the closing"],
  ["contributionsCents", "Contributions"],
  ["incomeCents", "Allocable income"],
  ["expenseCents", "Allocable expenses"],
  ["depreciationCents", "Allocable depreciation"],
  ["distributionsCents", "Distributions"],
  ["transferInCents", "Transferred in (share purchased)"],
  ["transferOutCents", "Transferred out (share sold)"],
];

function OwnerCapitalPage() {
  const { propertyId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(getOwnerCapitalAccount);
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["owner-capital", propertyId, user?.id], enabled: !!user, retry: false, queryFn: () => load({ data: { propertyId } }) });

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/owner/login", search: { redirect: window.location.pathname } });
  }, [authLoading, user, navigate]);
  const denied = data?.allowed === false;
  useEffect(() => {
    if (!denied) return;
    toast.error("You don't have ownership in that property.");
    navigate({ to: "/owner" });
  }, [denied, navigate]);

  return (
    <OwnerPageShell>
      <Link to="/owner/properties/$propertyId" params={{ propertyId }} className="text-sm text-muted-foreground hover:text-foreground">
        ← Owner dashboard
      </Link>
      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground sm:text-3xl">Capital account</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Your share of the LLC, year by year, from the books. Each year starts where the last one ended. This is for your records and your CPA; it is read-only. A joint account is one capital account.
      </p>
      <div className="mt-6 space-y-4">
        {isLoading || authLoading ? <OwnerLoading /> : null}
        {isError ? (
          <p className="text-sm text-destructive">
            Couldn't load your capital account.{" "}
            <button type="button" className="underline" onClick={() => refetch()}>
              Try again
            </button>
          </p>
        ) : null}
        {data?.allowed && data.years.length === 0 ? <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">Nothing has been recorded in your capital account yet.</p> : null}
        {data?.allowed
          ? data.years.map((y, i) => (
              <section key={y.year} className="rounded-xl border border-border bg-card p-5">
                <h2 className="font-display text-lg font-semibold text-foreground">
                  {y.year}
                  {i === 0 ? <span className="ml-2 text-xs font-normal text-muted-foreground">current year</span> : null}
                </h2>
                <dl className="mt-3 space-y-1 text-sm">
                  {LINES.filter(([k]) => k === "beginningCents" || y[k] !== 0).map(([k, label]) => (
                    <div key={k} className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="text-foreground">{formatCents(y[k] as number)}</dd>
                    </div>
                  ))}
                  <div className="flex justify-between gap-3 border-t border-border pt-2 font-medium">
                    <dt>Ending capital</dt>
                    <dd>{formatCents(y.endingCents)}</dd>
                  </div>
                </dl>
              </section>
            ))
          : null}
      </div>
    </OwnerPageShell>
  );
}
