import { formatDate } from "@/lib/format-date";
import { MAINTENANCE_STATUS_LABELS, type MaintenanceStatus, type MaintenanceUrgency } from "@/lib/maintenance";
import type { MaintenanceTimelineEntry } from "@/lib/maintenance.server";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<MaintenanceStatus, string> = {
  submitted: "border-border text-muted-foreground",
  triaged: "border-border bg-muted text-foreground",
  approved: "border-accent/50 bg-accent/10 text-accent",
  in_progress: "border-accent/50 bg-accent/10 text-accent",
  completed: "border-primary/40 bg-primary/10 text-primary",
  rejected: "border-destructive/40 text-destructive",
};

export function MaintenanceStatusChip({ status }: { status: MaintenanceStatus }) {
  return <span className={cn("shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium", STATUS_STYLES[status])}>{MAINTENANCE_STATUS_LABELS[status]}</span>;
}

export function UrgentChip({ urgency }: { urgency: MaintenanceUrgency }) {
  if (urgency !== "urgent") return null;
  return <span className="shrink-0 rounded-full border border-destructive/40 px-2.5 py-0.5 text-xs font-medium text-destructive">Urgent</span>;
}

export function MaintenancePhotos({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-wrap gap-2">
      {urls.map((url, index) => (
        <li key={url}>
          <a href={url} target="_blank" rel="noreferrer">
            <img src={url} alt={`Attached photo ${index + 1}`} className="h-20 w-20 rounded-lg border border-border object-cover" />
          </a>
        </li>
      ))}
    </ul>
  );
}

export function MaintenanceTimeline({ entries }: { entries: MaintenanceTimelineEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <ol className="mt-3 space-y-2 border-l border-border pl-3 text-sm">
      {entries.map((e) => (
        <li key={e.id}>
          <p className="text-xs text-muted-foreground">{formatDate(e.createdAt)}</p>
          {e.statusChange ? <p className="font-medium text-foreground">{MAINTENANCE_STATUS_LABELS[e.statusChange]}</p> : null}
          {e.note ? <p className="whitespace-pre-wrap break-words text-foreground">{e.note}</p> : null}
        </li>
      ))}
    </ol>
  );
}
