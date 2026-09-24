import { Link, useRouterState } from "@tanstack/react-router";
import {
  Check,
  Circle,
  FileCheck2,
  FileSearch,
  Landmark,
  Coins,
  FileSignature,
  Layers,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  Lock,
  Share2,
  ShieldCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import type { AgentOnboardingStatus } from "@/lib/agent-onboarding-status";

/**
 * Agent Portal navigation. Purely presentational: it changes HOW you reach a
 * page, never what that page does. Access is still enforced by the route
 * guard in `src/routes/agent.tsx` — this only mirrors it visually.
 */

const PORTAL_NAV = [
  { to: "/agent/dashboard", label: "Overview", icon: LayoutDashboard },
  { to: "/agent/leads", label: "My buyers", icon: Users },
  { to: "/agent/pools", label: "Market pools", icon: Layers },
  { to: "/agent/attribution", label: "Attribution tokens", icon: Share2 },
  { to: "/agent/listings", label: "My listings", icon: ListChecks },
  { to: "/agent/documents", label: "Agreements", icon: FileSignature },
  { to: "/agent/due-diligence", label: "Due diligence", icon: FileCheck2 },
  { to: "/agent/authorizations", label: "Authorizations", icon: ShieldCheck },
  { to: "/agent/reports", label: "Reports", icon: FileSearch },
  { to: "/agent/closing-funds", label: "Closing funds", icon: Landmark },
  { to: "/agent/commissions", label: "Commissions", icon: Coins },
  { to: "/support", label: "Support", icon: LifeBuoy },
] as const;

const LOCK_MESSAGE = "Complete onboarding to unlock.";

export function AgentSidebar({ status }: { status: AgentOnboardingStatus | null }) {
  const { state, setOpenMobile, isMobile } = useSidebar();
  const collapsed = state === "collapsed";
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onboardingComplete = status?.complete ?? false;

  const isActive = (path: string) => pathname === path || pathname.startsWith(`${path}/`);
  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarContent>
        {/* While credentialing is in flight the sidebar doubles as the
            onboarding progress tracker. */}
        {!onboardingComplete && status ? (
          <SidebarGroup>
            <SidebarGroupLabel>Onboarding</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {status.steps.map((step) => {
                  const reachable =
                    step.complete || status.firstIncomplete?.key === step.key;
                  const StepIcon = step.complete ? Check : Circle;
                  return (
                    <SidebarMenuItem key={step.key}>
                      {reachable ? (
                        <SidebarMenuButton asChild isActive={isActive(step.path)}>
                          <Link to={step.path} onClick={closeOnMobile} className="flex items-center gap-2">
                            <StepIcon
                              className={cn(
                                "h-4 w-4",
                                step.complete ? "text-primary" : "text-accent",
                              )}
                            />
                            {!collapsed && <span>{step.label}</span>}
                          </Link>
                        </SidebarMenuButton>
                      ) : (
                        <LockedItem
                          label={step.label}
                          icon={Circle}
                          collapsed={collapsed}
                          message="Finish the earlier steps first."
                        />
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}

        <SidebarGroup>
          <SidebarGroupLabel>Portal</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {PORTAL_NAV.map(({ to, label, icon: Icon }) => {
                // Support stays reachable throughout onboarding.
                const unlocked = onboardingComplete || to === "/support";
                return (
                  <SidebarMenuItem key={to}>
                    {unlocked ? (
                      <SidebarMenuButton asChild isActive={isActive(to)}>
                        <Link to={to} onClick={closeOnMobile} className="flex items-center gap-2">
                          <Icon className="h-4 w-4" />
                          {!collapsed && <span>{label}</span>}
                        </Link>
                      </SidebarMenuButton>
                    ) : (
                      <LockedItem
                        label={label}
                        icon={Icon}
                        collapsed={collapsed}
                        message={LOCK_MESSAGE}
                      />
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

function LockedItem({
  label,
  icon: Icon,
  collapsed,
  message,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  collapsed: boolean;
  message: string;
}) {
  return (
    <SidebarMenuButton
      type="button"
      title={message}
      aria-disabled
      onClick={() => toast.message(message)}
      className="cursor-not-allowed opacity-50"
    >
      <Icon className="h-4 w-4" />
      {!collapsed && (
        <span className="flex flex-1 items-center justify-between gap-2">
          {label}
          <Lock className="h-3.5 w-3.5" />
        </span>
      )}
    </SidebarMenuButton>
  );
}
