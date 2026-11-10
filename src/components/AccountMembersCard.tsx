import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Circle } from "lucide-react";
import { ActingMemberGate } from "@/components/ActingMemberGate";
import { SecondMemberManager } from "@/components/SecondMemberManager";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { ELIGIBILITY_LABELS, MAX_ACTIVE_MEMBERS, memberDisplayName, type MemberEligibility } from "@/lib/account-members";
import { getMyAccountMembers } from "@/lib/account-members.functions";
import { HELD_BUYER_TEXT, RESULT_TONES } from "@/lib/eligibility-engine";

// Held has its own colour: never the refused or unpaid tones.
const TONE: Record<MemberEligibility, string> = RESULT_TONES;

/** The buyer's own view: their members, each one's progress and status. Nobody else sees this. */
export function AccountMembersCard() {
  const { user } = useAuth();
  const load = useServerFn(getMyAccountMembers);
  const { data, isLoading, error } = useQuery({ queryKey: ["my-account-members", user?.id], enabled: !!user, retry: false, queryFn: () => load() });
  const [managing, setManaging] = useState(false);

  return (
    <section>
      <h2 className="font-display text-lg font-semibold text-foreground">
        Account Members
        {data ? (
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            ({data.members.length} of {MAX_ACTIVE_MEMBERS})
          </span>
        ) : null}
      </h2>
      <div className="mt-4 space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error || !data ? (
          <p className="text-sm text-muted-foreground">Members couldn't be loaded.</p>
        ) : (
          <>
            {data.members.map((m) => {
              const done = m.checklist.filter((c) => c.done).length;
              return (
                <div key={m.id} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{memberDisplayName(m)}</p>
                      <p className="text-xs text-muted-foreground">
                        {m.role === "primary" ? "Account holder" : "Second member"} · {done} of {m.checklist.length} steps done
                      </p>
                    </div>
                    <span className={cn("shrink-0 rounded-full border px-3 py-1 text-xs font-medium", TONE[m.eligibility])}>{ELIGIBILITY_LABELS[m.eligibility]}</span>
                  </div>
                  <ul className="mt-3 grid gap-1.5 text-xs sm:grid-cols-2">
                    {m.checklist.map((c) => (
                      <li key={c.key} className="flex items-center gap-1.5 text-foreground">
                        {c.done ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" aria-hidden /> : <Circle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
                        <span className={c.done ? "" : "text-muted-foreground"}>{c.label}</span>
                        <span className="sr-only">{c.done ? "done" : "not done"}</span>
                        {c.key === "liveness" && !c.done ? (
                          <Link to="/buyer/onboarding/liveness" className="font-medium text-accent hover:underline">
                            Take selfie
                          </Link>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {m.eligibility === "held" ? <p className="mt-3 text-sm text-foreground">{HELD_BUYER_TEXT}</p> : null}
                  {m.checklist.find((c) => c.key === "w9" && !c.done) ? (
                    <Link to="/buyer/onboarding/w9" className="mt-2 inline-block text-xs font-medium text-accent hover:underline">
                      Complete W-9
                    </Link>
                  ) : null}
                  {m.role === "member" && !data.locked && m.eligibility !== "eligible" ? (
                    <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                      The account can continue without this member: the account holder removes them, and the account is evaluated on the account holder alone. The fee isn't affected.
                      <button type="button" onClick={() => setManaging(true)} className="ml-2 font-medium text-accent hover:underline">
                        Continue without this member
                      </button>
                    </div>
                  ) : null}
                  {m.checklist.find((c) => c.key === "declaration")?.done ? (
                    <div className="mt-3">
                      {/* Q6: tell divieight within ten days if a statement stops being true. Opens a new declaration version. */}
                      <Link to="/buyer/onboarding/vetting" search={{ change: 1 }} className="text-xs font-medium text-accent hover:underline">
                        Report a change
                      </Link>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {data.locked ? (
              <p className="text-xs text-muted-foreground">Members can't be changed after the Golden Ticket is issued. Contact divieight support for any change.</p>
            ) : managing ? (
              <div className="rounded-xl border border-border bg-card p-4">
                <ActingMemberGate step="Account Members" only="primary">
                  {({ member, members }) => <SecondMemberManager actingMemberId={member.id} members={members} locked={data.locked} onDone={() => setManaging(false)} />}
                </ActingMemberGate>
              </div>
            ) : (
              <Button variant="outline" onClick={() => setManaging(true)}>
                {data.members.some((m) => m.role === "member") ? "Edit or remove the second member" : data.canAdd ? "Add a second member" : "Manage members"}
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
