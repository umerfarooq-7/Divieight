import { useEffect } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Building2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { resaleMoney } from "@/lib/resale";
import { expressResaleInterest, listOpenMarketResale } from "@/lib/resale.functions";
import type { OpenMarketListing } from "@/lib/resale.server";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/resale")({
  head: () => ({
    meta: [
      { title: "Resale shares — divieight" },
      { name: "description", content: "1/8th shares offered for resale by divieight co-owners." },
      { property: "og:title", content: "Resale shares — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ResalePage,
});

function ResalePage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(listOpenMarketResale);
  const { data, isLoading, error } = useQuery({
    queryKey: ["resale-open-market", user?.id],
    enabled: !!user,
    retry: false,
    queryFn: () => load(),
  });

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/buyer/login" });
  }, [authLoading, user, navigate]);

  const listings = data?.listings ?? [];
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
      <h1 className="font-display text-2xl font-semibold text-foreground sm:text-3xl">Resale shares</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Shares here have already been offered to the home's co-owners. Express interest and divieight will contact you.
      </p>
      <div className="mt-6">
        {authLoading || isLoading || (!data && !error) ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : data?.allowed === false ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            Resale shares are open to buyers who have finished onboarding.
            <div className="mt-4">
              <Link to="/buyer/dashboard" className="font-medium text-primary hover:underline">
                Go to my buyer dashboard
              </Link>
            </div>
          </div>
        ) : listings.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No resale shares are available right now.
          </p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {listings.map((l) => (
              <ListingCard key={l.id} listing={l} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ListingCard({ listing: l }: { listing: OpenMarketListing }) {
  const qc = useQueryClient();
  const express = useServerFn(expressResaleInterest);
  const mut = useMutation({
    mutationFn: () => express({ data: { listingId: l.id } }),
    onSuccess: (r) => {
      if (r.error) toast.error(r.error);
      else toast.success("Thanks. divieight will contact you.");
      void qc.invalidateQueries({ queryKey: ["resale-open-market"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <li className={cn("overflow-hidden rounded-xl border border-border bg-card shadow-sm", l.incompatible && "opacity-60 grayscale")}>
      {l.photo ? (
        <img src={l.photo} alt="" className="h-40 w-full object-cover" />
      ) : (
        <div className="flex h-40 items-center justify-center bg-muted">
          <Building2 className="h-8 w-8 text-muted-foreground" aria-hidden />
        </div>
      )}
      <div className="p-4">
        <h2 className="font-display text-base font-semibold text-foreground">{l.label}</h2>
        <p className="mt-1 text-sm text-foreground">
          1/8th share · {resaleMoney(l.askingPrice)}
        </p>
        {l.incompatible ? <p className="mt-1 text-xs text-muted-foreground">This home's use may not match your intended use.</p> : null}
        <button
          type="button"
          disabled={l.interested || mut.isPending}
          onClick={() => mut.mutate()}
          className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {l.interested ? "Interest sent" : "Express interest"}
        </button>
      </div>
    </li>
  );
}
