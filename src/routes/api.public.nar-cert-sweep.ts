import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";
import { runNarCertSweep } from "@/lib/nar-cert.functions";

/**
 * Entry point for the NAR re-certification sweep.
 *
 * TODO(cron): schedule a daily POST here (pg_cron + pg_net) with the project's
 * publishable key in the `apikey` header. Manual POSTs work today.
 */
export const Route = createFileRoute("/api/public/nar-cert-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "nar-cert-sweep", async () => {
          const result = await runNarCertSweep();
          return result;
        }),
    },
  },
});
