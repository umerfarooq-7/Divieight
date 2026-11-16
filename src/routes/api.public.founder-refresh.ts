import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Nightly: refreshes the Founder Dashboard's materialized views.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/founder-refresh")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "founder-refresh", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { refreshFounder } = await import("@/lib/founder.server");
          const result = await refreshFounder(supabaseAdmin as never);
          return result;
        }),
    },
  },
});
