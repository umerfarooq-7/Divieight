import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { UsersRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { getIncomingJointRequests, respondToJointRequestFn } from "@/lib/joint-reservation.functions";

const until = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * A co-buyer reserved a share and asked you to hold it together. Accepting makes you the second holder of that same share;
 * declining (or not answering) leaves it with them alone. Shown only while a request is waiting.
 */
export function JointRequestsCard() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const load = useServerFn(getIncomingJointRequests);
  const respond = useServerFn(respondToJointRequestFn);
  const { data = [] } = useQuery({ queryKey: ["incoming-joint-requests", user?.id], enabled: !!user, retry: false, queryFn: () => load() });

  const answer = useMutation({
    mutationFn: (v: { requestId: string; accept: boolean }) => respond({ data: v }),
    onSuccess: (r) => {
      toast.success(r.status === "accepted" ? "You now hold this share together." : "Request declined.");
      void qc.invalidateQueries({ queryKey: ["incoming-joint-requests"] });
      void qc.invalidateQueries({ queryKey: ["my-reservations"] });
      void qc.invalidateQueries({ queryKey: ["my-co-buyer"] });
    },
    onError: (e: Error) => {
      toast.error(e.message);
      void qc.invalidateQueries({ queryKey: ["incoming-joint-requests"] });
    },
  });

  if (data.length === 0) return null;
  return (
    <section aria-label="Requests from your co-buyer" className="space-y-3">
      {data.map((r) => (
        <div key={r.id} role="status" className="rounded-xl border border-accent/40 bg-accent/10 p-5">
          <p className="flex items-center gap-2 font-display text-base font-semibold text-foreground">
            <UsersRound className="h-5 w-5 text-accent" aria-hidden />
            {r.initiatorName} wants to take a share with you
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            A 1/8th share of {r.address}
            {r.city ? `, ${r.city}` : ""}
            {r.state ? `, ${r.state}` : ""}. It is reserved in {r.initiatorName}&apos;s name and they pay for it. If you accept, you hold it together and each complete your own due diligence and authorizations from your own account. If you decline or don&apos;t answer by {until(r.expiresAt)}, it stays with {r.initiatorName} alone.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" disabled={answer.isPending} onClick={() => answer.mutate({ requestId: r.id, accept: true })}>
              Accept
            </Button>
            <Button size="sm" variant="outline" disabled={answer.isPending} onClick={() => answer.mutate({ requestId: r.id, accept: false })}>
              Decline
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
