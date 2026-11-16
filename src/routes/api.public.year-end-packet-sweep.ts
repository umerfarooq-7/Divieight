import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Scheduled daily job: for the year that has just ended, make the Year-End CPA Export Packet for every LLC that has books for it and no packet
 * yet (within 30 days of year-end), and alert the Manager if one could not be made by the deadline. Caller must present the shared secret; the
 * job is idempotent.
 */
export const Route = createFileRoute("/api/public/year-end-packet-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "year-end-packet-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { runPacketSweep } = await import("@/lib/year-end-packet.server");
          const result = await runPacketSweep(supabaseAdmin as never);
          return result;
        }),
    },
  },
});
