import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { UserPlus, Clock, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { formatMarkets } from "@/lib/markets";
import { AgentChoice, PLATFORM_CHOICE_EXPLANATION } from "@/components/AgentChoice";
import { cancelAgentAssignment, requestAgentAssignment } from "@/lib/agent-assignment.functions";
import {
  acceptPlatformAssignment,
  clearDesignation,
  designateAgent,
  getDesignationState,
  resendDesignationInvite,
  searchAgents,
  type AgentSearchResult,
  type DesignationState,
} from "@/lib/designation.functions";

/**
 * "Have a specific agent in mind? Name them here."
 *
 * Representation is compensated only through the buyer-side commission paid at
 * closing by title/escrow from sale proceeds — divieight pays agents nothing.
 */
export function DesignateAgentCard({ buyerAccountId }: { buyerAccountId: string }) {
  const loadState = useServerFn(getDesignationState);
  const runSearch = useServerFn(searchAgents);
  const designate = useServerFn(designateAgent);
  const resend = useServerFn(resendDesignationInvite);
  const clear = useServerFn(clearDesignation);
  const acceptPlatform = useServerFn(acceptPlatformAssignment);
  const requestAssignment = useServerFn(requestAgentAssignment);
  const cancelAssignment = useServerFn(cancelAgentAssignment);

  const [state, setState] = useState<DesignationState | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AgentSearchResult[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"self" | "platform">("self");

  const refresh = useCallback(async () => {
    const s = await loadState({ data: { buyerAccountId } });
    setState(s);
  }, [buyerAccountId, loadState]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!state) return null;

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  async function handleSearch() {
    if (query.trim().length < 2) return;
    setResults(await runSearch({ data: { query: query.trim() } }));
  }

  async function nameAgent(agentId: string | null) {
    setBusy(true);
    const res = await designate({
      data: {
        buyerAccountId,
        agentId,
        email: agentId ? null : inviteEmail.trim(),
        name: agentId ? null : inviteName.trim() || null,
        origin,
      },
    });
    setBusy(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success(
      res.invited
        ? "Invitation sent. They have 3 calendar days to accept."
        : "Agent designated. They have 3 calendar days to accept.",
    );
    setOpen(false);
    setResults([]);
    setQuery("");
    setInviteEmail("");
    setInviteName("");
    void refresh();
  }

  if (state.tetherStatus === "tethered") {
    return (
      <section className="mt-6 rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-accent" />
          <h2 className="font-display text-lg font-semibold text-foreground">Your agent</h2>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          You're tethered to {state.tetheredAgentName ?? "your Resident Agent"}.
        </p>
      </section>
    );
  }

  // The buyer asked divieight to choose: waiting on admin, then on the agent.
  if (state.platformAssignment) {
    const assigned = state.platformAssignment.status === "assigned";
    return (
      <section className="mt-6 rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-accent" />
          <h2 className="font-display text-lg font-semibold text-foreground">
            {assigned ? "Your agent has been assigned" : "Waiting for divieight to assign your agent"}
          </h2>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {assigned
            ? `divieight assigned ${state.platformAssignment.agentName ?? "an agent"} as your agent. We'll confirm as soon as they accept.`
            : "We will match you with a verified Resident Agent in your market. You will be notified and can see who was assigned."}
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await cancelAssignment({ data: { requestId: state.platformAssignment!.requestId } });
            setBusy(false);
            if (r.error) toast.error(r.error);
            setMode("self");
            void refresh();
          }}
          className="mt-3 inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted"
        >
          Choose my own agent instead
        </button>
      </section>
    );
  }

  const pendingDesignation =
    state.tetherStatus === "awaiting_designation" &&
    (state.designatedAgentId || state.designatedAgentEmail);

  return (
    <section className="mt-6 rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2">
        <UserPlus className="h-5 w-5 text-accent" />
        <h2 className="font-display text-lg font-semibold text-foreground">
          Choose your agent
        </h2>
      </div>

      {pendingDesignation ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-muted-foreground">
            Waiting on{" "}
            <span className="font-medium text-foreground">
              {state.designatedAgentName ?? state.designatedAgentEmail}
            </span>
            .{" "}
            {state.designationDeadlineAt && !state.designationExpired ? (
              <>
                <Clock className="mr-1 inline h-3.5 w-3.5" />
                They have until {new Date(state.designationDeadlineAt).toLocaleDateString()} to
                accept.
              </>
            ) : null}
          </p>

          {state.designationExpired ? (
            <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground">
              Your designated agent has not responded within 3 days. Choose how to continue:
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const r = await resend({ data: { buyerAccountId, origin } });
                setBusy(false);
                if (r.error) toast.error(r.error);
                else toast.success("Invitation resent.");
                void refresh();
              }}
              className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted"
            >
              Resend Invitation
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await clear({ data: { buyerAccountId } });
                setBusy(false);
                setOpen(true);
                void refresh();
              }}
              className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted"
            >
              Name a Different Agent
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await acceptPlatform({ data: { buyerAccountId } });
                setBusy(false);
                toast.success("Platform assignment accepted.");
                void refresh();
              }}
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Accept Platform Assignment
            </button>
          </div>
        </div>
      ) : (
        <>
          <AgentChoice mode={mode} onChange={setMode} />
          {mode === "platform" ? (
            <div className="mt-4 rounded-lg border border-border bg-muted/30 p-4">
              <p className="text-sm text-foreground">{PLATFORM_CHOICE_EXPLANATION}</p>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const r = await requestAssignment();
                  setBusy(false);
                  if (r.error) toast.error(r.error);
                  else toast.success("Request sent. We'll notify you when your agent is assigned.");
                  void refresh();
                }}
                className="mt-3 inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                Ask divieight to choose
              </button>
            </div>
          ) : (
          <>
          <p className="mt-3 text-sm text-muted-foreground">
            Search for a licensed agent already on divieight, or invite your own agent by email.
          </p>
          {!open ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="mt-4 inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Name my agent
            </button>
          ) : (
            <div className="mt-4 space-y-5">
              <div>
                <label className="text-sm font-medium text-foreground">Search agents</label>
                <div className="mt-1 flex gap-2">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Name or email"
                    className="h-10 flex-1 rounded-md border border-border bg-background px-3 text-sm"
                  />
                  <button
                    type="button"
                    onClick={handleSearch}
                    className="h-10 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
                  >
                    Search
                  </button>
                </div>
                <ul className="mt-2 space-y-2">
                  {results.map((a) => (
                    <li
                      key={a.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{a.full_name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {a.email} · {formatMarkets(a.markets)}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => nameAgent(a.id)}
                        className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
                      >
                        Designate
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="border-t border-border pt-4">
                <label className="text-sm font-medium text-foreground">
                  Not on divieight yet? Invite them
                </label>
                <div className="mt-1 grid gap-2 sm:grid-cols-2">
                  <input
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    placeholder="Agent name (optional)"
                    className="h-10 rounded-md border border-border bg-background px-3 text-sm"
                  />
                  <input
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="agent@brokerage.com"
                    className="h-10 rounded-md border border-border bg-background px-3 text-sm"
                  />
                </div>
                <button
                  type="button"
                  disabled={busy || !inviteEmail.trim()}
                  onClick={() => nameAgent(null)}
                  className="mt-3 inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  Send invitation
                </button>
              </div>
            </div>
          )}
          </>
          )}
        </>
      )}
    </section>
  );
}
