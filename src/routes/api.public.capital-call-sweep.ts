import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Scheduled sweep: a capital call share past its due date becomes overdue and the
 * holder gets a notice. Overdue never takes anything away from an owner.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/capital-call-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "capital-call-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { settleOverdue } = await import("@/lib/expenses.server");
          const result = await settleOverdue(supabaseAdmin as never);
          return result;
        }),
    },
  },
});
