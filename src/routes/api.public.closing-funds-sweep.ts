import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled sweep: mark closing-funds obligations late once their deadline
 * passes, and after the grace period declare the Default under PRA Section 8,
 * which opens the existing Member Substitution Pipeline.
 *
 * Caller must present the shared secret; the endpoint is bounded and
 * idempotent, so repeated calls are safe.
 */
export const Route = createFileRoute("/api/public/closing-funds-sweep")({
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
        const { runClosingFundsSweep } = await import("@/lib/closing-funds.server");
        const result = await runClosingFundsSweep(supabaseAdmin as never, null);

        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
