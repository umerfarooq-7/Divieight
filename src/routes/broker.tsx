import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AlertOctagon, Building2, LayoutDashboard, LifeBuoy, ListChecks, LogOut } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { getBrokerProfile, type BrokerRow } from "@/lib/broker";

export const Route = createFileRoute("/broker")({
  head: () => ({
    meta: [
      { title: "Broker of Record Portal — divieight" },
      {
        name: "description",
        content:
          "The divieight Broker of Record portal for brokerage credentialing, banking and tax details.",
      },
      { property: "og:title", content: "Broker of Record Portal — divieight" },
      {
        property: "og:description",
        content: "Broker of Record credentialing for divieight co-ownership transactions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BrokerPortalLayout,
});

const NAV = [
  { to: "/broker/dashboard", label: "Overview", icon: LayoutDashboard },
  { to: "/broker/onboarding/license-check", label: "Onboarding", icon: ListChecks },
  { to: "/broker/closing-holds", label: "Closing holds", icon: AlertOctagon },
  { to: "/support", label: "Support", icon: LifeBuoy },
] as const;

const PUBLIC_PREFIXES = ["/broker/register", "/broker/login"];

function BrokerPortalLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [broker, setBroker] = useState<BrokerRow | null>(null);
  const [checking, setChecking] = useState(true);

  const isPublic = PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));

  useEffect(() => {
    let cancelled = false;
    if (loading) return;
    if (!user) {
      setBroker(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    getBrokerProfile(user.id).then((row) => {
      if (cancelled) return;
      setBroker(row);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [user, loading]);

  useEffect(() => {
    if (isPublic || loading || checking) return;
    if (!user) {
      navigate({ to: "/broker/login", replace: true });
      return;
    }
    if (!broker) {
      toast.error("This area is for Brokers of Record on the divieight platform.");
      navigate({ to: "/broker/register", search: { invite: undefined }, replace: true });
    }
  }, [isPublic, loading, checking, user, broker, navigate]);

  async function onSignOut() {
    await supabase.auth.signOut();
    toast.success("Signed out");
    navigate({ to: "/broker/login" });
  }

  if (isPublic) return <Outlet />;

  if (loading || checking) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">
        Checking broker access…
      </div>
    );
  }

  if (!user || !broker) return null;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link to="/broker/dashboard" className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-accent" />
            <span className="font-display text-sm font-semibold uppercase tracking-[0.18em] text-foreground">
              Broker of Record
            </span>
          </Link>

          <nav className="hidden items-center gap-6 md:flex">
            {NAV.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                activeProps={{ className: "text-foreground" }}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            <span className="hidden max-w-[12rem] truncate text-xs text-muted-foreground sm:inline">
              {broker.brokerage_name}
            </span>
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

      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <Outlet />
      </main>

      <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">
        Brokers receive only real-estate commission paid at closing by the title/escrow company
        from sale proceeds. divieight never pays brokers directly.{" "}
        <Link to="/terms" className="font-medium underline underline-offset-2">
          Terms and Conditions
        </Link>
      </footer>
    </div>
  );
}
