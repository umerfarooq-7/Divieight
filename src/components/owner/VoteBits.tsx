import { formatDate } from "@/lib/format-date";
import type { VoteResultSummary, VoteStatus } from "@/lib/votes";
import { cn } from "@/lib/utils";

const CHIP: Record<VoteStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "border-border text-muted-foreground" },
  open: { label: "Open", className: "border-accent/50 bg-accent/10 text-accent" },
  closed: { label: "Closed", className: "border-border bg-muted text-foreground" },
  cancelled: { label: "Cancelled", className: "border-destructive/40 text-destructive" },
};

export function VoteStatusChip({ status }: { status: VoteStatus }) {
  const chip = CHIP[status];
  return <span className={cn("shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium", chip.className)}>{chip.label}</span>;
}

function timeLeft(until: number, now: number): string {
  const minutes = Math.max(1, Math.round((until - now) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function voteTimingLabel(status: VoteStatus, opensAt: string, closesAt: string, now = Date.now()): string {
  if (status === "cancelled") return "Cancelled";
  if (status === "closed") return `Closed ${formatDate(closesAt)}`;
  const opens = new Date(opensAt).getTime();
  const closes = new Date(closesAt).getTime();
  if (now < opens) return `Opens in ${timeLeft(opens, now)}`;
  if (now < closes) return `Closes in ${timeLeft(closes, now)}`;
  return "Closing";
}

export function VoteResults({ result }: { result: VoteResultSummary }) {
  return (
    <div>
      <p className={cn("text-base font-semibold", result.passed ? "text-accent" : "text-foreground")}>
        {result.passed ? "Passed" : "Did not pass"}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        "{result.approvingOption}" needed {result.requiredShares} of {result.issuedShares} issued shares ({result.thresholdLabel}).
        {result.thresholdsArePlaceholder ? " Threshold pending Operating Agreement review." : ""}
      </p>
      <ul className="mt-3 space-y-1.5 text-sm">
        {result.tally.map((t) => (
          <li key={t.choice} className="flex justify-between gap-2">
            <span className="text-foreground">{t.choice}</span>
            <span className="font-medium text-foreground">
              {t.shares} share{t.shares === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        Participation: {result.votedShares} of {result.totalShares} shares voted.
      </p>
    </div>
  );
}
