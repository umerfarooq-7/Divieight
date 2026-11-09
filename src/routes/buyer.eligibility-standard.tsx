import { createFileRoute } from "@tanstack/react-router";
import { EligibilityStandardPage } from "@/components/EligibilityStandardPage";
import { decisionPageCopy } from "@/constants/eligibilityCopy";

/** The same page, from the account menu, any time later. */
export const Route = createFileRoute("/buyer/eligibility-standard")({
  head: () => ({
    meta: [
      { title: decisionPageCopy.eyebrow },
      { name: "description", content: decisionPageCopy.heading },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => <EligibilityStandardPage next="/buyer/dashboard" />,
});
