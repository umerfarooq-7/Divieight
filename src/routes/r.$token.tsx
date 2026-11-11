import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { resolveAttributionToken } from "@/lib/attribution.functions";
import { rememberToken, stampStoredAttribution } from "@/lib/agent-qr";
import { getAttributionLanding } from "@/lib/agent-qr.functions";

export const Route = createFileRoute("/r/$token")({
  head: () => ({
    meta: [
      { title: "Redirecting — divieight" },
      {
        name: "description",
        content: "Following an agent referral link into divieight.",
      },
      { property: "og:title", content: "Redirecting — divieight" },
      {
        property: "og:description",
        content: "Following an agent referral link into divieight.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ReferralResolver,
});

/**
 * An older /r link still redirects, and still counts the click. It no longer sets a referring agent: like a /a link it
 * only records a suggestion (the same stamp, first one wins), and the buyer confirms the agent on the agent-selection step.
 */
function ReferralResolver() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const resolve = useServerFn(resolveAttributionToken);
  const landingFn = useServerFn(getAttributionLanding);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    resolve({ data: { token } })
      .then(async (result) => {
        if (result.found && result.token) {
          rememberToken(result.token);
          // Already signed in and part-way through onboarding: nothing else would stamp them.
          const { data } = await supabase.auth.getSession();
          if (data.session) await stampStoredAttribution();
        }
      })
      .catch(() => {
        /* attribution is best-effort — never block entry */
      })
      .finally(async () => {
        const landing = await landingFn().catch(() => "/" as const);
        navigate({ to: landing, replace: true });
      });
  }, [token, resolve, landingFn, navigate]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 text-center">
      <p className="text-sm text-muted-foreground">Taking you to divieight…</p>
    </div>
  );
}
