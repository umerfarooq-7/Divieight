import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { BuyerOnboardingStepper } from "@/components/BuyerOnboardingStepper";
import { PaymentTestModeBanner } from "@/components/PaymentTestModeBanner";
import { BuyerEnrollmentCheckout } from "@/components/BuyerEnrollmentCheckout";
import { formatUsd, getStripeEnvironment } from "@/lib/stripe";
import { confirmBuyerEnrollmentPayment } from "@/utils/payments.functions";
import { logAudit } from "@/lib/audit";
import { buildPRA, hashDocument, PRA_VERSION } from "@/lib/legal-documents";
import { ActingMemberGate } from "@/components/ActingMemberGate";
import { getSignatureState, signMemberDocumentFn } from "@/lib/member-steps.functions";
import { DocumentReader } from "@/components/DocumentReader";
import { getPraReviewState, keepExecutedText } from "@/lib/document-access.functions";
import { PRA_EFFECTIVE } from "@/lib/legal-documents";
import {
  Block5AdviceNotice,
  BLOCK_5_DOCUMENT_TYPE,
  type Block5Member,
} from "@/components/Block5AdviceNotice";

export const Route = createFileRoute("/buyer/onboarding/payment")({
  validateSearch: (search: Record<string, unknown>): { session_id?: string } => ({
    session_id: typeof search.session_id === "string" ? search.session_id : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Priority Reservation Agreement & fee — divieight" },
      {
        name: "description",
        content:
          "Review and sign the Priority Reservation Agreement and pay the $2,570 platform enrollment fee to lock in your buyer priority rank.",
      },
      { property: "og:title", content: "Priority Reservation Agreement & fee — divieight" },
      {
        property: "og:description",
        content:
          "Sign the Priority Reservation Agreement and pay the enrollment fee to secure your buyer priority rank.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PaymentScreen,
});

const BUYER_ENROLLMENT_CENTS = 257000;

type BuyerRow = {
  id: string;
  onboarding_status: string;
  priority_rank_timestamp: string | null;
  intent: string | null;
  primary_target_market: string | null;
};


/** Every active member signs their own PRA (through the picker). The fee is the account's, paid once. */
function PaymentScreen() {
  return (
    <ActingMemberGate step="Step 4 · Agreement">
      {({ member, switchPerson }) => <PaymentForMember key={member.id} actingMemberId={member.id} onSwitch={switchPerson} />}
    </ActingMemberGate>
  );
}

function PaymentForMember({ actingMemberId, onSwitch }: { actingMemberId: string; onSwitch: () => void }) {
  const navigate = useNavigate();
  const [praSigned, setPraSigned] = useState(false);
  const [praWaitingOn, setPraWaitingOn] = useState<string[]>([]);
  const { user, loading } = useAuth();
  const { session_id: sessionId } = Route.useSearch();

  const [buyer, setBuyer] = useState<BuyerRow | null>(null);
  const [memberName, setMemberName] = useState("");
  const [checking, setChecking] = useState(true);

  const [scrolledEnd, setScrolledEnd] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [nonRefundable, setNonRefundable] = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);

  const [paid, setPaid] = useState(false);
  const [rankStamp, setRankStamp] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [signedName, setSignedName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Pre-Payment Review (its own screen, before this one): this member has read the PRA to the bottom and acknowledged it.
  const [reviewed, setReviewed] = useState(false);

  // Block 5 — Independent Professional Advice gate (precedes PRA review).
  const [members, setMembers] = useState<Block5Member[]>([]);
  const [adviceAccepted, setAdviceAccepted] = useState(false);

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
        .select("id, onboarding_status, priority_rank_timestamp, intent, primary_target_market")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (!account) {
        navigate({ to: "/buyer/register" });
        return;
      }
      setBuyer(account as BuyerRow);
      if (account.priority_rank_timestamp) {
        setPaid(true);
        setRankStamp(account.priority_rank_timestamp);
      }

      const [{ data: roster }, { data: block5 }] = await Promise.all([
        supabase
          .from("account_members")
          .select("id, full_name, role")
          .eq("buyer_account_id", account.id)
          .eq("status", "active")
          .order("created_at", { ascending: true }),
        supabase
          .from("signed_documents")
          .select("id")
          .eq("buyer_account_id", account.id)
          .eq("document_type", BLOCK_5_DOCUMENT_TYPE)
          .limit(1),
      ]);
      if (cancelled) return;
      const list = (roster as Block5Member[]) ?? [];
      const me = list.find((m) => m.id === actingMemberId) ?? list[0];
      setMembers(list);
      setAdviceAccepted((block5?.length ?? 0) > 0);
      setMemberName(me?.full_name ?? "");
      setSignedName("");
      try {
        const sig = await getSignatureState({ data: { actingMemberId, documentType: "PRA" } });
        if (cancelled) return;
        setPraSigned(sig.signed);
        setPraWaitingOn(sig.waitingOn);
        const rv = await getPraReviewState({ data: { actingMemberId } });
        if (cancelled) return;
        setReviewed(rv.acknowledged);
        // Not yet through the Pre-Payment Review (and not back from Stripe): that screen comes first.
        if (!rv.acknowledged && !account.priority_rank_timestamp && !sessionId) {
          navigate({ to: "/buyer/onboarding/pra-review", replace: true });
          return;
        }
      } catch {
        // Shown as not signed; signing reports any problem.
      }
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, loading, navigate, actingMemberId]);

  // Returning from Stripe — confirm server-side; the priority rank timestamp
  // is stamped only when Stripe reports the payment as actually paid.
  useEffect(() => {
    if (!sessionId || !user) return;
    let cancelled = false;
    setConfirming(true);
    (async () => {
      const result = await confirmBuyerEnrollmentPayment({
        data: { sessionId, environment: getStripeEnvironment() },
      });
      if (cancelled) return;
      setConfirming(false);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      if (!result.paid) {
        toast.error("Payment was not completed.");
        return;
      }
      setPaid(true);
      setShowCheckout(false);
      setRankStamp(result.priorityRankTimestamp ?? null);
      toast.success("Payment received — your priority rank is locked in.");
      void logAudit({
        actorId: user.id,
        actionType: "buyer.enrollment_fee_paid",
        entityType: "payment",
        entityId: sessionId,
        metadata: { priority_rank_timestamp: result.priorityRankTimestamp },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, user]);

  const pra = useMemo(() => buildPRA(memberName, buyer), [memberName, buyer]);
  const documentHash = useMemo(() => hashDocument(pra), [pra]);


  async function handleConfirmSign() {
    if (!user || !buyer) return;
    const typed = signedName.trim();
    if (typed.length < 3) {
      toast.error("Please type your full legal name.");
      return;
    }
    setSubmitting(true);

    // Checked on the server against this member's own name; recorded against this member only.
    let waitingOn: string[] = [];
    try {
      ({ waitingOn } = await signMemberDocumentFn({ data: { actingMemberId, documentType: "PRA", documentVersion: PRA_VERSION, documentHash, typedName: typed } }));
    } catch (e) {
      setSubmitting(false);
      toast.error(e instanceof Error ? e.message : "The PRA wasn't signed.");
      return;
    }
    setPraSigned(true);
    setPraWaitingOn(waitingOn);
    // The exact text just executed is kept, so the executed copy never depends on a template. Best effort: the signature is already recorded.
    void keepExecutedText({ data: { documentType: "PRA", documentVersion: PRA_VERSION, text: pra } }).catch(() => undefined);
    setSubmitting(false);
    setModalOpen(false);
    if (waitingOn.length) {
      toast.success(`Signed. Next: ${waitingOn.join(" and ")} signs their own PRA.`);
      return;
    }
    toast.success("Priority Reservation Agreement executed by every member.");
    navigate({ to: "/buyer/onboarding/vetting" });
  }

  const canPay = reviewed && scrolledEnd && acknowledged && nonRefundable;

  return (
    <div>
      <PaymentTestModeBanner />
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
        <BuyerOnboardingStepper current={3} />

        <div className="mt-10 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            Step 4 · Agreement & payment
          </p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Priority Reservation Agreement
          </h1>
          <p className="mt-3 text-base text-muted-foreground">
            Review the full agreement, pay the one-time {formatUsd(BUYER_ENROLLMENT_CENTS)}{" "}
            Platform Enrollment Fee, then sign to lock in your priority rank.
          </p>
        </div>

        {checking ? (
          <div className="mt-10 h-64 animate-pulse rounded-xl border border-border bg-muted/40" />
        ) : !adviceAccepted && buyer && user ? (
          <Block5AdviceNotice
            buyerAccountId={buyer.id}
            actorId={user.id}
            members={members}
            onAccepted={() => setAdviceAccepted(true)}
          />
        ) : (
          <>
            <div className="mt-8">
              <DocumentReader
                title="Priority Reservation Agreement"
                version={PRA_VERSION}
                effectiveDate={PRA_EFFECTIVE}
                text={pra}
                hash={documentHash}
                hashLabel="Document hash (the hash stored with your signature)"
                crossRefs={{ terms: true, pra: false }}
                onReachedEnd={(v) => v && setScrolledEnd(true)}
                heightClass="h-[320px] sm:h-[440px]"
              />
            </div>

            {paid ? (
              <div className="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
                <p className="text-sm font-medium text-foreground">
                  Enrollment fee paid — {formatUsd(BUYER_ENROLLMENT_CENTS)}
                </p>
                {rankStamp ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Priority rank timestamp:{" "}
                    <span className="font-mono">{rankStamp}</span>
                  </p>
                ) : null}
                <p className="mt-3 text-sm text-muted-foreground">
                  {praSigned
                    ? praWaitingOn.length
                      ? `You've signed. Each member signs their own PRA — waiting on ${praWaitingOn.join(" and ")}.`
                      : "Every member has signed the Priority Reservation Agreement."
                    : "Final step: execute the Priority Reservation Agreement with your own legal signature. Each member signs their own."}
                </p>
                {praSigned && praWaitingOn.length ? (
                  <button type="button" onClick={onSwitch} className="mt-3 mr-3 inline-flex h-11 items-center justify-center rounded-md border border-border px-6 text-sm font-medium">
                    Switch person
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setModalOpen(true)}
                  disabled={!scrolledEnd || praSigned}
                  className="mt-4 inline-flex h-11 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Sign the PRA
                </button>
                {!scrolledEnd ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Scroll through the agreement above to enable signing.
                  </p>
                ) : null}
              </div>
            ) : confirming ? (
              <div className="mt-6 rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground shadow-sm">
                Confirming your payment…
              </div>
            ) : showCheckout ? (
              <BuyerEnrollmentCheckout
                returnUrl={`${window.location.origin}/buyer/onboarding/payment?session_id={CHECKOUT_SESSION_ID}`}
                actingMemberId={actingMemberId}
              />
            ) : (
              <div className="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
                <dl className="space-y-3 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-muted-foreground">Platform Enrollment Fee</dt>
                    <dd className="font-medium text-foreground">
                      {formatUsd(BUYER_ENROLLMENT_CENTS)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between border-t border-border pt-3">
                    <dt className="font-semibold text-foreground">Total due today</dt>
                    <dd className="font-display text-xl font-semibold text-accent">
                      {formatUsd(BUYER_ENROLLMENT_CENTS)}
                    </dd>
                  </div>
                </dl>

                <div className="mt-5 space-y-3">
                  <label className="flex items-start gap-3 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      disabled={!scrolledEnd}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-input disabled:opacity-50"
                    />
                    <span>
                      I have read and agree to the Priority Reservation Agreement.
                    </span>
                  </label>
                  <label className="flex items-start gap-3 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={nonRefundable}
                      disabled={!scrolledEnd}
                      onChange={(e) => setNonRefundable(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-input disabled:opacity-50"
                    />
                    <span>
                      I understand this fee is <strong>fully earned upon payment and PRA
                      execution, regardless of transaction outcome</strong>, and is
                      non-refundable.
                    </span>
                  </label>
                </div>

                <button
                  type="button"
                  disabled={!canPay}
                  onClick={() => setShowCheckout(true)}
                  className="mt-5 inline-flex h-11 w-full items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                >
                  Pay {formatUsd(BUYER_ENROLLMENT_CENTS)} now
                </button>
                <p className="mt-2 text-xs text-muted-foreground">
                  Your priority rank timestamp is recorded only after payment clears.
                </p>
                {!reviewed ? (
                  <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground">
                    Payment is locked until you have read the Priority Reservation Agreement to the bottom and ticked the acknowledgment on the{" "}
                    <a href="/buyer/onboarding/pra-review" className="font-medium text-primary underline">
                      Pre-Payment Review
                    </a>{" "}
                    screen.
                  </p>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>

      {modalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 px-4 backdrop-blur-sm"
          onClick={() => !submitting && setModalOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-xl font-semibold text-foreground">
              Execute the PRA
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Type your full legal name to sign the Priority Reservation Agreement. This
              creates a legally binding electronic signature.
            </p>
            <label className="mt-5 block text-sm font-medium text-foreground">
              Full legal name
            </label>
            <input
              type="text"
              value={signedName}
              onChange={(e) => setSignedName(e.target.value)}
              placeholder="e.g. Jane A. Doe"
              className="mt-2 flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 font-serif text-sm italic shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
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
