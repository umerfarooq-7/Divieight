import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled nightly job: classifies every Know Your Owner record, archives accounts that have ended, computes retain_until, and opens a Retention review for each record
 * past its period. It never deletes or anonymizes anything: a founder approves each erasure, with a reason, and a legal hold blocks it.
 * Caller must present the shared secret; the job is idempotent.
 */
export const Route = createFileRoute("/api/public/kyo-retention-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["ESCALATION_SWEEP_SECRET"];
        const provided = request.headers.get("x-sweep-secret") ?? new URL(request.url).searchParams.get("secret");
        if (!secret || provided !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
        const { runRetentionSweep } = await import("@/lib/kyo-retention.server");
        const result = await runRetentionSweep(supabaseAdmin as never);

        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
