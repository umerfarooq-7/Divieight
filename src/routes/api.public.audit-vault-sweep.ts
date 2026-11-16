import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";

/**
 * Scheduled nightly job: recomputes the Audit Vault hash chain and stores the result, looks for changes to commission, referral, ownership and cap table data
 * that no application record accounts for, and tells the Compliance Officer (in the app and by email) about anything new. A broken chain is a critical alert.
 * Caller must present the shared secret; the job is idempotent.
 */
export const Route = createFileRoute("/api/public/audit-vault-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "audit-vault-sweep", async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
          const { runAuditVaultSweep } = await import("@/lib/audit-vault.server");
          const result = await runAuditVaultSweep(supabaseAdmin as never);
          return result;
        }),
    },
  },
});
