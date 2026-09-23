import { useEffect, useState } from "react";
import { TitleStatusTracker } from "@/components/TitleStatusTracker";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { EightSlicesTracker } from "@/components/EightSlicesTracker";
import { ListingStatusTimeline, type ListingStatus } from "@/components/ListingStatusTimeline";
import { resumeRouteForStep } from "@/lib/listing-progress";
import { getBuyerAccount } from "@/lib/buyer";

import { CheckCircle2, Home, LayoutGrid, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Seller Dashboard — divieight" },
      {
        name: "description",
        content: "Manage your listings, shares, and offers from your seller dashboard.",
      },
    ],
  }),
  component: Dashboard,
});

type Listing = {
  id: string;
  address: string;
  city: string;
  state: string;
  status: string;
  listing_status: ListingStatus;
  listing_price: number | null;
  property_type: string | null;
  exit_type: string | null;
  retained_shares: number | null;
  primary_photo?: string | null;
  has_media?: boolean;
  last_completed_step?: string | null;
  listing_rejection_reason?: string | null;
  listing_agent_engagement_status?: string | null;
  listing_agent_decline_reason?: string | null;
};

type SellerInfo = {
  full_name: string | null;
  email: string | null;
  onboarding_status: string | null;
  exit_type: string | null;
};

function formatPrice(n: number | null) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

/** Where an unfinished draft should pick back up in the onboarding flow. */
function resumeStepFor(l: Listing) {
  const tracked = resumeRouteForStep(l.last_completed_step);
  if (tracked === "/onboarding/listing") return "/onboarding/listing" as const;
  if (tracked === "/onboarding/media") return "/onboarding/media" as const;
  if (tracked === "/onboarding/agreement") return "/onboarding/agreement" as const;
  if (!l.listing_price || !l.property_type) return "/onboarding/listing" as const;
  if (!l.has_media) return "/onboarding/media" as const;
  return "/onboarding/agreement" as const;
}

function Dashboard() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [seller, setSeller] = useState<SellerInfo | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      navigate({ to: "/login" });
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      const [{ data: sellerData }, { data: props }] = await Promise.all([
        supabase
          .from("sellers")
          .select("full_name, email, onboarding_status, exit_type")
          .eq("id", user.id)
          .maybeSingle(),
        supabase
          .from("properties")
          .select(
            "id, address, city, state, status, listing_status, listing_price, property_type, exit_type, retained_shares, listing_rejection_reason, listing_agent_engagement_status, listing_agent_decline_reason",
          )
          .eq("seller_id", user.id)
          .order("created_at", { ascending: false }),
      ]);

      if (cancelled) return;
      if (!sellerData) {
        // Not a seller — buyers get bounced to their own dashboard.
        const buyer = await getBuyerAccount(user.id);
        if (cancelled) return;
        navigate({ to: buyer ? "/buyer/dashboard" : "/login" });
        return;
      }
      setSeller((sellerData as SellerInfo) ?? null);

      const propRows = ((props as unknown) as Listing[]) ?? [];

      // Resume-step column is optional: ignore it if the column isn't there yet.
      if (propRows.length > 0) {
        const { data: steps } = await supabase
          .from("properties")
          .select("id, last_completed_step")
          .eq("seller_id", user.id);
        const stepById = new Map<string, string | null>();
        ((steps as { id: string; last_completed_step: string | null }[] | null) ?? []).forEach(
          (s) => stepById.set(s.id, s.last_completed_step),
        );
        propRows.forEach((p) => {
          p.last_completed_step = stepById.get(p.id) ?? null;
        });
      }
      // Fetch primary photo per property (display_order 0 or first)
      if (propRows.length > 0) {
        const ids = propRows.map((p) => p.id);
        const { data: media } = await supabase
          .from("property_media")
          .select("property_id, url, display_order")
          .in("property_id", ids)
          .eq("media_type", "photo")
          .order("display_order", { ascending: true });
        const firstByProp = new Map<string, string>();
        (media ?? []).forEach((m: { property_id: string; url: string | null }) => {
          if (m.url && !firstByProp.has(m.property_id)) firstByProp.set(m.property_id, m.url);
        });
        propRows.forEach((p) => {
          p.has_media = firstByProp.has(p.id);
        });
        const paths = Array.from(firstByProp.values());
        if (paths.length > 0) {
          const { data: signed } = await supabase.storage
            .from("property-media")
            .createSignedUrls(paths, 60 * 60);
          const signedByPath = new Map<string, string>();
          (signed ?? []).forEach((s) => {
            if (s.path && s.signedUrl) signedByPath.set(s.path, s.signedUrl);
          });
          propRows.forEach((p) => {
            const path = firstByProp.get(p.id);
            p.primary_photo = path ? signedByPath.get(path) ?? null : null;
          });
        }
      }


      setListings(propRows);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user, authLoading, navigate]);

  const totalProps = listings.length;
  const totalAvailable = listings.reduce((acc, l) => {
    const retained =
      l.exit_type === "hybrid_exit" ? Math.max(0, Math.min(7, l.retained_shares ?? 0)) : 0;
    return acc + (8 - retained);
  }, 0);

  const feeStatus = seller?.exit_type === "hybrid_exit" ? "Due" : "N/A";

  const fullyOnboarded = seller?.onboarding_status === "active";
  const displayName =
    seller?.full_name?.trim() ||
    (seller?.email ? seller.email.split("@")[0] : "there");

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 sm:flex sm:flex-wrap sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            Seller Dashboard
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="truncate font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Welcome back, {displayName}
            </h1>
            {fullyOnboarded ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Onboarded
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your fractional listings and track share availability.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Link
            to="/onboarding"
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            New listing
          </Link>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={<Home className="h-4 w-4" />}
          label="Total Properties Listed"
          value={String(totalProps)}
        />
        <StatCard
          icon={<LayoutGrid className="h-4 w-4" />}
          label="Total Shares Available"
          value={String(totalAvailable)}
          hint={`${totalProps * 8} total across all listings`}
        />
        <StatCard
          icon={<Wallet className="h-4 w-4" />}
          label="Enrollment Fee"
          value={feeStatus}
          tone={feeStatus === "Due" ? "warning" : "muted"}
        />
      </div>

      {/* My Listings */}
      <section className="mt-10">
        <div className="flex items-end justify-between">
          <h2 className="font-display text-xl font-semibold tracking-tight text-foreground">
            My Listings
          </h2>
          {listings.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {listings.length} {listings.length === 1 ? "property" : "properties"}
            </p>
          ) : null}
        </div>

        <div className="mt-4 space-y-4">
          {authLoading || loading ? (
            <div className="grid gap-4">
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="h-40 animate-pulse rounded-xl border border-border bg-card"
                />
              ))}
            </div>
          ) : listings.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card p-12 text-center">
              <Home className="mx-auto h-8 w-8 text-muted-foreground" />
              <h3 className="mt-3 font-display text-lg font-semibold text-foreground">
                You haven't listed a property yet
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Get started by listing your first fractional property.
              </p>
              <Link
                to="/onboarding"
                className="mt-5 inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
              >
                List a Property
              </Link>
            </div>
          ) : (
            listings.map((l) => (
              <article
                key={l.id}
                className="overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-colors hover:border-foreground/20"
              >
                <div className="grid gap-0 md:grid-cols-[240px_1fr]">
                  <div className="relative aspect-[4/3] w-full bg-secondary md:aspect-auto md:h-full">
                    {l.primary_photo ? (
                      <img
                        src={l.primary_photo}
                        alt={l.address}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full min-h-32 w-full items-center justify-center text-muted-foreground">
                        <Home className="h-8 w-8 opacity-40" />
                      </div>
                    )}
                  </div>
                  <div className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-display text-lg font-semibold text-foreground">
                            {l.address}
                          </h3>
                          {l.status !== "listed" ? (
                            <span className="inline-flex items-center rounded-full border border-accent/30 bg-accent/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
                              Draft
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
                              Live
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {l.city}, {l.state}
                          {l.property_type ? ` · ${l.property_type}` : ""}
                        </p>
                      </div>

                      <div className="text-right">
                        <p className="font-display text-lg font-semibold text-foreground">
                          {formatPrice(l.listing_price)}
                        </p>
                        {l.listing_price ? (
                          <p className="text-[11px] text-muted-foreground">
                            {formatPrice(l.listing_price / 8)} / share
                          </p>
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-4">
                      <EightSlicesTracker
                        propertyId={l.id}
                        retainedShares={
                          l.exit_type === "hybrid_exit" ? l.retained_shares ?? 0 : 0
                        }
                        compact
                      />
                    </div>

                    <div className="mt-4 border-t border-border pt-4">
                      <ListingStatusTimeline
                        status={l.listing_status ?? "forming"}
                        showDescription={false}
                      />
                    </div>

                    <div className="mt-4">
                      <TitleStatusTracker propertyId={l.id} />
                    </div>

                    {l.listing_rejection_reason && (
                      <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
                        <p className="text-sm font-medium text-foreground">
                          Action required — your Listing Agent rejected this property
                        </p>
                        <p className="mt-1 break-words text-sm text-muted-foreground">
                          {l.listing_rejection_reason}
                        </p>
                      </div>
                    )}

                    {l.listing_agent_engagement_status === "declined" && (
                      <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
                        <p className="text-sm font-medium text-foreground">
                          Action required — your Listing Agent declined the engagement
                        </p>
                        <p className="mt-1 break-words text-sm text-muted-foreground">
                          {l.listing_agent_decline_reason ?? "No reason given."} Choose another
                          Listing Agent, or let divieight pick one for you.
                        </p>
                        <Link
                          to="/onboarding/listing-agent"
                          search={{ property: l.id }}
                          className="mt-3 inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
                        >
                          Choose a Listing Agent
                        </Link>
                      </div>
                    )}

                    {l.listing_agent_engagement_status === "pending" && (
                      <p className="mt-4 text-sm text-muted-foreground">
                        Waiting for your Listing Agent to accept the engagement.
                      </p>
                    )}

                    <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                      {/* Each step is scoped by ?property=<id>, so any listing —
                          draft or live — can be reopened at the right step without
                          repeating Identity verification. */}
                      {l.listing_rejection_reason ? (
                        <Link
                          to="/listings/$id/edit"
                          params={{ id: l.id }}
                          className="inline-flex h-9 items-center rounded-md border border-accent bg-accent/10 px-4 text-sm font-medium text-accent transition-colors hover:bg-accent/20"
                        >
                          Edit property details
                        </Link>
                      ) : (
                      <Link
                        to={l.status !== "listed" ? resumeStepFor(l) : "/onboarding/listing"}
                        search={{ property: l.id }}
                        className="inline-flex h-9 items-center rounded-md border border-accent bg-accent/10 px-4 text-sm font-medium text-accent transition-colors hover:bg-accent/20"
                      >
                        {l.status !== "listed" ? "Continue Editing" : "Edit listing"}
                      </Link>
                      )}
                      <Link
                        to="/listings/$id"
                        params={{ id: l.id }}
                        className="inline-flex h-9 items-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
                      >
                        View Details
                      </Link>
                    </div>

                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
  tone = "muted",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: "muted" | "success" | "warning";
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <span
          className={cn(
            "inline-flex h-6 w-6 items-center justify-center rounded-md",
            tone === "success" && "bg-primary/10 text-primary",
            tone === "warning" && "bg-accent/10 text-accent",
            tone === "muted" && "bg-secondary text-foreground",
          )}
        >
          {icon}
        </span>
        {label}
      </div>
      <p className="mt-3 font-display text-2xl font-semibold text-foreground">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
