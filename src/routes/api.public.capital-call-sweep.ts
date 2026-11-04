import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled sweep: a capital call share past its due date becomes overdue and the
 * holder gets a notice. Overdue never takes anything away from an owner.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/capital-call-sweep")({
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
        const { settleOverdue } = await import("@/lib/expenses.server");
        const result = await settleOverdue(supabaseAdmin as never);

        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
