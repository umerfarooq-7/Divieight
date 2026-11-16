import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Scheduled sweep: a bound homeowners policy whose renewal date has passed
 * without a bound renewal is marked lapsed, and admins are alerted.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/insurance-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "insurance-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { runInsuranceLapseSweep } = await import("@/lib/insurance.server");
          const result = await runInsuranceLapseSweep(supabaseAdmin as never);
          return result;
        }),
    },
  },
});
