import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Lock, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { EightSlicesTracker } from "@/components/EightSlicesTracker";
import { PodCompositionPanel } from "@/components/PodCompositionPanel";
import { getMarketplaceProperty } from "@/lib/marketplace.functions";
import {
  checkReservationEligibility,
  createReservation,
} from "@/lib/reservations.functions";
import { RESERVATION_BLOCK_COPY, type ReservationResult } from "@/lib/pod";
import { searchAgents } from "@/lib/designation.functions";
import { formatMarkets } from "@/lib/markets";
import { budgetBucketLabel } from "@/lib/budget-buckets";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/reserve/$id")({
  head: () => ({
    meta: [
      { title: "Secure Your Priority Rank — divieight" },
      {
        name: "description",
        content:
          "Confirm your 1/8th share reservation: review the pod, clear the Liquidity Gate and lock your priority rank on this divieight home.",
      },
      { property: "og:title", content: "Secure Your Priority Rank — divieight" },
      {
        property: "og:description",
        content:
          "Review the share price, pod availability and liquidity check before committing to a 1/8th share.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ReservePage,
});

function money(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function ReservePage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();

  const fetchProperty = useServerFn(getMarketplaceProperty);
  const checkEligibility = useServerFn(checkReservationEligibility);
  const reserve = useServerFn(createReservation);

  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ systemLocked: boolean; agentChange: ReservationResult["agentChange"] } | null>(null);
  // Set when the buyer's agent holds this listing: nothing is reserved until
  // they pick a different agent for this property (or let divieight choose).
  const [conflict, setConflict] = useState<ReservationResult["conflict"]>(null);

  const { data: property, isLoading: propertyLoading } = useQuery({
    queryKey: ["marketplace-property", id],
    queryFn: () => fetchProperty({ data: { id } }),
  });

  const {
    data: eligibility,
    isLoading: eligibilityLoading,
    refetch,
  } = useQuery({
    queryKey: ["reservation-eligibility", id, user?.id],
    queryFn: () => checkEligibility({ data: { propertyId: id } }),
    enabled: !!user,
  });

  if (authLoading || propertyLoading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-sm text-muted-foreground sm:px-6">
        Loading reservation…
      </div>
    );
  }

  if (!property) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
        <h1 className="font-display text-2xl font-semibold text-foreground">
          Listing unavailable
        </h1>
        <Link to="/properties" className="mt-6 inline-block text-sm font-medium text-accent">
          Back to all homes →
        </Link>
      </div>
    );
  }

  const perShare = property.listing_price != null ? property.listing_price / 8 : null;
  const composition = eligibility?.composition ?? null;
  const blocked =
    eligibility && !eligibility.ok
      ? (eligibility.reason as keyof typeof RESERVATION_BLOCK_COPY)
      : null;

  async function confirm(agent?: { replacementAgentId?: string; autoAssignAgent?: boolean }) {
    setSubmitting(true);
    const result = await reserve({ data: { propertyId: id, ...agent } });
    setSubmitting(false);
    if (!result.ok && result.reason === "dual_agency_conflict") {
      setConflict(result.conflict ?? null);
      return;
    }
    if (!result.ok && (result.reason === "invalid_replacement_agent" || result.reason === "no_replacement_agent")) {
      toast.error("Choose a different agent", { description: result.message ?? undefined });
      return;
    }
    if (!result.ok) {
      const copy = RESERVATION_BLOCK_COPY[result.reason as keyof typeof RESERVATION_BLOCK_COPY];
      toast.error(copy?.title ?? "Reservation failed", { description: copy?.body });
      void refetch();
      return;
    }
    setConflict(null);
    setDone({ systemLocked: result.systemLocked, agentChange: result.agentChange ?? null });
    void refetch();
    // Keep the Eight-Slices Tracker honest on the listing page and marketplace.
    void queryClient.invalidateQueries({ queryKey: ["pod-composition", id] });
    void queryClient.invalidateQueries({ queryKey: ["marketplace-property", id] });
    void queryClient.invalidateQueries({ queryKey: ["marketplace-properties"] });
    void queryClient.invalidateQueries({ queryKey: ["my-reservations"] });
    toast.success("Priority rank secured", {
      description: "Your 1/8th share is now reserved on this home.",
    });
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <Link
        to="/properties/$id"
        params={{ id }}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Back to the listing
      </Link>

      <h1 className="mt-4 font-display text-3xl font-semibold tracking-tight text-foreground">
        Secure your priority rank
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Review the pod, clear the Liquidity Gate, and commit to one 1/8th share.
      </p>

      {/* 1. Summary */}
      <section className="mt-8 rounded-xl border border-border bg-card p-6 shadow-sm">
        <h2 className="font-display text-lg font-semibold text-foreground">{property.address}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {property.city}, {property.state} {property.zip}
        </p>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border px-4 py-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Price per 1/8th share
            </p>
            <p className="mt-1 font-display text-2xl font-semibold text-foreground">
              {money(perShare)}
            </p>
          </div>
          <div className="rounded-lg border border-border px-4 py-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Whole-home value
            </p>
            <p className="mt-1 font-display text-2xl font-semibold text-foreground">
              {money(property.listing_price)}
            </p>
          </div>
        </div>

        <div className="mt-5">
          <EightSlicesTracker
            retainedShares={composition?.retainedShares ?? 0}
            reservedShares={composition?.reservedShares ?? 0}
          />
        </div>
      </section>

      {/* 2. Liquidity Gate */}
      {!user ? (
        <Notice
          tone="warn"
          title="Sign in to reserve"
          body="Reservations are limited to enrolled divieight buyers who have cleared vetting and the Liquidity Gate."
          action={
            <button
              type="button"
              onClick={() => navigate({ to: "/buyer/login" })}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Sign in as a buyer
            </button>
          }
        />
      ) : eligibilityLoading ? (
        <p className="mt-6 text-sm text-muted-foreground">Running the Liquidity Gate check…</p>
      ) : blocked ? (
        <Notice
          tone={blocked === "already_reserved" ? "ok" : "warn"}
          title={RESERVATION_BLOCK_COPY[blocked].title}
          body={RESERVATION_BLOCK_COPY[blocked].body}
          action={
            blocked === "not_liquidity_verified" ? (
              <Link
                to="/buyer/onboarding/liquidity"
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                Complete liquidity verification
              </Link>
            ) : blocked === "no_buyer_account" ? (
              <Link
                to="/buyer/register"
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                Create a buyer account
              </Link>
            ) : blocked === "already_reserved" ? (
              <Link
                to="/buyer/dashboard"
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                View my reservations
              </Link>
            ) : (
              <Link
                to="/properties"
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground"
              >
                Browse other homes
              </Link>
            )
          }
        />
      ) : done ? (
        <Notice
          tone="ok"
          title="Share reserved"
          body={[
            done.systemLocked
              ? "All eight shares are now committed — this pod has entered System Lock."
              : "Your 1/8th share is reserved and the pod price is now Hard-Locked.",
            done.agentChange
              ? ` For this property your agent is ${done.agentChange.newAgentName ?? "your new agent"}; your other properties keep your usual agent.`
              : "",
            done.agentChange?.referralPreserved ? " Your original agent keeps their referral share." : "",
          ].join("")}
          action={
            <Link
              to="/buyer/dashboard"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Go to my dashboard
            </Link>
          }
        />
      ) : conflict ? (
        <AgentChangeStep
          propertyId={id}
          conflict={conflict}
          submitting={submitting}
          onChoose={(agentId) => void confirm({ replacementAgentId: agentId })}
          onAutoAssign={() => void confirm({ autoAssignAgent: true })}
          onCancel={() => setConflict(null)}
        />
      ) : (
        <>
          <div className="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
              <div>
                <h2 className="font-display text-base font-semibold text-foreground">
                  Liquidity Gate cleared
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Your verified liquidity covers at least 1.2× your stated target budget
                  {eligibility?.targetBudget
                    ? ` range of ${budgetBucketLabel(null, eligibility.targetBudget)}`
                    : ""}
                  , so you're eligible to hold a share on this home.
                </p>
              </div>
            </div>
          </div>

          {/* 3. Confirm */}
          <div className="mt-6 rounded-xl border border-accent/40 bg-accent/5 p-6">
            <p className="inline-flex items-start gap-2 text-sm text-foreground">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              Confirming reserves one 1/8th share and applies the Hard-Lock: the price per share
              and commission terms for this pod are frozen from the first reservation onward.
            </p>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void confirm()}
              className="mt-5 w-full rounded-md bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {submitting ? "Reserving…" : "Confirm and secure my priority rank"}
            </button>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Reserving a share is a commitment to proceed to closing. Withdrawals may forfeit your
              priority rank.
            </p>
          </div>
        </>
      )}

      {composition && composition.reservedShares + composition.retainedShares > 0 ? (
        <PodCompositionPanel composition={composition} className="mt-6" />
      ) : null}
    </div>
  );
}

/**
 * Dual-agency step: the buyer's agent holds this listing. Pick another agent
 * for THIS property (the Listing Agent is never offered), or let divieight
 * choose. Nothing is reserved until one of these succeeds.
 */
function AgentChangeStep({
  propertyId,
  conflict,
  submitting,
  onChoose,
  onAutoAssign,
  onCancel,
}: {
  propertyId: string;
  conflict: NonNullable<ReservationResult["conflict"]>;
  submitting: boolean;
  onChoose: (agentId: string) => void;
  onAutoAssign: () => void;
  onCancel: () => void;
}) {
  const runSearch = useServerFn(searchAgents);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; full_name: string; email: string; markets: unknown }>>([]);
  const [searching, setSearching] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim().length < 2) return;
    setSearching(true);
    try {
      setResults((await runSearch({ data: { query, excludeListingAgentOf: propertyId } })) as never);
    } finally {
      setSearching(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-accent/50 bg-accent/5 p-6" aria-labelledby="agent-change-heading">
      <h2 id="agent-change-heading" className="font-display text-base font-semibold text-foreground">
        Choose a different agent for this property
      </h2>
      <p className="mt-1 text-sm text-foreground">
        Your agent {conflict.conflicting_agent_name ?? ""} is also the listing agent for this property. For this property
        you need a different agent. Your other properties keep your usual agent.
      </p>
      {conflict.referring_agent_id_same ? (
        <p className="mt-2 text-sm text-muted-foreground">Your original agent keeps their referral share.</p>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">Nothing is reserved until you confirm an agent below.</p>

      <form onSubmit={search} className="mt-4 flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search agents by name or email"
          aria-label="Search agents by name or email"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={searching || query.trim().length < 2}
          className="rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground disabled:opacity-60"
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </form>
      {results.length > 0 ? (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {results.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{a.full_name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {a.email} · {formatMarkets(a.markets)}
                </span>
              </span>
              <button
                type="button"
                disabled={submitting}
                onClick={() => onChoose(a.id)}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
              >
                {submitting ? "Reserving…" : "Use this agent & reserve"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={submitting}
          onClick={onAutoAssign}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-60"
        >
          {submitting ? "Reserving…" : "Let divieight choose an agent for me"}
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={onCancel}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground disabled:opacity-60"
        >
          Not now
        </button>
      </div>
    </section>
  );
}

function Notice({
  tone,
  title,
  body,
  action,
}: {
  tone: "ok" | "warn";
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  const Icon = tone === "ok" ? CheckCircle2 : ShieldAlert;
  return (
    <div
      className={
        tone === "ok"
          ? "mt-6 rounded-xl border border-accent/40 bg-accent/5 p-6"
          : "mt-6 rounded-xl border border-destructive/40 bg-destructive/5 p-6"
      }
    >
      <div className="flex items-start gap-3">
        <Icon
          className={
            tone === "ok"
              ? "mt-0.5 h-5 w-5 shrink-0 text-accent"
              : "mt-0.5 h-5 w-5 shrink-0 text-destructive"
          }
        />
        <div>
          <h2 className="font-display text-base font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{body}</p>
          {action ? <div className="mt-4">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}
