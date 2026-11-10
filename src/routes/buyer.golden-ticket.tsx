import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, Sparkles, Ticket } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { issueGoldenTicketIfEligible } from "@/lib/golden-ticket";
import { missingSteps, type MemberSteps } from "@/lib/account-rollup";
import { HELD_BUYER_TEXT, RESULT_LABELS, RESULT_TONES } from "@/lib/eligibility-engine";

export const Route = createFileRoute("/buyer/golden-ticket")({
  head: () => ({
    meta: [
      { title: "Your Golden Ticket — divieight" },
      {
        name: "description",
        content:
          "Vetted Buyer status unlocked: full access to the divieight fractional marketplace.",
      },
      { property: "og:title", content: "Your Golden Ticket — divieight" },
      {
        property: "og:description",
        content: "Vetted Buyer status unlocked on the divieight marketplace.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GoldenTicketPage,
});

function GoldenTicketPage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [state, setState] = useState<"checking" | "issued" | "blocked">("checking");
  const [missing, setMissing] = useState<string[]>([]);
  const [members, setMembers] = useState<MemberSteps[]>([]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/buyer/login", replace: true });
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: acct } = await supabase
        .from("buyer_accounts")
        .select("id")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (!acct) {
        navigate({ to: "/buyer/register", replace: true });
        return;
      }
      const result = await issueGoldenTicketIfEligible({
        authUserId: user.id,
        buyerAccountId: acct.id,
      });
      if (cancelled) return;
      setMissing(result.missing);
      setMembers(result.members);
      setState(result.issued ? "issued" : "blocked");
    })();
    return () => {
      cancelled = true;
    };
  }, [user, loading, navigate]);

  if (state === "checking") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">
        Finalising your vetting review…
      </div>
    );
  }

  if (state === "blocked") {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center sm:px-6">
        <h1 className="font-display text-2xl font-semibold text-foreground">
          Almost there
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your Golden Ticket unlocks once these are complete:
        </p>
        <ul className="mx-auto mt-6 max-w-sm space-y-2 text-left">
          {missing.map((m) => (
            <li
              key={m}
              className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground"
            >
              {m}
            </li>
          ))}
        </ul>
        <MemberStatuses members={members} />
        <Link
          to="/buyer/dashboard"
          className="mt-8 inline-block rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
      <div className="relative mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-accent/15">
        <Ticket className="h-11 w-11 text-accent" />
        <Sparkles className="absolute -right-1 -top-1 h-6 w-6 text-accent" />
      </div>
      <p className="mt-6 text-xs font-semibold uppercase tracking-[0.2em] text-accent">
        Golden Ticket issued
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold text-foreground sm:text-4xl">
        You're a Vetted Buyer!
      </h1>
      <p className="mt-3 text-base text-muted-foreground">
        You now have full access to the marketplace.
      </p>

      <ul className="mx-auto mt-8 grid max-w-md gap-3 text-left">
        {[
          "All Account Members cleared vetting",
          "Liquidity verification complete",
          "Priority Reservation Agreement executed",
        ].map((item) => (
          <li
            key={item}
            className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 text-accent" />
            {item}
          </li>
        ))}
      </ul>

      <MemberStatuses members={members} />

      <div className="mt-10 flex flex-wrap justify-center gap-3">
        <Link
          to="/buyer/dashboard"
          className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground"
        >
          Go to my dashboard
        </Link>
        <Link
          to="/properties"
          className="rounded-md border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground hover:bg-secondary"
        >
          Browse properties
        </Link>
      </div>
    </div>
  );
}

/** The ticket belongs to the account; each member's own status is shown beneath it. */
function MemberStatuses({ members }: { members: MemberSteps[] }) {
  if (!members.length) return null;
  return (
    <ul className="mx-auto mt-8 grid max-w-md gap-3 text-left">
      {members.map((m) => {
        const todo = missingSteps(m);
        const label = m.result ? RESULT_LABELS[m.result] : "Pending";
        return (
          <li key={m.memberId} className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-foreground">{m.name}</span>
              <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${RESULT_TONES[m.result ?? "pending"]}`}>{label}</span>
            </div>
            {m.result === "held" ? <p className="mt-1 text-xs text-foreground">{HELD_BUYER_TEXT}</p> : null}
            {todo.length ? <p className="mt-1 text-xs text-muted-foreground">Still to do: {todo.map((t) => t.label).join(", ")}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
