import { createFileRoute } from "@tanstack/react-router";
import { runSweep } from "@/lib/job-runner.server";
import { runEnrollmentMaintenance } from "@/lib/enrollment-maintenance.functions";

/**
 * Cron entry point for the 30-Day Enrollment Maintenance sweep.
 *
 * TODO(cron): no scheduler is wired yet. Once pg_cron + pg_net are enabled,
 * schedule a daily POST here with the project's anon key in the `apikey`
 * header. Until then the sweep is fired manually from /admin/audit-log.
 */
export const Route = createFileRoute("/api/public/enrollment-maintenance")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runSweep(request, "enrollment-maintenance", async () => {
          const result = await runEnrollmentMaintenance();
          return result;
        }),
    },
  },
});
