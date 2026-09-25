import { useQuery } from "@tanstack/react-query";
import { formatDate } from "@/lib/format-date";
import { useServerFn } from "@tanstack/react-start";
import { Check } from "lucide-react";
import { getTitleStatusFor } from "@/lib/title-escrow.functions";
import { MILESTONE_LABELS, type TitleStatus } from "@/lib/title-escrow";

/**
 * Title Certainty Monitor — live title/escrow milestones for one property.
 * Renders nothing until a title order exists. Pass `status` when the parent
 * already has it; otherwise it loads by propertyId or podId (access-checked
 * server-side).
 */
export function TitleStatusTracker({
  status: given,
  propertyId,
  podId,
  title = "Title & escrow",
}: {
  status?: TitleStatus | null;
  propertyId?: string;
  podId?: string;
  title?: string;
}) {
  const load = useServerFn(getTitleStatusFor);
  const { data } = useQuery({
    queryKey: ["title-status", propertyId ?? null, podId ?? null],
    queryFn: () => load({ data: { propertyId, podId } }),
    enabled: !given && Boolean(propertyId || podId),
    refetchInterval: 60_000,
  });
  const status = given ?? data ?? null;
  if (!status || !status.provider) return null;

  const done = status.milestones.filter((m) => m.receivedAt).length;
  return (
    <div className="w-full rounded-lg border border-border bg-background p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</p>
        <p className="text-[11px] text-muted-foreground">
          {done}/{status.milestones.length} milestones
          {status.closingDate ? ` · closing ${formatDate(status.closingDate.slice(0, 10))}` : ""}
          {status.simulated ? " · simulated feed" : ""}
        </p>
      </div>
      <ol className="mt-2 grid gap-1.5 sm:grid-cols-5">
        {status.milestones.map((m) => (
          <li key={m.milestone} className="flex items-start gap-1.5 text-xs">
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
                m.receivedAt ? "bg-emerald-600 text-white" : "border border-border"
              }`}
            >
              {m.receivedAt ? <Check className="h-3 w-3" /> : null}
            </span>
            <span className={m.receivedAt ? "text-foreground" : "text-muted-foreground"}>
              {MILESTONE_LABELS[m.milestone]}
              {m.receivedAt ? <span className="block text-[10px] text-muted-foreground">{formatDate(m.receivedAt)}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
