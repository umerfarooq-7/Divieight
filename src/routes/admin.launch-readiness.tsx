import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { when } from "@/lib/admin";
import { LAUNCH_STATUSES, type LaunchItemView } from "@/lib/launch-readiness";
import { getLaunchReadiness, saveLaunchItem } from "@/lib/launch-readiness.functions";

export const Route = createFileRoute("/admin/launch-readiness")({
  head: () => ({
    meta: [
      { title: "Launch readiness — divieight admin" },
      { name: "description", content: "Every placeholder or simulated part of the app, with its status, owner and notes." },
      { property: "og:title", content: "Launch readiness — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LaunchReadinessPage,
});

const KEY = ["launch-readiness"];
const FIELD = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal";
const TONE: Record<string, string> = {
  Done: "bg-emerald-100 text-emerald-900",
  Placeholder: "bg-amber-100 text-amber-900",
  Simulated: "bg-amber-100 text-amber-900",
  "Test mode": "bg-amber-100 text-amber-900",
  "Needs counsel": "bg-sky-100 text-sky-900",
};

function LaunchReadinessPage() {
  const load = useServerFn(getLaunchReadiness);
  const { data, isLoading, error } = useQuery({ queryKey: KEY, retry: false, queryFn: () => load() });
  const items = data?.items ?? [];
  const open = items.filter((i) => i.status !== "Done").length;
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Launch readiness</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Every placeholder or simulated part of the app that has to be dealt with before real members and real money. Change a status as it is done; each change is logged.
        {data ? ` ${open} of ${items.length} still open.` : ""}
      </p>
      {isLoading ? <p className="mt-6 text-sm text-muted-foreground">Loading…</p> : null}
      {error ? (
        /not authorized/i.test((error as Error).message) ? (
          <div className="py-16 text-center">
            <p className="font-display text-3xl font-semibold text-foreground">403</p>
            <p className="mt-2 text-sm text-muted-foreground">Only founders can open Launch readiness.</p>
          </div>
        ) : (
          <p className="mt-6 text-sm text-destructive">{(error as Error).message}</p>
        )
      ) : null}
      <div className="mt-6 space-y-8">
        {groups.map((group) => (
          <section key={group}>
            <h2 className="font-display text-lg font-semibold text-foreground">{group}</h2>
            <div className="mt-3 space-y-3">
              {items.filter((i) => i.group === group).map((item) => (
                <ItemCard key={item.key} item={item} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ItemCard({ item }: { item: LaunchItemView }) {
  const save = useServerFn(saveLaunchItem);
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>(item.status);
  const [owner, setOwner] = useState(item.owner);
  const [notes, setNotes] = useState(item.notes);
  const dirty = status !== item.status || owner !== item.owner || notes !== item.notes;
  const mut = useMutation({
    mutationFn: () => save({ data: { key: item.key, status, owner, notes } }),
    onSuccess: () => {
      toast.success("Saved.");
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-foreground">{item.title}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{item.detail}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${TONE[item.status] ?? "bg-muted text-foreground"}`}>{item.status}</span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[12rem_1fr]">
        <label className="block text-sm font-medium text-foreground">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={FIELD}>
            {LAUNCH_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-foreground">
          Owner
          <input value={owner} onChange={(e) => setOwner(e.target.value)} maxLength={200} placeholder="Who is on it" className={FIELD} />
        </label>
      </div>
      <label className="mt-3 block text-sm font-medium text-foreground">
        Notes
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={4000} className={FIELD} />
      </label>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" disabled={!dirty || mut.isPending} onClick={() => mut.mutate()}>
          Save
        </Button>
        {item.updatedAt ? <span className="text-xs text-muted-foreground">Last changed {when(item.updatedAt)}</span> : null}
      </div>
    </div>
  );
}
