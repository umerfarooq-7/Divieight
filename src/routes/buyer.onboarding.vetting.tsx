import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
import { ActingMemberGate, actingAuditMeta } from "@/components/ActingMemberGate";
import { EligibilityDeclaration, type DeclarationSubmit, type DeclarationSummary } from "@/components/EligibilityDeclaration";
import { getDeclarationState, submitEligibilityDeclaration } from "@/lib/eligibility-declaration.functions";
import { HELD_BUYER_TEXT, RESULT_LABELS, RESULT_TONES } from "@/lib/eligibility-engine";

export const Route = createFileRoute("/buyer/onboarding/vetting")({
  head: () => ({
    meta: [
      { title: "Vetting & Security Clearance — divieight" },
      {
        name: "description",
        content:
          "Make your Eligibility Declaration and Authorization, and sign the hold harmless acknowledgment.",
      },
      { property: "og:title", content: "Vetting & Security Clearance — divieight" },
      {
        property: "og:description",
        content: "Buyer vetting step: the Eligibility Declaration and Authorization, made by each Account Member.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  // ?change=1: the ten-day change notice (Q6) — reopens this member's declaration as a new version.
  validateSearch: (s: Record<string, unknown>): { change?: 1 } => (s.change === 1 || s.change === "1" ? { change: 1 } : {}),
  component: VettingScreen,
});

const HOLD_HARMLESS_VERSION = "hh-v1";
const HOLD_HARMLESS_TEXT =
  "I acknowledge that while the platform vets all members, I remain responsible for my final property decisions.";

interface BuyerRow {
  id: string;
  onboarding_status: string;
  priority_rank_timestamp: string | null;
}

interface MemberRow {
  id: string;
  full_name: string;
  vetting_status: string;
}

interface DeclarationView {
  current: DeclarationSummary | null;
  verifiedName: string | null;
  vettingStatus: string | null;
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

  const [declaration, setDeclaration] = useState<DeclarationView | null>(null);
  const [held, setHeld] = useState(false);

  const [hhChecked, setHhChecked] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [signedName, setSignedName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [signed, setSigned] = useState(false);

  const loadDeclaration = useCallback(async (memberId: string): Promise<DeclarationView | null> => {
    try {
      const st = await getDeclarationState({ data: { actingMemberId: memberId } });
      return { current: st.current as DeclarationSummary | null, verifiedName: st.verifiedName, vettingStatus: st.vettingStatus };
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load your declaration.");
      return null;
    }
  }, []);

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
        .select("id, full_name, vetting_status")
        .eq("buyer_account_id", b.id)
        .eq("id", actingMemberId)
        .eq("status", "active")
        .maybeSingle();
      // This member's own hold harmless, if already signed.
      const { data: hh } = m
        ? await supabase.from("signed_documents").select("id").eq("buyer_account_id", b.id).eq("document_type", "HOLD_HARMLESS").eq("account_member_id", m.id).limit(1)
        : { data: [] };
      const state = m ? await loadDeclaration(m.id) : null;
      if (cancelled) return;
      setBuyer(b as BuyerRow);
      setMember((m as MemberRow) ?? null);
      setDeclaration(state);
      setSignedName(m?.full_name ?? "");
      if ((hh ?? []).length) {
        setSigned(true);
        setHhChecked(true);
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, loading, navigate, actingMemberId, loadDeclaration]);

  const declared = declaration?.current?.status === "complete";
  const reportingChange = Route.useSearch().change === 1 && declared;
  const holdHarmlessHash = useMemo(
    () => hashDocument(`${HOLD_HARMLESS_VERSION}::${HOLD_HARMLESS_TEXT}`),
    [],
  );

  async function submitDeclaration(input: DeclarationSubmit) {
    if (!member) return;
    const result = await submitEligibilityDeclaration({ data: { actingMemberId: member.id, ...input } });
    if (result.status === "complete") toast.success("Declaration recorded.");
    if (buyer) {
      await supabase
        .from("buyer_accounts")
        .update({ last_activity_at: new Date().toISOString(), stall_warning_sent_at: null })
        .eq("id", buyer.id);
    }
    setDeclaration(await loadDeclaration(member.id));
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

  async function continueFromDeclaration() {
    if (!buyer) return;
    // Every active member makes their own declaration and signs their own hold harmless before the account moves on.
    const { data: everyone } = await supabase
      .from("account_members")
      .select("id, full_name, role, vetting_status")
      .eq("buyer_account_id", buyer.id)
      .eq("status", "active");
    const [{ data: hhRows }, { data: declRows }] = await Promise.all([
      supabase.from("signed_documents").select("account_member_id").eq("buyer_account_id", buyer.id).eq("document_type", "HOLD_HARMLESS"),
      supabase.from("eligibility_declarations").select("account_member_id").eq("buyer_account_id", buyer.id).eq("status", "complete"),
    ]);
    const signedIds = new Set(((hhRows ?? []) as Array<{ account_member_id: string | null }>).map((r) => r.account_member_id));
    const declaredIds = new Set(((declRows ?? []) as Array<{ account_member_id: string }>).map((r) => r.account_member_id));
    const members = (everyone ?? []) as Array<{ id: string; full_name: string; role: string; vetting_status: string }>;
    const waiting = members.filter((m) => !declaredIds.has(m.id) || !signedIds.has(m.id));
    if (waiting.length > 0) {
      toast.success(`Done for you. Next: ${waiting.map((m) => m.full_name || (m.role === "primary" ? "the account holder" : "the second member")).join(" and ")} completes vetting.`);
      onSwitch();
      return;
    }
    // A "No" to any statement is held for divieight's review; the account waits here until then.
    if (members.some((m) => m.vetting_status !== "cleared")) {
      setHeld(true);
      return;
    }
    // Cleared buyers now pass through the Plaid liquidity gate before the
    // Golden Ticket can be issued.
    await supabase
      .from("buyer_accounts")
      .update({ last_activity_at: new Date().toISOString(), stall_warning_sent_at: null, onboarding_status: "liquidity_pending" })
      .eq("id", buyer.id);
    navigate({ to: "/buyer/onboarding/liquidity" });
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
          Vetting & Security Clearance
        </h1>
        <p className="mt-3 text-base text-muted-foreground">
          Every divieight co-owner makes their own Eligibility Declaration and Authorization before reservations unlock.
        </p>
      </div>

      {member ? (
        <EligibilityDeclaration
          key={declaration?.current?.id ?? "new"}
          memberName={member.full_name}
          verifiedName={declaration?.verifiedName ?? null}
          current={declaration?.current ?? null}
          reportChange={reportingChange}
          onSubmit={submitDeclaration}
        />
      ) : null}

      {declared && declaration?.vettingStatus === "held" ? (
        <div className={`mt-6 rounded-xl border p-5 ${RESULT_TONES.held}`}>
          <p className="font-display text-base font-semibold">{RESULT_LABELS.held}</p>
          <p className="mt-1 text-sm">{HELD_BUYER_TEXT}</p>
        </div>
      ) : null}
      {declared && declaration?.vettingStatus === "not_eligible" ? (
        <div className={`mt-6 rounded-xl border p-5 ${RESULT_TONES.not_eligible}`}>
          <p className="font-display text-base font-semibold">{RESULT_LABELS.not_eligible}</p>
          <p className="mt-1 text-sm">
            Under the Participant Eligibility Standard, this member can't take part. If an answer was recorded wrongly, you can correct it and resubmit.
          </p>
        </div>
      ) : null}

      {held ? (
        <div className="mt-6 rounded-xl border border-accent/50 bg-accent/10 p-5">
          <p className="font-display text-base font-semibold text-foreground">Your account is pending</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Every member has declared. The account moves on once every member's result is eligible. If a member is held, it waits until the disclosed charge is resolved.
          </p>
        </div>
      ) : null}

      <>
          {/* Hold harmless */}          {/* Hold harmless */}
          {declared ? (
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
                <Button onClick={continueFromDeclaration} disabled={!signed}>
                  Continue
                </Button>
              </div>
            </section>
          ) : null}
      </>

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
