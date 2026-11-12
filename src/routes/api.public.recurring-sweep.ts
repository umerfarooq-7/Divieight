import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled daily job: post each LLC's recurring expenses that are due, once per due date, and log every application.
 * Caller must present the shared secret; the job is idempotent.
 */
export const Route = createFileRoute("/api/public/recurring-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["ESCALATION_SWEEP_SECRET"];
        const provided = request.headers.get("x-sweep-secret") ?? new URL(request.url).searchParams.get("secret");
        if (!secret || provided !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
        const { applyDueRecurring } = await import("@/lib/books.server");
        const result = await applyDueRecurring(supabaseAdmin as never, {});

        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
