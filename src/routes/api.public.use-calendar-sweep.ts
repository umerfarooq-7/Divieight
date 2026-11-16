import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Scheduled sweep: a Use Calendar turn past its pick deadline is skipped and the
 * holder is notified, even if nobody opens the page.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/use-calendar-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "use-calendar-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { runUseCalendarSweep } = await import("@/lib/use-calendar.server");
          const result = await runUseCalendarSweep(supabaseAdmin as never);
          return result;
        }),
    },
  },
});
