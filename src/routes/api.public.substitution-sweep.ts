import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Scheduled sweep: expire lapsed substitution invitations and cascade the
 * offer to the next compatible candidate by Priority Rank.
 *
 * Caller must present the shared secret; the endpoint is bounded and
 * idempotent, so repeated calls are safe.
 */
export const Route = createFileRoute("/api/public/substitution-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "substitution-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { runSubstitutionExpirySweep } = await import("@/lib/substitution-invite.server");
          const result = await runSubstitutionExpirySweep(supabaseAdmin as never);
          return result;
        }),
    },
  },
});
