import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ActingMemberGate } from "@/components/ActingMemberGate";
import { EligibilityStandardContent } from "@/components/EligibilityStandard";
import { acknowledgeEligibilityStandard } from "@/lib/eligibility-standard.functions";

/**
 * Shown once per Account Member through the "Who is acting?" switcher. When the other
 * member still has to read it, Continue hands over to them; once everyone has, it moves on.
 */
export function EligibilityStandardPage({ next }: { next: "/buyer/onboarding/payment" | "/buyer/dashboard" }) {
  return (
    <ActingMemberGate step="Participant Eligibility Standard">
      {({ member, switchPerson }) => <ForMember key={member.id} actingMemberId={member.id} next={next} onSwitch={switchPerson} />}
    </ActingMemberGate>
  );
}

function ForMember({ actingMemberId, next, onSwitch }: { actingMemberId: string; next: string; onSwitch: () => void }) {
  const navigate = useNavigate();
  const acknowledge = useServerFn(acknowledgeEligibilityStandard);
  const [busy, setBusy] = useState(false);
  const onContinue = async () => {
    setBusy(true);
    try {
      const { remaining } = await acknowledge({ data: { actingMemberId } });
      if (remaining > 0) onSwitch();
      else navigate({ to: next as never });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <EligibilityStandardContent onContinue={() => void onContinue()} busy={busy} />;
}
