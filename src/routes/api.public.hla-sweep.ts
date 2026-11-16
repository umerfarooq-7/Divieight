import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";
import { runHlaAcceptanceSweep } from "@/lib/hla.functions";

/**
 * 3-calendar-day Heavy Lifting Agent acceptance window sweep.
 *
 * TODO(cron): schedule a daily POST here (pg_cron + pg_net) with the project's
 * publishable key in the `apikey` header. Manual POSTs work today.
 */
export const Route = createFileRoute("/api/public/hla-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "hla-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const result = await runHlaAcceptanceSweep(
            supabaseAdmin as unknown as { from: (t: string) => any },
          );
          return result;
        }),
    },
  },
});
