import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Scheduled daily job: post each LLC's recurring expenses that are due, once per due date, and log every application.
 * Caller must present the shared secret; the job is idempotent.
 */
export const Route = createFileRoute("/api/public/recurring-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "recurring-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { applyDueRecurring } = await import("@/lib/books.server");
          const result = await applyDueRecurring(supabaseAdmin as never, {});
          return result;
        }),
    },
  },
});
