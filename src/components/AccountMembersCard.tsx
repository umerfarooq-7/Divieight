import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Circle } from "lucide-react";
import { ActingMemberGate } from "@/components/ActingMemberGate";
import { SecondMemberManager } from "@/components/SecondMemberManager";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { ELIGIBILITY_LABELS, MAX_ACTIVE_MEMBERS, memberDisplayName, type MemberEligibility } from "@/lib/account-members";
import { getMyAccountMembers } from "@/lib/account-members.functions";

const TONE: Record<MemberEligibility, string> = {
  eligible: "border-primary/30 bg-primary/10 text-primary",
  held: "border-accent/40 bg-accent/10 text-foreground",
  not_eligible: "border-destructive/40 bg-destructive/10 text-destructive",
  pending: "border-border bg-muted text-muted-foreground",
};

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
                      </li>
                    ))}
                  </ul>
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
