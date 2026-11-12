import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Home, Users, UserCheck, Briefcase } from "lucide-react";
import { getAgentPodView } from "@/lib/agent-pod.functions";
import { EightSlicesTracker } from "@/components/EightSlicesTracker";
import { ListingStatusTimeline, type ListingStatus } from "@/components/ListingStatusTimeline";

/**
 * Agent Pod View — broader-audience sibling of the HLA-only Master Briefcase.
 * Any Resident Agent tethered to a buyer in this pod may read it; only their
 * own buyers are named (see agent-pod.functions.ts privacy boundary).
 */
export const Route = createFileRoute("/agent/pods/$id/")({
  head: () => ({
    meta: [
      { title: "Pod view — divieight Professional Portal" },
      {
        name: "description",
        content:
          "Coordination view of a divieight buyer pod: share fill, pod stage, your buyers, and the agent roster.",
      },
      { property: "og:title", content: "Pod view — divieight Professional Portal" },
      {
        property: "og:description",
        content: "Resident Agent view of an eight-share divieight buyer pod.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AgentPodViewPage,
});

function money(n: number | null) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function AgentPodViewPage() {
  const { id } = Route.useParams();
  const load = useServerFn(getAgentPodView);

  const { data, isLoading } = useQuery({
    queryKey: ["agent-pod-view", id],
    retry: false,
    queryFn: () => load({ data: { propertyId: id } }),
  });

  if (isLoading) {
    return <p className="p-8 text-sm text-muted-foreground">Loading pod…</p>;
  }

  if (!data || "error" in data) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-20 text-center sm:px-6">
        <h1 className="font-display text-2xl font-semibold text-foreground">Pod unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {(data && "error" in data && data.error) || "We couldn't load this pod for your account."}
        </p>
        <Link
          to="/agent/dashboard"
          className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Back to portal
        </Link>
      </div>
    );
  }

  const pod = data;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <Link
        to="/agent/dashboard"
        className="text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
      >
        ← Back to portal
      </Link>

      <header className="mt-4 grid gap-6 sm:grid-cols-[220px_1fr]">
        <div className="aspect-[4/3] w-full overflow-hidden rounded-xl border border-border bg-secondary">
          {pod.photoUrl ? (
            <img src={pod.photoUrl} alt={pod.address} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Home className="h-8 w-8 opacity-40" />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Pod view</p>
          <h1 className="mt-1 font-display text-2xl font-semibold text-foreground [overflow-wrap:anywhere]">
            {pod.address}
          </h1>
          <p className="text-sm text-muted-foreground">
            {pod.city}, {pod.state} {pod.zip}
          </p>
          <p className="mt-3 font-display text-xl font-semibold text-foreground">
            {money(pod.pricePerShare)} <span className="text-sm font-normal">per share</span>
          </p>
        </div>
      </header>

      <section className="mt-8 rounded-xl border border-border bg-card p-6">
        <h2 className="text-sm font-semibold text-foreground">Share fill</h2>
        <div className="mt-3">
          <EightSlicesTracker
            retainedShares={pod.retainedShares}
            reservedShares={pod.reservedShares}
          />
        </div>
        <div className="mt-5 border-t border-border pt-5">
          <ListingStatusTimeline status={(pod.listingStatus as ListingStatus) ?? "forming"} />
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <UserCheck className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold text-foreground">My buyers in this pod</h2>
        </div>
        <ul className="mt-4 space-y-2">
          {pod.myBuyers.map((b) => (
            <li
              key={b.buyerAccountId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-4 py-3 text-sm"
            >
              <div className="min-w-0">
                <p className="font-semibold text-foreground [overflow-wrap:anywhere]">{b.name}</p>
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {b.email} · Onboarding stage: {b.onboardingStatus.replace(/_/g, " ")}
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {b.sharesReserved} share{b.sharesReserved === 1 ? "" : "s"} · {b.reservationStatus}
                {b.reservedAt ? ` · ${new Date(b.reservedAt).toLocaleDateString()}` : ""}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">
          Commission for this pod covers {pod.myShareTotal} of 8 shares —{" "}
          <Link
            to="/agent/dashboard"
            hash="commission"
            className="font-medium text-foreground underline underline-offset-2"
          >
            open my commission pipeline
          </Link>
          .
        </p>
      </section>

      <section className="mt-6 rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold text-foreground">Other Resident Agents</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Professional contact only — which buyer each agent represents is never shown.
        </p>
        {pod.otherAgents.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No other Resident Agents are tethered into this pod yet.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {pod.otherAgents.map((a) => (
              <li key={a.agentId} className="rounded-lg border border-border px-4 py-3 text-sm">
                <p className="font-medium text-foreground">{a.fullName}</p>
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {a.brokerageName ?? "Brokerage —"}
                  {a.brokerOfRecord ? ` · Broker of Record: ${a.brokerOfRecord}` : ""}
                  {a.contactEmail ? ` · ${a.contactEmail}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-2">
            <Briefcase className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-foreground">Heavy Lifting Agent</h2>
          </div>
          <p className="mt-3 text-sm text-foreground">
            {pod.heavyLifterName ?? "Not selected yet"}
          </p>
          <p className="text-xs text-muted-foreground">
            Status: {(pod.hlaStatus ?? "awaiting selection").replace(/_/g, " ")}
          </p>
          {pod.viewerHlaAccepted && pod.podId ? (
            <Link
              to="/agent/pods/$id/briefcase"
              params={{ id: pod.podId }}
              className="mt-4 inline-flex h-9 items-center rounded-md bg-accent px-4 text-xs font-semibold text-accent-foreground"
            >
              Open Master Briefcase
            </Link>
          ) : null}
          {pod.viewerHlaAccepted ? (
            <Link
              to="/agent/pods/$id/books"
              params={{ id }}
              className="mt-4 ml-2 inline-flex h-9 items-center rounded-md border border-border px-4 text-xs font-semibold text-foreground"
            >
              Books (read-only)
            </Link>
          ) : null}
        </div>

        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="text-sm font-semibold text-foreground">Listing Agent</h2>
          <p className="mt-3 text-sm text-foreground">
            {pod.listingAgentName ?? "Not assigned"}
          </p>
          <p className="text-xs text-muted-foreground">
            {pod.listingAgentBrokerage ?? "Brokerage —"}
          </p>
        </div>
      </section>
    </div>
  );
}
