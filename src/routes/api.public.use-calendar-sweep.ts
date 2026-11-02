import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled sweep: a Use Calendar turn past its pick deadline is skipped and the
 * holder is notified, even if nobody opens the page.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/use-calendar-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["ESCALATION_SWEEP_SECRET"];
        const provided =
          request.headers.get("x-sweep-secret") ??
          new URL(request.url).searchParams.get("secret");
        if (!secret || provided !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
        const { runUseCalendarSweep } = await import("@/lib/use-calendar.server");
        const result = await runUseCalendarSweep(supabaseAdmin as never);

        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
