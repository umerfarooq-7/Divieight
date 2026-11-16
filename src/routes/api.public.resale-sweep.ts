import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Scheduled sweep: a resale listing past its right-of-first-refusal window moves
 * to the open market, or to conflict resolution if a co-owner exercised.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/resale-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "resale-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { settleRofr } = await import("@/lib/resale.server");
          const result = await settleRofr(supabaseAdmin as never);
          return result;
        }),
    },
  },
});
