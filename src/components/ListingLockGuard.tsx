import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { isListingLocked, LISTING_LOCKED_MESSAGE } from "@/lib/listing-lock";

/** Renders the seller's edit screen only while the listing is still editable. */
export function ListingLockGuard({ propertyId, children }: { propertyId: string | undefined; children: ReactNode }) {
  const [status, setStatus] = useState<string | null | undefined>(propertyId ? undefined : null);

  useEffect(() => {
    if (!propertyId) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    void supabase
      .from("properties")
      .select("listing_status")
      .eq("id", propertyId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setStatus((data?.listing_status as string | null) ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  if (status === undefined) return <p className="px-6 py-16 text-center text-sm text-muted-foreground">Loading…</p>;
  if (isListingLocked(status)) return <ListingLockedNotice />;
  return <>{children}</>;
}

export function ListingLockedNotice() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <div className="rounded-xl border border-border bg-card p-6 text-center">
        <Lock className="mx-auto h-6 w-6 text-accent" />
        <h1 className="mt-3 font-display text-xl font-semibold text-foreground">Listing locked</h1>
        <p className="mt-2 text-sm text-muted-foreground">{LISTING_LOCKED_MESSAGE}</p>
        <Link to="/dashboard" className="mt-5 inline-block text-sm font-medium text-primary hover:underline">
          Back to your dashboard
        </Link>
      </div>
    </div>
  );
}
