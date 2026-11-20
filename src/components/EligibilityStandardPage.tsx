import { useEffect, useState } from "react";
import { useIsCoBuyer } from "@/hooks/use-co-buyer";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ActingMemberGate } from "@/components/ActingMemberGate";
import { EligibilityStandardContent } from "@/components/EligibilityStandard";
import { acknowledgeEligibilityStandard } from "@/lib/eligibility-standard.functions";
import { getLiveStandardFn } from "@/lib/standard-version.functions";

/**
 * Shown once per Account Member. Each member reads it in their own turn and carries on; nobody is asked to switch here.
 */
export function EligibilityStandardPage({ next }: { next: "/buyer/onboarding/pra-review" | "/buyer/onboarding/payment" | "/buyer/dashboard" }) {
  return (
    <ActingMemberGate step="Participant Eligibility Standard" journey={next !== "/buyer/dashboard"}>
      {({ member, switchPerson }) => <ForMember key={member.id} actingMemberId={member.id} next={next} onSwitch={switchPerson} />}
    </ActingMemberGate>
  );
}

function ForMember({ actingMemberId, next, onSwitch }: { actingMemberId: string; next: string; onSwitch: () => void }) {
  const navigate = useNavigate();
  // A co-buyer has no pre-payment review: they pay from their portal, so it is on to the agreement.
  const isCoBuyer = useIsCoBuyer();
  const acknowledge = useServerFn(acknowledgeEligibilityStandard);
  const [busy, setBusy] = useState(false);
  // The version shown is the live one: the same source the declaration is recorded under.
  const [version, setVersion] = useState<string | undefined>(undefined);
  useEffect(() => {
    void getLiveStandardFn().then((s) => setVersion(s.version)).catch(() => undefined);
  }, []);
  const onContinue = async () => {
    setBusy(true);
    try {
      await acknowledge({ data: { actingMemberId } });
      // One person at a time: each member carries on after reading. The other member reads it in their own turn.
      navigate({ to: (isCoBuyer && next === "/buyer/onboarding/pra-review" ? "/buyer/onboarding/payment" : next) as never });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <EligibilityStandardContent onContinue={() => void onContinue()} busy={busy} version={version} />;
}
