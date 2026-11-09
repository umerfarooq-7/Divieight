import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getBuyerAccount } from "@/lib/buyer";

export const Route = createFileRoute("/buyer/onboarding/")({
  head: () => ({
    meta: [
      { title: "Buyer onboarding — divieight" },
      {
        name: "description",
        content: "Complete buyer vetting to unlock reservations on divieight listings.",
      },
      { property: "og:title", content: "Buyer onboarding — divieight" },
      {
        property: "og:description",
        content: "Complete buyer vetting to unlock reservations on divieight listings.",
      },
    ],
  }),
  component: BuyerOnboardingPage,
});

function BuyerOnboardingPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"loading" | "ready">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!data.user) {
        navigate({ to: "/buyer/login" });
        return;
      }
      const account = await getBuyerAccount(data.user.id);
      if (cancelled) return;
      if (!account) {
        navigate({ to: "/buyer/register" });
        return;
      }
      navigate({ to: "/buyer/onboarding/members", replace: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  if (status === "loading") {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
        Loading your buyer account…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
        Buyer Onboarding
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
        Welcome to divieight
      </h1>
      <p className="mt-4 text-base text-muted-foreground">
        Your Buyer Account and primary member are set up. Vetting, intent, and target market
        steps arrive in the next build.
      </p>

      <div className="mt-10 rounded-xl border border-dashed border-border bg-card/50 p-10 text-center text-sm text-muted-foreground">
        Buyer onboarding steps will be added here.
      </div>

      <Link
        to="/buyer/dashboard"
        className="mt-8 inline-flex items-center rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
      >
        Go to buyer dashboard
      </Link>
    </div>
  );
}
