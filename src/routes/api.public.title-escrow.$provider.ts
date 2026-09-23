import { createFileRoute } from "@tanstack/react-router";

/**
 * Inbound title/escrow webhooks: POST /api/public/title-escrow/<provider>.
 * The provider's adapter authenticates the signature and normalizes the body;
 * a new provider (SoftPro) only needs a new adapter, not a new endpoint.
 *
 * TODO(qualia-credentials): register this URL with Qualia and set
 * QUALIA_WEBHOOK_SECRET — until then every real delivery is rejected (401)
 * and milestones come from the admin simulation panel.
 */
export const Route = createFileRoute("/api/public/title-escrow/$provider")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const rawBody = await request.text();
        const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
        const { ingestTitleWebhook } = await import("@/lib/title-escrow.server");
        let result;
        try {
          result = await ingestTitleWebhook(supabaseAdmin as never, params.provider, rawBody, request.headers);
        } catch (e) {
          const message = e instanceof Error ? e.message : "error";
          const status = /No title\/escrow adapter/.test(message) ? 404 : /JSON/.test(message) ? 400 : 500;
          return Response.json({ error: message }, { status });
        }
        if (result.status === "unauthorized") return new Response("Unauthorized", { status: 401 });
        // Duplicates and unknown orders are acknowledged so the provider stops retrying.
        return Response.json(result, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
