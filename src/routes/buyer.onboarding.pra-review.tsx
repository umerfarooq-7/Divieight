import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { ActingMemberGate } from "@/components/ActingMemberGate";
import { BuyerOnboardingStepper } from "@/components/BuyerOnboardingStepper";
import { DocumentReader } from "@/components/DocumentReader";
import { acknowledgePraReview, getPraReviewState } from "@/lib/document-access.functions";
import { buildPRA, hashDocument, PRA_EFFECTIVE, PRA_VERSION, type PraBuyer } from "@/lib/legal-documents";

/** Pre-Payment: after the Eligibility Decision page, before the fee. Payment stays closed until this member has read the PRA to the bottom and acknowledged it. */
export const Route = createFileRoute("/buyer/onboarding/pra-review")({
  head: () => ({
    meta: [
      { title: "Pre-Payment Review — Priority Reservation Agreement" },
      { name: "description", content: "Read the Priority Reservation Agreement before you pay the enrollment fee." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PraReviewScreen,
});

function PraReviewScreen() {
  return (
    <ActingMemberGate step="Step 4 · Pre-Payment Review">
      {({ member, switchPerson }) => <ReviewForMember key={member.id} actingMemberId={member.id} onSwitch={switchPerson} />}
    </ActingMemberGate>
  );
}

function ReviewForMember({ actingMemberId, onSwitch }: { actingMemberId: string; onSwitch: () => void }) {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [buyer, setBuyer] = useState<PraBuyer | null>(null);
  const [memberName, setMemberName] = useState("");
  const [acknowledgedAt, setAcknowledgedAt] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [ticked, setTicked] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/buyer/login" });
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: account } = await supabase.from("buyer_accounts").select("id, intent, primary_target_market").eq("auth_user_id", user.id).maybeSingle();
      if (cancelled) return;
      if (!account) {
        navigate({ to: "/buyer/register" });
        return;
      }
      setBuyer(account as PraBuyer);
      const { data: m } = await supabase.from("account_members").select("full_name").eq("id", actingMemberId).maybeSingle();
      if (cancelled) return;
      setMemberName((m as { full_name: string | null } | null)?.full_name ?? "");
      try {
        const s = await getPraReviewState({ data: { actingMemberId } });
        if (!cancelled) setAcknowledgedAt(s.acknowledgedAt);
      } catch {
        /* shown as not yet acknowledged */
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, loading, navigate, actingMemberId]);

  // The same text the payment and signing screen builds, so the hash on both screens is the same.
  const pra = useMemo(() => buildPRA(memberName, buyer), [memberName, buyer]);
  const hash = useMemo(() => hashDocument(pra), [pra]);

  async function acknowledge() {
    setSaving(true);
    try {
      await acknowledgePraReview({ data: { actingMemberId, documentVersion: PRA_VERSION, documentHash: hash, reachedEnd } });
      toast.success("Acknowledged. You can now continue to payment.");
      navigate({ to: "/buyer/onboarding/payment" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record the acknowledgment.");
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <BuyerOnboardingStepper current={3} />
      <div className="mt-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Step 4 · Pre-Payment Review</p>
        <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-foreground">Read the Priority Reservation Agreement</h1>
        <p className="mt-2 text-base text-muted-foreground">
          Before you pay the enrollment fee, read the agreement you will sign afterward. You can search it, jump to any section, enlarge the text and download it. Payment opens once you have read it to the
          bottom and acknowledged it.
        </p>
      </div>

      {!ready ? (
        <div className="mt-8 h-64 animate-pulse rounded-xl border border-border bg-muted/40" />
      ) : (
        <>
          <div className="mt-6">
            <DocumentReader
              title="Priority Reservation Agreement"
              version={PRA_VERSION}
              effectiveDate={PRA_EFFECTIVE}
              text={pra}
              hash={hash}
              crossRefs={{ terms: true, pra: true }}
              onReachedEnd={(v) => v && setReachedEnd(true)}
              heightClass="h-[60vh] min-h-[300px]"
              downloadNote="This is a draft for your review. You sign on the next screen, after payment."
            />
          </div>

          <div className="mt-6 rounded-xl border border-border bg-card p-5 shadow-sm">
            {acknowledgedAt ? (
              <p className="text-base text-foreground" role="status">
                ✓ You acknowledged this agreement on {new Date(acknowledgedAt).toLocaleString()}.
              </p>
            ) : (
              <label className="flex items-start gap-3 text-base text-foreground">
                <input
                  type="checkbox"
                  checked={ticked}
                  disabled={!reachedEnd}
                  onChange={(e) => setTicked(e.target.checked)}
                  className="mt-1 h-5 w-5 rounded border-input disabled:opacity-50"
                />
                <span>I have read the whole Priority Reservation Agreement, I understand it, and I am ready to pay the enrollment fee and sign it.</span>
              </label>
            )}
            {!reachedEnd && !acknowledgedAt ? <p className="mt-2 text-sm text-muted-foreground">Scroll to the bottom of the agreement to enable the acknowledgment.</p> : null}
            <div className="mt-4 flex flex-wrap gap-3">
              <button type="button" onClick={onSwitch} className="inline-flex h-11 items-center justify-center rounded-md border border-border px-5 text-sm font-medium text-foreground hover:bg-muted">
                Switch person
              </button>
              {acknowledgedAt ? (
                <button type="button" onClick={() => navigate({ to: "/buyer/onboarding/payment" })} className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                  Continue to payment
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!reachedEnd || !ticked || saving}
                  onClick={acknowledge}
                  className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Acknowledge and continue to payment"}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
