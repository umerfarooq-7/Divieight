import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Hourly sweep: brings conversion_events up to date with signed PRAs and cleared
 * PEFs, in case a trigger was missed.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/conversion-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "conversion-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { runConversionSync } = await import("@/lib/conversions.server");
          const result = await runConversionSync(supabaseAdmin as never);
          return result;
        }),
    },
  },
});
