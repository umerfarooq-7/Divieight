import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Building2, Copy, Loader2, Mail, Search } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { getAgentProfile, type AgentRow } from "@/lib/agent";
import { CredentialStepper } from "@/components/credentialing/CredentialStepper";
import { AgentPendingBanner } from "@/components/AgentPendingBanner";
import { AgentCertLapsedBanner } from "@/components/AgentCertLapsedBanner";
import { Field } from "@/components/Field";
import { logAudit } from "@/lib/audit";
import {
  createBrokerInvitation,
  invitationLink,
  listAgentInvitations,
  searchBrokers,
  type BrokerInvitationRow,
  type BrokerRow,
} from "@/lib/broker";
import {
  getAgentLinkRequestState,
  requestBrokerLink,
  type AgentLinkRequestState,
} from "@/lib/broker-link-requests";
import { BrokerLinkRequestStatus } from "@/components/BrokerLinkRequestStatus";

export const Route = createFileRoute("/agent/onboarding/broker")({
  head: () => ({
    meta: [
      { title: "Broker of Record link — divieight Professional Portal" },
      {
        name: "description",
        content:
          "Step 4 of divieight agent credentialing: link your Broker of Record for buyer-side commission routing.",
      },
      { property: "og:title", content: "Broker of Record link — divieight" },
      {
        property: "og:description",
        content: "Connect your Broker of Record to complete divieight agent credentialing.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BrokerLinkPage,
});

function BrokerLinkPage() {
  const { user } = useAuth();
  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [linkState, setLinkState] = useState<AgentLinkRequestState | null>(null);
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<BrokerRow[]>([]);
  const [linking, setLinking] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<BrokerInvitationRow[]>([]);
  const [invite, setInvite] = useState({ brokerageName: "", contactName: "", email: "" });
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    getAgentProfile(user.id).then(async (row) => {
      if (cancelled) return;
      setAgent(row);
      if (row) {
        setInvitations(await listAgentInvitations(row.id));
        const state = await getAgentLinkRequestState(row.id);
        if (!cancelled) setLinkState(state);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const rows = await searchBrokers(term);
      if (!cancelled) setResults(rows.filter((b) => b.onboarding_status === "active"));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [term]);

  async function onLink(broker: BrokerRow) {
    if (!agent) return;
    setLinking(broker.id);
    const res = await requestBrokerLink({
      agent,
      brokerId: broker.id,
      brokerageName: broker.brokerage_name,
      reason: "initial_registration",
    });
    setLinking(null);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    setLinkState(await getAgentLinkRequestState(agent.id));
    toast.success(`Request sent to ${broker.brokerage_name} — awaiting their approval.`);
  }

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    if (!agent) return;
    if (!invite.brokerageName.trim() || !invite.email.trim()) {
      toast.error("Brokerage name and email are required.");
      return;
    }
    setInviting(true);
    // One email is one role: an address that already has an account can't accept an invitation, so say so now.
    try {
      const { checkInviteEmailFn, EXISTING_ACCOUNT_MESSAGE } = await import("@/lib/account-check.functions");
      const existing = await checkInviteEmailFn({ data: { email: invite.email } });
      if (existing.kind) {
        setInviting(false);
        toast.error(EXISTING_ACCOUNT_MESSAGE(existing.kind));
        return;
      }
    } catch {
      /* the invitation can still be created; sign-up reports a taken address */
    }
    const res = await createBrokerInvitation({
      agentId: agent.id,
      email: invite.email,
      brokerageName: invite.brokerageName,
      contactName: invite.contactName,
    });
    setInviting(false);
    if (res.error || !res.invitation) {
      toast.error(res.error ?? "Unable to create the invitation.");
      return;
    }
    await logAudit({
      actorId: agent.auth_user_id,
      actorType: "agent",
      actionType: "broker.invitation_sent",
      entityType: "broker",
      entityId: res.invitation.id,
      metadata: { invited_email: res.invitation.invited_email, agent_id: agent.id },
    });
    setInvitations(await listAgentInvitations(agent.id));
    setInvite({ brokerageName: "", contactName: "", email: "" });
    toast.success("Invitation created — share the onboarding link with your broker.");
  }

  return (
    <div className="space-y-8">
      <CredentialStepper entityType="agent" current={4} />

      {agent ? <AgentPendingBanner agent={agent} onUpdated={setAgent} /> : null}
      {agent ? <AgentCertLapsedBanner agent={agent} onUpdated={setAgent} /> : null}
      <BrokerLinkRequestStatus state={linkState} />

      <header className="space-y-2">
        <h1 className="font-display text-3xl font-semibold text-foreground">
          Broker of Record link
        </h1>
        <p className="text-sm text-muted-foreground">
          Connect your Broker of Record, through whom any buyer-side commission is paid at closing
          from sale proceeds. The platform does not pay agents or brokers directly.
        </p>
      </header>

      <section className="rounded-xl border border-border bg-card p-6">
        <div className="mb-4 flex items-center gap-3">
          <Building2 className="h-5 w-5 text-accent" />
          <h2 className="font-display text-lg font-semibold text-foreground">
            Select an existing broker
          </h2>
        </div>

        <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search brokerages…"
            className="w-full bg-transparent text-sm outline-none"
          />
        </label>

        <ul className="mt-4 space-y-2">
          {results.length === 0 ? (
            <li className="text-sm text-muted-foreground">
              No onboarded brokerages match that search yet.
            </li>
          ) : (
            results.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"
              >
                <span className="min-w-0">
                  <span className="block font-medium text-foreground [overflow-wrap:anywhere]">
                    {b.brokerage_name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    License {b.license_number} ({b.license_state})
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => onLink(b)}
                  disabled={linking === b.id || !!linkState?.pending}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {linking === b.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {linkState?.pending ? "Awaiting approval" : "Request link"}
                </button>
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="rounded-xl border border-border bg-card p-6">
        <div className="mb-4 flex items-center gap-3">
          <Mail className="h-5 w-5 text-accent" />
          <h2 className="font-display text-lg font-semibold text-foreground">
            Invite a new Broker of Record
          </h2>
        </div>

        <form onSubmit={onInvite} className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Brokerage name"
            name="brokerageName"
            value={invite.brokerageName}
            onChange={(e) => setInvite((v) => ({ ...v, brokerageName: e.target.value }))}
            required
          />
          <Field
            label="Contact name"
            name="contactName"
            value={invite.contactName}
            onChange={(e) => setInvite((v) => ({ ...v, contactName: e.target.value }))}
          />
          <Field
            label="Broker email"
            type="email"
            name="email"
            value={invite.email}
            onChange={(e) => setInvite((v) => ({ ...v, email: e.target.value }))}
            required
          />
          <div className="sm:col-span-3">
            <button
              type="submit"
              disabled={inviting}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
            >
              {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Send onboarding invitation
            </button>
          </div>
        </form>

        {invitations.length > 0 ? (
          <ul className="mt-6 space-y-2 text-sm">
            {invitations.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
              >
                <span className="min-w-0">
                  <span className="block font-medium text-foreground [overflow-wrap:anywhere]">
                    {inv.invited_brokerage_name ?? inv.invited_email}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {inv.invited_email} · {inv.status}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(invitationLink(inv.id));
                    toast.success("Invitation link copied");
                  }}
                  className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy link
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
