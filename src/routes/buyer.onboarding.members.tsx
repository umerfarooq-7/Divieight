import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

/**
 * There is no Members step any more. Each buyer has their own account; buying with someone is a co-buyer, invited by email from the dashboard
 * (they sign up with their own account, onboarding and payment). Old links to this address go straight on to the identity step.
 */
export const Route = createFileRoute("/buyer/onboarding/members")({
  head: () => ({
    meta: [
      { title: "Buyer onboarding — divieight" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: MembersStep,
});

function MembersStep() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate({ to: "/buyer/onboarding/identity", replace: true });
  }, [navigate]);
  return <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">Loading…</div>;
}
