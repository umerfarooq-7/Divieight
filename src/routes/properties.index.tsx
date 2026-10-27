import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Heart, LayoutGrid, Map as MapIcon, Search, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { EightSlicesTracker } from "@/components/EightSlicesTracker";
import { PropertyMap, type MapPin } from "@/components/PropertyMap";
import { getMarketplaceProperties, type MarketplaceProperty } from "@/lib/marketplace.functions";
import { DEFAULT_AMENITIES } from "@/lib/amenities";
import { geocodePlaces } from "@/lib/geocode";
import { getBuyerAccount } from "@/lib/buyer";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/audit";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/properties/")({
  head: () => ({
    meta: [
      { title: "Browse Fractional Homes — divieight Marketplace" },
      {
        name: "description",
        content:
          "Explore vetted second homes offered in eight equal 1/8th shares. Filter by price, location, bedrooms, usage and amenities — map or grid view, no login required.",
      },
      { property: "og:title", content: "Browse Fractional Homes — divieight Marketplace" },
      {
        property: "og:description",
        content:
          "Open discovery of fractional co-ownership homes. Compare price per 1/8th share, share availability, and amenities.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MarketplacePage,
  errorComponent: ({ error }) => (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
      <h1 className="font-display text-2xl font-semibold text-foreground">
        Couldn't load the marketplace
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p>
    </div>
  ),
  notFoundComponent: () => (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
      <h1 className="font-display text-2xl font-semibold text-foreground">No properties yet</h1>
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

/**
 * Compatibility filter: aligning intended use (Personal Use vs. Short-Term
 * Rental). A Personal Use buyer conflicts with a short-term-rental-only home,
 * and an income-focused buyer conflicts with an owner-occupied-only home.
 */
function isIncompatible(intent: string | null, usageTag: string | null): boolean {
  if (!intent || !usageTag) return false;
  if (intent === "long_term") return usageTag === "short_term_rental";
  if (intent === "short_term_rental") return usageTag === "owner_occupied";
  return false;
}

function MarketplacePage() {
  const fetchProperties = useServerFn(getMarketplaceProperties);
  const { data: properties = [], isLoading } = useQuery({
    queryKey: ["marketplace-properties"],
    queryFn: () => fetchProperties(),
  });

  const { user } = useAuth();
  const [buyerAccountId, setBuyerAccountId] = useState<string | null>(null);
  const [buyerIntent, setBuyerIntent] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  const [view, setView] = useState<"grid" | "map">("grid");
  const [q, setQ] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [beds, setBeds] = useState("any");
  const [baths, setBaths] = useState("any");
  const [usage, setUsage] = useState("any");
  const [amenities, setAmenities] = useState<string[]>([]);
  const [coords, setCoords] = useState<Record<string, { lat: number; lng: number }>>({});

  // Buyer context: intent (for the compatibility filter) + saved properties.
  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setBuyerAccountId(null);
      setBuyerIntent(null);
      setSaved(new Set());
      return;
    }
    (async () => {
      const account = await getBuyerAccount(user.id);
      if (cancelled || !account) return;
      setBuyerAccountId(account.id);

      const { data: full } = await supabase
        .from("buyer_accounts")
        .select("intent")
        .eq("id", account.id)
        .maybeSingle();
      if (!cancelled) setBuyerIntent(full?.intent ?? null);

      const { data: rows } = await supabase
        .from("wishlist")
        .select("property_id")
        .eq("buyer_account_id", account.id);
      if (!cancelled) setSaved(new Set((rows ?? []).map((r) => r.property_id)));
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const min = Number(minPrice) || 0;
    const max = Number(maxPrice) || Infinity;
    return properties.filter((p) => {
      const perShare = p.listing_price != null ? p.listing_price / 8 : null;
      if (term && !`${p.city} ${p.state} ${p.zip} ${p.address}`.toLowerCase().includes(term))
        return false;
      if (perShare != null && (perShare < min || perShare > max)) return false;
      if (perShare == null && (minPrice || maxPrice)) return false;
      if (beds !== "any" && (p.bedrooms ?? 0) < Number(beds)) return false;
      if (baths !== "any" && (p.bathrooms ?? 0) < Number(baths)) return false;
      if (usage !== "any" && p.usage_tag !== usage) return false;
      if (amenities.length > 0 && !amenities.every((a) => p.amenities.includes(a))) return false;
      return true;
    });
  }, [properties, q, minPrice, maxPrice, beds, baths, usage, amenities]);

  // Geocode the visible city/state pairs once the map view is opened.
  useEffect(() => {
    if (view !== "map" || filtered.length === 0) return;
    let cancelled = false;
    const places = filtered.map((p) => `${p.city}, ${p.state} ${p.zip}`);
    geocodePlaces(places, (place, c) => {
      // Stream pins onto the map as each place resolves.
      if (!cancelled) setCoords((prev) => (prev[place] ? prev : { ...prev, [place]: c }));
    });
    return () => {
      cancelled = true;
    };
  }, [view, filtered]);

  const pins: MapPin[] = useMemo(() => {
    const out: MapPin[] = [];
    filtered.forEach((p) => {
      const c = coords[`${p.city}, ${p.state} ${p.zip}`];
      if (!c) return;
      out.push({
        id: p.id,
        lat: c.lat,
        lng: c.lng,
        title: `${p.city}, ${p.state}`,
        subtitle: p.listing_price != null ? `${money(p.listing_price / 8)} per 1/8th share` : "—",
        dimmed: isIncompatible(buyerIntent, p.usage_tag),
      });
    });
    return out;
  }, [filtered, coords, buyerIntent]);

  async function toggleSave(propertyId: string) {
    if (!user || !buyerAccountId) {
      toast("Sign in as a buyer to save homes", {
        description: "Create a buyer account to build your wishlist.",
        action: { label: "Sign in", onClick: () => window.location.assign("/buyer/login") },
      });
      return;
    }
    const isSaved = saved.has(propertyId);
    setSaved((prev) => {
      const next = new Set(prev);
      if (isSaved) next.delete(propertyId);
      else next.add(propertyId);
      return next;
    });

    const { error } = isSaved
      ? await supabase
          .from("wishlist")
          .delete()
          .eq("buyer_account_id", buyerAccountId)
          .eq("property_id", propertyId)
      : await supabase
          .from("wishlist")
          .insert({ buyer_account_id: buyerAccountId, property_id: propertyId });

    if (error) {
      toast.error("Couldn't update your saved homes");
      setSaved((prev) => {
        const next = new Set(prev);
        if (isSaved) next.add(propertyId);
        else next.delete(propertyId);
        return next;
      });
      return;
    }

    await logAudit({
      actorId: user.id,
      actorType: "buyer",
      actionType: isSaved ? "buyer.wishlist_removed" : "buyer.wishlist_added",
      entityType: "wishlist",
      entityId: propertyId,
      metadata: { buyer_account_id: buyerAccountId, property_id: propertyId },
    });
  }

  function toggleAmenity(a: string) {
    setAmenities((prev) => (prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]));
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Browse fractional homes
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Open discovery — every live divieight listing, sold in eight equal 1/8th shares. No
            account needed to look around.
          </p>
        </div>
        <div className="inline-flex rounded-full border border-border bg-card p-1">
          <button
            type="button"
            onClick={() => setView("grid")}
            className={cn(
              "inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
              view === "grid" ? "bg-primary text-primary-foreground" : "text-muted-foreground",
            )}
          >
            <LayoutGrid className="h-4 w-4" /> Grid
          </button>
          <button
            type="button"
            onClick={() => setView("map")}
            className={cn(
              "inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
              view === "map" ? "bg-primary text-primary-foreground" : "text-muted-foreground",
            )}
          >
            <MapIcon className="h-4 w-4" /> Map
          </button>
        </div>
      </header>

      <div className="mt-8 grid gap-8 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="h-fit rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <SlidersHorizontal className="h-4 w-4 text-accent" /> Filters
          </div>

          <div className="mt-5 space-y-5">
            <div>
              <label className="text-xs font-medium text-muted-foreground">City or ZIP</label>
              <div className="relative mt-1.5">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Aspen, 81611…"
                  className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Price per 1/8th share
              </label>
              <div className="mt-1.5 flex gap-2">
                <input
                  inputMode="numeric"
                  value={minPrice}
                  onChange={(e) => setMinPrice(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="Min"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <input
                  inputMode="numeric"
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="Max"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Beds</label>
                <select
                  value={beds}
                  onChange={(e) => setBeds(e.target.value)}
                  className="mt-1.5 h-10 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="any">Any</option>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}+
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Baths</label>
                <select
                  value={baths}
                  onChange={(e) => setBaths(e.target.value)}
                  className="mt-1.5 h-10 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="any">Any</option>
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n}+
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground">Usage</label>
              <select
                value={usage}
                onChange={(e) => setUsage(e.target.value)}
                className="mt-1.5 h-10 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="any">Any usage</option>
                <option value="owner_occupied">Owner-Occupied</option>
                <option value="short_term_rental">Short-Term Rental</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground">Amenities</label>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {DEFAULT_AMENITIES.map((a) => {
                  const on = amenities.includes(a);
                  return (
                    <button
                      key={a}
                      type="button"
                      onClick={() => toggleAmenity(a)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs transition-colors",
                        on
                          ? "border-accent bg-accent/10 text-foreground"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {a}
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                setQ("");
                setMinPrice("");
                setMaxPrice("");
                setBeds("any");
                setBaths("any");
                setUsage("any");
                setAmenities([]);
              }}
              className="text-xs text-accent underline-offset-4 hover:underline"
            >
              Reset filters
            </button>
          </div>
        </aside>

        <section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {isLoading ? "Loading homes…" : `${filtered.length} home${filtered.length === 1 ? "" : "s"} available`}
            </p>
            {buyerIntent ? (
              <p className="text-xs text-muted-foreground">
                Compatibility filter on — aligning intended use (Personal Use vs. Short-Term
                Rental); homes that conflict with your stated intent are dimmed.
              </p>
            ) : null}
          </div>

          {view === "map" ? (
            <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <PropertyMap pins={pins} className="h-[380px] w-full sm:h-[480px] lg:h-[560px]" />
              {pins.length === 0 ? (
                <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
                  Placing homes on the map…
                </p>
              ) : null}
            </div>
          ) : (
            <div className="mt-4 grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
              {!isLoading && filtered.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No homes match these filters yet. Try widening your search.
                </p>
              ) : null}
              {filtered.map((p) => (
                <PropertyCard
                  key={p.id}
                  property={p}
                  saved={saved.has(p.id)}
                  onSave={() => toggleSave(p.id)}
                  incompatible={isIncompatible(buyerIntent, p.usage_tag)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function PropertyCard({
  property: p,
  saved,
  onSave,
  incompatible,
}: {
  property: MarketplaceProperty;
  saved: boolean;
  onSave: () => void;
  incompatible: boolean;
}) {
  const perShare = p.listing_price != null ? p.listing_price / 8 : null;
  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md",
        incompatible && "opacity-60 grayscale",
      )}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
        {p.photo ? (
          <img
            src={p.photo}
            alt={`${p.address}, ${p.city}, ${p.state}`}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            Photo coming soon
          </div>
        )}
        <button
          type="button"
          onClick={onSave}
          aria-label={saved ? "Remove from saved homes" : "Save this home"}
          aria-pressed={saved}
          className="absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-full bg-background/90 shadow-sm backdrop-blur transition-transform hover:scale-105"
        >
          <Heart
            className={cn("h-4 w-4", saved ? "fill-accent text-accent" : "text-muted-foreground")}
          />
        </button>
        <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
          {p.usage_tag ? (
            <span className="rounded-full bg-background/90 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-sm backdrop-blur">
              {USAGE_LABELS[p.usage_tag] ?? p.usage_tag}
            </span>
          ) : null}
          <span className="rounded-full bg-primary/90 px-2.5 py-1 text-[11px] font-medium text-primary-foreground shadow-sm backdrop-blur">
            {p.exit_type === "hybrid_exit" ? "Hybrid Exit" : "Full Exit"}
          </span>
        </div>
      </div>

      <div className="p-5">
        <h2 className="font-display text-base font-semibold text-foreground">{p.address}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {p.city}, {p.state} {p.zip}
        </p>

        <p className="mt-3 text-lg font-semibold text-foreground">
          {money(perShare)}
          <span className="ml-1 text-xs font-normal text-muted-foreground">per 1/8th share</span>
        </p>
        <p className="text-xs text-muted-foreground">
          {[
            p.bedrooms != null ? `${p.bedrooms} bd` : null,
            p.bathrooms != null ? `${p.bathrooms} ba` : null,
            p.square_footage != null ? `${p.square_footage.toLocaleString()} sqft` : null,
          ]
            .filter(Boolean)
            .join(" · ") || "Details coming soon"}
        </p>

        <div className="mt-4">
          <EightSlicesTracker
            compact
            retainedShares={p.exit_type === "hybrid_exit" ? (p.retained_shares ?? 0) : 0}
            reservedShares={p.reserved_shares}
          />
        </div>

        {incompatible ? (
          <p className="mt-3 rounded-md bg-muted px-3 py-2 text-[11px] text-muted-foreground">
            {p.usage_tag === "short_term_rental"
              ? "Short-Term Rental Only / No Personal Use"
              : "Doesn't match your stated ownership intent."}
          </p>
        ) : null}

        <Link
          to="/properties/$id"
          params={{ id: p.id }}
          className="mt-4 inline-block text-sm font-medium text-accent underline-offset-4 hover:underline"
        >
          View details →
        </Link>
      </div>
    </article>
  );
}
