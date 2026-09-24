import { createFileRoute } from "@tanstack/react-router";
import { TitleStatusTracker } from "@/components/TitleStatusTracker";
import { listAgentTitleStatuses } from "@/lib/title-escrow.functions";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { getAgentProfile, agentRedirect, type AgentRow } from "@/lib/agent";
import { formatMarkets } from "@/lib/markets";
import { AgentPendingBanner } from "@/components/AgentPendingBanner";
import { AgentCertLapsedBanner } from "@/components/AgentCertLapsedBanner";
import { AgentEoLapsedBanner } from "@/components/AgentEoLapsedBanner";
import { AgentBrokerLapsedBanner } from "@/components/AgentBrokerLapsedBanner";
import { AgentActionItems } from "@/components/AgentActionItems";
import { VerifiedLeadTable } from "@/components/agent/VerifiedLeadTable";
import { getBrokerById, type BrokerRow } from "@/lib/broker";
import {
  getAgentLinkRequestState,
  type AgentLinkRequestState,
} from "@/lib/broker-link-requests";
import { BrokerLinkRequestStatus } from "@/components/BrokerLinkRequestStatus";
import {
  getAgentOnboardingStatus,
  type AgentOnboardingStatus,
} from "@/lib/agent-onboarding-status";
import { daysUntilExpiry } from "@/lib/agent-compliance";
import { daysUntilEoExpiry } from "@/lib/eo-expiry";
import { listMyTetheredBuyers, type TetheredBuyer } from "@/lib/agent-leads.functions";
import { listAttributionTokens, getTaggedBuyerCounts } from "@/lib/attribution";
import {
  BadgeCheck,
  Building2,
  CalendarClock,
  Coins,
  PauseCircle,
  Share2,
  ShieldCheck,
  Users,
} from "lucide-react";

export const Route = createFileRoute("/agent/dashboard")({
  head: () => ({
    meta: [
      { title: "Agent overview — divieight Professional Portal" },
      {
        name: "description",
        content: "Your licensed-agent overview inside the divieight Professional Portal.",
      },
      { property: "og:title", content: "Agent overview — divieight" },
      {
        property: "og:description",
        content: "Track credentialing, tethered buyers, and referral performance at divieight.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AgentDashboard,
});

function StatusChip({
  ok,
  okLabel,
  warnLabel,
  icon: Icon,
}: {
  ok: boolean;
  okLabel: string;
  warnLabel: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
        ok
          ? "border-accent/50 bg-accent/10 text-accent"
          : "border-destructive/40 bg-destructive/10 text-destructive"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {ok ? okLabel : warnLabel}
    </span>
  );
}

function AgentDashboard() {
  const { user } = useAuth();
  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [broker, setBroker] = useState<BrokerRow | null>(null);
  const [linkState, setLinkState] = useState<AgentLinkRequestState | null>(null);
  const [buyers, setBuyers] = useState<TetheredBuyer[]>([]);
  const [buyersLoading, setBuyersLoading] = useState(true);
  const [attribution, setAttribution] = useState({ tokens: 0, clicks: 0, tagged: 0 });
  const [onboardingState, setOnboardingState] = useState<AgentOnboardingStatus | null>(null);

  const loadBuyers = useServerFn(listMyTetheredBuyers);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    getAgentProfile(user.id).then(async (row) => {
      if (cancelled) return;
      setAgent(row);
      if (row) {
        const [state, onboarding] = await Promise.all([
          getAgentLinkRequestState(row.id),
          getAgentOnboardingStatus(row.id),
        ]);
        if (!cancelled) {
          setLinkState(state);
          setOnboardingState(onboarding);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!agent?.broker_id) {
      setBroker(null);
      return;
    }
    let cancelled = false;
    getBrokerById(agent.broker_id).then((row) => {
      if (!cancelled) setBroker(row);
    });
    return () => {
      cancelled = true;
    };
  }, [agent?.broker_id]);

  useEffect(() => {
    let cancelled = false;
    loadBuyers({})
      .then((rows) => {
        if (!cancelled) setBuyers(rows);
      })
      .finally(() => {
        if (!cancelled) setBuyersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadBuyers]);

  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    Promise.all([listAttributionTokens(agent.id), getTaggedBuyerCounts(agent.id)]).then(
      ([tokens, tagged]) => {
        if (cancelled) return;
        setAttribution({
          tokens: tokens.length,
          clicks: tokens.reduce((sum, t) => sum + (t.click_count ?? 0), 0),
          tagged: tagged.total,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agent]);

  if (!agent) return <p className="text-sm text-muted-foreground">Loading your profile…</p>;

  const onboardingComplete = onboardingState?.complete ?? true;
  const certDays = daysUntilExpiry(agent.nar_cert_expires_at);
  const eoDays = daysUntilEoExpiry(agent.eo_expires_at);
  const relationshipActive = (agent.relationship_status ?? "active") === "active";
  const qualifiedLeads = buyers.filter(
    (b) => b.goldenTicketIssued && b.pefStatus === "paid",
  ).length;

  return (
    <div className="space-y-8">
      <AgentPendingBanner agent={agent} onUpdated={setAgent} />
      <AgentCertLapsedBanner agent={agent} onUpdated={setAgent} />
      <AgentEoLapsedBanner agent={agent} onUpdated={setAgent} />
      <AgentBrokerLapsedBanner status={agent.relationship_status} />

      {!onboardingComplete ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-accent/40 bg-accent/5 p-4 text-sm">
          <p className="min-w-0 flex-1 text-foreground">
            Credentialing is incomplete — your profile is at status{" "}
            <span className="font-medium">{agent.onboarding_status}</span>. Finish every step
            before you can be tethered to a buyer pod.
          </p>
          <Link
            to={agentRedirect(agent.onboarding_status)}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-xs font-semibold text-primary-foreground"
          >
            Continue onboarding
          </Link>
        </div>
      ) : null}

      <AgentActionItems />

      <header className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-accent">
          Licensed agent
        </p>
        <h1 className="font-display text-3xl font-semibold text-foreground">
          Welcome, {agent.full_name}
        </h1>
        <p className="text-sm text-muted-foreground">
          Markets: {formatMarkets(agent.markets)} · License {agent.license_number} (
          {agent.license_state})
        </p>
        <p className="text-xs text-muted-foreground">
          Resident or Non-Resident standing is worked out per transaction from your markets — it
          isn't a fixed label on your profile.
        </p>
        <div className="flex flex-wrap gap-2">
          <StatusChip
            ok={Boolean(agent.license_verified)}
            okLabel="License verified"
            warnLabel="License verification pending"
            icon={BadgeCheck}
          />
          <StatusChip
            ok={Boolean(agent.broker_id) && relationshipActive}
            okLabel={`Broker linked${broker?.brokerage_name ? ` — ${broker.brokerage_name}` : ""}`}
            warnLabel={
              agent.broker_id ? "Broker relationship needs re-verification" : "No Broker of Record"
            }
            icon={Building2}
          />
          <StatusChip
            ok={!agent.nar_cert_lapsed && (certDays === null || certDays > 0)}
            okLabel={
              certDays === null
                ? "NAR certification on file"
                : `NAR cert renews in ${certDays} day${certDays === 1 ? "" : "s"}`
            }
            warnLabel="NAR certification expired"
            icon={CalendarClock}
          />
          <StatusChip
            ok={!agent.eo_lapsed && (eoDays === null || eoDays > 0)}
            okLabel={
              eoDays === null
                ? "E&O coverage on file"
                : `E&O renews in ${eoDays} day${eoDays === 1 ? "" : "s"}`
            }
            warnLabel="E&O coverage expired"
            icon={ShieldCheck}
          />
        </div>
      </header>

      <AgentTitleStatuses />

      <section className="rounded-xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Users className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold text-foreground">My buyers</h2>
          </div>
          <Link
            to="/agent/leads"
            className="inline-flex h-9 items-center rounded-md border border-border px-4 text-xs font-semibold text-foreground"
          >
            Verified lead dashboard
          </Link>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {qualifiedLeads} of {buyers.length} tethered buyer{buyers.length === 1 ? "" : "s"} are
          fully qualified. Vetting report contents remain private to the buyer and the Platform.
        </p>
        <div className="mt-4">
          <VerifiedLeadTable buyers={buyers.slice(0, 3)} loading={buyersLoading} />
        </div>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-3">
            <Coins className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold text-foreground">My commission pipeline</h2>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {qualifiedLeads} qualified buyer{qualifiedLeads === 1 ? "" : "s"} in your pipeline.
            Compensation is the buyer-side commission paid at closing by the title/escrow company
            through your Broker of Record — divieight never pays agents directly.
          </p>
          <Link to="/agent/commissions" className="mt-3 inline-block text-xs font-medium text-primary hover:underline">
            Open your Commission Dashboard — per-share splits, referral shares and Heavy Lifter Premium →
          </Link>
        </section>

        <section className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-3">
            <Share2 className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold text-foreground">My attribution tokens</h2>
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
            {[
              { label: "Tokens", value: attribution.tokens },
              { label: "Clicks", value: attribution.clicks },
              { label: "Tagged buyers", value: attribution.tagged },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-border p-3">
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {s.label}
                </dt>
                <dd className="text-xl font-semibold text-foreground">{s.value}</dd>
              </div>
            ))}
          </dl>
          <Link
            to="/agent/attribution"
            className="mt-4 inline-flex h-9 items-center rounded-md border border-border px-4 text-xs font-semibold text-foreground"
          >
            Manage attribution
          </Link>
        </section>
      </div>

      <section className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-3">
          <Building2 className="h-5 w-5 text-accent" />
          <h2 className="text-lg font-semibold text-foreground">Broker of Record</h2>
        </div>
        <BrokerLinkRequestStatus state={linkState} className="mt-4" />
        {agent.broker_id ? (
          <>
            <p className="mt-2 text-sm font-medium text-foreground [overflow-wrap:anywhere]">
              {broker?.brokerage_name ?? "Linked brokerage"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Standing: {agent.relationship_status ?? "active"}
              {agent.relationship_verified_at
                ? ` · verified ${new Date(agent.relationship_verified_at).toLocaleDateString()}`
                : ""}
            </p>
            <Link
              to="/agent/broker-relationship"
              className="mt-4 inline-flex h-9 items-center rounded-md border border-border px-4 text-xs font-semibold text-foreground"
            >
              Manage relationship
            </Link>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              {linkState?.pending
                ? "No Broker of Record is linked yet — your request is with the brokerage."
                : "No Broker of Record is linked to your profile yet."}
            </p>
            <Link
              to="/agent/onboarding/broker"
              className="mt-4 inline-flex h-9 items-center rounded-md border border-border px-4 text-xs font-semibold text-foreground"
            >
              Link a broker
            </Link>
          </>
        )}
      </section>

      <section className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-foreground">
            <ShieldCheck className="h-4 w-4 text-accent" /> In-flight transactions
          </span>
          {agent.nar_cert_lapsed ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-destructive/50 bg-destructive/10 px-3 py-1 text-xs font-semibold text-destructive">
              <PauseCircle className="h-3.5 w-3.5" /> Hold — certification lapsed
            </span>
          ) : null}
          {agent.transactions_held ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-destructive/50 bg-destructive/10 px-3 py-1 text-xs font-semibold text-destructive">
              <PauseCircle className="h-3.5 w-3.5" /> Hold — broker relationship
            </span>
          ) : null}
        </div>
        <p className="mt-2">
          Pod assignments, tethered buyers, and closing coordination tools arrive in the next
          release.
        </p>
      </section>
    </div>
  );
}

/** Live title/escrow milestones for properties my tethered buyers are closing on. */
function AgentTitleStatuses() {
  const load = useServerFn(listAgentTitleStatuses);
  const { data } = useQuery({ queryKey: ["agent-title-statuses"], queryFn: () => load(), refetchInterval: 60_000 });
  const rows = data?.rows ?? [];
  if (rows.length === 0) return null;
  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-lg font-semibold text-foreground">Title &amp; escrow</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Milestones arrive directly from the title company — no status calls needed.
      </p>
      <div className="mt-4 space-y-3">
        {rows.map((r) => (
          <TitleStatusTracker key={r.status.propertyId} status={r.status} title={r.label} />
        ))}
      </div>
    </section>
  );
}
