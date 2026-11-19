import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRightCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { journeyMember, memberDisplayName, nextJourneyPath } from "@/lib/account-members";
import { getMyAccountMembers } from "@/lib/account-members.functions";

/**
 * With two members the steps go one person at a time. When one member has finished all of theirs, this says so and hands over to
 * the other: "Ana has finished all of her steps. Now Ben completes his." Shown at the end of a member's last screen, and on the dashboard
 * for as long as a member still has steps to do. It shows nothing on a one-member account or once both are done.
 */
export function JourneyHandoverCard({ actingMemberId, refreshKey }: { actingMemberId?: string; refreshKey?: string }) {
  const { user } = useAuth();
  const load = useServerFn(getMyAccountMembers);
  const { data, refetch } = useQuery({ queryKey: ["my-account-members", user?.id], enabled: !!user, retry: false, queryFn: () => load(), refetchOnMount: "always" });

  // The caller's page just recorded something: read the checklist again.
  useEffect(() => {
    if (refreshKey !== undefined) void refetch();
  }, [refreshKey, refetch]);

  if (!data) return null;
  const turn = journeyMember(data.members);
  if (!turn) return null;
  // Your own turn on your own screen: nothing to hand over.
  if (actingMemberId && turn.id === actingMemberId) return null;

  const turnName = memberDisplayName(turn);
  const me = actingMemberId ? data.members.find((m) => m.id === actingMemberId) : undefined;
  const path = nextJourneyPath(turn);

  return (
    <section role="status" className="mt-6 rounded-xl border border-accent/40 bg-accent/10 p-5">
      <div className="flex items-start gap-3">
        <ArrowRightCircle className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-display text-base font-semibold text-foreground">
            {me ? `${memberDisplayName(me)} has finished all of their steps.` : `${turnName} still has steps to complete.`}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {me
              ? `Now ${turnName} completes their own steps, from the start: identity, selfie, agreement, vetting and consents. Hand the keyboard over, then continue.`
              : "On a two-member account the steps go one person at a time: the account holder first, then the second member."}
          </p>
          {path ? (
            <Button className="mt-3" onClick={() => window.location.assign(path)}>
              Continue as {turnName}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
