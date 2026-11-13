import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled daily job: for the year that has just ended, make the Year-End CPA Export Packet for every LLC that has books for it and no packet
 * yet (within 30 days of year-end), and alert the Manager if one could not be made by the deadline. Caller must present the shared secret; the
 * job is idempotent.
 */
export const Route = createFileRoute("/api/public/year-end-packet-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["ESCALATION_SWEEP_SECRET"];
        const provided = request.headers.get("x-sweep-secret") ?? new URL(request.url).searchParams.get("secret");
        if (!secret || provided !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
        const { runPacketSweep } = await import("@/lib/year-end-packet.server");
        const result = await runPacketSweep(supabaseAdmin as never);

        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
