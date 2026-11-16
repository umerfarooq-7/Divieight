import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";
import { runDiligenceEscalationSweep } from "@/lib/due-diligence.server";

/**
 * Entry point for the 7-day Resident Agent acknowledgment escalation sweep.
 * Schedule a daily POST here with the project's publishable key in `apikey`.
 */
export const Route = createFileRoute("/api/public/diligence-escalation")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "diligence-escalation", async () => {
          const result = await runDiligenceEscalationSweep();
          return result;
        }),
    },
  },
});
