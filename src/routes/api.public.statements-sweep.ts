import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Scheduled daily job: from the first business day of the month, make (or refresh) the drafts of the previous month's statements for every
 * LLC and every member, draft a new version where a correction changed an issued month, and alert the Manager if the deadline has passed
 * with drafts waiting. Caller must present the shared secret; the job is idempotent.
 */
export const Route = createFileRoute("/api/public/statements-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "statements-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { runStatementsSweep } = await import("@/lib/statements.server");
          const result = await runStatementsSweep(supabaseAdmin as never);
          return result;
        }),
    },
  },
});
