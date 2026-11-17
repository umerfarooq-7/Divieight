import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Banknote,
  Bell,
  BookOpen,
  CalendarDays,
  FileText,
  FolderOpen,
  HandCoins,
  Home,
  LayoutDashboard,
  Lock,
  LogOut,
  Receipt,
  Scale,
  Store,
  Users,
  Vote,
  Wallet,
  Wrench,
  Building2,
  Megaphone,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { getOwnerProperty } from "@/lib/owner.functions";
import { getOwnerStr } from "@/lib/str.functions";

const base =
  "flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground";
const active = { className: "bg-secondary font-medium text-foreground" };

type PropLink = {
  to:
    | "/owner/properties/$propertyId"
    | "/owner/properties/$propertyId/votes"
    | "/owner/properties/$propertyId/calendar"
    | "/owner/properties/$propertyId/resale"
    | "/owner/properties/$propertyId/maintenance"
    | "/owner/properties/$propertyId/expenses"
    | "/owner/properties/$propertyId/ledger"
    | "/owner/properties/$propertyId/capital"
    | "/owner/properties/$propertyId/distributions"
    | "/owner/properties/$propertyId/statements"
    | "/owner/properties/$propertyId/capital-calls"
    | "/owner/properties/$propertyId/retention";
  label: string;
  icon: LucideIcon;
  exact?: boolean;
};

const OVERVIEW: PropLink[] = [
  { to: "/owner/properties/$propertyId", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { to: "/owner/properties/$propertyId/calendar", label: "Use calendar", icon: CalendarDays },
  { to: "/owner/properties/$propertyId/votes", label: "Voting", icon: Vote },
];
const MONEY: PropLink[] = [
  { to: "/owner/properties/$propertyId/capital", label: "Capital account", icon: Wallet },
  { to: "/owner/properties/$propertyId/capital-calls", label: "Capital calls", icon: HandCoins },
  { to: "/owner/properties/$propertyId/distributions", label: "Distributions", icon: Banknote },
  { to: "/owner/properties/$propertyId/expenses", label: "Expenses", icon: Receipt },
  { to: "/owner/properties/$propertyId/ledger", label: "Ledger", icon: BookOpen },
  { to: "/owner/properties/$propertyId/statements", label: "Statements", icon: FileText },
];
const HOME: PropLink[] = [
  { to: "/owner/properties/$propertyId/maintenance", label: "Maintenance", icon: Wrench },
  { to: "/owner/properties/$propertyId/resale", label: "Resale Shop", icon: Store },
  { to: "/owner/properties/$propertyId/retention", label: "Retention lock", icon: Lock },
];

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1 lg:flex-col">
      <p className="hidden px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80 lg:block">
        {title}
      </p>
      {children}
    </div>
  );
}

function PropLinks({ links, propertyId }: { links: PropLink[]; propertyId: string }) {
  return (
    <>
      {links.map(({ to, label, icon: Icon, exact }) => (
        <Link key={to} to={to} params={{ propertyId }} activeOptions={{ exact: !!exact }} activeProps={active} className={base}>
          <Icon className="h-4 w-4 shrink-0" aria-hidden />
          {label}
        </Link>
      ))}
    </>
  );
}

/** Left navigation for the owner area, in the same style as the admin console. */
export function OwnerSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const { user } = useAuth();
  const propertyId = /^\/owner\/properties\/([^/]+)/.exec(pathname)?.[1] ?? null;

  // Same query keys as the pages, so these are served from the cache and cost no extra request.
  const loadProp = useServerFn(getOwnerProperty);
  const prop = useQuery({
    queryKey: ["owner-property", propertyId, user?.id],
    enabled: !!user && !!propertyId,
    retry: false,
    queryFn: () => loadProp({ data: { propertyId: propertyId as string } }),
  });
  const loadStr = useServerFn(getOwnerStr);
  const str = useQuery({
    queryKey: ["owner-str", propertyId],
    enabled: !!user && !!propertyId,
    retry: false,
    queryFn: () => loadStr({ data: { propertyId: propertyId as string } }),
  });

  const label = prop.data && prop.data.access !== "none" ? prop.data.property.label : null;

  async function signOut() {
    await supabase.auth.signOut();
    toast.success("Signed out");
    navigate({ to: "/owner/login", search: { redirect: undefined } });
  }

  return (
    <aside className="lg:sticky lg:top-6 lg:w-64 lg:shrink-0 lg:self-start">
      <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
        <div className="px-2 pb-3 pt-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Owner</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{user?.email}</p>
        </div>

        <nav aria-label="Owner navigation" className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
          <Link to="/owner" activeOptions={{ exact: true }} activeProps={active} className={base}>
            <Home className="h-4 w-4 shrink-0" aria-hidden />
            My properties
          </Link>

          {propertyId ? (
            <>
              <div className="mx-1 my-1 hidden rounded-lg bg-secondary/60 px-3 py-2 lg:block">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                  <p className="min-w-0 truncate text-sm font-semibold text-foreground">{label ?? "This property"}</p>
                </div>
              </div>

              <Group title="Overview">
                <PropLinks links={OVERVIEW} propertyId={propertyId} />
              </Group>

              <Group title="Money">
                <PropLinks links={MONEY} propertyId={propertyId} />
              </Group>

              <Group title="The home">
                <PropLinks links={HOME} propertyId={propertyId} />
                {str.data?.trackerEnabled ? (
                  <Link to="/owner/properties/$propertyId/str" params={{ propertyId }} activeProps={active} className={base}>
                    <Home className="h-4 w-4 shrink-0" aria-hidden />
                    Short-term rental
                  </Link>
                ) : null}
              </Group>

              <Group title="Governance">
                <Link to="/owner/properties/$propertyId/llc" params={{ propertyId }} search={{ tab: "operating-agreement" }} className={base}>
                  <FileText className="h-4 w-4 shrink-0" aria-hidden />
                  Operating Agreement
                </Link>
                <Link to="/owner/properties/$propertyId/llc" params={{ propertyId }} search={{ tab: "co-owners" }} className={base}>
                  <Users className="h-4 w-4 shrink-0" aria-hidden />
                  Co-owners
                </Link>
                <Link to="/owner/properties/$propertyId/llc" params={{ propertyId }} search={{ tab: "governance" }} className={base}>
                  <Scale className="h-4 w-4 shrink-0" aria-hidden />
                  Governance rules
                </Link>
                <Link to="/owner/properties/$propertyId/llc" params={{ propertyId }} search={{ tab: "notices" }} className={base}>
                  <Megaphone className="h-4 w-4 shrink-0" aria-hidden />
                  Notices
                </Link>
                <Link to="/owner/properties/$propertyId/$section" params={{ propertyId, section: "documents" }} activeProps={active} className={base}>
                  <FolderOpen className="h-4 w-4 shrink-0" aria-hidden />
                  Documents
                </Link>
              </Group>
            </>
          ) : null}

          <Group title="Account">
            <Link to="/owner/notifications" activeProps={active} className={base}>
              <Bell className="h-4 w-4 shrink-0" aria-hidden />
              Notification settings
            </Link>
          </Group>
        </nav>

        <button
          type="button"
          onClick={signOut}
          className="mt-3 inline-flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <LogOut className="h-4 w-4" aria-hidden />
          Sign out
        </button>
      </div>
    </aside>
  );
}
