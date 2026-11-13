import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { OnboardingStepper } from "@/components/OnboardingStepper";

import { buildListingAgreement, hashDocument, LISTING_EFFECTIVE, LISTING_VERSION } from "@/lib/legal-documents";
import { DocumentReader } from "@/components/DocumentReader";
import { keepExecutedText } from "@/lib/document-access.functions";
import { cn } from "@/lib/utils";
import { logAudit } from "@/lib/audit";
import { markListingStep } from "@/lib/listing-progress";
import { submitListingForApproval, getListingAgentTagState } from "@/lib/listing-approval.functions";

export const Route = createFileRoute("/onboarding/agreement")({
  // Optional ?property=<id> scopes the agreement to one existing listing.
  validateSearch: (search: Record<string, unknown>) => ({
    property: typeof search.property === "string" ? search.property : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Seller agreement — divieight" },
      { name: "description", content: "Review and sign the divieight seller agreement." },
    ],
  }),
  component: AgreementScreen,
});


type SellerRow = {
  id: string;
  full_name: string | null;
  exit_type: string | null;
  retained_shares: number | null;
};

type PropertyRow = {
  id: string;
  address: string;
  city: string;
  state: string;
  zip: string;
};


function AgreementScreen() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const { property: propertyParam } = Route.useSearch();
  const [seller, setSeller] = useState<SellerRow | null>(null);
  const [property, setProperty] = useState<PropertyRow | null>(null);
  const [scrolledEnd, setScrolledEnd] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [signedName, setSignedName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: s } = await supabase
        .from("sellers")
        .select("id, full_name, exit_type, retained_shares")
        .eq("id", user.id)
        .maybeSingle();
      setSeller(s ?? null);
      setSignedName((s?.full_name ?? "").trim());

      let query = supabase
        .from("properties")
        .select("id, address, city, state, zip")
        .eq("seller_id", user.id);
      query = propertyParam
        ? query.eq("id", propertyParam)
        : query.order("created_at", { ascending: false }).limit(1);
      const { data: p } = await query.maybeSingle();
      setProperty(p ?? null);

      // A Listing Agent must be tagged or invited before the agreement step.
      if (p?.id) {
        try {
          const tag = await getListingAgentTagState({ data: { propertyId: p.id } });
          if (!tag.agentName && !tag.invitedEmail) {
            navigate({ to: "/onboarding/listing-agent", search: { property: p.id } });
          }
        } catch {
          /* ignore — leave the seller on the agreement step */
        }
      }
    })();
  }, [user, propertyParam, navigate]);

  const agreement = useMemo(() => buildListingAgreement(seller, property), [seller, property]);
  const documentHash = useMemo(() => hashDocument(agreement), [agreement]);


  async function handleConfirmSign() {
    if (!user || !seller) {
      toast.error("You need to be signed in.");
      return;
    }
    const typed = signedName.trim();
    if (typed.length < 3) {
      toast.error("Please type your full legal name.");
      return;
    }

    setSubmitting(true);

    let ip: string | null = null;
    try {
      const res = await fetch("https://api.ipify.org?format=json");
      if (res.ok) ip = (await res.json()).ip ?? null;
    } catch {
      ip = null;
    }

    const { error: signErr } = await supabase.from("signed_documents").insert({
      seller_id: user.id,
      document_type: "listing_agreement",
      document_version: LISTING_VERSION,
      signed_name: typed,
      document_hash: documentHash,
      ip_address: ip,
      property_id: property?.id ?? null,
    });
    if (signErr) {
      setSubmitting(false);
      toast.error(signErr.message);
      return;
    }

    const { error: sellerErr } = await supabase
      .from("sellers")
      .update({ onboarding_status: "active" })
      .eq("id", user.id);
    if (sellerErr) {
      setSubmitting(false);
      toast.error(sellerErr.message);
      return;
    }

    if (property?.id) {
      // Signing no longer publishes. Content now routes through Gate 1
      // (Listing Agent approval) and Gate 2 (compliance) before going live.
      await markListingStep(property.id, "agreement");
      try {
        await submitListingForApproval({ data: { propertyId: property.id } });
      } catch (e) {
        console.error("[listing] submit for approval failed", e);
      }
    }

    await logAudit({
      actorId: user.id,
      actionType: "seller.listing_agreement_signed",
      entityType: "property",
      entityId: property?.id ?? null,
      metadata: {
        document_version: LISTING_VERSION,
        document_hash: documentHash,
        signed_name: typed,
        ip_address: ip,
      },
    });

    // Keep the exact executed text (accepted only if it hashes to the signed hash). Best effort: the signature is already recorded.
    void keepExecutedText({ data: { documentType: "listing_agreement", documentVersion: LISTING_VERSION, text: agreement } }).catch(() => undefined);
    setSubmitting(false);
    setModalOpen(false);
    setDone(true);
    toast.success("Signed. Your listing is now with your Listing Agent for review.");
    setTimeout(() => navigate({ to: "/dashboard" }), 1600);
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <OnboardingStepper current={7} />

      <div className="mt-10 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
          Step 7 · Agreement
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Sign your listing agreement
        </h1>
        <p className="mt-3 text-base text-muted-foreground">
          Review the full agreement. Scroll to the end to enable signing.
        </p>
      </div>

      {done ? (
        <div className="mt-10 rounded-xl border border-accent/40 bg-accent/10 p-10 text-center">
          <h2 className="font-display text-2xl font-semibold text-foreground">
            Submitted for review
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your listing content is with your Listing Agent for approval, followed by
            a compliance review. You'll be notified when it goes live. Redirecting…
          </p>
        </div>
      ) : (
        <>
          <p className="mt-6 text-sm text-muted-foreground">
            You can read this agreement on its own first, search it and download a draft on the{" "}
            <a href={`/onboarding/agreement-review${property?.id ? `?property=${property.id}` : ""}`} className="font-medium text-primary underline">
              Pre-Signing Review
            </a>{" "}
            screen. This is the signing screen: below is the exact text you are signing.
          </p>
          <div className="mt-4">
            <DocumentReader
              title="Listing Agreement"
              version={LISTING_VERSION}
              effectiveDate={LISTING_EFFECTIVE}
              text={agreement}
              hash={documentHash}
              hashLabel="Document hash (the hash stored with your signature)"
              crossRefs={{ terms: true, pra: false }}
              onReachedEnd={(v) => v && setScrolledEnd(true)}
              heightClass="h-[440px]"
            />
          </div>

          <div className="mt-8 flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              disabled={!scrolledEnd || loading || !seller}
              className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Sign Agreement
            </button>
            <p className="text-xs text-muted-foreground">
              By signing, you agree to the terms above and consent to electronic signature.
            </p>
          </div>
        </>
      )}

      {modalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm px-4"
          onClick={() => !submitting && setModalOpen(false)}
        >
          <div
            className={cn(
              "w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg",
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-xl font-semibold text-foreground">
              Confirm your signature
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Type your full legal name to sign the Listing Agreement. This creates a
              legally binding electronic signature.
            </p>
            <label className="mt-5 block text-sm font-medium text-foreground">
              Full legal name
            </label>
            <input
              type="text"
              value={signedName}
              onChange={(e) => setSignedName(e.target.value)}
              placeholder="e.g. Jane A. Doe"
              className="mt-2 flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background font-serif italic"
            />
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmSign}
                disabled={submitting || signedName.trim().length < 3}
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
              >
                {submitting ? "Signing…" : "Confirm & Sign"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
