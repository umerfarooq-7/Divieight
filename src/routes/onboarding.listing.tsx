import { useEffect, useMemo, useState } from "react";
import { ListingLockGuard } from "@/components/ListingLockGuard";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { OnboardingStepper } from "@/components/OnboardingStepper";
import { Field } from "@/components/Field";
import { CurrencyInput } from "@/components/CurrencyInput";
import { EightSlicesTracker } from "@/components/EightSlicesTracker";
import { markListingStep } from "@/lib/listing-progress";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/onboarding/listing")({
  // Optional ?property=<id> lets a seller re-enter this step for a specific
  // existing listing (edit path) instead of always resuming the newest draft.
  validateSearch: (search: Record<string, unknown>) => ({
    property: typeof search.property === "string" ? search.property : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Create your listing — divieight" },
      { name: "description", content: "Set price, details, and amenities for your fractional listing." },
    ],
  }),
  component: ListingScreenGuarded,
});

const PROPERTY_TYPES = ["Single Family", "Condo", "Townhome", "Villa", "Other"] as const;
const USAGE_TAGS = [
  { value: "owner_occupied", label: "Owner-Occupied / Lifestyle" },
  { value: "short_term_rental", label: "Short-Term Rental" },
] as const;
const DEFAULT_AMENITIES = [
  "Pool",
  "Home Office",
  "Pet-Friendly",
  "Waterfront",
  "Mountain View",
  "Gated Community",
  "Hot Tub",
  "Garage",
  "Fireplace",
  "Air Conditioning",
] as const;

type UsageTag = (typeof USAGE_TAGS)[number]["value"];

type Errors = Partial<Record<
  "property_type" | "listing_price" | "usage_tag" | "bedrooms" | "bathrooms" | "square_footage" | "description",
  string
>>;

function currency(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function ListingScreenGuarded() {
  const { property: propertyId } = Route.useSearch();
  return (
    <ListingLockGuard propertyId={propertyId}>
      <ListingScreen />
    </ListingLockGuard>
  );
}

function ListingScreen() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const { property: propertyParam } = Route.useSearch();

  const [propertyType, setPropertyType] = useState<string>("");
  const [priceStr, setPriceStr] = useState<string>("");
  const [usageTag, setUsageTag] = useState<UsageTag | "">("");
  const [bedrooms, setBedrooms] = useState<string>("");
  const [bathrooms, setBathrooms] = useState<string>("");
  const [sqft, setSqft] = useState<string>("");
  const [description, setDescription] = useState<string>("");

  const [selectedAmenities, setSelectedAmenities] = useState<string[]>([]);
  const [customAmenity, setCustomAmenity] = useState<string>("");

  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const [retainedShares, setRetainedShares] = useState<number>(0);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("sellers")
      .select("exit_type, retained_shares")
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.exit_type === "hybrid_exit" && typeof data.retained_shares === "number") {
          setRetainedShares(data.retained_shares);
        } else {
          setRetainedShares(0);
        }
      });
  }, [user]);

  // Prefill from the seller's most recent property so a saved draft can be
  // reopened and edited instead of starting over.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      let query = supabase
        .from("properties")
        .select(
          "property_type, listing_price, usage_tag, bedrooms, bathrooms, square_footage, description, amenities",
        )
        .eq("seller_id", user.id);
      query = propertyParam
        ? query.eq("id", propertyParam)
        : query.order("created_at", { ascending: false }).limit(1);
      const { data } = await query.maybeSingle();
      if (cancelled || !data) return;
      if (data.property_type) setPropertyType(data.property_type);
      if (data.listing_price != null) setPriceStr(String(data.listing_price));
      if (data.usage_tag) setUsageTag(data.usage_tag as UsageTag);
      if (data.bedrooms != null) setBedrooms(String(data.bedrooms));
      if (data.bathrooms != null) setBathrooms(String(data.bathrooms));
      if (data.square_footage != null) setSqft(String(data.square_footage));
      if (data.description) setDescription(data.description);
      if (Array.isArray(data.amenities)) setSelectedAmenities(data.amenities as string[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, propertyParam]);



  const listingPrice = useMemo(() => Number(priceStr.replace(/[^0-9.]/g, "")) || 0, [priceStr]);
  const sharePrice = listingPrice > 0 ? listingPrice / 8 : 0;

  function toggleAmenity(tag: string) {
    setSelectedAmenities((s) =>
      s.includes(tag) ? s.filter((t) => t !== tag) : [...s, tag],
    );
  }

  function addCustomAmenity() {
    const t = customAmenity.trim();
    if (!t) return;
    if (!selectedAmenities.includes(t)) {
      setSelectedAmenities((s) => [...s, t]);
    }
    setCustomAmenity("");
  }

  function validate(): boolean {
    const next: Errors = {};
    if (!propertyType) next.property_type = "Select a property type.";
    if (!(listingPrice > 0)) next.listing_price = "Enter a valid listing price.";
    if (!usageTag) next.usage_tag = "Choose how this property will be used.";
    if (!bedrooms || Number(bedrooms) < 0) next.bedrooms = "Enter bedrooms.";
    if (!bathrooms || Number(bathrooms) < 0) next.bathrooms = "Enter bathrooms.";
    if (!sqft || Number(sqft) <= 0) next.square_footage = "Enter square footage.";
    if (description.trim().length < 50) {
      next.description = `Description must be at least 50 characters (${description.trim().length}/50).`;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit() {
    if (!user) {
      toast.error("You need to be signed in.");
      navigate({ to: "/login" });
      return;
    }
    if (!validate()) return;

    setSubmitting(true);

    // Find the most recent draft property for this seller (created in the previous step).
    let findQuery = supabase.from("properties").select("id").eq("seller_id", user.id);
    findQuery = propertyParam
      ? findQuery.eq("id", propertyParam)
      : findQuery.order("created_at", { ascending: false }).limit(1);
    const { data: property, error: findErr } = await findQuery.maybeSingle();

    if (findErr || !property) {
      setSubmitting(false);
      toast.error("Couldn't find your property. Please complete the previous step first.");
      return;
    }

    const { error: updateErr } = await supabase
      .from("properties")
      .update({
        property_type: propertyType,
        listing_price: listingPrice,
        usage_tag: usageTag,
        bedrooms: Number(bedrooms),
        bathrooms: Number(bathrooms),
        square_footage: Number(sqft),
        description: description.trim(),
        amenities: selectedAmenities,
        ...(propertyParam ? {} : { status: "draft" }),
      })
      .eq("id", property.id);

    if (!updateErr) await markListingStep(property.id, "listing_creation");

    if (updateErr) {
      setSubmitting(false);
      toast.error(updateErr.message);
      return;
    }

    // Advance the seller's onboarding pointer so mid-flow returns land here.
    // Editing an existing listing must not rewind the seller's onboarding state.
    if (!propertyParam) {
      await supabase
        .from("sellers")
        .update({ onboarding_status: "media_pending" })
        .eq("id", user.id);
    }

    setSubmitting(false);
    toast.success("Listing details saved.");
    navigate({ to: "/onboarding/media", search: { property: property.id } });
  }

  const previewTitle = propertyType
    ? `${propertyType} · ${bedrooms || "?"}bd / ${bathrooms || "?"}ba`
    : "Your listing preview";

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <OnboardingStepper current={4} />

      <div className="mt-10 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
          Step 4 · Listing details
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Create your listing
        </h1>
        <p className="mt-3 text-base text-muted-foreground">
          Tell buyers what makes this property special. You can edit this later.
        </p>
      </div>

      <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Form column */}
        <div className="space-y-8">
          {/* Basics */}
          <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="font-display text-lg font-semibold text-foreground">Basics</h2>

            <div className="mt-5 space-y-1.5">
              <label htmlFor="property_type" className="text-sm font-medium text-foreground">
                Property type
              </label>
              <select
                id="property_type"
                value={propertyType}
                onChange={(e) => setPropertyType(e.target.value)}
                className={cn(
                  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
                  errors.property_type && "border-destructive focus:ring-destructive",
                )}
              >
                <option value="">Select…</option>
                {PROPERTY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {errors.property_type ? (
                <p className="text-xs text-destructive">{errors.property_type}</p>
              ) : null}
            </div>

            <div className="mt-5">
              <CurrencyInput
                label="Listing price (total property, USD)"
                name="listing_price"
                value={priceStr.replace(/[^0-9]/g, "")}
                onValueChange={setPriceStr}
                error={errors.listing_price}
                hint={
                  listingPrice > 0
                    ? `Price per 1/8th share: ${currency(sharePrice)}`
                    : "We'll auto-calculate the price per 1/8th share."
                }
                placeholder="1,200,000"
              />
            </div>

            <div className="mt-6">
              <p className="text-sm font-medium text-foreground">Intended usage</p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {USAGE_TAGS.map((u) => (
                  <button
                    key={u.value}
                    type="button"
                    onClick={() => setUsageTag(u.value)}
                    className={cn(
                      "rounded-md border px-4 py-3 text-left text-sm transition-colors",
                      usageTag === u.value
                        ? "border-accent bg-accent/10 text-foreground"
                        : "border-border bg-background text-foreground hover:bg-muted",
                    )}
                  >
                    <span className="block font-medium">{u.label}</span>
                  </button>
                ))}
              </div>
              {errors.usage_tag ? (
                <p className="mt-2 text-xs text-destructive">{errors.usage_tag}</p>
              ) : null}
            </div>
          </section>

          {/* Details */}
          <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="font-display text-lg font-semibold text-foreground">Details</h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <Field
                label="Bedrooms"
                name="bedrooms"
                type="number"
                min={0}
                value={bedrooms}
                onChange={(e) => setBedrooms(e.target.value)}
                error={errors.bedrooms}
              />
              <Field
                label="Bathrooms"
                name="bathrooms"
                type="number"
                min={0}
                step="0.5"
                value={bathrooms}
                onChange={(e) => setBathrooms(e.target.value)}
                error={errors.bathrooms}
              />
              <Field
                label="Square footage"
                name="square_footage"
                type="number"
                min={0}
                value={sqft}
                onChange={(e) => setSqft(e.target.value)}
                error={errors.square_footage}
              />
            </div>
          </section>

          {/* Description */}
          <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="font-display text-lg font-semibold text-foreground">Description</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Minimum 50 characters. Describe the location, layout, and what makes it special.
            </p>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={7}
              className={cn(
                "mt-4 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
                errors.description && "border-destructive focus:ring-destructive",
              )}
              placeholder="A sunlit 3-bedroom in the hills with sweeping ocean views…"
            />
            <div className="mt-1.5 flex items-center justify-between text-xs">
              <span className={cn("text-muted-foreground", errors.description && "text-destructive")}>
                {errors.description ?? `${description.trim().length} characters`}
              </span>
            </div>
          </section>

          {/* Amenities */}
          <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="font-display text-lg font-semibold text-foreground">Amenities</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Tap to toggle. Add your own if you don't see it.
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              {Array.from(new Set([...DEFAULT_AMENITIES, ...selectedAmenities])).map((tag) => {
                const active = selectedAmenities.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleAmenity(tag)}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                      active
                        ? "border-accent bg-accent text-accent-foreground"
                        : "border-border bg-background text-foreground hover:bg-muted",
                    )}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>

            <div className="mt-4 flex gap-2">
              <input
                value={customAmenity}
                onChange={(e) => setCustomAmenity(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomAmenity();
                  }
                }}
                placeholder="Add a custom amenity"
                className="flex h-10 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
              />
              <button
                type="button"
                onClick={addCustomAmenity}
                className="inline-flex h-10 items-center rounded-md border border-border bg-background px-4 text-sm font-medium hover:bg-muted"
              >
                Add
              </button>
            </div>
          </section>

          <div className="flex justify-center">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || loading}
              className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Saving..." : "Save and continue"}
            </button>
          </div>
        </div>

        {/* Live preview column */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Marketplace preview
          </p>
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <div className="flex aspect-[4/3] items-center justify-center bg-gradient-to-br from-primary/10 via-muted to-accent/10 text-xs text-muted-foreground">
              Photos added in the next step
            </div>
            <div className="p-5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="rounded-full bg-accent/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-accent">
                  1/8 Share
                </span>
                {usageTag ? (
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {USAGE_TAGS.find((u) => u.value === usageTag)?.label}
                  </span>
                ) : null}
              </div>
              <div className="mt-3">
                <p className="font-display text-2xl font-semibold text-foreground">
                  {currency(sharePrice)}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">/ share</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Total property {currency(listingPrice)}
                </p>
              </div>
              <h3 className="mt-4 font-display text-base font-semibold text-foreground">
                {previewTitle}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {sqft ? `${Number(sqft).toLocaleString()} sqft` : "Square footage —"}
              </p>
              {description.trim() ? (
                <p className="mt-3 line-clamp-3 text-sm text-foreground/80">
                  {description.trim()}
                </p>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground/70">
                  Your description will appear here.
                </p>
              )}
              <div className="mt-5 border-t border-border pt-4">
                <EightSlicesTracker retainedShares={retainedShares} reservedShares={0} compact />
              </div>
              {selectedAmenities.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {selectedAmenities.slice(0, 6).map((a) => (
                    <span
                      key={a}
                      className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-foreground"
                    >
                      {a}
                    </span>
                  ))}
                  {selectedAmenities.length > 6 ? (
                    <span className="text-[10px] text-muted-foreground">
                      +{selectedAmenities.length - 6} more
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
