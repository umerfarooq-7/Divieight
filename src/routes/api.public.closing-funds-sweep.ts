import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Scheduled sweep: mark closing-funds obligations late once their deadline
 * passes, and after the grace period declare the Default under PRA Section 8,
 * which opens the existing Member Substitution Pipeline.
 *
 * Caller must present the shared secret; the endpoint is bounded and
 * idempotent, so repeated calls are safe.
 */
export const Route = createFileRoute("/api/public/closing-funds-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "closing-funds-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { runClosingFundsSweep } = await import("@/lib/closing-funds.server");
          const result = await runClosingFundsSweep(supabaseAdmin as never, null);
          return result;
        }),
    },
  },
});
