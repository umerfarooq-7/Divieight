import { useEffect, useState } from "react";
import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ChevronLeft,
  ChevronRight,
  Heart,
  Lock,
  MapPin,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { EightSlicesTracker } from "@/components/EightSlicesTracker";
import { getMarketplaceProperty } from "@/lib/marketplace.functions";
import { knownAmenities } from "@/lib/amenities";
import { getPodComposition } from "@/lib/reservations.functions";
import { PodCompositionPanel } from "@/components/PodCompositionPanel";
import { getBuyerAccount } from "@/lib/buyer";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/audit";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/properties/$id")({
  head: () => ({
    meta: [
      { title: "Property Details — divieight Marketplace" },
      {
        name: "description",
        content:
          "See photos, price per 1/8th share, share availability, amenities and seller exit disclosures for this fractional co-ownership home.",
      },
      { property: "og:title", content: "Property Details — divieight Marketplace" },
      {
        property: "og:description",
        content:
          "Full listing detail for a divieight fractional home: gallery, share tracker, exit disclosure and the gated Virtual Data Room.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PropertyDetailPage,
  notFoundComponent: () => (
    <div className="mx-auto max-w-2xl px-4 py-20 text-center sm:px-6">
      <h1 className="font-display text-2xl font-semibold text-foreground">Listing unavailable</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This home isn't published on the marketplace.
      </p>
      <Link to="/properties" className="mt-6 inline-block text-sm font-medium text-accent">
        Back to all homes →
      </Link>
    </div>
  ),
  errorComponent: () => (
    <div className="mx-auto max-w-2xl px-4 py-20 text-center sm:px-6">
      <h1 className="font-display text-2xl font-semibold text-foreground">
        This listing didn&apos;t load
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Something went wrong fetching this home. Please try again.
      </p>
      <Link to="/properties" className="mt-6 inline-block text-sm font-medium text-accent">
        Back to all homes →
      </Link>
    </div>
  ),
});

const USAGE_LABELS: Record<string, string> = {
  owner_occupied: "Owner-Occupied",
  short_term_rental: "Short-Term Rental",
};

function money(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function PropertyDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const fetchProperty = useServerFn(getMarketplaceProperty);
  const { data: property, isLoading } = useQuery({
    queryKey: ["marketplace-property", id],
    queryFn: () => fetchProperty({ data: { id } }),
  });

  const fetchPod = useServerFn(getPodComposition);
  const { data: composition } = useQuery({
    queryKey: ["pod-composition", id],
    queryFn: () => fetchPod({ data: { propertyId: id } }),
  });

  const { user } = useAuth();
  const [buyerAccountId, setBuyerAccountId] = useState<string | null>(null);
  const [goldenTicket, setGoldenTicket] = useState(false);
  const [saved, setSaved] = useState(false);
  const [photoIndex, setPhotoIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setBuyerAccountId(null);
      setGoldenTicket(false);
      setSaved(false);
      return;
    }
    (async () => {
      const account = await getBuyerAccount(user.id);
      if (cancelled || !account) return;
      setBuyerAccountId(account.id);

      const [{ data: full }, { data: rows }] = await Promise.all([
        supabase
          .from("buyer_accounts")
          .select("golden_ticket_issued")
          .eq("id", account.id)
          .maybeSingle(),
        supabase
          .from("wishlist")
          .select("id")
          .eq("buyer_account_id", account.id)
          .eq("property_id", id)
          .limit(1),
      ]);
      if (cancelled) return;
      setGoldenTicket(!!full?.golden_ticket_issued);
      setSaved((rows?.length ?? 0) > 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, id]);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-16 text-sm text-muted-foreground sm:px-6">
        Loading listing…
      </div>
    );
  }
  if (!property) throw notFound();

  const perShare = property.listing_price != null ? property.listing_price / 8 : null;
  const retained =
    property.exit_type === "hybrid_exit" ? (property.retained_shares ?? 0) : 0;
  const photos = property.photos;

  async function toggleSave() {
    if (!user || !buyerAccountId) {
      toast("Sign in as a buyer to save this home", {
        description: "Create a buyer account to build your wishlist.",
        action: { label: "Sign in", onClick: () => navigate({ to: "/buyer/login" }) },
      });
      return;
    }
    const wasSaved = saved;
    setSaved(!wasSaved);
    const { error } = wasSaved
      ? await supabase
          .from("wishlist")
          .delete()
          .eq("buyer_account_id", buyerAccountId)
          .eq("property_id", id)
      : await supabase.from("wishlist").insert({ buyer_account_id: buyerAccountId, property_id: id });
    if (error) {
      setSaved(wasSaved);
      toast.error("Couldn't update your saved homes");
      return;
    }
    await logAudit({
      actorId: user.id,
      actorType: "buyer",
      actionType: wasSaved ? "buyer.wishlist_removed" : "buyer.wishlist_added",
      entityType: "wishlist",
      entityId: id,
      metadata: { buyer_account_id: buyerAccountId, property_id: id },
    });
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <Link
        to="/properties"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> All homes
      </Link>

      {/* Gallery */}
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="relative aspect-[16/9] w-full bg-muted">
          {photos.length > 0 ? (
            <img
              src={photos[photoIndex]?.url}
              alt={photos[photoIndex]?.caption ?? `${property.address} — photo ${photoIndex + 1}`}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
              No photos yet
            </div>
          )}

          {photos.length > 1 ? (
            <>
              <GalleryNav
                side="left"
                onClick={() => setPhotoIndex((i) => (i - 1 + photos.length) % photos.length)}
              />
              <GalleryNav
                side="right"
                onClick={() => setPhotoIndex((i) => (i + 1) % photos.length)}
              />
              <span className="absolute bottom-3 right-3 rounded-full bg-background/90 px-3 py-1 text-xs text-foreground shadow-sm backdrop-blur">
                {photoIndex + 1} / {photos.length}
              </span>
            </>
          ) : null}

          <button
            type="button"
            onClick={toggleSave}
            aria-label={saved ? "Remove from saved homes" : "Save this home"}
            className="absolute right-3 top-3 rounded-full bg-background/90 p-2 shadow-sm backdrop-blur transition-colors hover:bg-background"
          >
            <Heart
              className={cn(
                "h-5 w-5",
                saved ? "fill-accent text-accent" : "text-muted-foreground",
              )}
            />
          </button>
        </div>

        {photos.length > 1 ? (
          <div className="flex gap-2 overflow-x-auto border-t border-border p-3">
            {photos.map((p, i) => (
              <button
                key={p.url}
                type="button"
                onClick={() => setPhotoIndex(i)}
                className={cn(
                  "h-16 w-24 shrink-0 overflow-hidden rounded-md border transition-opacity",
                  i === photoIndex ? "border-accent" : "border-border opacity-70 hover:opacity-100",
                )}
              >
                <img src={p.url} alt={p.caption ?? ""} className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {property.usage_tag ? (
              <span className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-foreground">
                {USAGE_LABELS[property.usage_tag] ?? property.usage_tag}
              </span>
            ) : null}
            <span className="rounded-full bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground">
              {property.exit_type === "hybrid_exit" ? "Hybrid Exit" : "Full Exit"}
            </span>
            {property.property_type ? (
              <span className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground">
                {property.property_type}
              </span>
            ) : null}
          </div>

          <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-foreground">
            {property.address}
          </h1>
          <p className="mt-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <MapPin className="h-4 w-4" />
            {property.city}, {property.state} {property.zip}
          </p>

          <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Bedrooms" value={property.bedrooms != null ? String(property.bedrooms) : "—"} />
            <Stat label="Bathrooms" value={property.bathrooms != null ? String(property.bathrooms) : "—"} />
            <Stat
              label="Square feet"
              value={property.square_footage != null ? property.square_footage.toLocaleString() : "—"}
            />
            <Stat label="Whole-home price" value={money(property.listing_price)} />
          </dl>

          {property.description ? (
            <section className="mt-8">
              <h2 className="font-display text-lg font-semibold text-foreground">About this home</h2>
              <p className="mt-2 whitespace-pre-line break-words [overflow-wrap:anywhere] text-sm leading-relaxed text-muted-foreground">
                {property.description}
              </p>
            </section>
          ) : null}

          {knownAmenities(property.amenities).length > 0 ? (
            <section className="mt-8">
              <h2 className="font-display text-lg font-semibold text-foreground">Amenities</h2>
              <ul className="mt-3 flex flex-wrap gap-2">
                {knownAmenities(property.amenities).map((a) => (
                  <li
                    key={a}
                    className="rounded-full border border-border bg-card px-3 py-1 text-xs text-foreground"
                  >
                    {a}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Share tracker */}
          <section className="mt-8 rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="font-display text-lg font-semibold text-foreground">Share availability</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Every divieight home is divided into eight equal 1/8th shares.
            </p>
            <div className="mt-5">
              <EightSlicesTracker
                retainedShares={composition?.retainedShares ?? retained}
                reservedShares={composition?.reservedShares ?? 0}
              />
            </div>
          </section>

          {composition && composition.reservedShares > 0 ? (
            <PodCompositionPanel composition={composition} className="mt-6" />
          ) : null}

          {/* Exit disclosure */}
          <section className="mt-6 rounded-xl border border-accent/40 bg-accent/5 p-6">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
              <div>
                <h2 className="font-display text-base font-semibold text-foreground">
                  Seller exit disclosure
                </h2>
                <p className="mt-1 text-sm text-foreground">
                  {property.exit_type === "hybrid_exit" ? (
                    <>
                      <span className="font-semibold">Hybrid Exit</span> — Seller retaining{" "}
                      {retained} of 8 shares (subject to 12-month Retention Lock).
                    </>
                  ) : (
                    <>
                      <span className="font-semibold">Full Exit</span> — the seller is releasing all
                      eight shares and will not retain ownership.
                    </>
                  )}
                </p>
                {property.exit_type === "hybrid_exit" ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    During the Retention Lock the seller cannot transfer their retained shares, and
                    remains a co-owner alongside incoming buyers.
                  </p>
                ) : null}
              </div>
            </div>
          </section>

          {/* Virtual Data Room */}
          <section className="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
            <div className="flex items-start gap-3">
              {goldenTicket ? (
                <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
              ) : (
                <Lock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <h2 className="font-display text-base font-semibold text-foreground">
                  Virtual Data Room
                </h2>
                {goldenTicket ? (
                  <>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Your Golden Ticket unlocks inspection reports, title documents and rental
                      projections for this home.
                    </p>
                    <Link
                      to="/data-room/$id"
                      params={{ id }}
                      className="mt-4 inline-flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                    >
                      Open the Data Room →
                    </Link>
                  </>
                ) : (
                  <>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Complete your vetting to access inspection reports, title documents, and
                      rental projections.
                    </p>
                    <Link
                      to={user && buyerAccountId ? "/buyer/onboarding" : "/buyer/register"}
                      className="mt-4 inline-flex items-center gap-1 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
                    >
                      {user && buyerAccountId ? "Continue onboarding" : "Start buyer vetting"} →
                    </Link>
                  </>
                )}
              </div>
            </div>
          </section>
        </div>

        {/* Sticky buy rail */}
        <aside className="h-fit lg:sticky lg:top-24">
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Price per 1/8th share
            </p>
            <p className="mt-1 font-display text-3xl font-semibold text-foreground">
              {money(perShare)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {money(property.listing_price)} whole-home value
            </p>

            <div className="mt-5">
              <EightSlicesTracker
                compact
                retainedShares={composition?.retainedShares ?? retained}
                reservedShares={composition?.reservedShares ?? 0}
              />
            </div>

            <Link
              to="/reserve/$id"
              params={{ id }}
              className="mt-6 flex w-full items-center justify-center rounded-md bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90"
            >
              Secure My Priority Rank
            </Link>
            <button
              type="button"
              onClick={toggleSave}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted"
            >
              <Heart className={cn("h-4 w-4", saved ? "fill-accent text-accent" : "")} />
              {saved ? "Saved" : "Save this home"}
            </button>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Reserving a rank does not purchase a share. Priority is assigned in the order buyers
              complete enrollment.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function GalleryNav({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous photo" : "Next photo"}
      className={cn(
        "absolute top-1/2 -translate-y-1/2 rounded-full bg-background/90 p-2 shadow-sm backdrop-blur transition-colors hover:bg-background",
        side === "left" ? "left-3" : "left-auto right-3",
      )}
    >
      <Icon className="h-5 w-5 text-foreground" />
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-foreground">{value}</dd>
    </div>
  );
}
