import { createFileRoute } from "@tanstack/react-router";

/**
 * Nightly sweep: an open-market resale listing past its expiry (the governance setting, 180 days by default) moves to
 * 'expired', and the seller is told they can list it again. Also lets an offer to the next co-owner lapse.
 *
 * Caller must present the shared secret; the endpoint is idempotent.
 */
export const Route = createFileRoute("/api/public/resale-expiry-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["ESCALATION_SWEEP_SECRET"];
        const provided = request.headers.get("x-sweep-secret") ?? new URL(request.url).searchParams.get("secret");
        if (!secret || provided !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
        const { expireOpenMarketListings, settleOffers } = await import("@/lib/resale.server");
        const expired = await expireOpenMarketListings(supabaseAdmin as never);
        const lapsed = await settleOffers(supabaseAdmin as never);

        return new Response(JSON.stringify({ expired, lapsed }), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
