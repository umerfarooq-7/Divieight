import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { BuyerOnboardingStepper } from "@/components/BuyerOnboardingStepper";
import { DEFAULT_AMENITIES } from "@/lib/amenities";
import { cn } from "@/lib/utils";
import { logAudit } from "@/lib/audit";

export const Route = createFileRoute("/buyer/onboarding/lifestyle")({
  head: () => ({
    meta: [
      { title: "Lifestyle survey — divieight" },
      {
        name: "description",
        content: "Tell us where you want to own and which amenities are non-negotiable.",
      },
      { property: "og:title", content: "Lifestyle survey — divieight" },
      {
        property: "og:description",
        content: "Tell us where you want to own and which amenities are non-negotiable.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LifestyleScreen,
});

type TargetLocation = { zip: string; area: string };

function LifestyleScreen() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  const [accountId, setAccountId] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [locations, setLocations] = useState<TargetLocation[]>([{ zip: "", area: "" }]);
  // May hold values from when free-text amenities were allowed: they stay stored but aren't shown.
  const [amenities, setAmenities] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/buyer/login" });
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: account } = await supabase
        .from("buyer_accounts")
        .select("id, target_zip_codes, non_negotiable_amenities")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (!account) {
        navigate({ to: "/buyer/register" });
        return;
      }
      setAccountId(account.id);
      const saved = account.target_zip_codes;
      if (Array.isArray(saved) && saved.length > 0) {
        setLocations(
          (saved as Array<Record<string, unknown>>).map((l) => ({
            zip: String(l?.zip ?? ""),
            area: String(l?.area ?? ""),
          })),
        );
      }
      if (Array.isArray(account.non_negotiable_amenities)) {
        setAmenities(account.non_negotiable_amenities as string[]);
      }
      setBootstrapping(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, loading, navigate]);

  function updateLocation(index: number, patch: Partial<TargetLocation>) {
    setLocations((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLocation() {
    setLocations((prev) => [...prev, { zip: "", area: "" }]);
  }

  function removeLocation(index: number) {
    setLocations((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function toggleAmenity(tag: string) {
    setAmenities((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  function cleanedLocations() {
    return locations
      .map((l) => ({ zip: l.zip.trim(), area: l.area.trim() }))
      .filter((l) => l.zip.length > 0);
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    const cleaned = cleanedLocations();
    if (cleaned.length === 0) next.locations = "Add at least one target zip code.";
    else if (cleaned.some((l) => !/^\d{5}$/.test(l.zip)))
      next.locations = "Zip codes must be 5 digits.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit() {
    if (!user || !accountId) return;
    if (!validate()) return;

    const cleaned = cleanedLocations();
    setSubmitting(true);
    const { error } = await supabase
      .from("buyer_accounts")
      .update({
        target_zip_codes: cleaned,
        non_negotiable_amenities: amenities,
        // The first zip entered is treated as the buyer's primary market.
        // Month 3 uses `primary_target_market` for Resident Agent matching.
        primary_target_market: cleaned[0].zip,
        last_activity_at: new Date().toISOString(),
        stall_warning_sent_at: null,
        onboarding_status: "payment_pending",
      })
      .eq("id", accountId);

    setSubmitting(false);
    if (error) {
      toast.error(error.message);
      return;
    }

    await logAudit({
      actorId: user.id,
      actorType: "buyer",
      actionType: "buyer.lifestyle_submitted",
      entityType: "buyer_account",
      entityId: accountId,
      metadata: { zip_count: cleaned.length, amenity_count: amenities.length },
    });

    navigate({ to: "/buyer/onboarding/payment" });
  }

  if (loading || bootstrapping) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
        Loading your buyer account…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <BuyerOnboardingStepper current={2} />

      <div className="mt-10 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
          Step 2 · Lifestyle
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Lifestyle survey
        </h1>
        <p className="mt-3 text-base text-muted-foreground">
          Tell us where you want to own and what you can't live without.
        </p>
        <p
          className="mt-3 inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground"
          title="This helps us match you to compatible properties and pools"
        >
          <span aria-hidden className="text-accent">
            ⓘ
          </span>
          This helps us match you to compatible properties and pools
        </p>
      </div>

      {/* Target locations */}
      <section className="mt-10 rounded-xl border border-border bg-card p-6 shadow-sm">
        <h2 className="font-display text-lg font-semibold text-foreground">Target locations</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Add every zip code you'd consider. The first one becomes your primary market.
        </p>

        <div className="mt-4 space-y-3">
          {locations.map((loc, i) => (
            <div key={i} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="sm:w-40">
                <label className="text-sm font-medium text-foreground" htmlFor={`zip-${i}`}>
                  Zip code {i === 0 ? "(primary)" : ""}
                </label>
                <input
                  id={`zip-${i}`}
                  inputMode="numeric"
                  maxLength={5}
                  value={loc.zip}
                  onChange={(e) =>
                    updateLocation(i, { zip: e.target.value.replace(/[^0-9]/g, "").slice(0, 5) })
                  }
                  placeholder="94103"
                  className="mt-1.5 flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
                />
              </div>
              <div className="flex-1">
                <label className="text-sm font-medium text-foreground" htmlFor={`area-${i}`}>
                  State / community <span className="text-muted-foreground">(optional)</span>
                </label>
                <input
                  id={`area-${i}`}
                  value={loc.area}
                  maxLength={120}
                  onChange={(e) => updateLocation(i, { area: e.target.value })}
                  placeholder="CA · Mission Bay"
                  className="mt-1.5 flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
                />
              </div>
              <button
                type="button"
                onClick={() => removeLocation(i)}
                disabled={locations.length === 1}
                className="inline-flex h-11 items-center rounded-md border border-border bg-background px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        {errors.locations ? (
          <p className="mt-3 text-xs text-destructive">{errors.locations}</p>
        ) : null}

        <button
          type="button"
          onClick={addLocation}
          className="mt-4 inline-flex h-10 items-center rounded-md border border-border bg-background px-4 text-sm font-medium hover:bg-muted"
        >
          + Add another location
        </button>
      </section>

      {/* Non-negotiable amenities */}
      <section className="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
        <h2 className="font-display text-lg font-semibold text-foreground">
          Non-negotiable amenities
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">Tap to toggle.</p>

        <div className="mt-4 flex flex-wrap gap-2">
          {DEFAULT_AMENITIES.map((tag) => {
            const active = amenities.includes(tag);
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
      </section>

      <div className="mt-8 flex justify-center">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="inline-flex h-12 items-center rounded-md bg-primary px-8 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          {submitting ? "Saving…" : "Save & continue"}
        </button>
      </div>
    </div>
  );
}
