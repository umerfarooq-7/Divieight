import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { rememberToken, stampStoredAttribution } from "@/lib/agent-qr";
import { recordAttributionVisit } from "@/lib/agent-qr.functions";

/** Where a link lands. Becomes /library once the Buyer Library is built. */
const LANDING = "/";

export const Route = createFileRoute("/a/$token")({
  head: () => ({
    meta: [
      { title: "Redirecting — divieight" },
      { name: "description", content: "Following an agent's link into divieight." },
      { property: "og:title", content: "divieight" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AttributionLanding,
});

function AttributionLanding() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const visit = useServerFn(recordAttributionVisit);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void (async () => {
      try {
        const { active } = await visit({ data: { token } });
        if (active) {
          rememberToken(token);
          // Already signed in and part-way through onboarding: nothing else would stamp them.
          const { data } = await supabase.auth.getSession();
          if (data.session) await stampStoredAttribution();
        }
      } catch {
        /* attribution is best-effort: it never stops anyone reaching the site */
      } finally {
        navigate({ to: LANDING, replace: true });
      }
    })();
  }, [token, visit, navigate]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 text-center">
      <p className="text-sm text-muted-foreground">Taking you to divieight…</p>
    </div>
  );
}
