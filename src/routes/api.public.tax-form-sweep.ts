import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled daily job: a Broker of Record whose W-8 has lapsed is told, once, with the link to submit a new one (the payout gate already refuses them).
 * Caller must present the shared secret; the job is idempotent.
 */
export const Route = createFileRoute("/api/public/tax-form-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["ESCALATION_SWEEP_SECRET"];
        const provided = request.headers.get("x-sweep-secret") ?? new URL(request.url).searchParams.get("secret");
        if (!secret || provided !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
        const { runTaxFormSweep } = await import("@/lib/tax-forms.server");
        const result = await runTaxFormSweep(supabaseAdmin as never);

        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
