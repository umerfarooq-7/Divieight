import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";
import { runAuthorizationEscalationSweep } from "@/lib/authorization.server";

/**
 * Entry point for the Buyer-Authorization time-out escalation sweep.
 * Schedule a frequent POST here with the project's publishable key in `apikey`.
 * This sweep never grants authorization — it only escalates non-response.
 */
export const Route = createFileRoute("/api/public/authorization-escalation")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "authorization-escalation", async () => {
          return await runAuthorizationEscalationSweep();
        }),
    },
  },
});
