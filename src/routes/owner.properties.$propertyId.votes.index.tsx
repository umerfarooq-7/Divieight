import { useEffect } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { VoteStatusChip, voteTimingLabel } from "@/components/owner/VoteBits";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import { listVotesForOwner } from "@/lib/votes.functions";
import { VOTE_TYPE_LABELS } from "@/lib/votes";

export const Route = createFileRoute("/owner/properties/$propertyId/votes/")({
  head: () => ({
    meta: [
      { title: "Votes — divieight" },
      { name: "description", content: "Votes on your home: one vote per 1/8th share." },
      { property: "og:title", content: "Votes — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerVotesPage,
});

function OwnerVotesPage() {
  const { propertyId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(listVotesForOwner);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["owner-votes", propertyId, user?.id],
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
      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground sm:text-3xl">Votes</h1>
      <p className="mt-1 text-sm text-muted-foreground">One vote per 1/8th share.</p>
      <div className="mt-6">
        {isError ? (
          <p className="text-sm text-muted-foreground">
            We couldn't load votes.{" "}
            <button type="button" onClick={() => void refetch()} className="font-medium text-primary hover:underline">
              Try again
            </button>
          </p>
        ) : authLoading || isLoading || !data || denied ? (
          <OwnerLoading />
        ) : data.votes.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">No votes yet.</p>
        ) : (
          <ul className="space-y-3">
            {data.votes.map((v) => (
              <li key={v.id}>
                <Link
                  to="/owner/properties/$propertyId/votes/$voteId"
                  params={{ propertyId, voteId: v.id }}
                  className="block rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:bg-secondary/60"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h2 className="min-w-0 text-sm font-semibold text-foreground">{v.title}</h2>
                    <VoteStatusChip status={v.status} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {VOTE_TYPE_LABELS[v.voteType]} · {voteTimingLabel(v.status, v.opensAt, v.closesAt)}
                  </p>
                  <p className="mt-2 text-xs text-foreground">
                    My weight: {v.myWeight} · My choice: {v.myChoice ?? "Not cast"}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </OwnerPageShell>
  );
}
