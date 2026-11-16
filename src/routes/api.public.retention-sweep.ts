import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Scheduled sweep: a Retention Lock release vote past its closing time closes
 * and its exception is decided, even if nobody opens the page.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/retention-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "retention-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { settleVoteExceptions } = await import("@/lib/retention.server");
          const settled = await settleVoteExceptions(supabaseAdmin as never);
          return { settled };
        }),
    },
  },
});
