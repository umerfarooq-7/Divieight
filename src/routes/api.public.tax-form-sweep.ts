import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Scheduled daily job: a Broker of Record whose W-8 has lapsed is told, once, with the link to submit a new one (the payout gate already refuses them).
 * Caller must present the shared secret; the job is idempotent.
 */
export const Route = createFileRoute("/api/public/tax-form-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "tax-form-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { runTaxFormSweep } = await import("@/lib/tax-forms.server");
          const result = await runTaxFormSweep(supabaseAdmin as never);
          return result;
        }),
    },
  },
});
