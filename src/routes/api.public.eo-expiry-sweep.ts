import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";
import { runEoExpirySweep } from "@/lib/eo-expiry.functions";

/**
 * Entry point for the E&O coverage expiry sweep (60/30/7-day reminders and
 * the lapse on expiry). Mirrors the NAR re-certification sweep endpoint.
 *
 * TODO(cron): schedule a daily POST here (pg_cron + pg_net) with the project's
 * publishable key in the `apikey` header. Manual POSTs work today.
 */
export const Route = createFileRoute("/api/public/eo-expiry-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "eo-expiry-sweep", async () => {
          const result = await runEoExpirySweep();
          return result;
        }),
    },
  },
});
