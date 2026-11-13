import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled daily job: from the first business day of the month, make (or refresh) the drafts of the previous month's statements for every
 * LLC and every member, draft a new version where a correction changed an issued month, and alert the Manager if the deadline has passed
 * with drafts waiting. Caller must present the shared secret; the job is idempotent.
 */
export const Route = createFileRoute("/api/public/statements-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["ESCALATION_SWEEP_SECRET"];
        const provided = request.headers.get("x-sweep-secret") ?? new URL(request.url).searchParams.get("secret");
        if (!secret || provided !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
        const { runStatementsSweep } = await import("@/lib/statements.server");
        const result = await runStatementsSweep(supabaseAdmin as never);

        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
