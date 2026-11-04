import { useEffect } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { MyAllocationLine } from "@/components/owner/PaymentBits";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import { formatDate } from "@/lib/format-date";
import { expenseMoney } from "@/lib/expenses";
import { getOwnerExpenses } from "@/lib/expenses.functions";

export const Route = createFileRoute("/owner/properties/$propertyId/expenses")({
  head: () => ({
    meta: [
      { title: "Expenses — divieight" },
      { name: "description", content: "Your home's expenses and your share of each." },
      { property: "og:title", content: "Expenses — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerExpensesPage,
});

function OwnerExpensesPage() {
  const { propertyId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(getOwnerExpenses);
  const queryKey = ["owner-expenses", propertyId, user?.id];
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
      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground sm:text-3xl">Expenses</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Every expense posted to this home, and your share by the shares you held when it was posted. No payment is taken here: tell us when you've paid and divieight confirms it once
        received.
      </p>
      <div className="mt-6 space-y-3">
        {isError ? (
          <p className="text-sm text-muted-foreground">
            We couldn't load expenses.{" "}
            <button type="button" onClick={() => void refetch()} className="font-medium text-primary hover:underline">
              Try again
            </button>
          </p>
        ) : authLoading || isLoading || !data || denied ? (
          <OwnerLoading />
        ) : data.rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No expenses have been posted yet.</p>
        ) : (
          data.rows.map((e) => (
            <article key={e.id} className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="min-w-0 break-words font-display text-base font-semibold text-foreground">{e.description}</h2>
                <p className={`font-semibold text-foreground ${e.status === "voided" ? "line-through" : ""}`}>{expenseMoney(e.totalAmount)}</p>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {e.category} · {formatDate(e.incurredOn)}
                {e.fromMaintenance ? " · From a maintenance request" : ""}
                {e.status === "voided" ? " · Voided" : ""}
              </p>
              {e.status === "voided" && e.voidReason ? <p className="mt-2 break-words text-sm text-muted-foreground">Reason: {e.voidReason}</p> : null}
              {e.mine ? (
                <MyAllocationLine kind="expense" allocation={e.mine} invalidate={[["owner-expenses", propertyId]]} />
              ) : (
                <p className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground">Posted before you held shares, so you have no share of it.</p>
              )}
            </article>
          ))
        )}
      </div>
    </OwnerPageShell>
  );
}
