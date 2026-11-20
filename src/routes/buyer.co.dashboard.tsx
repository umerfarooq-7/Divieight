import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { PaymentTestModeBanner } from "@/components/PaymentTestModeBanner";
import { BuyerEnrollmentCheckout } from "@/components/BuyerEnrollmentCheckout";
import { formatUsd, getStripeEnvironment } from "@/lib/stripe";
import { BUYER_ENROLLMENT_CENTS_PER_MEMBER } from "@/lib/buyer-fee";
import { confirmCoBuyerEnrollmentPayment } from "@/utils/payments.functions";
import { getCoBuyerSelf } from "@/lib/co-buyer-members.functions";
import { saveMemberIdentityFn } from "@/lib/account-members.functions";

export const Route = createFileRoute("/buyer/co/dashboard")({
  validateSearch: (search: Record<string, unknown>): { session_id?: string } => ({
    session_id: typeof search.session_id === "string" ? search.session_id : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Co-buyer portal — divieight" },
      { name: "description", content: "Your own steps and signatures for the shares you are buying together." },
    ],
  }),
  component: CoBuyerPortal,
});

const CARD = "rounded-xl border border-border bg-card p-5 shadow-sm";
const BTN = "inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-60";
const INPUT = "mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm";

function Done({ ok }: { ok: boolean }) {
  return <span className={ok ? "text-emerald-600" : "text-muted-foreground"}>{ok ? "Done" : "To do"}</span>;
}

function CoBuyerPortal() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { session_id: sessionId } = Route.useSearch();
  const q = useQuery({ queryKey: ["co-buyer-self", user?.id], enabled: !!user, retry: false, queryFn: () => getCoBuyerSelf() });
  const [showCheckout, setShowCheckout] = useState(false);
  const [agree, setAgree] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [form, setForm] = useState({ fullName: "", address: "", dateOfBirth: "", idNumber: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/buyer/login" });
  }, [loading, user, navigate]);

  useEffect(() => {
    if (q.data) setForm((f) => ({ ...f, fullName: f.fullName || q.data!.name }));
  }, [q.data]);

  // Back from Stripe: confirmed on the server before anything is marked paid.
  useEffect(() => {
    if (!sessionId || !user) return;
    let cancelled = false;
    setConfirming(true);
    (async () => {
      const r = await confirmCoBuyerEnrollmentPayment({ data: { sessionId, environment: getStripeEnvironment() } });
      if (cancelled) return;
      setConfirming(false);
      if ("error" in r) toast.error(r.error);
      else if (!r.paid) toast.error("Payment was not completed.");
      else {
        toast.success("Payment received.");
        setShowCheckout(false);
        await qc.invalidateQueries({ queryKey: ["co-buyer-self"] });
      }
      navigate({ to: "/buyer/co/dashboard", search: {}, replace: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, user, navigate, qc]);

  async function saveIdentity() {
    if (!q.data) return;
    setSaving(true);
    try {
      await saveMemberIdentityFn({
        data: { actingMemberId: q.data.memberId, fullName: form.fullName, address: form.address, dateOfBirth: form.dateOfBirth, idDocumentNumber: form.idNumber },
      });
      toast.success("Identity saved.");
      await qc.invalidateQueries({ queryKey: ["co-buyer-self"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save your identity.");
    } finally {
      setSaving(false);
    }
  }

  const d = q.data;
  return (
    <main className="mx-auto max-w-3xl space-y-5 px-4 py-8 text-foreground">
      <PaymentTestModeBanner />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold sm:text-3xl">Co-buyer portal</h1>
          <p className="text-sm text-muted-foreground">
            {d ? `You are a co-buyer with ${d.holderName}. You see only your own steps and the shares bought with you.` : "Your own steps and signatures."}
          </p>
        </div>
        <button
          type="button"
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-secondary"
          onClick={async () => {
            await supabase.auth.signOut();
            navigate({ to: "/buyer/login" });
          }}
        >
          Sign out
        </button>
      </header>

      {q.isLoading || loading ? <p className="text-muted-foreground">Loading…</p> : null}
      {q.isError ? <p className="text-destructive">{(q.error as Error).message}</p> : null}
      {q.data === null ? (
        <p className={CARD}>This login isn't linked to a buyer account as a co-buyer. If you were invited, open the invitation link from your email again.</p>
      ) : null}

      {d ? (
        <>
          <section className={CARD}>
            <h2 className="font-display text-lg font-semibold">Your steps</h2>
            <ol className="mt-3 divide-y divide-border text-sm">
              <li className="flex items-center justify-between py-2">
                <span>1. Identity</span>
                <Done ok={d.identityDone} />
              </li>
              <li className="flex items-center justify-between py-2">
                <span>2. W-9 (tax form)</span>
                <span className="flex items-center gap-3">
                  <Done ok={d.w9Done} />
                  {!d.w9Done ? (
                    <Link to="/buyer/onboarding/w9" className="font-medium text-primary underline">
                      Open
                    </Link>
                  ) : null}
                </span>
              </li>
              <li className="flex items-center justify-between py-2">
                <span>3. Platform enrollment fee ({formatUsd(BUYER_ENROLLMENT_CENTS_PER_MEMBER)})</span>
                <Done ok={d.feePaid} />
              </li>
            </ol>
          </section>

          {!d.identityDone ? (
            <section className={CARD}>
              <h2 className="font-display text-lg font-semibold">Your identity</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  Full legal name
                  <input className={INPUT} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
                </label>
                <label className="text-sm">
                  Date of birth
                  <input className={INPUT} type="date" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} />
                </label>
                <label className="text-sm sm:col-span-2">
                  Home address
                  <input className={INPUT} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
                </label>
                <label className="text-sm sm:col-span-2">
                  ID document number
                  <input className={INPUT} value={form.idNumber} onChange={(e) => setForm({ ...form, idNumber: e.target.value })} />
                </label>
              </div>
              <button type="button" className={`${BTN} mt-4`} disabled={saving} onClick={saveIdentity}>
                {saving ? "Saving…" : "Save identity"}
              </button>
            </section>
          ) : null}

          {!d.feePaid ? (
            <section className={CARD}>
              <h2 className="font-display text-lg font-semibold">Your enrollment fee</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                You pay your own one-time Platform Enrollment Fee of {formatUsd(BUYER_ENROLLMENT_CENTS_PER_MEMBER)}. It does not change {d.holderName}'s account.
              </p>
              {confirming ? (
                <p className="mt-3 text-sm text-muted-foreground">Confirming your payment…</p>
              ) : showCheckout ? (
                <BuyerEnrollmentCheckout coBuyer actingMemberId={d.memberId} returnUrl={`${window.location.origin}/buyer/co/dashboard?session_id={CHECKOUT_SESSION_ID}`} />
              ) : (
                <>
                  <label className="mt-3 flex items-start gap-3 text-sm">
                    <input type="checkbox" className="mt-0.5 h-4 w-4" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                    <span>I understand this fee is fully earned upon payment, is non-refundable, and applies regardless of transaction outcome.</span>
                  </label>
                  <button type="button" className={`${BTN} mt-3`} disabled={!agree} onClick={() => setShowCheckout(true)}>
                    Pay {formatUsd(BUYER_ENROLLMENT_CENTS_PER_MEMBER)} now
                  </button>
                </>
              )}
            </section>
          ) : null}

          <section className={CARD}>
            <h2 className="font-display text-lg font-semibold">Shares bought with you</h2>
            {d.shares.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                None yet. When {d.holderName} buys a share together with you, it appears here with what you need to sign.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-border text-sm">
                {d.shares.map((s) => (
                  <li key={s.reservationId} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <span className="font-medium">{s.address || "Property"}</span>
                    <span className="flex gap-3">
                      <Link to="/buyer/due-diligence/$id" params={{ id: s.propertyId }} className="text-primary underline">
                        Due diligence
                      </Link>
                      <Link to="/buyer/authorizations" search={{ property: s.propertyId }} className="text-primary underline">
                        Authorizations
                      </Link>
                      <Link to="/buyer/operating-agreement" search={{ property: s.propertyId }} className="text-primary underline">
                        Operating Agreement
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!d.feePaid || !d.identityDone || !d.w9Done ? (
              <p className="mt-3 text-xs text-muted-foreground">Finish your steps above so nothing holds up a closing.</p>
            ) : null}
          </section>
        </>
      ) : null}
    </main>
  );
}
