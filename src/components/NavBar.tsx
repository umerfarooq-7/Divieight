import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { UserCircle2, LogOut, LayoutDashboard } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useAdmin } from "@/lib/admin";
import { getBuyerAccount } from "@/lib/buyer";
import { getAgentProfile } from "@/lib/agent";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { NotificationsBell } from "./NotificationsBell";

export function NavBar() {
  const { user, loading } = useAuth();
  const { isAdmin } = useAdmin();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [portal, setPortal] = useState<"buyer" | "seller" | "agent" | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setPortal(null);
      return;
    }

    const metadataRole = user.user_metadata?.account_type;
    if (pathname.startsWith("/agent") || metadataRole === "agent") {
      setPortal("agent");
      return;
    }
    if (metadataRole === "buyer") {
      setPortal("buyer");
      return;
    }

    Promise.all([getBuyerAccount(user.id), getAgentProfile(user.id)]).then(
      ([buyer, agent]) => {
        if (cancelled) return;
        setPortal(
          agent
            ? "agent"
            : buyer
              ? "buyer"
              : metadataRole === "seller"
                ? "seller"
                : null,
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pathname, user]);

  async function onSignOut() {
    await supabase.auth.signOut();
    toast.success("Signed out");
    navigate({ to: "/" });
  }

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link to="/" className="flex items-center">
          <img
            src="/divieight-logo.png"
            alt="divieight — independent co-ownership"
            className="h-8 w-auto"
          />
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          <Link
            to="/properties"
            className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            activeProps={{ className: "text-foreground" }}
          >
            Properties
          </Link>
          <Link
            to="/about"
            className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            activeProps={{ className: "text-foreground" }}
          >
            About
          </Link>
          <Link
            to="/contact"
            className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            activeProps={{ className: "text-foreground" }}
          >
            Contact
          </Link>
          <Link
            to="/support"
            className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            activeProps={{ className: "text-foreground" }}
          >
            Support
          </Link>
        </nav>


        <div className="flex items-center gap-3">
          {loading ? null : user ? (
            <>
              {!isAdmin && <NotificationsBell />}
              {isAdmin ? (
                <Link
                  to="/admin"
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground shadow-sm transition-transform hover:-translate-y-0.5"
                >
                  <LayoutDashboard className="h-4 w-4" />
                  Admin console
                </Link>
              ) : (
                portal !== null && (
                  <Link
                    to={
                      portal === "agent"
                        ? "/agent/dashboard"
                        : portal === "buyer"
                          ? "/buyer/dashboard"
                          : "/dashboard"
                    }
                    className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground shadow-sm transition-transform hover:-translate-y-0.5"
                  >
                    <LayoutDashboard className="h-4 w-4" />
                    {portal === "agent"
                      ? "Professional Portal"
                      : portal === "buyer"
                        ? "Buyer dashboard"
                        : "Seller dashboard"}
                  </Link>
                )
              )}
              <span className="hidden max-w-[180px] truncate text-xs text-muted-foreground sm:inline">
                {user.email}
              </span>
              <button
                type="button"
                onClick={onSignOut}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-foreground shadow-sm transition-colors hover:bg-secondary"
              >
                <LogOut className="h-4 w-4 text-muted-foreground" />
                <span className="hidden text-xs font-medium sm:inline">Sign out</span>
              </button>
            </>
          ) : (
            <>
              <Link
                to="/buyer/login"
                className="hidden text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
              >
                Buyer sign in
              </Link>
              <Link
                to="/login"
                className="hidden text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
              >
                Seller sign in
              </Link>
              <Link
                to="/agent/login"
                className="hidden text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
              >
                Agent sign in
              </Link>
              <Link
                to="/buyer/register"
                className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground shadow-sm transition-transform hover:-translate-y-0.5"
              >
                <UserCircle2 className="h-4 w-4" />
                Get started
              </Link>
            </>

          )}
        </div>
      </div>
    </header>
  );
}
