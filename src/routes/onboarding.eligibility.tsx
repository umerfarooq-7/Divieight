import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { OnboardingStepper } from "@/components/OnboardingStepper";
import { EligibilityDeclaration, type DeclarationSubmit, type DeclarationSummary } from "@/components/EligibilityDeclaration";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { eligibilityCheckScreen, fullExitSellerNotice, hybridSellerNotice } from "@/constants/eligibilityCheckCopy";
import { HELD_BUYER_TEXT, RESULT_LABELS, RESULT_TONES } from "@/lib/eligibility-engine";
import { getSellerEligibility, submitSellerEligibility } from "@/lib/seller-eligibility.functions";

export const Route = createFileRoute("/onboarding/eligibility")({
  head: () => ({
    meta: [
      { title: "The Eligibility Check — divieight" },
      { name: "description", content: "A seller who retains shares makes the same eligibility declaration every buyer makes." },
    ],
  }),
  component: SellerEligibilityScreen,
});

type State = Awaited<ReturnType<typeof getSellerEligibility>>;

function SellerEligibilityScreen() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [state, setState] = useState<State | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await getSellerEligibility());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load the eligibility check.");
    }
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/login", replace: true });
      return;
    }
    void refresh();
  }, [user, loading, navigate, refresh]);

  async function onSubmit(input: DeclarationSubmit) {
    await submitSellerEligibility({ data: { answers: input.answers, attestedPersonally: input.attestedPersonally, signedName: input.signedName, supersedesId: input.supersedesId } });
    toast.success("Declaration recorded.");
    await refresh();
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <OnboardingStepper current={2} />
      <div className="mt-10">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">The Eligibility Check</p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{eligibilityCheckScreen.heading}</h1>
        <p className="mt-3 text-base text-muted-foreground">{eligibilityCheckScreen.body}</p>
      </div>

      {!state ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading…</p>
      ) : !state.required ? (
        <section className="mt-8 rounded-xl border border-border bg-card p-6">
          <p className="text-sm text-foreground">{fullExitSellerNotice}</p>
          <Button asChild className="mt-4">
            <Link to="/onboarding/property">Continue</Link>
          </Button>
        </section>
      ) : (
        <>
          <p className="mt-4 text-sm text-muted-foreground">{hybridSellerNotice}</p>
          {!state.verifiedName ? (
            <section className="mt-8 rounded-xl border border-border bg-card p-6">
              <p className="text-sm text-foreground">Finish the identity step first. Your signature is checked against the name you gave there.</p>
              <Button asChild className="mt-4">
                <Link to="/onboarding/identity">Go to the identity step</Link>
              </Button>
            </section>
          ) : (
            <EligibilityDeclaration
              key={state.current?.id ?? "new"}
              memberName={state.verifiedName}
              verifiedName={state.verifiedName}
              current={(state.current as DeclarationSummary | null) ?? null}
              onSubmit={onSubmit}
            />
          )}
          {state.result === "held" ? (
            <div className={`mt-6 rounded-xl border p-5 ${RESULT_TONES.held}`}>
              <p className="font-display text-base font-semibold">{RESULT_LABELS.held}</p>
              <p className="mt-1 text-sm">{HELD_BUYER_TEXT}</p>
            </div>
          ) : null}
          {state.result === "not_eligible" ? (
            <div className={`mt-6 rounded-xl border p-5 ${RESULT_TONES.not_eligible}`}>
              <p className="font-display text-base font-semibold">{RESULT_LABELS.not_eligible}</p>
              <p className="mt-1 text-sm">Under the Participant Eligibility Standard, this declaration doesn't qualify. If an answer was recorded wrongly, you can correct it and resubmit.</p>
            </div>
          ) : null}
          {state.current?.status === "complete" ? (
            <Button asChild className="mt-6">
              <Link to="/onboarding/property">Continue</Link>
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
