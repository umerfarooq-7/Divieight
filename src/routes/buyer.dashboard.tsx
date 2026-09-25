import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { TitleStatusTracker } from "@/components/TitleStatusTracker";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  FileText,
  Heart,
  KeyRound,
  RefreshCw,
  Ticket,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { DesignateAgentCard } from "@/components/DesignateAgentCard";
import { buyerRedirect } from "@/lib/buyer";
import { getSellerAccount } from "@/lib/seller";
import { getMyReservations, withdrawReservation } from "@/lib/reservations.functions";
import { getMyOwnership } from "@/lib/ownership.functions";
import {
  getBuyerActionItems,
  type BuyerAction,
  type ProgressStep,
} from "@/lib/buyer-actions.functions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { enrollmentDaysRemaining, enrollmentEndDate } from "@/lib/golden-ticket";
import { formatDate } from "@/lib/format-date";
import { cn } from "@/lib/utils";
import { LifestylePerksConsent } from "@/components/LifestylePerksConsent";
import { SubstitutionInvitations } from "@/components/SubstitutionInvitations";

// The pod's stage outranks the reservation's own status once it moves past forming.
const POD_STAGE_LABELS: Record<string, string> = {
  system_lock: "System Lock",
  closing_ready: "Closing-Ready",
  active: "Active",
};

// Nested sections bring their own top margin; the page spaces sections itself.
const SECTION = "[&>section]:mt-0";

export const Route = createFileRoute("/buyer/dashboard")({
  head: () => ({
    meta: [
      { title: "Buyer dashboard — divieight" },
      {
        name: "description",
        content: "Track your Buyer Account, members, vetting status, and reserved shares.",
      },
      { property: "og:title", content: "Buyer dashboard — divieight" },
      {
        property: "og:description",
        content: "Track your Buyer Account, members, vetting status, and reserved shares.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BuyerDashboardPage,
  notFoundComponent: () => <BuyerDashboardFallback />,
  errorComponent: () => <BuyerDashboardFallback />,
});

/** Shown when the dashboard can't resolve a buyer account (wrong role, stale link). */
function BuyerDashboardFallback() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-20 text-center sm:px-6">
      <h1 className="font-display text-2xl font-semibold text-foreground">
        Buyer dashboard unavailable
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        We couldn&apos;t load a buyer account for this session. Sign in with your buyer account, or
        head to the seller dashboard if that&apos;s the account you use.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link
          to="/buyer/login"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Buyer sign in
        </Link>
        <Link
          to="/dashboard"
          className="rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground"
        >
          Seller dashboard
        </Link>
      </div>
    </div>
  );
}

interface Member {
  id: string;
  full_name: string;
  role: string;
  vetting_status: string;
}

interface AccountView {
  id: string;
  email: string;
  phone: string | null;
  onboarding_status: string;
  intent: string | null;
  primary_target_market: string | null;
  golden_ticket_issued: boolean;
  golden_ticket_issued_at: string | null;
  priority_rank: number | null;
  priority_rank_timestamp: string | null;
}

interface SignedDoc {
  id: string;
  document_type: string;
  document_version: string;
  signed_name: string;
  created_at: string;
}

function BuyerDashboardPage() {
  const navigate = useNavigate();
  const fetchMyReservations = useServerFn(getMyReservations);
  const withdraw = useServerFn(withdrawReservation);
  const queryClient = useQueryClient();
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const {
    data: reservations = [],
    refetch: refetchReservations,
    isLoading: reservationsLoading,
    isError: reservationsFailed,
    isFetching: reservationsFetching,
  } = useQuery({
    queryKey: ["my-reservations", authUserId],
    // The server fn requires a bearer token — don't fire it until the Supabase
    // session has resolved, otherwise it 401s on first paint.
    enabled: !!authUserId,
    retry: false,
    queryFn: () => fetchMyReservations(),
  });
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [confirmingWithdrawId, setConfirmingWithdrawId] = useState<string | null>(null);
  // After the Closing Ping Saga issues Digital Keys, the portal speaks as a Co-owner.
  const fetchOwnership = useServerFn(getMyOwnership);
  const { data: ownership } = useQuery({
    queryKey: ["my-ownership", authUserId],
    enabled: !!authUserId,
    retry: false,
    queryFn: () => fetchOwnership(),
  });
  const isCoOwner = Boolean(ownership?.isCoOwner);
  const ownedSince = new Map((ownership?.properties ?? []).map((o) => [o.propertyId, o.since]));

  const fetchActions = useServerFn(getBuyerActionItems);
  const actionsQuery = useQuery({
    queryKey: ["buyer-action-items", authUserId],
    enabled: !!authUserId,
    retry: false,
    queryFn: () => fetchActions(),
  });

  async function handleWithdraw(reservationId: string) {
    setConfirmingWithdrawId(null);
    setWithdrawingId(reservationId);
    try {
      const res = await withdraw({ data: { reservationId } });
      if (res.ok) {
        toast.success("Reservation withdrawn. The slice has been released.");
        await refetchReservations();
        void queryClient.invalidateQueries({ queryKey: ["buyer-action-items"] });
        void queryClient.invalidateQueries({ queryKey: ["pod-composition"] });
        void queryClient.invalidateQueries({ queryKey: ["marketplace-property"] });
        void queryClient.invalidateQueries({ queryKey: ["marketplace-properties"] });
      } else {
        toast.error("Couldn't withdraw this reservation. Please try again.");
      }
    } finally {
      setWithdrawingId(null);
    }
  }

  const [account, setAccount] = useState<AccountView | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [docs, setDocs] = useState<SignedDoc[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!auth.user) {
        navigate({ to: "/buyer/login" });
        return;
      }
      const { data: acct } = await supabase
        .from("buyer_accounts")
        .select(
          "id, email, phone, onboarding_status, intent, primary_target_market, golden_ticket_issued, golden_ticket_issued_at, priority_rank, priority_rank_timestamp",
        )
        .eq("auth_user_id", auth.user.id)
        .maybeSingle();
      if (cancelled) return;
      if (!acct) {
        // Not a buyer — sellers get bounced back to their own dashboard.
        const seller = await getSellerAccount(auth.user.id);
        if (cancelled) return;
        navigate({ to: seller ? "/dashboard" : "/buyer/register" });
        return;
      }
      setAccount(acct as AccountView);
      setAuthUserId(auth.user.id);

      const [{ data: mem }, { data: sd }] = await Promise.all([
        supabase
          .from("account_members")
          .select("id, full_name, role, vetting_status")
          .eq("buyer_account_id", acct.id)
          .order("created_at", { ascending: true }),
        supabase
          .from("signed_documents")
          .select("id, document_type, document_version, signed_name, created_at")
          .eq("buyer_account_id", acct.id)
          .order("created_at", { ascending: false }),
      ]);
      if (cancelled) return;
      setMembers((mem as Member[]) ?? []);
      setDocs((sd as SignedDoc[]) ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  if (loading || !account) return <DashboardSkeleton />;

  const primaryName =
    members.find((m) => m.role === "primary")?.full_name || members[0]?.full_name || account.email;
  const onboardingComplete = account.onboarding_status === "active";
  const daysLeft = enrollmentDaysRemaining(account.priority_rank_timestamp);
  const endDate = enrollmentEndDate(account.priority_rank_timestamp);
  const resumeTo = buyerRedirect(account.onboarding_status);
  const ownedCount = ownership?.properties?.length ?? 0;

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-12 sm:px-6 lg:px-8">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 sm:flex sm:flex-wrap sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            {isCoOwner ? "Co-owner" : "Buyer Account"}
          </p>
          <h1 className="truncate font-display text-2xl font-semibold text-foreground sm:text-3xl">
            {primaryName}
          </h1>
          <p className="truncate text-sm text-muted-foreground">
            {account.email}
            {account.intent ? <> · Intent: {humanize(account.intent)}</> : null}
          </p>
          {isCoOwner ? (
            <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
              <KeyRound className="h-3.5 w-3.5" aria-hidden /> Co-owner of {ownedCount} home
              {ownedCount === 1 ? "" : "s"}
            </span>
          ) : account.golden_ticket_issued ? (
            <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-accent/50 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
              <Ticket className="h-3.5 w-3.5" aria-hidden /> Golden Ticket · Vetted Buyer
              {account.golden_ticket_issued_at ? ` · ${formatDate(account.golden_ticket_issued_at)}` : ""}
            </span>
          ) : null}
        </div>
        {!isCoOwner && account.priority_rank != null ? (
          <div className="shrink-0 rounded-xl border border-accent/40 bg-accent/10 px-5 py-3 text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">
              Priority rank
            </p>
            <p className="font-display text-3xl font-semibold text-foreground">
              #{account.priority_rank}
            </p>
            <p className="mt-0.5 max-w-[10rem] text-[11px] leading-tight text-muted-foreground">
              Your place in line when shares are offered
            </p>
          </div>
        ) : !isCoOwner ? (
          <Link
            to="/properties"
            className="shrink-0 rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary"
          >
            Browse properties
          </Link>
        ) : null}
      </header>

      {account.onboarding_status === "verification_pending" ? (
        <div className="rounded-xl border border-accent/50 bg-accent/10 p-5">
          <p className="font-display text-base font-semibold text-foreground">
            Your account is under review
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            We need additional information to verify your background check results. You can add
            more documents at any time.
          </p>
          <Link
            to="/buyer/verification"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Upload documents
          </Link>
        </div>
      ) : null}

      {account.onboarding_status === "adverse_action" ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-5">
          <p className="font-display text-base font-semibold text-foreground">
            Adverse action notice issued
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Your Buyer Account cannot proceed to reservations. Review the notice for your rights
            under the Fair Credit Reporting Act.
          </p>
          <Link
            to="/buyer/adverse-action"
            className="mt-4 inline-block rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary"
          >
            View notice
          </Link>
        </div>
      ) : null}

      {!onboardingComplete ? (
        <div className="grid gap-3 rounded-xl border border-accent/50 bg-accent/10 p-5 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <p className="font-display text-base font-semibold text-foreground">
              Continue onboarding
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              You're at the “{humanize(account.onboarding_status)}” stage. Pick up right where
              you left off to unlock your Golden Ticket.
            </p>
          </div>
          <Link
            to={resumeTo}
            className="justify-self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground sm:justify-self-end"
          >
            Continue onboarding
          </Link>
        </div>
      ) : null}

      {reservations.length > 0 ? (
        <NeedsYourAction
          actions={actionsQuery.data?.actions ?? []}
          loading={actionsQuery.isLoading}
          failed={actionsQuery.isError}
          onRetry={() => void actionsQuery.refetch()}
        />
      ) : null}

      {account.golden_ticket_issued ? (
        <div className={SECTION}>
          <SubstitutionInvitations />
        </div>
      ) : null}

      {account.golden_ticket_issued ? (
        <div className={SECTION}>
          <DesignateAgentCard buyerAccountId={account.id} />
        </div>
      ) : null}

      <section>
        <h2 className="font-display text-lg font-semibold text-foreground">
          {isCoOwner ? "My homes & reservations" : "My reservations"}
          {!reservationsLoading && !reservationsFailed ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              ({reservations.length})
            </span>
          ) : null}
        </h2>
        {reservationsLoading ? (
          <div className="mt-4 h-40 animate-pulse rounded-xl border border-border bg-muted/40" />
        ) : reservationsFailed ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-5 text-sm">
            <p className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              We couldn&apos;t load your reservations. Nothing has changed on your account.
            </p>
            <button
              type="button"
              onClick={() => void refetchReservations()}
              disabled={reservationsFetching}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-60"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", reservationsFetching && "animate-spin")} aria-hidden />
              Try again
            </button>
          </div>
        ) : reservations.length === 0 ? (
          <div className="mt-4 rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            You haven&apos;t reserved a share yet. Explore homes on the marketplace to secure a priority rank.
            <div className="mt-4">
              <Link
                to="/properties"
                className="inline-block rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground"
              >
                Browse properties
              </Link>
            </div>
          </div>
        ) : (
          <ul className="mt-4 grid gap-4">
            {reservations.map((r) => {
              const owned = ownedSince.has(r.property_id);
              const steps = actionsQuery.data?.progress[r.property_id];
              return (
                <li key={r.id} className="rounded-xl border border-border bg-card p-5 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        to="/properties/$id"
                        params={{ id: r.property_id }}
                        className="font-display text-base font-semibold text-foreground hover:underline"
                      >
                        {r.address}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {r.city}, {r.state} {r.zip}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-accent/15 px-3 py-1 text-xs font-medium text-accent">
                          {r.shares_reserved} of 8 shares {owned ? "owned" : "reserved"}
                        </span>
                        {owned ? (
                          <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-800">
                            Co-owner since {formatDate(ownedSince.get(r.property_id)!)}
                          </span>
                        ) : (
                          <span className="rounded-full border border-border px-2.5 py-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                            {POD_STAGE_LABELS[r.listing_status ?? ""] ?? r.status}
                          </span>
                        )}
                      </div>
                    </div>
                    <Link
                      to={owned ? "/buyer/documents" : "/buyer/pods/$id"}
                      params={owned ? undefined : { id: r.property_id }}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
                    >
                      {owned ? "Records vault" : "Open pod"}
                      <ArrowRight className="h-4 w-4" aria-hidden />
                    </Link>
                  </div>

                  {steps ? <ProgressTracker steps={steps} /> : null}

                  <nav aria-label={`Pages for ${r.address}`} className="mt-4 border-t border-border pt-4">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {owned ? (
                        <PageLink to="/buyer/pods/$id" params={{ id: r.property_id }}>
                          View pod
                        </PageLink>
                      ) : (
                        <>
                          <PageLink to="/buyer/due-diligence/$id" params={{ id: r.property_id }}>
                            Due diligence
                          </PageLink>
                          <PageLink to="/buyer/authorizations">Authorizations</PageLink>
                          <PageLink to="/buyer/earnest-money">Earnest money</PageLink>
                          <PageLink to="/buyer/closing-funds">Closing funds</PageLink>
                        </>
                      )}
                      <PageLink to="/buyer/operating-agreement">Operating Agreement</PageLink>
                      <PageLink to="/buyer/insurance">Insurance</PageLink>
                      <PageLink to="/buyer/reports">Reports</PageLink>
                      <PageLink to="/properties/$id" params={{ id: r.property_id }}>
                        View home
                      </PageLink>
                    </div>
                  </nav>

                  {r.status === "reserved" && r.listing_status === "forming" ? (
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      {confirmingWithdrawId === r.id ? (
                        <>
                          <p className="text-xs text-muted-foreground">
                            Your slice is released back to the pod and your hold on this home ends.
                          </p>
                          <button
                            type="button"
                            onClick={() => void handleWithdraw(r.id)}
                            className="min-h-9 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground hover:opacity-90"
                          >
                            Confirm withdrawal
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmingWithdrawId(null)}
                            className="min-h-9 rounded-md border border-border px-3 text-xs font-medium text-foreground hover:bg-secondary"
                          >
                            Keep reservation
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmingWithdrawId(r.id)}
                          disabled={withdrawingId === r.id}
                          className="min-h-9 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60"
                        >
                          {withdrawingId === r.id ? "Withdrawing…" : "Withdraw reservation"}
                        </button>
                      )}
                    </div>
                  ) : r.status === "reserved" && !owned ? (
                    <p className="mt-4 text-xs text-muted-foreground">
                      Pod locked — exits run through the Member Substitution Pipeline.
                    </p>
                  ) : null}

                  <TitleStatusTracker propertyId={r.property_id} />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {!isCoOwner ? (
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <KeyRound className="h-5 w-5" aria-hidden />
            </span>
            <div className="flex-1">
              <p className="font-display text-base font-semibold text-foreground">Enrollment period</p>
              <p className="text-sm text-muted-foreground">
                12-month enrollment period for your Buyer Account.
              </p>
              {daysLeft == null ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  Your enrollment period starts once your reservation payment clears.
                </p>
              ) : (
                <>
                  <div className="mt-4 flex items-baseline gap-2">
                    <span className="font-display text-3xl font-semibold text-foreground">
                      {daysLeft}
                    </span>
                    <span className="text-sm text-muted-foreground">days remaining</span>
                  </div>
                  <div
                    className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={365}
                    aria-valuenow={daysLeft}
                    aria-label="Enrollment days remaining"
                  >
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${Math.min(100, (daysLeft / 365) * 100)}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Active through {formatDate(endDate)}
                  </p>
                </>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {authUserId ? (
        <div className={SECTION}>
          <LifestylePerksConsent buyerAccountId={account.id} authUserId={authUserId} />
        </div>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-3">
        <QuickLink
          to="/buyer/documents"
          icon={<FileText className="h-4 w-4" aria-hidden />}
          title={isCoOwner ? "Records vault & documents" : "My documents"}
          hint={`${docs.length} signed document${docs.length === 1 ? "" : "s"}`}
        />
        <QuickLink
          to="/buyer/wishlist"
          icon={<Heart className="h-4 w-4" aria-hidden />}
          title="My saved properties"
          hint="View your wishlist"
        />
        <QuickLink
          to="/properties"
          icon={<Building2 className="h-4 w-4" aria-hidden />}
          title="Browse properties"
          hint="Explore live 1/8th share listings"
        />
      </section>

      <section>
        <h2 className="font-display text-lg font-semibold text-foreground">
          Account members
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            ({members.length} {members.length === 1 ? "member" : "members"} · up to 2 per account)
          </span>
        </h2>
        <div className="mt-4 space-y-3">
          {members.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No members on this account yet.
            </p>
          ) : (
            members.map((m) => (
              <div
                key={m.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-xl border border-border bg-card p-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {m.full_name || "Unnamed member"}
                  </p>
                  <p className="text-xs text-muted-foreground">{humanize(m.role)} member</p>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-3 py-1 text-xs font-medium",
                    vettingTone(m.vetting_status),
                  )}
                >
                  {vettingLabel(m.vetting_status)}
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

const ACTION_LINK: Record<BuyerAction["kind"], string> = {
  due_diligence: "/buyer/due-diligence/$id",
  authorization: "/buyer/authorizations/$id",
  earnest_money: "/buyer/earnest-money",
  closing_funds: "/buyer/closing-funds",
  operating_agreement: "/buyer/operating-agreement",
};

function actionParams(a: BuyerAction): { id: string } | undefined {
  if (a.kind === "due_diligence") return { id: a.propertyId };
  if (a.kind === "authorization" && a.requestId) return { id: a.requestId };
  return undefined;
}

function NeedsYourAction({
  actions,
  loading,
  failed,
  onRetry,
}: {
  actions: BuyerAction[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <section aria-labelledby="needs-action-heading">
      <h2 id="needs-action-heading" className="font-display text-lg font-semibold text-foreground">
        Needs your action
        {!loading && !failed && actions.length > 0 ? (
          <span className="ml-2 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
            {actions.length}
          </span>
        ) : null}
      </h2>
      {loading ? (
        <div className="mt-4 h-20 animate-pulse rounded-xl border border-border bg-muted/40" />
      ) : failed ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          We couldn&apos;t check for pending actions right now.
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-secondary"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Try again
          </button>
        </div>
      ) : actions.length === 0 ? (
        <p className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
          You&apos;re all caught up — nothing is waiting on you right now.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {actions.map((a, i) => (
            <li key={`${a.kind}-${a.propertyId}-${a.requestId ?? i}`}>
              <Link
                to={ACTION_LINK[a.kind]}
                params={actionParams(a)}
                className="flex items-center justify-between gap-3 p-4 transition-colors hover:bg-secondary/60"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{a.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {a.propertyLabel}
                    {a.detail ? ` · ${a.detail}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {a.dueAt ? (
                    <span
                      className={cn(
                        "rounded-full px-2.5 py-0.5 text-xs font-medium",
                        a.overdue ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {a.overdue ? "Overdue · " : "Due "}
                      {formatDate(a.dueAt)}
                    </span>
                  ) : null}
                  <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProgressTracker({ steps }: { steps: ProgressStep[] }) {
  return (
    <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-label="Transaction progress">
      {steps.map((s) => (
        <li
          key={s.key}
          aria-current={s.state === "current" ? "step" : undefined}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs",
            s.state === "done" && "border-emerald-200 bg-emerald-50 text-emerald-800",
            s.state === "current" && "border-accent/50 bg-accent/10 font-medium text-foreground",
            s.state === "todo" && "border-border text-muted-foreground",
          )}
        >
          {s.state === "done" ? (
            <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : (
            <span
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                s.state === "current" ? "bg-accent" : "bg-muted-foreground/30",
              )}
              aria-hidden
            />
          )}
          <span className="truncate">{s.label}</span>
          <span className="sr-only">{s.state === "done" ? " (done)" : s.state === "current" ? " (current step)" : ""}</span>
        </li>
      ))}
    </ol>
  );
}

function PageLink({
  to,
  params,
  children,
}: {
  to: string;
  params?: { id: string };
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      params={params}
      className="flex min-h-9 items-center justify-between gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
    >
      <span className="truncate">{children}</span>
      <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}

function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-12 sm:px-6 lg:px-8" aria-busy="true" aria-label="Loading your dashboard">
      <div className="space-y-2">
        <div className="h-3 w-24 animate-pulse rounded bg-muted" />
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
        <div className="h-4 w-48 animate-pulse rounded bg-muted" />
      </div>
      <div className="h-24 animate-pulse rounded-xl bg-muted/60" />
      <div className="h-48 animate-pulse rounded-xl bg-muted/60" />
    </div>
  );
}

function vettingLabel(status: string) {
  if (status === "cleared") return "Cleared";
  if (status === "failed" || status === "adverse_action") return "Failed";
  return "Pending";
}

function vettingTone(status: string) {
  if (status === "cleared") return "border-accent/50 bg-accent/10 text-accent";
  if (status === "failed" || status === "adverse_action")
    return "border-destructive/40 bg-destructive/5 text-destructive";
  return "border-border bg-muted/40 text-muted-foreground";
}

function QuickLink({
  to,
  icon,
  title,
  hint,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-secondary/60"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </Link>
  );
}

function humanize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
