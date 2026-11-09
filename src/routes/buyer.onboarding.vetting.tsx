import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { BuyerOnboardingStepper } from "@/components/BuyerOnboardingStepper";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logAudit } from "@/lib/audit";
import { cn } from "@/lib/utils";
import { ActingMemberGate, actingAuditMeta } from "@/components/ActingMemberGate";

export const Route = createFileRoute("/buyer/onboarding/vetting")({
  head: () => ({
    meta: [
      { title: "Buyer vetting & background check — divieight" },
      {
        name: "description",
        content:
          "Provide FCRA consent, run your eligibility background check, and sign the hold harmless acknowledgment.",
      },
      { property: "og:title", content: "Buyer vetting & background check — divieight" },
      {
        property: "og:description",
        content: "Final buyer vetting step: FCRA consent and background screening.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: VettingScreen,
});

const HOLD_HARMLESS_VERSION = "hh-v1";
const HOLD_HARMLESS_TEXT =
  "I acknowledge that while the platform vets all members, I remain responsible for my final property decisions.";

type Outcome = "cleared" | "flagged_needs_review" | "failed";

interface BuyerRow {
  id: string;
  onboarding_status: string;
  priority_rank_timestamp: string | null;
}

interface MemberRow {
  id: string;
  full_name: string;
  vetting_status: string;
  background_check_result: string | null;
}

function VettingScreen() {
  return (
    <ActingMemberGate step="Step 5 · Vetting">
      {({ member, switchPerson }) => <VettingForMember key={member.id} actingMemberId={member.id} onSwitch={switchPerson} />}
    </ActingMemberGate>
  );
}

function VettingForMember({ actingMemberId, onSwitch }: { actingMemberId: string; onSwitch: () => void }) {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  const [buyer, setBuyer] = useState<BuyerRow | null>(null);
  const [member, setMember] = useState<MemberRow | null>(null);
  const [ready, setReady] = useState(false);

  const [consent, setConsent] = useState(false);
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Dev toggle: leave on "random" for realistic behaviour, or force an outcome to test each branch.
  const [devOutcome, setDevOutcome] = useState<"random" | Outcome>("random");

  const [hhChecked, setHhChecked] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [signedName, setSignedName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [signed, setSigned] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/buyer/login", replace: true });
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: b } = await supabase
        .from("buyer_accounts")
        .select("id, onboarding_status, priority_rank_timestamp")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (!b) {
        navigate({ to: "/buyer/onboarding/identity", replace: true });
        return;
      }
      // Route guard: vetting only unlocks once the enrollment payment cleared.
      if (!b.priority_rank_timestamp) {
        navigate({ to: "/buyer/onboarding/payment", replace: true });
        return;
      }
      const { data: m } = await supabase
        .from("account_members")
        .select("id, full_name, vetting_status, background_check_result")
        .eq("buyer_account_id", b.id)
        .eq("id", actingMemberId)
        .eq("status", "active")
        .maybeSingle();
      // This member's own hold harmless, if already signed.
      const { data: hh } = m
        ? await supabase.from("signed_documents").select("id").eq("buyer_account_id", b.id).eq("document_type", "HOLD_HARMLESS").eq("account_member_id", m.id).limit(1)
        : { data: [] };
      if (cancelled) return;
      setBuyer(b as BuyerRow);
      setMember((m as MemberRow) ?? null);
      if (m?.background_check_result) {
        setConsent(true);
        setOutcome(m.background_check_result as Outcome);
      }
      setSignedName(m?.full_name ?? "");
      if ((hh ?? []).length) {
        setSigned(true);
        setHhChecked(true);
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [user, loading, navigate, actingMemberId]);

  const canStart = consent && !checking && !outcome;
  const holdHarmlessHash = useMemo(
    () => hashDocument(`${HOLD_HARMLESS_VERSION}::${HOLD_HARMLESS_TEXT}`),
    [],
  );

  async function startCheck() {
    if (!user || !buyer || !member) return;
    setChecking(true);
    await supabase
      .from("account_members")
      .update({ fcra_consent_at: new Date().toISOString(), vetting_status: "in_progress" })
      .eq("id", member.id);

    // TODO: replace with a real consumer-report provider (e.g. Checkr / Persona) call.
    await new Promise<void>((resolve) => {
      timerRef.current = window.setTimeout(resolve, 3200);
    });

    const pool: Outcome[] = ["cleared", "cleared", "flagged_needs_review", "failed"];
    const result: Outcome =
      devOutcome === "random" ? pool[Math.floor(Math.random() * pool.length)] : devOutcome;

    const { error } = await supabase
      .from("account_members")
      .update({
        vetting_status: result,
        background_check_result: result,
        background_check_at: new Date().toISOString(),
      })
      .eq("id", member.id);

    setChecking(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setOutcome(result);
    await logAudit({
      actorId: user.id,
      actionType: "buyer.background_check_completed",
      entityType: "buyer_account",
      entityId: buyer.id,
      metadata: { result, member_id: member.id, simulated: true, ...actingAuditMeta(member.id) },
    });
  }

  async function handleSign() {
    if (!user || !buyer || !member) return;
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

    const { error } = await supabase.from("signed_documents").insert({
      buyer_account_id: buyer.id,
      document_type: "HOLD_HARMLESS",
      account_member_id: member.id,
      document_version: HOLD_HARMLESS_VERSION,
      signed_name: typed,
      document_hash: holdHarmlessHash,
      ip_address: ip,
    });
    if (error) {
      setSubmitting(false);
      toast.error(error.message);
      return;
    }

    await logAudit({
      actorId: user.id,
      actionType: "buyer.hold_harmless_signed",
      entityType: "buyer_account",
      entityId: buyer.id,
      metadata: { document_hash: holdHarmlessHash, member_id: member.id, ...actingAuditMeta(member.id, ip) },
    });

    setSubmitting(false);
    setModalOpen(false);
    setSigned(true);
    toast.success("Acknowledgment signed.");
  }

  async function continueFromOutcome() {
    if (!buyer) return;
    if (outcome === "cleared") {
      // Every active member clears, each with their own hold harmless, before the account moves on.
      const { data: everyone } = await supabase
        .from("account_members")
        .select("id, full_name, role, vetting_status")
        .eq("buyer_account_id", buyer.id)
        .eq("status", "active");
      const { data: hhRows } = await supabase
        .from("signed_documents")
        .select("account_member_id")
        .eq("buyer_account_id", buyer.id)
        .eq("document_type", "HOLD_HARMLESS");
      const signedIds = new Set(((hhRows ?? []) as Array<{ account_member_id: string | null }>).map((r) => r.account_member_id));
      const waiting = ((everyone ?? []) as Array<{ id: string; full_name: string; role: string; vetting_status: string }>).filter(
        (m) => m.vetting_status !== "cleared" || !signedIds.has(m.id),
      );
      if (waiting.length > 0) {
        toast.success(`Done for you. Next: ${waiting.map((m) => m.full_name || (m.role === "primary" ? "the account holder" : "the second member")).join(" and ")} completes vetting.`);
        onSwitch();
        return;
      }
      // Cleared buyers now pass through the Plaid liquidity gate before the
      // Golden Ticket can be issued.
      await supabase
        .from("buyer_accounts")
        .update({ last_activity_at: new Date().toISOString(), stall_warning_sent_at: null, onboarding_status: "liquidity_pending" })
        .eq("id", buyer.id);
      navigate({ to: "/buyer/onboarding/liquidity" });
      return;
    }
    if (outcome === "flagged_needs_review") {
      await supabase
        .from("buyer_accounts")
        .update({ last_activity_at: new Date().toISOString(), stall_warning_sent_at: null, onboarding_status: "verification_pending" })
        .eq("id", buyer.id);
      if (member) {
        await supabase
          .from("account_members")
          .update({ vetting_status: "verification_pending" })
          .eq("id", member.id);
      }
      if (user) {
        await logAudit({
          actorId: user.id,
          actionType: "buyer.verification_requested",
          entityType: "buyer_account",
          entityId: buyer.id,
          metadata: { member_id: member?.id ?? null, reason: "flagged_needs_review" },
        });
      }
      navigate({ to: "/buyer/verification" });
    }
  }


  if (loading || !ready) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 text-center text-sm text-muted-foreground sm:px-6 lg:px-8">
        Loading your vetting status…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <BuyerOnboardingStepper current={4} />

      <div className="mt-10">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
          Step 5 · Vetting
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Member vetting & background check
        </h1>
        <p className="mt-3 text-base text-muted-foreground">
          Every divieight co-owner is screened for eligibility before reservations unlock.
        </p>
      </div>

      {outcome === "failed" ? (
        <RejectionPanel />
      ) : (
        <>
          {/* Block 4 — FCRA consent */}
          <section className="mt-8 rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="font-display text-lg font-semibold text-foreground">
              Consumer report authorization (FCRA)
            </h2>
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                In plain language: divieight will ask a consumer reporting agency for a
                report about you. That report may include <strong>criminal history</strong>,{" "}
                <strong>financial fraud history</strong>, and{" "}
                <strong>identity verification</strong> data. We use it only to decide
                whether you are eligible to become a co-owner on this platform.
              </p>
              <p>
                We may <strong>re-pull this report periodically</strong> for as long as you
                hold an account or shares with us.
              </p>
              <p>
                You have the right to request a copy of any report we obtain about you, and
                if we take an adverse action (such as declining your account) based on that
                report, we will send you notice of the action along with the information
                required by the Fair Credit Reporting Act.
              </p>
            </div>
            <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-background p-4">
              <Checkbox
                checked={consent}
                onCheckedChange={(v) => setConsent(v === true)}
                disabled={checking || !!outcome}
                className="mt-0.5"
              />
              <span className="text-sm text-foreground">
                I authorize divieight to obtain a consumer report about me for eligibility
                purposes, now and periodically thereafter.
              </span>
            </label>

            {!outcome ? (
              <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <Button onClick={startCheck} disabled={!canStart}>
                  {checking ? "Verifying…" : "Start background check"}
                </Button>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Dev outcome
                  <select
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                    value={devOutcome}
                    onChange={(e) => setDevOutcome(e.target.value as typeof devOutcome)}
                    disabled={checking}
                  >
                    <option value="random">Random</option>
                    <option value="cleared">Cleared</option>
                    <option value="flagged_needs_review">Flagged — needs review</option>
                    <option value="failed">Failed</option>
                  </select>
                </label>
              </div>
            ) : null}

            {checking ? (
              <div className="mt-5 flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                Verifying your identity and screening records… this usually takes a few
                seconds.
              </div>
            ) : null}
          </section>

          {outcome ? <OutcomeBanner outcome={outcome} /> : null}

          {/* Hold harmless */}
          {outcome ? (
            <section className="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
              <h2 className="font-display text-lg font-semibold text-foreground">
                Hold harmless acknowledgment
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {HOLD_HARMLESS_TEXT}
              </p>
              <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-background p-4">
                <Checkbox
                  checked={hhChecked}
                  onCheckedChange={(v) => setHhChecked(v === true)}
                  disabled={signed}
                  className="mt-0.5"
                />
                <span className="text-sm text-foreground">
                  I have read and agree to the hold harmless acknowledgment.
                </span>
              </label>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <Button
                  variant={signed ? "outline" : "default"}
                  onClick={() => setModalOpen(true)}
                  disabled={!hhChecked || signed}
                >
                  {signed ? "Signed" : "Sign acknowledgment"}
                </Button>
                <Button onClick={continueFromOutcome} disabled={!signed}>
                  {outcome === "cleared" ? "Continue to liquidity check" : "Continue to review"}
                </Button>
              </div>
            </section>
          ) : null}
        </>
      )}

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign the acknowledgment</DialogTitle>
            <DialogDescription>
              Type {member?.full_name ? `${member.full_name}'s` : "your"} full legal name. We record the name, IP address, and a timestamp.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="hh-name">Full legal name</Label>
            <Input
              id="hh-name"
              value={signedName}
              onChange={(e) => setSignedName(e.target.value)}
              placeholder="Jane A. Doe"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSign} disabled={submitting}>
              {submitting ? "Signing…" : "Sign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OutcomeBanner({ outcome }: { outcome: Outcome }) {
  const map: Record<Outcome, { title: string; body: string; tone: string }> = {
    cleared: {
      title: "Cleared",
      body: "Your background check came back clear. Sign the acknowledgment below to continue.",
      tone: "border-primary/40 bg-primary/5",
    },
    flagged_needs_review: {
      title: "Flagged — additional review needed",
      body: "We need a little more information before we can finalize your eligibility. Sign the acknowledgment below and we'll take you to the verification request.",
      tone: "border-accent/50 bg-accent/10",
    },
    failed: {
      title: "Not eligible",
      body: "Your account cannot proceed at this time.",
      tone: "border-destructive/40 bg-destructive/5",
    },
  };
  const o = map[outcome];
  return (
    <div className={cn("mt-6 rounded-xl border p-5", o.tone)}>
      <p className="font-display text-base font-semibold text-foreground">{o.title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{o.body}</p>
    </div>
  );
}

function RejectionPanel() {
  return (
    <section className="mt-8 rounded-xl border border-destructive/40 bg-destructive/5 p-6">
      <h2 className="font-display text-xl font-semibold text-foreground">
        We can't move your Buyer Account forward
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
        <p>
          Based on the consumer report obtained for eligibility purposes, your Buyer Account
          cannot proceed to reservations at this time.
        </p>
        <p>
          Under the Fair Credit Reporting Act you have the right to obtain a free copy of
          the report used in this decision and to dispute the accuracy or completeness of
          any information it contains. We will send the formal adverse action notice with
          the reporting agency's contact details to your registered email address.
        </p>
      </div>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button asChild>
          <Link to="/buyer/adverse-action">View adverse action notice</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/contact">Contact support</Link>
        </Button>

        <Button asChild variant="outline">
          <Link to="/">Back to home</Link>
        </Button>
      </div>
    </section>
  );
}

function hashDocument(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}
