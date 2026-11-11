import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { Sparkles, UserSearch } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { confirmMyReferringAgent, declineMyReferringAgent, getMyReferralSuggestion } from "@/lib/agent-qr.functions";
import { cn } from "@/lib/utils";

export const PLATFORM_CHOICE_EXPLANATION =
  "We will match you with a verified Resident Agent in your market. You will be notified and can see who was assigned.";

/**
 * A link only suggests an agent. Nothing is set until the buyer confirms: Confirm names the agent as their referring
 * agent; No thanks is remembered and the question isn't asked again. The buyer's own choice below is unchanged.
 */
function ReferralNote() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const load = useServerFn(getMyReferralSuggestion);
  const confirm = useServerFn(confirmMyReferringAgent);
  const decline = useServerFn(declineMyReferringAgent);
  const key = ["my-referral-suggestion", user?.id];
  const { data } = useQuery({ queryKey: key, enabled: !!user, retry: false, queryFn: () => load() });
  const answer = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast.success(done);
    } catch (e) {
      toast.error((e as Error).message);
    }
    await qc.invalidateQueries({ queryKey: key });
  };
  if (!data) return null;
  if (data.status === "confirmed") return <p className="mt-4 break-words text-sm text-muted-foreground">{data.agentName} is your referring agent.</p>;
  return (
    <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <p className="break-words text-foreground">You were referred by {data.agentName}. Confirm this agent as your referring agent?</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => void answer(() => confirm(), "Thanks. We've noted your referring agent.")} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">
          Confirm
        </button>
        <button type="button" onClick={() => void answer(() => decline(), "No problem.")} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary">
          No thanks
        </button>
      </div>
    </div>
  );
}

/** "Choose my own agent" / "Let divieight choose for me" — shared by the dashboard and reserve steps. */
export function AgentChoice({
  mode,
  onChange,
}: {
  mode: "self" | "platform";
  onChange: (mode: "self" | "platform") => void;
}) {
  const options = [
    { value: "self", label: "Choose my own agent", icon: UserSearch },
    { value: "platform", label: "Let divieight choose for me", icon: Sparkles },
  ] as const;
  return (
    <>
    <ReferralNote />
    <div role="radiogroup" aria-label="How to choose your agent" className="mt-4 grid gap-2 sm:grid-cols-2">
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          onClick={() => onChange(value)}
          className={cn(
            "flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium text-foreground transition-colors",
            mode === value ? "border-accent bg-accent/10" : "border-border bg-card hover:bg-muted",
          )}
        >
          <Icon className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          {label}
        </button>
      ))}
    </div>
    </>
  );
}
