import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { when } from "@/lib/admin";
import { changeGovernanceSetting, getGovernanceSettings } from "@/lib/governance-config.functions";

export const Route = createFileRoute("/admin/governance-settings")({
  head: () => ({
    meta: [
      { title: "Governance settings — divieight admin" },
      { name: "description", content: "The voting thresholds, windows and quotas the platform uses." },
      { property: "og:title", content: "Governance settings — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: GovernanceSettingsPage,
});

const KEY = "governance-settings";
const FIELD = "w-28 rounded-lg border border-border bg-background px-3 py-1.5 text-sm";

function GovernanceSettingsPage() {
  const load = useServerFn(getGovernanceSettings);
  const change = useServerFn(changeGovernanceSetting);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: [KEY], retry: false, queryFn: () => load() });
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: (key: string) => change({ data: { key, value: Number(value), reason } }),
    onSuccess: () => {
      toast.success("Saved. Votes that are already open keep the numbers they started with.");
      setEditing(null);
      setReason("");
      void qc.invalidateQueries({ queryKey: [KEY] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Governance settings</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        The numbers the voting, resale, retention and calendar rules read. {data?.canEdit ? "You can change them, with a reason; every change is logged." : "Only the founder can change them. Every change is logged."} A vote that is already open keeps the thresholds it started with, whatever is changed here.
      </p>
      {isLoading ? <p className="mt-6 text-sm text-muted-foreground">Loading…</p> : null}
      {error ? <p className="mt-6 text-sm text-destructive">{(error as Error).message}</p> : null}
      <div className="mt-6 space-y-3">
        {(data?.settings ?? []).map((s) => (
          <div key={s.key} className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{s.label}</p>
                <p className="text-xs text-muted-foreground">{s.help}</p>
              </div>
              <div className="text-right">
                <p className="text-lg font-semibold text-foreground">
                  {s.value} <span className="text-xs font-normal text-muted-foreground">{s.unit}</span>
                </p>
                <p className="text-xs text-muted-foreground">{s.changed ? `Default ${s.defaultValue}. Changed ${s.updatedAt ? when(s.updatedAt) : ""}` : "Default"}</p>
              </div>
            </div>
            {data?.canEdit ? (
              editing === s.key ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input className={FIELD} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-label={`New value for ${s.label}`} />
                  <input className="min-w-[14rem] flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm" placeholder="Why it is changing" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
                  <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(s.key)}>
                    Save
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <button type="button" className="mt-2 text-xs font-medium text-accent hover:underline" onClick={() => { setEditing(s.key); setValue(String(s.value)); setReason(""); }}>
                  Change
                </button>
              )
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
