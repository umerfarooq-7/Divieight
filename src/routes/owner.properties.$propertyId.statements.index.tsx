import { useEffect } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import { DesignatedCpaCard } from "@/components/DesignatedCpaCard";
import { getOwnerStatements } from "@/lib/statements.functions";
import { STATEMENT_STATUS_LABELS, periodLabel, statementMoney } from "@/lib/statements";

export const Route = createFileRoute("/owner/properties/$propertyId/statements/")({
  head: () => ({
    meta: [
      { title: "Monthly statements — divieight" },
      { name: "description", content: "Your monthly statements for this home's LLC." },
      { property: "og:title", content: "Monthly statements — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerStatementsPage,
});

function OwnerStatementsPage() {
  const { propertyId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(getOwnerStatements);
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["owner-statements", propertyId, user?.id], enabled: !!user, retry: false, queryFn: () => load({ data: { propertyId } }) });

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
      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground sm:text-3xl">Monthly statements</h1>
      <p className="mt-1 max-w-3xl text-base text-muted-foreground">
        One statement a month for your capital account (a joint account has one, shared by both members). If the books for a past month are corrected you get a new version; the earlier one stays here.
      </p>
      <div className="mt-4">
        <DesignatedCpaCard propertyId={propertyId} />
      </div>
      <div className="mt-6 space-y-3">
        {isLoading || authLoading ? <OwnerLoading /> : null}
        {isError ? (
          <p className="text-base text-destructive">
            Couldn&apos;t load your statements.{" "}
            <button type="button" className="underline" onClick={() => refetch()}>
              Try again
            </button>
          </p>
        ) : null}
        {data?.allowed && data.statements.length === 0 ? <p className="rounded-xl border border-border bg-card p-4 text-base text-muted-foreground">No statements have been issued yet.</p> : null}
        {data?.allowed
          ? data.statements.map((s) => (
              <Link key={s.id} to="/owner/properties/$propertyId/statements/$statementId" params={{ propertyId, statementId: s.id }} className="block rounded-xl border border-border bg-card p-4 hover:bg-secondary">
                <div className="flex flex-wrap items-center justify-between gap-2 text-base">
                  <span className="font-medium text-foreground">
                    {periodLabel(s.period)} · version {s.version}
                  </span>
                  <span className="text-foreground">Closing {statementMoney(s.closingCents)}</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {STATEMENT_STATUS_LABELS[s.status]}
                  {s.issuedAt ? ` · Issued ${s.issuedAt.slice(0, 10)}` : ""}
                </p>
              </Link>
            ))
          : null}
      </div>
    </OwnerPageShell>
  );
}
