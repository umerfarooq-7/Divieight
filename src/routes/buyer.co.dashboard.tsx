import { useEffect, useRef, useState } from "react";
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

const CARD = "rounded-xl border border-border bg-card p-6 shadow-sm";
const BTN = "inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground disabled:opacity-60";
const INPUT = "mt-1 flex h-11 w-full rounded-md border border-input bg-background px-3 text-sm font-normal";
const EYEBROW = "text-xs font-semibold uppercase tracking-[0.18em] text-accent";

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
  const [scanning, setScanning] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  // Reads the details off the photo (a stand-in until the identity provider is connected). Review and correct everything.
  async function scan() {
    setScanning(true);
    await new Promise((r) => setTimeout(r, 1200));
    setForm((f) => ({ ...f, address: f.address || "123 Market Street, Apt 4B, San Francisco, CA 94103", dateOfBirth: f.dateOfBirth || "1988-06-14" }));
    setScanning(false);
    toast.success("Details extracted. Please review and correct as needed.");
  }

  async function saveIdentity() {
    if (!q.data || !user) return;
    if (!file) return void toast.error("Upload a photo of your driver's license.");
    setSaving(true);
    try {
      const ext = file.name.split(".").pop() ?? "jpg";
      const path = `${user.id}/buyer-license-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("identity-documents").upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw new Error(upErr.message);
      await saveMemberIdentityFn({
        data: { actingMemberId: q.data.memberId, fullName: form.fullName, address: form.address, dateOfBirth: form.dateOfBirth, idDocumentNumber: form.idNumber, idDocumentPath: path },
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
  const flags = d ? [d.identityDone, d.w9Done, d.feePaid] : [false, false, false];
  const current = flags.findIndex((x) => !x);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 text-foreground sm:px-6">
      <PaymentTestModeBanner />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className={EYEBROW}>Co-buyer</p>
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
      {q.data === null ? <p className={`mt-6 ${CARD}`}>This login isn't linked to a buyer account as a co-buyer. If you were invited, open the invitation link from your email again.</p> : null}

      {d ? (
        <>
          <Stepper labels={["Identity", "W-9", "Payment"]} flags={flags} current={current} />

          {current === -1 ? (
            <div className="mt-8 rounded-xl border border-emerald-600/40 bg-emerald-50 p-6 text-center dark:bg-emerald-950/20">
              <p className="font-display text-xl font-semibold">You're all set</p>
              <p className="mt-1 text-sm text-muted-foreground">Your steps are complete. When {d.holderName} buys a share together with you, it shows up below with what you need to sign.</p>
            </div>
          ) : null}

          {current === 0 ? (
            <div className={`mt-8 ${CARD}`}>
              <p className={EYEBROW}>Step 1 · Identity</p>
              <h2 className="mt-1 font-display text-2xl font-semibold">Verify your identity</h2>
              <p className="mt-1 text-sm text-muted-foreground">Upload a clear photo of your driver's license and confirm your details.</p>

              <div className={`mt-5 flex flex-col items-center rounded-lg border-2 border-dashed p-6 text-center ${preview ? "border-accent/50 bg-accent/5" : "border-border"}`}>
                {preview ? <img src={preview} alt="License preview" className="max-h-48 rounded-md border border-border object-contain" /> : <p className="text-sm text-muted-foreground">JPG or PNG, up to 10MB.</p>}
                <button type="button" onClick={() => fileRef.current?.click()} className="mt-4 inline-flex h-10 items-center rounded-md border border-border bg-background px-4 text-sm font-medium hover:bg-muted">
                  {preview ? "Replace photo" : "Choose photo"}
                </button>
                {scanning ? <p className="mt-3 text-xs text-muted-foreground">Scanning document…</p> : null}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (!f) return;
                    if (!f.type.startsWith("image/")) return void toast.error("Please upload an image file.");
                    if (f.size > 10 * 1024 * 1024) return void toast.error("File must be 10MB or smaller.");
                    setFile(f);
                    setPreview(URL.createObjectURL(f));
                    void scan();
                  }}
                />
              </div>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-medium">
                  Full legal name
                  <input className={INPUT} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
                </label>
                <label className="text-sm font-medium">
                  Date of birth
                  <input className={INPUT} type="date" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} />
                </label>
                <label className="text-sm font-medium sm:col-span-2">
                  Address
                  <input className={INPUT} placeholder="Street, city, state, ZIP" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
                </label>
                <label className="text-sm font-medium sm:col-span-2">
                  ID document number
                  <input className={INPUT} autoComplete="off" value={form.idNumber} onChange={(e) => setForm({ ...form, idNumber: e.target.value })} />
                </label>
              </div>
              <button type="button" className={`${BTN} mt-6 w-full sm:w-auto`} disabled={saving} onClick={saveIdentity}>
                {saving ? "Saving…" : "Save and continue"}
              </button>
            </div>
          ) : null}

          {current === 1 ? (
            <div className={`mt-8 text-center ${CARD}`}>
              <p className={EYEBROW}>Step 2 · W-9</p>
              <h2 className="mt-1 font-display text-2xl font-semibold">Tax form</h2>
              <p className="mt-1 text-sm text-muted-foreground">A short W-9 with your tax details, needed for any distributions you receive. You come back here when it is done.</p>
              <Link to="/buyer/onboarding/w9" className={`${BTN} mt-6`}>
                Open the W-9
              </Link>
            </div>
          ) : null}

          {current === 2 ? (
            <div className={`mt-8 ${CARD}`}>
              <p className={EYEBROW}>Step 3 · Payment</p>
              <h2 className="mt-1 font-display text-2xl font-semibold">Platform enrollment fee</h2>
              <p className="mt-1 text-sm text-muted-foreground">Your own one-time fee of {formatUsd(BUYER_ENROLLMENT_CENTS_PER_MEMBER)}. It does not change {d.holderName}'s account.</p>
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

          <section className={`mt-8 ${CARD}`}>
            <h2 className="font-display text-lg font-semibold">Shares bought with you</h2>
            {d.shares.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">None yet. When {d.holderName} buys a share together with you, it appears here with what you need to sign.</p>
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

function Stepper({ labels, flags, current }: { labels: string[]; flags: boolean[]; current: number }) {
  return (
    <ol className="mt-8 flex w-full items-center gap-2">
      {labels.map((label, i) => {
        const done = flags[i];
        const active = i === current;
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${active ? "border-accent bg-accent text-accent-foreground" : done ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground"}`}
            >
              {done ? "✓" : i + 1}
            </span>
            <span className={`hidden text-xs font-medium uppercase tracking-wider sm:inline ${active ? "text-foreground" : "text-muted-foreground"}`}>{label}</span>
            {i < labels.length - 1 ? <span className={`h-px flex-1 ${done ? "bg-primary" : "bg-border"}`} /> : null}
          </li>
        );
      })}
    </ol>
  );
}
