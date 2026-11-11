import { createFileRoute } from "@tanstack/react-router";
import { EligibilityStandardPage } from "@/components/EligibilityStandardPage";
import { decisionPageCopy } from "@/constants/eligibilityCopy";

/** Module 1: after the Buyer Persona survey, before the Priority Reservation Agreement. */
export const Route = createFileRoute("/buyer/onboarding/eligibility")({
  head: () => ({
    meta: [
      { title: "Participant Eligibility Standard" },
      { name: "description", content: decisionPageCopy.heading },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => <EligibilityStandardPage next="/buyer/onboarding/payment" />,
});
