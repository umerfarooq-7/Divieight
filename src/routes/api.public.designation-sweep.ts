import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";
import { runDesignationSweep } from "@/lib/designation.functions";
import { runTetherResolutionSweep } from "@/lib/tether-resolution.functions";

/**
 * 3-calendar-day Buyer-Designated Agent acceptance window sweep, plus the
 * tether failure detection pass (undeliverable notice, 72h buyer silence,
 * 14-day Pending Tether).
 *
 * TODO(cron): schedule a daily POST here (pg_cron + pg_net) with the project's
 * publishable key in the `apikey` header. Manual POSTs work today.
 */
export const Route = createFileRoute("/api/public/designation-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "designation-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const db = supabaseAdmin as unknown as { from: (t: string) => any };
          const designation = await runDesignationSweep(db);
          const alerts = await runTetherResolutionSweep(db);
          return { designation, alerts };
        }),
    },
  },
});
