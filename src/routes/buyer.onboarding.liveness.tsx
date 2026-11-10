import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { BuyerOnboardingStepper } from "@/components/BuyerOnboardingStepper";
import { Button } from "@/components/ui/button";
import { ActingMemberGate } from "@/components/ActingMemberGate";
import { SelfieCapture } from "@/components/SelfieCapture";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { LIVENESS_STATE_COPY, type LivenessStatus } from "@/lib/liveness";
import { getLivenessState, submitLivenessSelfie } from "@/lib/liveness.functions";

export const Route = createFileRoute("/buyer/onboarding/liveness")({
  head: () => ({
    meta: [
      { title: "Liveness check — divieight" },
      { name: "description", content: "Take a selfie so divieight can confirm a real person is present and that the ID document is theirs." },
    ],
  }),
  component: LivenessScreen,
});

function LivenessScreen() {
  return (
    <ActingMemberGate step="Step 2 · Liveness">
      {({ member, switchPerson }) => <LivenessForMember key={member.id} actingMemberId={member.id} memberName={member.fullName ?? ""} onSwitch={switchPerson} />}
    </ActingMemberGate>
  );
}

type State = Awaited<ReturnType<typeof getLivenessState>>;

const TONE: Record<LivenessStatus, string> = {
  passed: "border-primary/40 bg-primary/5",
  failed: "border-destructive/40 bg-destructive/5",
  inconclusive: "border-accent/50 bg-accent/10",
  pending: "border-border bg-muted/40",
};

function LivenessForMember({ actingMemberId, memberName, onSwitch }: { actingMemberId: string; memberName: string; onSwitch: () => void }) {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [state, setState] = useState<State | null>(null);
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [next, setNext] = useState<Array<{ name: string; step: "identity" | "liveness" }> | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await getLivenessState({ data: { actingMemberId } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load the liveness check.");
    }
  }, [actingMemberId]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/buyer/login", replace: true });
      return;
    }
    void load();
  }, [user, loading, navigate, load]);

  async function onCaptured(file: File) {
    if (!user) return;
    setPreview(URL.createObjectURL(file));
    setChecking(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `${user.id}/selfie-${actingMemberId}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("liveness-selfies").upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw new Error(error.message);
      const result = await submitLivenessSelfie({ data: { actingMemberId, selfiePath: path, selfieFileName: file.name, contentType: file.type } });
      await load();
      if (result.status === "inconclusive") {
        toast.message("We've opened a Verification Request.");
        navigate({ to: "/buyer/verification" });
        return;
      }
      if (result.status === "passed") {
        if (result.advanced) {
          navigate({ to: "/buyer/onboarding/lifestyle" });
          return;
        }
        setNext(result.waitingOn);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The liveness check didn't go through. Try again.");
    } finally {
      setChecking(false);
    }
  }

  const latest = state?.latest?.status ?? null;
  const shown: LivenessStatus | null = checking ? "pending" : latest;

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <BuyerOnboardingStepper current={1} />
      <div className="mt-10">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Step 2 · Liveness</p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Confirm it's really you</h1>
        <p className="mt-3 text-base text-muted-foreground">
          {memberName ? `${memberName}, take` : "Take"} a selfie. We compare it with the ID you uploaded to confirm that a real person is present and that the document is yours.
        </p>
      </div>

      {!state ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading…</p>
      ) : !state.hasIdDocument ? (
        <section className="mt-8 rounded-xl border border-border bg-card p-6">
          <p className="text-sm text-foreground">Upload this member's ID photo first. The selfie is checked against it.</p>
          <Button asChild className="mt-4">
            <Link to="/buyer/onboarding/identity">Go to the identity step</Link>
          </Button>
        </section>
      ) : (
        <>
          {shown ? (
            <div role="status" className={cn("mt-8 rounded-xl border p-5", TONE[shown])}>
              <p className="font-display text-base font-semibold text-foreground">{LIVENESS_STATE_COPY[shown].title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{LIVENESS_STATE_COPY[shown].body}</p>
              {shown === "inconclusive" && !checking ? (
                <Button asChild variant="outline" className="mt-3">
                  <Link to="/buyer/verification">Open the Verification Request</Link>
                </Button>
              ) : null}
            </div>
          ) : null}

          {preview && checking ? <img src={preview} alt="Your selfie" className="mx-auto mt-6 max-h-56 rounded-md border border-border object-contain" /> : null}

          {state.canAttempt && !checking ? (
            <section className="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
              <h2 className="font-display text-lg font-semibold text-foreground">{latest === "inconclusive" ? "Try another selfie" : "Take your selfie"}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {latest === "inconclusive" ? "Another attempt is added to your record; your Verification Request stays open." : "Only this member can take it."}
              </p>
              <div className="mt-4">
                <SelfieCapture disabled={checking} onCaptured={(f) => void onCaptured(f)} />
              </div>
            </section>
          ) : null}

          {latest === "passed" ? (
            <div className="mt-6 flex flex-wrap items-center gap-3">
              {next && next.length > 0 ? (
                <>
                  <p className="w-full text-sm text-muted-foreground">
                    Next: {next.map((n) => `${n.name} (${n.step === "identity" ? "identity" : "selfie"})`).join(" and ")}.
                  </p>
                  <Button
                    onClick={() => {
                      const first = next[0]!;
                      onSwitch();
                      if (first.step === "identity") navigate({ to: "/buyer/onboarding/identity" });
                    }}
                  >
                    Switch person
                  </Button>
                </>
              ) : (
                <Button asChild>
                  <Link to="/buyer/dashboard">Continue</Link>
                </Button>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
