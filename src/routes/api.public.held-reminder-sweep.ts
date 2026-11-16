import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Nightly sweep: a member held for the configured number of days (30) with no reminder in that long raises one admin
 * reminder. It touches nothing on the account and tells neither the buyer nor the agent.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/held-reminder-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "held-reminder-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { runHeldReminders } = await import("@/lib/held-reminders.server");
          const result = await runHeldReminders(supabaseAdmin as never);
          return result;
        }),
    },
  },
});
