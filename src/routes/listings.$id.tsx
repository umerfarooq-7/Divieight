import { useEffect, useState } from "react";
import { isListingLocked } from "@/lib/listing-lock";
import { createFileRoute, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { ListingAgentTagger } from "@/components/ListingAgentTagger";
import { EightSlicesTracker } from "@/components/EightSlicesTracker";
import { useAuth } from "@/hooks/use-auth";
import { SellerDataRoom } from "@/components/SellerDataRoom";
import { DiligenceUploader } from "@/components/DiligenceUploader";
import {
  ListingStatusTimeline,
  type ListingStatus,
} from "@/components/ListingStatusTimeline";

export const Route = createFileRoute("/listings/$id")({
  head: () => ({
    meta: [
      { title: "Listing detail — divieight" },
      { name: "description", content: "Manage a fractional property listing." },
    ],
  }),
  component: ListingDetail,
  errorComponent: ({ error }) => (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
      <h1 className="font-display text-2xl font-semibold text-foreground">
        Something went wrong
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
      <Link
        to="/dashboard"
        className="mt-4 inline-block text-sm text-accent underline-offset-4 hover:underline"
      >
        ← Back to dashboard
      </Link>
    </div>
  ),
  notFoundComponent: () => (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
      <h1 className="font-display text-2xl font-semibold text-foreground">
        Listing not found
      </h1>
      <Link
        to="/dashboard"
        className="mt-4 inline-block text-sm text-accent underline-offset-4 hover:underline"
      >
        ← Back to dashboard
      </Link>
    </div>
  ),
});

type Property = {
  id: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  status: string;
  listing_status: ListingStatus;
  listing_price: number | null;
  property_type: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  square_footage: number | null;
  description: string | null;
};

type Photo = { url: string; caption: string | null };

function ListingDetail() {
  const { id } = Route.useParams();
  const { user } = useAuth();
  const [tab, setTab] = useState<"overview" | "data-room">("overview");
  const [property, setProperty] = useState<Property | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("properties")
        .select(
          "id, address, city, state, zip, status, listing_status, listing_price, property_type, bedrooms, bathrooms, square_footage, description",
        )
        .eq("id", id)
        .maybeSingle();
      if (cancelled) return;
      if (!data) setNotFound(true);
      setProperty((data as Property) ?? null);
      setLoading(false);

      if (data) {
        const { data: media } = await supabase
          .from("property_media")
          .select("url, caption, display_order")
          .eq("property_id", id)
          .eq("media_type", "photo")
          .order("display_order", { ascending: true });
        const rows = (media ?? []).filter((m) => !!m.url) as {
          url: string;
          caption: string | null;
        }[];
        if (rows.length > 0) {
          const { data: signed } = await supabase.storage
            .from("property-media")
            .createSignedUrls(
              rows.map((r) => r.url),
              60 * 60,
            );
          const byPath = new Map<string, string>();
          (signed ?? []).forEach((s) => {
            if (s.path && s.signedUrl) byPath.set(s.path, s.signedUrl);
          });
          if (cancelled) return;
          setPhotos(
            rows
              .map((r) => ({ url: byPath.get(r.url) ?? "", caption: r.caption }))
              .filter((p) => !!p.url),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);


  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6 lg:px-8">
        <p className="text-sm text-muted-foreground">Loading listing…</p>
      </div>
    );
  }

  if (notFound || !property) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6 lg:px-8">
        <h1 className="font-display text-2xl font-semibold text-foreground">
          Listing not found
        </h1>
        <Link
          to="/dashboard"
          className="mt-4 inline-block text-sm text-accent underline-offset-4 hover:underline"
        >
          ← Back to dashboard
        </Link>
      </div>
    );
  }

  const perShare = property.listing_price ? property.listing_price / 8 : null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
      <Link
        to="/dashboard"
        className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
      >
        ← Dashboard
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            Listing
          </p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground">
            {property.address}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {property.city}, {property.state} {property.zip}
            {property.property_type ? ` · ${property.property_type}` : ""}
          </p>
        </div>
        <span className="rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-medium capitalize text-foreground">
          {property.status.replace(/_/g, " ")}
        </span>
      </div>

      <div className="mt-6 flex gap-1 border-b border-border">
        {(["overview", "data-room"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={
              "-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition " +
              (tab === t
                ? "border-accent text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground")
            }
          >
            {t === "overview" ? "Overview" : "Virtual Data Room"}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <>
      {photos.length > 0 ? (
        <section className="mt-8">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {photos.map((p, i) => (
              <figure
                key={i}
                className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
              >
                <img
                  src={p.url}
                  alt={p.caption || `${property.address} photo ${i + 1}`}
                  loading="lazy"
                  className={
                    i === 0
                      ? "h-64 w-full object-cover sm:h-72"
                      : "h-48 w-full object-cover"
                  }
                />
                {p.caption ? (
                  <figcaption className="px-3 py-2 text-xs text-muted-foreground">
                    {p.caption}
                  </figcaption>
                ) : null}
              </figure>
            ))}
          </div>
        </section>
      ) : null}



      <section className="mt-8">
        <ListingAgentTagger propertyId={property.id} />
      </section>

      <section className="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Property Status
        </h2>
        <div className="mt-4">
          <ListingStatusTimeline status={property.listing_status ?? "forming"} />
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Share Availability
        </h2>
        <div className="mt-4">
          <EightSlicesTracker propertyId={property.id} />
        </div>
      </section>

      <section className="mt-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Listing price" value={fmt(property.listing_price)} />
        <Stat label="Per 1/8th share" value={fmt(perShare)} />
        <Stat
          label="Beds · Baths · Sqft"
          value={`${property.bedrooms ?? "—"} · ${property.bathrooms ?? "—"} · ${
            property.square_footage?.toLocaleString() ?? "—"
          }`}
        />
      </section>

      {property.description ? (
        <section className="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Description
          </h2>
          <p className="mt-3 whitespace-pre-line break-words [overflow-wrap:anywhere] text-sm leading-relaxed text-foreground">
            {property.description}
          </p>
        </section>
      ) : null}
        </>
      ) : user ? (
        <>
          <SellerDataRoom propertyId={property.id} sellerId={user.id} locked={isListingLocked(property.listing_status)} />
          <section className="mt-10">
            <DiligenceUploader propertyId={property.id} mode="seller" />
          </section>
        </>
      ) : null}
    </div>

  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 font-display text-xl font-semibold text-foreground">
        {value}
      </p>
    </div>
  );
}

function fmt(n: number | null): string {
  if (n == null) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}
