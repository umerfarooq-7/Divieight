import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ActingMemberGate } from "@/components/ActingMemberGate";
import { BuyerOnboardingStepper } from "@/components/BuyerOnboardingStepper";
import { SecondMemberManager } from "@/components/SecondMemberManager";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { getMyAccountMembers } from "@/lib/account-members.functions";

export const Route = createFileRoute("/buyer/onboarding/members")({
  head: () => ({
    meta: [
      { title: "Who is buying — divieight" },
      { name: "description", content: "Tell us whether you are buying with one other person." },
      { property: "og:title", content: "Who is buying — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MembersStep,
});

function MembersStep() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <BuyerOnboardingStepper current={0} />
      <ActingMemberGate step="Step 1 · Members" only="primary">
        {({ member }) => <MembersForm actingMemberId={member.id} />}
      </ActingMemberGate>
    </div>
  );
}

function MembersForm({ actingMemberId }: { actingMemberId: string }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const load = useServerFn(getMyAccountMembers);
  const { data } = useQuery({ queryKey: ["my-account-members", user?.id], enabled: !!user, queryFn: () => load() });
  const second = data?.members.find((m) => m.role === "member");
  const [withSomeone, setWithSomeone] = useState<boolean | null>(null);
  const answer = withSomeone ?? (second ? true : null);
  if (!data) return null;

  return (
    <div className="mt-8">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Step 1 · Members</p>
      <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Are you buying with someone else?</h1>
      <p className="mt-3 text-base text-muted-foreground">A Buyer Account can have one additional person at most. Each person completes their own identity and vetting steps.</p>

      {second ? null : (
        <div role="radiogroup" aria-label="Buying with someone else" className="mt-6 grid gap-3 sm:grid-cols-2">
          {[
            { value: false, label: "No, just me" },
            { value: true, label: "Yes, with one other person" },
          ].map((o) => (
            <button
              key={String(o.value)}
              type="button"
              role="radio"
              aria-checked={answer === o.value}
              onClick={() => setWithSomeone(o.value)}
              className={cn("min-h-11 rounded-lg border px-4 py-3 text-left text-sm font-medium text-foreground", answer === o.value ? "border-accent bg-accent/10" : "border-border bg-card hover:bg-muted")}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      {answer ? (
        <section className="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
          <h2 className="font-display text-lg font-semibold text-foreground">{second ? second.fullName || "Second member" : "The other person"}</h2>
          {second ? <p className="mt-1 text-sm text-muted-foreground">{second.email}{second.phone ? ` · ${second.phone}` : ""}</p> : null}
          <div className="mt-4">
            <SecondMemberManager actingMemberId={actingMemberId} members={data.members} locked={data.locked} />
          </div>
        </section>
      ) : null}

      <div className="mt-8 flex justify-end">
        <Button disabled={answer === null || (answer === true && !second)} onClick={() => navigate({ to: "/buyer/onboarding/identity" })}>
          Continue
        </Button>
      </div>
    </div>
  );
}
