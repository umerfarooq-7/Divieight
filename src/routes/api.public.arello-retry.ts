import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";
import { runArelloRetrySweep } from "@/lib/arello-retry.functions";

/**
 * Cron entry point for the ARELLO pending-retry sweep.
 *
 * TODO(cron): schedule an hourly POST here (pg_cron + pg_net) with the
 * project's publishable key in the `apikey` header. Manual POSTs work today.
 */
export const Route = createFileRoute("/api/public/arello-retry")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "arello-retry", async () => {
          const result = await runArelloRetrySweep();
          return result;
        }),
    },
  },
});
