import { createFileRoute } from "@tanstack/react-router";

/**
 * Startup / health check: do the questions and the engine's rules in this build still match the live Standard version?
 * 200 when they do (or the live version has no stored hash yet), 500 with the message when they don't. Reveals nothing but
 * a yes or no and the version.
 */
export const Route = createFileRoute("/api/public/standard-rules-check")({
  server: {
    handlers: {
      GET: async () => {
        const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
        const { checkStandardRules } = await import("@/lib/standard-rules-check.server");
        const check = await checkStandardRules(supabaseAdmin as never);
        return new Response(JSON.stringify({ ok: check.ok, message: check.message, liveVersion: check.liveVersion }), {
          status: check.ok ? 200 : 500,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
