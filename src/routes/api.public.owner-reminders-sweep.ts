import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Hourly sweep: votes closing in 48h, capital calls due in 7 days, Use Calendar turns
 * ending in 12h and rights of first refusal closing in 24h. Each goes to an owner once.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/owner-reminders-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "owner-reminders-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { sendOwnerReminders } = await import("@/lib/owner-notifications.server");
          const result = await sendOwnerReminders(supabaseAdmin as never);
          return result;
        }),
    },
  },
});
