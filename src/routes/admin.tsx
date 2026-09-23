import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  ShieldCheck,
  LayoutDashboard,
  Users,
  Home,
  Mail,
  CreditCard,
  Users2,
  Boxes,
  Briefcase,
  ScrollText,
  LogOut,
  AlertTriangle,
  LifeBuoy,
  Building2,
  FileSignature,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAdmin } from "@/lib/admin";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Admin console — divieight" },
      { name: "description", content: "Internal operations console for the divieight platform." },
      { property: "og:title", content: "Admin console — divieight" },
      { property: "og:description", content: "Internal operations console for the divieight platform." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminLayout,
});

const NAV = [
  { to: "/admin", label: "Overview", icon: LayoutDashboard },
  { to: "/admin/sellers", label: "Sellers", icon: Users },
  { to: "/admin/buyers", label: "Buyers", icon: ShieldCheck },
  { to: "/admin/properties", label: "Properties", icon: Home },
  { to: "/admin/agents", label: "Agents", icon: Users2 },
  { to: "/admin/brokers", label: "Brokers", icon: Briefcase },
  { to: "/admin/payments", label: "Payments", icon: CreditCard },
  { to: "/admin/contacts", label: "Contact inbox", icon: Mail },
  { to: "/admin/support", label: "Support tickets", icon: LifeBuoy },
  { to: "/admin/authorizations", label: "Authorizations", icon: FileSignature },
  { to: "/admin/earnest-money", label: "Earnest money", icon: CreditCard },
  { to: "/admin/closing-funds", label: "Closing funds", icon: CreditCard },
  { to: "/admin/insurance-requirements", label: "Insurance rules", icon: FileSignature },
  { to: "/admin/title-escrow", label: "Title & escrow", icon: FileSignature },
  { to: "/admin/settlement", label: "Settlement (CDA)", icon: FileSignature },
  { to: "/admin/pods", label: "Pods & HLA", icon: Boxes },
  { to: "/admin/entity-genesis", label: "Entity Genesis", icon: Building2 },
  { to: "/admin/substitutions", label: "Substitutions", icon: Users2 },
  { to: "/admin/tether-resolution", label: "Tether alerts", icon: AlertTriangle },
  { to: "/admin/listing-compliance", label: "Listing compliance", icon: ShieldCheck },
  { to: "/admin/audit-log", label: "Audit log", icon: ScrollText },
] as const;

function AdminLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const { user, loading, isAdmin } = useAdmin();
  const isLoginRoute = pathname.startsWith("/admin/login");

  useEffect(() => {
    if (isLoginRoute || loading) return;
    if (!user || !isAdmin) navigate({ to: "/admin/login", replace: true });
  }, [isLoginRoute, loading, user, isAdmin, navigate]);

  if (isLoginRoute) return <Outlet />;

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">
        Checking admin access…
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">
        Redirecting to admin sign in…
      </div>
    );
  }

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/admin/login", replace: true });
  }

  return (
    <div className="mx-auto flex max-w-[95rem] flex-col gap-6 px-4 py-8 sm:px-6 lg:flex-row lg:px-8">
      <aside className="lg:w-60 lg:shrink-0">
        <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
          <div className="px-2 pb-3 pt-1">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Admin</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">{user?.email}</p>
          </div>
          <nav className="flex flex-wrap gap-1 lg:flex-col">
            {NAV.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                activeOptions={{ exact: to === "/admin" }}
                activeProps={{ className: "bg-secondary text-foreground" }}
                className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            ))}
          </nav>
          <button
            type="button"
            onClick={signOut}
            className="mt-3 inline-flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
