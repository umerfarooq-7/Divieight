import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled daily job: pull each LLC operating account's new bank transactions, upsert them (no duplicates, pending
 * becomes posted on the same record), categorize, and log the run in the Audit Vault.
 *
 * Caller must present the shared secret; the job is idempotent.
 */
export const Route = createFileRoute("/api/public/bank-feed-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["ESCALATION_SWEEP_SECRET"];
        const provided = request.headers.get("x-sweep-secret") ?? new URL(request.url).searchParams.get("secret");
        if (!secret || provided !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
        const { runBankFeed } = await import("@/lib/bank-feed.server");
        const { getBankFeedAdapter } = await import("@/lib/bank-feed-adapters");
        const result = await runBankFeed(supabaseAdmin as never, (provider) => getBankFeedAdapter(provider), { trigger: "schedule" });

        return new Response(JSON.stringify({ runId: result.runId, properties: result.properties.length, failed: result.properties.filter((p) => p.error).length }), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
