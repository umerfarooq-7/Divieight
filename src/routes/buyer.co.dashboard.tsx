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
import { getCoBuyerActionsFn, getCoBuyerSelf } from "@/lib/co-buyer-members.functions";
import { getMyAccountMembers } from "@/lib/account-members.functions";
import { acceptAuthorizationFn, getAuthorizationState } from "@/lib/member-steps.functions";
import { block1ConsentText, block2AuthorizationText } from "@/constants/authorizationsCopy";
import { COBUYER_STEPS } from "@/lib/co-buyer-members";

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

const CARD = "rounded-xl border border-border bg-card p-6 shadow-sm";
const BTN = "inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground disabled:opacity-60";
const EYEBROW = "text-xs font-semibold uppercase tracking-[0.18em] text-accent";

function CoBuyerPortal() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { session_id: sessionId } = Route.useSearch();
  const self = useQuery({ queryKey: ["co-buyer-self", user?.id], enabled: !!user, retry: false, queryFn: () => getCoBuyerSelf() });
  const mine = useQuery({ queryKey: ["co-buyer-members", user?.id], enabled: !!user, retry: false, queryFn: () => getMyAccountMembers(), refetchOnMount: "always" });
  const d = self.data;
  const me = mine.data?.members[0];
  const memberId = d?.memberId;
  const auth = useQuery({
    queryKey: ["co-buyer-auth", memberId],
    enabled: !!memberId,
    retry: false,
    queryFn: () => getAuthorizationState({ data: { actingMemberId: memberId! } }),
  });
  // What is waiting on this person for the shares they are on (documents, authorizations, the Operating Agreement).
  const actions = useQuery({ queryKey: ["co-buyer-actions", user?.id], enabled: !!user && !!self.data, retry: false, queryFn: () => getCoBuyerActionsFn(), refetchOnMount: "always" });
  const todo = actions.data ?? [];
  const [showCheckout, setShowCheckout] = useState(false);
  const [agree, setAgree] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/buyer/login" });
  }, [loading, user, navigate]);

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
        // Shown at once, then confirmed against the server: the step turns done without a refresh.
        qc.setQueryData(["co-buyer-self", user.id], (old: typeof self.data) => (old ? { ...old, feePaid: true } : old));
        await qc.invalidateQueries({ queryKey: ["co-buyer-self"] });
        await qc.invalidateQueries({ queryKey: ["co-buyer-members"] });
      }
      navigate({ to: "/buyer/co/dashboard", search: {}, replace: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, user?.id, navigate, qc]);

  async function accept(block: "block1" | "block2") {
    if (!memberId) return;
    setBusy(true);
    try {
      await acceptAuthorizationFn({ data: { actingMemberId: memberId, block } });
      toast.success("Recorded.");
      await Promise.all([qc.invalidateQueries({ queryKey: ["co-buyer-auth"] }), qc.invalidateQueries({ queryKey: ["co-buyer-members"] })]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't record that.");
    } finally {
      setBusy(false);
    }
  }

  // Every step in order, with where each one is done. The consents and the fee are done right here.
  const doneOf = (key: string) => Boolean(me?.checklist.find((c) => c.key === key)?.done);
  const rows = COBUYER_STEPS.map((s) => ({ ...s, done: s.key === "fee" ? Boolean(d?.feePaid) : doneOf(s.key) }));
  const current = rows.findIndex((r) => !r.done);
  const doneCount = rows.filter((r) => r.done).length;
  const ready = Boolean(d && me);
  const next = current >= 0 ? rows[current] : null;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 text-foreground sm:px-6">
      <div className="mb-8 overflow-hidden rounded-lg">
        <PaymentTestModeBanner />
      </div>
      <header>
        <div>
          <p className={EYEBROW}>Co-buyer portal</p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">Welcome{d?.name ? `, ${d.name.split(" ")[0]}` : ""}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {d ? `You are buying together with ${d.holderName}. You complete your own steps once, and sign for the shares bought with you.` : "Your own steps and signatures."}
          </p>
        </div>
      </header>

      {self.isLoading || mine.isLoading || loading ? <div className="mt-8 h-48 animate-pulse rounded-xl border border-border bg-muted/40" /> : null}
      {self.isError ? <p className="mt-6 text-destructive">{(self.error as Error).message}</p> : null}
      {self.data === null ? <p className={`mt-6 ${CARD}`}>This login isn't linked to a buyer account as a co-buyer. If you were invited, open the invitation link from your email again.</p> : null}

      {ready && d ? (
        <>
          {todo.length > 0 ? (
            <section className="mt-8 rounded-xl border border-amber-500/50 bg-amber-50 p-5 dark:bg-amber-950/20">
              <h2 className="font-display text-lg font-semibold">Needs your action ({todo.length})</h2>
              <ul className="mt-3 space-y-2">
                {todo.map((a, i) => (
                  <li key={`${a.kind}-${a.propertyId}-${a.requestId ?? i}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm">
                    <span>
                      <span className="font-medium">{a.title}</span>
                      <span className="block text-xs text-muted-foreground">{a.propertyLabel}</span>
                    </span>
                    {a.kind === "due_diligence" ? (
                      <Link to="/buyer/due-diligence/$id" params={{ id: a.propertyId }} className="font-medium text-primary underline">
                        Open
                      </Link>
                    ) : a.kind === "authorization" ? (
                      a.requestId ? (
                        <Link to="/buyer/authorizations/$id" params={{ id: a.requestId }} className="font-medium text-primary underline">
                          Open
                        </Link>
                      ) : (
                        <Link to="/buyer/authorizations" search={{ property: a.propertyId }} className="font-medium text-primary underline">
                          Open
                        </Link>
                      )
                    ) : (
                      <Link to="/buyer/operating-agreement" search={{ property: a.propertyId }} className="font-medium text-primary underline">
                        Open
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {next ? (
            <>
              <div className="mt-8">
                <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                  <span>Your progress</span>
                  <span>
                    {doneCount} of {rows.length} steps
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(doneCount / rows.length) * 100}%` }} />
                </div>
              </div>

              <div className={`mt-6 ${CARD}`}>
                <p className={EYEBROW}>
                  Step {current + 1} of {rows.length}
                </p>
                <h2 className="mt-1 font-display text-2xl font-semibold">{next.label}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{next.blurb}</p>

                {next.path ? (
                  <Link to={next.path} className={`${BTN} mt-5`}>
                    {doneCount === 0 ? "Start" : "Continue"}
                  </Link>
                ) : null}

                {next.key === "block1" ? (
                  <div className="mt-4">
                    <p className="text-sm text-foreground">{block1ConsentText}</p>
                    <button type="button" className={`${BTN} mt-4`} disabled={busy || auth.isLoading} onClick={() => void accept("block1")}>
                      I consent
                    </button>
                  </div>
                ) : null}

                {next.key === "block2" ? (
                  <div className="mt-4">
                    <p className="text-sm text-foreground">{block2AuthorizationText}</p>
                    <button type="button" className={`${BTN} mt-4`} disabled={busy || auth.isLoading} onClick={() => void accept("block2")}>
                      I authorize
                    </button>
                  </div>
                ) : null}

                {next.key === "fee" ? (
                  <div className="mt-4">
                    <p className="text-sm text-muted-foreground">
                      Your own one-time fee of {formatUsd(BUYER_ENROLLMENT_CENTS_PER_MEMBER)}. It does not change {d.holderName}'s account.
                    </p>
                    {confirming ? (
                      <p className="mt-4 text-sm text-muted-foreground">Confirming your payment…</p>
                    ) : showCheckout ? (
                      <BuyerEnrollmentCheckout coBuyer actingMemberId={d.memberId} returnUrl={`${window.location.origin}/buyer/co/dashboard?session_id={CHECKOUT_SESSION_ID}`} />
                    ) : (
                      <>
                        <label className="mt-4 flex items-start gap-3 text-sm">
                          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                          <span>I understand this fee is fully earned upon payment, is non-refundable, and applies regardless of transaction outcome.</span>
                        </label>
                        <button type="button" className={`${BTN} mt-4`} disabled={!agree} onClick={() => setShowCheckout(true)}>
                          Pay {formatUsd(BUYER_ENROLLMENT_CENTS_PER_MEMBER)} now
                        </button>
                      </>
                    )}
                  </div>
                ) : null}
              </div>

              <ol className="mt-6 divide-y divide-border rounded-xl border border-border bg-card text-sm shadow-sm">
                {rows.map((r, i) => (
                  <li key={r.key} className="flex items-center gap-3 px-4 py-3">
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${r.done ? "border-primary bg-primary text-primary-foreground" : i === current ? "border-accent bg-accent text-accent-foreground" : "border-border text-muted-foreground"}`}
                      aria-hidden
                    >
                      {r.done ? "✓" : i + 1}
                    </span>
                    <span className={r.done ? "text-muted-foreground" : i === current ? "font-medium text-foreground" : "text-muted-foreground"}>{r.label}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <div className="mt-8 flex items-start gap-4 rounded-xl border border-emerald-600/40 bg-emerald-50 p-5 dark:bg-emerald-950/20">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white" aria-hidden>
                ✓
              </span>
              <div>
                <p className="font-display text-lg font-semibold">You're all set</p>
                <p className="mt-0.5 text-sm text-muted-foreground">All {rows.length} of your steps are complete. You have nothing more to do until {d.holderName} buys a share together with you.</p>
              </div>
            </div>
          )}

          <section className="mt-10">
            <h2 className="font-display text-xl font-semibold">Shares bought with you</h2>
            <p className="mt-1 text-sm text-muted-foreground">Each share {d.holderName} buys together with you appears here, with the documents you sign for it.</p>
            {d.shares.length === 0 ? (
              <p className="mt-4 rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No shares yet.</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {d.shares.map((sh) => (
                  <li key={sh.reservationId} className="rounded-xl border border-border bg-card p-5 shadow-sm">
                    <p className="font-display text-base font-semibold">{sh.address || "Property"}</p>
                    <p className="text-xs text-muted-foreground">
                      1/8th share · bought together with {d.holderName}
                      {todo.filter((t) => t.propertyId === sh.propertyId).length > 0 ? (
                        <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                          {todo.filter((t) => t.propertyId === sh.propertyId).length} to do
                        </span>
                      ) : null}
                    </p>
                    <div className="mt-4 grid gap-2 sm:grid-cols-3">
                      <Link to="/buyer/due-diligence/$id" params={{ id: sh.propertyId }} className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-secondary">
                        Due diligence
                      </Link>
                      <Link to="/buyer/authorizations" search={{ property: sh.propertyId }} className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-secondary">
                        Authorizations
                      </Link>
                      <Link to="/buyer/operating-agreement" search={{ property: sh.propertyId }} className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-secondary">
                        Operating Agreement
                      </Link>
                    </div>
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
