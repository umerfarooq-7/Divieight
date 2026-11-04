import { useEffect } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { MyAllocationLine, OverduePaymentNotice } from "@/components/owner/PaymentBits";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import { formatDate } from "@/lib/format-date";
import { CAPITAL_CALL_STATUS_LABELS, expenseMoney } from "@/lib/expenses";
import { getOwnerCapitalCalls } from "@/lib/expenses.functions";

export const Route = createFileRoute("/owner/properties/$propertyId/capital-calls")({
  head: () => ({
    meta: [
      { title: "Capital calls — divieight" },
      { name: "description", content: "Capital calls on your home and your share of each." },
      { property: "og:title", content: "Capital calls — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerCapitalCallsPage,
});

function OwnerCapitalCallsPage() {
  const { propertyId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(getOwnerCapitalCalls);
  const queryKey = ["owner-capital-calls", propertyId, user?.id];
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    enabled: !!user,
    retry: false,
    queryFn: () => load({ data: { propertyId } }),
  });

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
      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground sm:text-3xl">Capital calls</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Your share of each call, by the shares you held when it was issued. No payment is taken here: tell us when you've paid and divieight confirms it once received.
      </p>
      <div className="mt-6 space-y-3">
        {isError ? (
          <p className="text-sm text-muted-foreground">
            We couldn't load capital calls.{" "}
            <button type="button" onClick={() => void refetch()} className="font-medium text-primary hover:underline">
              Try again
            </button>
          </p>
        ) : authLoading || isLoading || !data || denied ? (
          <OwnerLoading />
        ) : data.rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No capital calls have been issued.</p>
        ) : (
          <>
            <OverduePaymentNotice propertyId={propertyId} />
            {data.rows.map((c) => (
              <article key={c.id} className="rounded-xl border border-border bg-card p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h2 className="min-w-0 break-words font-display text-base font-semibold text-foreground">{c.title}</h2>
                  <p className="font-semibold text-foreground">{expenseMoney(c.totalAmount)}</p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {CAPITAL_CALL_STATUS_LABELS[c.status]} · Due {formatDate(c.dueDate)}
                </p>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">{c.reason}</p>
                {c.mine ? (
                  <MyAllocationLine kind="capital_call" allocation={c.mine} invalidate={[["owner-capital-calls", propertyId], ["owner-payment-notice", propertyId]]} />
                ) : (
                  <p className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground">Issued before you held shares, so you have no share of it.</p>
                )}
              </article>
            ))}
          </>
        )}
      </div>
    </OwnerPageShell>
  );
}
