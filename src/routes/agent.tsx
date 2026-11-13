import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BadgeCheck, LogOut } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { getAgentProfile, type AgentRow } from "@/lib/agent";
import {
  getAgentOnboardingStatus,
  agentGuardRedirect,
  type AgentOnboardingStatus,
} from "@/lib/agent-onboarding-status";
import { AgentOnboardingProvider } from "@/hooks/use-agent-onboarding";
import { formatMarkets } from "@/lib/markets";
import { NotificationsBell } from "@/components/NotificationsBell";
import { AgentSidebar } from "@/components/agent/AgentSidebar";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export const Route = createFileRoute("/agent")({
  head: () => ({
    meta: [
      { title: "Professional Portal — divieight" },
      {
        name: "description",
        content:
          "The divieight Professional Portal for licensed real estate agents and brokers.",
      },
      { property: "og:title", content: "Professional Portal — divieight" },
      {
        property: "og:description",
        content: "Licensed agent portal for divieight co-ownership transactions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AgentPortalLayout,
});

// Portal navigation now lives in the left sidebar (AgentSidebar).

const PUBLIC_PREFIXES = ["/agent/register", "/agent/login"];

function AgentPortalLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [checking, setChecking] = useState(true);
  const [status, setStatus] = useState<AgentOnboardingStatus | null>(null);

  const isPublic = PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));

  useEffect(() => {
    let cancelled = false;
    if (loading) return;
    if (!user) {
      setAgent(null);
      setStatus(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    // Re-check on navigation too: right after registration the profile row is
    // created a moment before we land on the first onboarding screen. The
    // onboarding status is re-read from the database on EVERY navigation, so
    // a typed URL, bookmark or back/forward cannot bypass the guard.
    getAgentProfile(user.id).then(async (row) => {
      if (cancelled) return;
      setAgent(row);
      const next = row ? await getAgentOnboardingStatus(row.id) : null;
      if (cancelled) return;
      setStatus(next);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [user, loading, pathname]);

  // Pin the agent to the first genuinely-incomplete onboarding step.
  useEffect(() => {
    if (isPublic || loading || checking || !agent || !status) return;
    const target = agentGuardRedirect(status, pathname);
    if (target && target !== pathname) navigate({ to: target, replace: true });
  }, [isPublic, loading, checking, agent, status, pathname, navigate]);



  useEffect(() => {
    if (isPublic || loading || checking) return;
    if (!user) {
      navigate({ to: "/agent/login", replace: true });
      return;
    }
    if (agent) return;
    // Give the just-created profile one more chance before bouncing out.
    let cancelled = false;
    const t = setTimeout(() => {
      getAgentProfile(user.id).then((row) => {
        if (cancelled) return;
        if (row) {
          setAgent(row);
          return;
        }
        toast.error("This area is for licensed agents on the divieight Professional Portal.");
        navigate({ to: "/agent/register", replace: true });
      });
    }, 900);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [isPublic, loading, checking, user, agent, navigate]);


  async function onSignOut() {
    await supabase.auth.signOut();
    toast.success("Signed out");
    navigate({ to: "/agent/login" });
  }

  if (isPublic) return <Outlet />;

  if (loading || checking) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">
        Checking professional access…
      </div>
    );
  }

  if (!user || !agent) return null;

  const pendingRedirect = status ? agentGuardRedirect(status, pathname) : null;
  // Don't paint a page the guard is about to leave — no fake-complete content.
  const blocked = !!pendingRedirect && pendingRedirect !== pathname;

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <AgentSidebar status={status} />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-40 border-b border-border bg-card">
            <div className="flex h-16 items-center justify-between gap-4 px-4 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <SidebarTrigger />
                <Link to="/agent/dashboard" className="flex items-center gap-2">
                  <BadgeCheck className="h-5 w-5 text-accent" />
                  <span className="truncate font-display text-sm font-semibold uppercase tracking-[0.18em] text-foreground">
                    Professional Portal
                  </span>
                </Link>
              </div>

              <div className="flex items-center gap-3">
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {agent.full_name}
                </span>
                <span className="hidden text-xs text-muted-foreground lg:inline">
                  {formatMarkets(agent.markets)}
                </span>
                <NotificationsBell />
                <button
                  type="button"
                  onClick={onSignOut}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
                >
                  <LogOut className="h-4 w-4 text-muted-foreground" />
                  Sign out
                </button>
              </div>
            </div>
          </header>

          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
            <AgentOnboardingProvider status={status}>
              {blocked ? (
                <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
                  Taking you to the next onboarding step…
                </div>
              ) : (
                <Outlet />
              )}
            </AgentOnboardingProvider>
          </main>

          <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">
            Agents are compensated solely through buyer-side commission paid at closing by their
            Broker of Record. divieight does not pay agents.{" "}
            <Link to="/terms" className="font-medium underline underline-offset-2">
              Terms and Conditions
            </Link>
          </footer>
        </div>
      </div>
    </SidebarProvider>
  );
}
