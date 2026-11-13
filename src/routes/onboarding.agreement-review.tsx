import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { PreSigningReview } from "@/components/PreSigningReview";
import { buildListingAgreement, hashDocument, LISTING_EFFECTIVE, LISTING_VERSION, type ListingProperty, type ListingSeller } from "@/lib/legal-documents";

/** Pre-Signing Review of the Listing Agreement: its own screen, before the signing screen. */
export const Route = createFileRoute("/onboarding/agreement-review")({
  validateSearch: (search: Record<string, unknown>) => ({ property: typeof search.property === "string" ? search.property : undefined }),
  head: () => ({ meta: [{ title: "Pre-Signing Review — Listing Agreement" }, { name: "robots", content: "noindex" }] }),
  component: ListingReview,
});

function ListingReview() {
  const { user } = useAuth();
  const { property: propertyParam } = Route.useSearch();
  const [seller, setSeller] = useState<ListingSeller | null>(null);
  const [property, setProperty] = useState<(ListingProperty & { id: string }) | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: s } = await supabase.from("sellers").select("full_name, exit_type, retained_shares").eq("id", user.id).maybeSingle();
      setSeller((s as ListingSeller | null) ?? null);
      let q = supabase.from("properties").select("id, address, city, state, zip").eq("seller_id", user.id);
      q = propertyParam ? q.eq("id", propertyParam) : q.order("created_at", { ascending: false }).limit(1);
      const { data: p } = await q.maybeSingle();
      setProperty((p as (ListingProperty & { id: string }) | null) ?? null);
      setReady(true);
    })();
  }, [user, propertyParam]);
  // Built by the same function as the signing screen: the same text, the same hash.
  const text = useMemo(() => (ready ? buildListingAgreement(seller, property) : null), [ready, seller, property]);
  return (
    <PreSigningReview
      title="Listing Agreement"
      version={LISTING_VERSION}
      effectiveDate={LISTING_EFFECTIVE}
      text={text}
      hash={text ? hashDocument(text) : null}
      signHref={`/onboarding/agreement${property?.id ? `?property=${property.id}` : ""}`}
      signDisabledNote={ready ? "Sign in as the seller to review your Listing Agreement." : "Loading…"}
    />
  );
}
