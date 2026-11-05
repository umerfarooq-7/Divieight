import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sparkles, UserSearch } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { getMyReferralSuggestion } from "@/lib/agent-qr.functions";
import { cn } from "@/lib/utils";

export const PLATFORM_CHOICE_EXPLANATION =
  "We will match you with a verified Resident Agent in your market. You will be notified and can see who was assigned.";

/** A note only: it selects nobody, and the buyer's choice below is unchanged. */
function ReferralNote() {
  const { user } = useAuth();
  const load = useServerFn(getMyReferralSuggestion);
  const { data } = useQuery({ queryKey: ["my-referral-suggestion", user?.id], enabled: !!user, retry: false, queryFn: () => load() });
  if (!data) return null;
  return <p className="mt-4 break-words text-sm text-muted-foreground">You were referred via {data.agentName} — you may choose them.</p>;
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
