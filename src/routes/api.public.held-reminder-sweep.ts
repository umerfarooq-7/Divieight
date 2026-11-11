import { createFileRoute } from "@tanstack/react-router";

/**
 * Nightly sweep: a member held for the configured number of days (30) with no reminder in that long raises one admin
 * reminder. It touches nothing on the account and tells neither the buyer nor the agent.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/held-reminder-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["ESCALATION_SWEEP_SECRET"];
        const provided = request.headers.get("x-sweep-secret") ?? new URL(request.url).searchParams.get("secret");
        if (!secret || provided !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
        const { runHeldReminders } = await import("@/lib/held-reminders.server");
        const result = await runHeldReminders(supabaseAdmin as never);

        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
