import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled sweep: a Retention Lock release vote past its closing time closes
 * and its exception is decided, even if nobody opens the page.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/retention-sweep")({
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
        const { settleVoteExceptions } = await import("@/lib/retention.server");
        const settled = await settleVoteExceptions(supabaseAdmin as never);

        return new Response(JSON.stringify({ settled }), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
