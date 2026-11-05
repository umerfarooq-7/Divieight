import { createFileRoute } from "@tanstack/react-router";

/**
 * Nightly: refreshes the Founder Dashboard's materialized views.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/founder-refresh")({
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
        const { refreshFounder } = await import("@/lib/founder.server");
        const result = await refreshFounder(supabaseAdmin as never);

        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
