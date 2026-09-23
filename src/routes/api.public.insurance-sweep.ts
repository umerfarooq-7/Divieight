import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled sweep: a bound homeowners policy whose renewal date has passed
 * without a bound renewal is marked lapsed, and admins are alerted.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/insurance-sweep")({
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
        const { runInsuranceLapseSweep } = await import("@/lib/insurance.server");
        const result = await runInsuranceLapseSweep(supabaseAdmin as never);

        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
