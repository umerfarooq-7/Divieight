import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BadgeCheck, Banknote, Building2, FileText, UserPlus, Users } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { getBrokerProfile, type BrokerRow } from "@/lib/broker";
import { CredentialStepper } from "@/components/credentialing/CredentialStepper";
import { AgentBrokerLapsedBanner } from "@/components/AgentBrokerLapsedBanner";
import { TaxFormGateBanner } from "@/components/TaxFormGateBanner";
import { formatMarkets } from "@/lib/markets";
import {
  acceptLinkRequest,
  listPendingRequestsForBroker,
  rejectLinkRequest,
  type PendingRequestWithAgent,
} from "@/lib/broker-link-requests";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getBrokerTaxFormStatus } from "@/lib/tax-forms.functions";

export const Route = createFileRoute("/broker/dashboard")({
  head: () => ({
    meta: [
      { title: "Broker dashboard — divieight" },
      {
        name: "description",
        content: "Broker of Record overview: credentials, supervised agents, banking and tax.",
      },
      { property: "og:title", content: "Broker dashboard — divieight" },
      {
        property: "og:description",
        content: "Manage your brokerage credentials and supervised agents on divieight.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BrokerDashboard,
});

interface LinkedAgent {
  id: string;
  full_name: string;
  role: string;
  onboarding_status: string;
  relationship_status: string | null;
}

function BrokerDashboard() {
  const { user } = useAuth();
  const [broker, setBroker] = useState<BrokerRow | null>(null);
  const [agents, setAgents] = useState<LinkedAgent[]>([]);
  const [requests, setRequests] = useState<PendingRequestWithAgent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // The real status, from the stored forms (the same check the settlement gate uses), not the cached column on the broker row.
  const loadTax = useServerFn(getBrokerTaxFormStatus);
  const taxQ = useQuery({ queryKey: ["broker-tax-form"], queryFn: () => loadTax(), retry: false });
  const taxKnown = !!taxQ.data;
  const taxOk = taxQ.data ? taxQ.data.allowed : !!broker?.tax_form_verified;

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    getBrokerProfile(user.id).then(async (row) => {
      if (cancelled || !row) return;
      setBroker(row);
      const db = supabase as unknown as { from: (t: string) => any };
      const { data } = await db
        .from("agents")
        .select("id, full_name, role, onboarding_status, relationship_status")
        .eq("broker_id", row.id);
      if (cancelled) return;
      setAgents((data as LinkedAgent[]) ?? []);
      setRequests(await listPendingRequestsForBroker(row.id));
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const isActive = broker?.onboarding_status === "active";

  async function refresh(brokerId: string) {
    const db = supabase as unknown as { from: (t: string) => any };
    const { data } = await db
      .from("agents")
      .select("id, full_name, role, onboarding_status, relationship_status")
      .eq("broker_id", brokerId);
    setAgents((data as LinkedAgent[]) ?? []);
    setRequests(await listPendingRequestsForBroker(brokerId));
  }

  async function onDecide(req: PendingRequestWithAgent, accept: boolean) {
    if (!broker) return;
    setBusy(req.id);
    const target = {
      id: broker.id,
      auth_user_id: broker.auth_user_id,
      brokerage_name: broker.brokerage_name,
    };
    const res = accept
      ? await acceptLinkRequest(req, target)
      : await rejectLinkRequest(req, target);
    setBusy(null);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success(
      accept
        ? `${req.agent?.full_name ?? "Agent"} is now one of your sponsored agents.`
        : "Request declined.",
    );
    await refresh(broker.id);
  }

  const lapsedAgents = agents.filter(
    (a) => a.relationship_status && a.relationship_status !== "active",
  );

  return (
    <div className="space-y-8">
      {broker && !taxOk ? <TaxFormGateBanner /> : null}

      {broker && (!taxOk || !broker.license_verified || !broker.bank_account_last4) ? (
        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">Needs your attention</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {!taxOk ? (
              <li>
                Tax form {taxKnown && taxQ.data?.state === "expired" ? "expired" : taxKnown && taxQ.data?.state === "rejected" ? "rejected" : "missing"}: payouts are blocked.{" "}
                <Link to="/broker/tax-form" className="font-medium text-primary underline">Complete tax form</Link>
              </li>
            ) : null}
            {!broker.bank_account_last4 ? (
              <li>
                No payout account.{" "}
                <Link to="/broker/onboarding/banking" className="font-medium text-primary underline">Add payout account</Link>
              </li>
            ) : null}
            {!broker.license_verified ? (
              <li>
                License not verified.{" "}
                <Link to="/broker/onboarding/license-check" className="font-medium text-primary underline">Complete license check</Link>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {lapsedAgents.map((a) => (
        <AgentBrokerLapsedBanner
          key={a.id}
          status={a.relationship_status}
          agentName={a.full_name}
          actionable={false}
        />
      ))}

      <header className="space-y-2">
        <h1 className="font-display text-3xl font-semibold text-foreground">
          {broker?.brokerage_name ?? "Broker of Record"}
        </h1>
        <p className="text-sm text-muted-foreground">
          Commission for supervised agents is paid to this brokerage at closing by the title/escrow
          company from sale proceeds.
        </p>
      </header>

      {!isActive ? <CredentialStepper entityType="broker" current={4} /> : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          icon={BadgeCheck}
          label="License"
          value={broker?.license_verified ? "Verified" : "Pending"}
          action={broker?.license_verified ? undefined : { to: "/broker/onboarding/license-check", label: "Complete license check" }}
        />
        <Card
          icon={Building2}
          label="Status"
          value={broker?.onboarding_status ?? "—"}
        />
        <Card
          icon={Banknote}
          label="Payout account"
          value={
            broker?.bank_account_last4 ? `•••• ${broker.bank_account_last4}` : "Not provided"
          }
          action={broker?.bank_account_last4 ? undefined : { to: "/broker/onboarding/banking", label: "Add payout account" }}
        />
        <Card
          icon={FileText}
          label="Tax form"
          value={
            taxOk
              ? (taxQ.data?.formType ?? broker?.w9_or_w8_type ?? "On file")
              : "Payout blocked"
          }
          action={taxOk ? undefined : { to: "/broker/tax-form", label: "Complete tax form" }}
        />
      </div>

      <section className="rounded-xl border border-border bg-card p-6">
        <div className="mb-4 flex items-center gap-3">
          <UserPlus className="h-5 w-5 text-accent" />
          <h2 className="font-display text-lg font-semibold text-foreground">Pending requests</h2>
        </div>
        {requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agents are waiting on your approval right now.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {requests.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
              >
                <span className="min-w-0">
                  <span className="block font-medium text-foreground [overflow-wrap:anywhere]">
                    {r.agent?.full_name ?? "Agent"}
                  </span>
                  <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    License {r.agent?.license_number ?? "—"} ({r.agent?.license_state ?? "—"})
                    {r.agent?.email ? ` · ${r.agent.email}` : ""}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {r.reason === "broker_change"
                      ? "Moving from another brokerage"
                      : "New agent registration"}{" "}
                    · requested {new Date(r.requested_at).toLocaleDateString()}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onDecide(r, true)}
                    disabled={busy !== null}
                    className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-60"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => onDecide(r, false)}
                    disabled={busy !== null}
                    className="inline-flex h-9 items-center rounded-md border border-border px-4 text-xs font-semibold text-foreground disabled:opacity-60"
                  >
                    Reject
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-6">
        <div className="mb-4 flex items-center gap-3">
          <Users className="h-5 w-5 text-accent" />
          <h2 className="font-display text-lg font-semibold text-foreground">Supervised agents</h2>
        </div>
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agents are linked to this brokerage yet.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {agents.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
              >
                <span className="font-medium text-foreground [overflow-wrap:anywhere]">
                  {a.full_name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatMarkets((a as { markets?: unknown }).markets)} · {a.onboarding_status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Card({
  icon: Icon,
  label,
  value,
  action,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  action?: { to: "/broker/tax-form" | "/broker/onboarding/banking" | "/broker/onboarding/license-check"; label: string };
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <Icon className="h-5 w-5 text-accent" />
      <p className="mt-3 text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold text-foreground [overflow-wrap:anywhere]">{value}</p>
      {action ? (
        <Link to={action.to} className="mt-3 inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90">
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
