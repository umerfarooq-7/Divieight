import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Scheduled sweep: mark earnest-money obligations late once their deadline
 * passes, and after the grace period declare the Default under PRA Section 8,
 * which opens the existing Member Substitution Pipeline.
 *
 * Caller must present the shared secret; the endpoint is bounded and
 * idempotent, so repeated calls are safe.
 */
export const Route = createFileRoute("/api/public/earnest-money-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "earnest-money-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { runEarnestMoneySweep } = await import("@/lib/earnest-money.server");
          const result = await runEarnestMoneySweep(supabaseAdmin as never, null);
          return result;
        }),
    },
  },
});
