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
const INPUT = "mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm font-normal";

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
  const doneFlags = d ? [d.identityDone, d.w9Done, d.feePaid] : [false, false, false];
  const current = doneFlags.findIndex((x) => !x);
  const doneCount = doneFlags.filter(Boolean).length;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 text-foreground sm:px-6">
      <PaymentTestModeBanner />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Co-buyer</p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">Welcome{d?.name ? `, ${d.name.split(" ")[0]}` : ""}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {d ? `You are buying together with ${d.holderName}. You complete your own steps and sign for the shares bought with you.` : "Your own steps and signatures."}
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

      {q.isLoading || loading ? <div className="mt-8 h-48 animate-pulse rounded-xl border border-border bg-muted/40" /> : null}
      {q.isError ? <p className="mt-6 text-destructive">{(q.error as Error).message}</p> : null}
      {q.data === null ? (
        <p className={`mt-6 ${CARD}`}>This login isn't linked to a buyer account as a co-buyer. If you were invited, open the invitation link from your email again.</p>
      ) : null}

      {d ? (
        <>
          <div className="mt-8">
            <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span>Your progress</span>
              <span>{doneCount} of 3 steps</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(doneCount / 3) * 100}%` }} />
            </div>
          </div>

          <ol className="mt-6 space-y-4">
            <StepCard n={1} title="Your identity" done={d.identityDone} active={current === 0} summary="Name, date of birth, address and ID number.">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm font-medium">
                  Full legal name
                  <input className={INPUT} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
                </label>
                <label className="text-sm font-medium">
                  Date of birth
                  <input className={INPUT} type="date" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} />
                </label>
                <label className="text-sm font-medium sm:col-span-2">
                  Home address
                  <input className={INPUT} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
                </label>
                <label className="text-sm font-medium sm:col-span-2">
                  ID document number
                  <input className={INPUT} value={form.idNumber} onChange={(e) => setForm({ ...form, idNumber: e.target.value })} />
                </label>
              </div>
              <button type="button" className={`${BTN} mt-4`} disabled={saving} onClick={saveIdentity}>
                {saving ? "Saving…" : "Save and continue"}
              </button>
            </StepCard>

            <StepCard n={2} title="W-9 tax form" done={d.w9Done} active={current === 1} summary="Needed for any distributions you receive.">
              <p className="text-sm text-muted-foreground">A short form with your tax details. You will come back here when it is done.</p>
              <Link to="/buyer/onboarding/w9" className={`${BTN} mt-4`}>
                Open the W-9
              </Link>
            </StepCard>

            <StepCard n={3} title={`Platform enrollment fee (${formatUsd(BUYER_ENROLLMENT_CENTS_PER_MEMBER)})`} done={d.feePaid} active={current === 2} summary="Your own one-time fee. It does not change the account holder's.">
              <p className="text-sm text-muted-foreground">You pay your own one-time Platform Enrollment Fee of {formatUsd(BUYER_ENROLLMENT_CENTS_PER_MEMBER)}.</p>
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
            </StepCard>
          </ol>

          <section className={`mt-8 ${CARD}`}>
            <h2 className="font-display text-lg font-semibold">Shares bought with you</h2>
            {d.shares.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                None yet. When {d.holderName} buys a share together with you, it appears here with what you need to sign.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-border text-sm">
                {d.shares.map((sh) => (
                  <li key={sh.reservationId} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <span className="font-medium">{sh.address || "Property"}</span>
                    <span className="flex gap-3">
                      <Link to="/buyer/due-diligence/$id" params={{ id: sh.propertyId }} className="text-primary underline">
                        Due diligence
                      </Link>
                      <Link to="/buyer/authorizations" search={{ property: sh.propertyId }} className="text-primary underline">
                        Authorizations
                      </Link>
                      <Link to="/buyer/operating-agreement" search={{ property: sh.propertyId }} className="text-primary underline">
                        Operating Agreement
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}

function StepCard({ n, title, summary, done, active, children }: { n: number; title: string; summary: string; done: boolean; active: boolean; children: React.ReactNode }) {
  return (
    <li className={`rounded-xl border bg-card p-5 shadow-sm ${active ? "border-accent/60" : "border-border"}`}>
      <div className="flex items-start gap-4">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${done ? "bg-emerald-600 text-white" : active ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground"}`}
          aria-hidden
        >
          {done ? "✓" : n}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-semibold">{title}</h2>
            <span className={`text-xs font-medium ${done ? "text-emerald-600" : "text-muted-foreground"}`}>{done ? "Done" : active ? "Up next" : "Waiting"}</span>
          </div>
          <p className="text-sm text-muted-foreground">{summary}</p>
          {active && !done ? <div className="mt-4">{children}</div> : null}
        </div>
      </div>
    </li>
  );
}
