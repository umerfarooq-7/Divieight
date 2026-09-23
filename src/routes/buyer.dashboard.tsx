import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Building2, FileText, Heart, KeyRound, Ticket } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { DesignateAgentCard } from "@/components/DesignateAgentCard";
import { buyerRedirect } from "@/lib/buyer";
import { getSellerAccount } from "@/lib/seller";
import { getMyReservations, withdrawReservation } from "@/lib/reservations.functions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { enrollmentDaysRemaining, enrollmentEndDate } from "@/lib/golden-ticket";
import { cn } from "@/lib/utils";
import { LifestylePerksConsent } from "@/components/LifestylePerksConsent";
import { SubstitutionInvitations } from "@/components/SubstitutionInvitations";

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
  } = useQuery({
    queryKey: ["my-reservations", authUserId],
    // The server fn requires a bearer token — don't fire it until the Supabase
    // session has resolved, otherwise it 401s on first paint.
    enabled: !!authUserId,
    retry: false,
    queryFn: () => fetchMyReservations(),
  });
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);

  async function handleWithdraw(reservationId: string) {
    if (
      !window.confirm(
        "Withdraw this reservation? Your slice is released back to the pod and your hold on this home ends.",
      )
    )
      return;
    setWithdrawingId(reservationId);
    try {
      const res = await withdraw({ data: { reservationId } });
      if (res.ok) {
        toast.success("Reservation withdrawn. The slice has been released.");
        await refetchReservations();
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

  if (loading || !account) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
        Loading your buyer dashboard…
      </div>
    );
  }

  const primaryName =
    members.find((m) => m.role === "primary")?.full_name || members[0]?.full_name || account.email;
  const onboardingComplete = account.onboarding_status === "active";
  const daysLeft = enrollmentDaysRemaining(account.priority_rank_timestamp);
  const endDate = enrollmentEndDate(account.priority_rank_timestamp);
  const resumeTo = buyerRedirect(account.onboarding_status);

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 sm:flex sm:flex-wrap sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            Buyer Account
          </p>
          <h1 className="truncate font-display text-2xl font-semibold text-foreground sm:text-3xl">
            {primaryName}
          </h1>
          <p className="truncate text-sm text-muted-foreground">{account.email}</p>
          {account.golden_ticket_issued ? (
            <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-accent/50 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
              <Ticket className="h-3.5 w-3.5" /> Golden Ticket · Vetted Buyer
            </span>
          ) : null}
        </div>
        {account.priority_rank != null ? (
          <div className="shrink-0 rounded-xl border border-accent/40 bg-accent/10 px-5 py-3 text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">
              Priority rank
            </p>
            <p className="font-display text-3xl font-semibold text-foreground">
              #{account.priority_rank}
            </p>
          </div>
        ) : (
          <Link
            to="/properties"
            className="shrink-0 rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary"
          >
            Browse properties
          </Link>
        )}
      </header>

      {account.onboarding_status === "verification_pending" ? (
        <div className="mt-8 rounded-xl border border-accent/50 bg-accent/10 p-5">
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
        <div className="mt-8 rounded-xl border border-destructive/40 bg-destructive/5 p-5">
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
        <div className="mt-8 grid gap-3 rounded-xl border border-accent/50 bg-accent/10 p-5 sm:grid-cols-[1fr_auto] sm:items-center">
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

      {account.golden_ticket_issued ? (
        <div className="mt-8">
          <SubstitutionInvitations />
        </div>
      ) : null}

      {account.golden_ticket_issued ? <DesignateAgentCard buyerAccountId={account.id} /> : null}

      <section className="mt-8 rounded-xl border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <KeyRound className="h-5 w-5" />
          </span>
          <div className="flex-1">
            <p className="font-display text-base font-semibold text-foreground">Digital Key</p>
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
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${Math.min(100, (daysLeft / 365) * 100)}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Active through {endDate?.toLocaleDateString()}
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      {authUserId ? (
        <LifestylePerksConsent buyerAccountId={account.id} authUserId={authUserId} />
      ) : null}



      <section className="mt-6 grid gap-4 sm:grid-cols-3">
        <QuickLink
          to="/properties"
          icon={<Building2 className="h-4 w-4" />}
          title="Browse properties"
          hint="Explore live 1/8th share listings"
        />
        <QuickLink
          to="/buyer/wishlist"
          icon={<Heart className="h-4 w-4" />}
          title="My saved properties"
          hint="View your wishlist"
        />

        <QuickLink
          to="/buyer/documents"
          icon={<FileText className="h-4 w-4" />}
          title="My documents"
          hint={`${docs.length} signed document${docs.length === 1 ? "" : "s"}`}
        />
      </section>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Stat label="Onboarding" value={humanize(account.onboarding_status)} />
        <Stat label="Intent" value={account.intent ? humanize(account.intent) : "Not set"} />
        <Stat
          label="Golden ticket"
          value={
            account.golden_ticket_issued
              ? `Issued ${account.golden_ticket_issued_at ? new Date(account.golden_ticket_issued_at).toLocaleDateString() : ""}`.trim()
              : "Not issued"
          }
        />
      </div>

      <section className="mt-10">
        <h2 className="font-display text-lg font-semibold text-foreground">
          My Reservations
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            ({reservations.length})
          </span>
        </h2>
        {reservations.length === 0 ? (
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
          <ul className="mt-4 grid gap-3">
            {reservations.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-4 shadow-sm"
              >
                <div>
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
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="rounded-full bg-accent/15 px-3 py-1 text-xs font-medium text-accent">
                    {r.shares_reserved} of 8 share{r.shares_reserved === 1 ? "" : "s"} reserved
                  </span>
                  <span className="rounded-full border border-border px-2.5 py-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                    {r.listing_status === "system_lock" ? "System Lock" : r.status}
                  </span>
                  <Link
                    to="/buyer/pods/$id"
                    params={{ id: r.property_id }}
                    className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    View pod →
                  </Link>
                  <Link
                    to="/buyer/due-diligence/$id"
                    params={{ id: r.property_id }}
                    className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    Due diligence →
                  </Link>
                  <Link
                    to="/buyer/authorizations"
                    className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    Authorizations →
                  </Link>
                  <Link
                    to="/buyer/earnest-money"
                    className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    Earnest money →
                  </Link>
                  <Link
                    to="/buyer/closing-funds"
                    className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    Closing funds →
                  </Link>
                  <Link
                    to="/buyer/reports"
                    className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    Reports →
                  </Link>
                  <Link
                    to="/properties/$id"
                    params={{ id: r.property_id }}
                    className="text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
                  >
                    View home
                  </Link>
                  {r.status === "reserved" && r.listing_status === "forming" ? (
                    <button
                      type="button"
                      onClick={() => handleWithdraw(r.id)}
                      disabled={withdrawingId === r.id}
                      className="rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60"
                    >
                      {withdrawingId === r.id ? "Withdrawing…" : "Withdraw reservation"}
                    </button>
                  ) : r.status === "reserved" ? (
                    <span className="text-[11px] text-muted-foreground">
                      Pod locked — exits run through the Member Substitution Pipeline.
                    </span>
                  ) : null}

                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="font-display text-lg font-semibold text-foreground">
          Account members
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            ({members.length} of 2)
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
  disabled,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  const body = (
    <>
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </>
  );
  const className = cn(
    "flex items-center gap-3 rounded-xl border border-border bg-card p-4 transition-colors",
    disabled ? "cursor-not-allowed opacity-60" : "hover:bg-secondary/60",
  );
  if (disabled) return <div className={className}>{body}</div>;
  return (
    <Link to={to} className={className}>
      {body}
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}

function humanize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
