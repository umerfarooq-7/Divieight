import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { when } from "@/lib/admin";
import { listHeldAccounts, snoozeHeldAccountFn } from "@/lib/held-reminders.functions";

export const Route = createFileRoute("/admin/held-accounts")({
  head: () => ({
    meta: [
      { title: "Held accounts — divieight admin" },
      { name: "description", content: "Accounts with a held member, how long they have been held, and the last reminder." },
      { property: "og:title", content: "Held accounts — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: HeldAccountsPage,
});

const KEY = ["admin-held-accounts"];

function HeldAccountsPage() {
  const load = useServerFn(listHeldAccounts);
  const snooze = useServerFn(snoozeHeldAccountFn);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: KEY, retry: false, queryFn: () => load() });
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const mut = useMutation({
    mutationFn: (memberId: string) => snooze({ data: { memberId, note } }),
    onSuccess: () => {
      toast.success("Snoozed for 30 days.");
      setOpen(null);
      setNote("");
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Held accounts</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Accounts with a member whose application is held. Nothing is done to the account: it is never warned, forfeited or charged, and neither the buyer nor the agent is told. After 30 days held, with no reminder in 30 days, you get one reminder. You can snooze it for 30 days with a note. The reason for a hold is not shown here.
      </p>
      <div className="mt-6 space-y-3">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {error ? <p className="text-sm text-destructive">{(error as Error).message}</p> : null}
        {data && data.rows.length === 0 ? <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">No held accounts.</p> : null}
        {(data?.rows ?? []).map((r) => (
          <section key={r.memberId} className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words font-medium text-foreground">{r.memberLabel}</p>
                <p className="break-words text-xs text-muted-foreground">Account: {r.accountEmail ?? "—"}</p>
              </div>
              <p className="text-lg font-semibold text-foreground">{r.daysHeld} {r.daysHeld === 1 ? "day" : "days"} held</p>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Last reminder: {r.lastReminderAt ? when(r.lastReminderAt) : "none yet"}
              {r.snoozedUntil ? ` · Snoozed until ${when(r.snoozedUntil)}: ${r.snoozeNote ?? ""}` : ""}
            </p>
            {open === r.memberId ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Note (required)" aria-label="Snooze note" className="min-w-[14rem] flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                <button type="button" disabled={!note.trim() || mut.isPending} onClick={() => mut.mutate(r.memberId)} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
                  Snooze 30 days
                </button>
                <button type="button" onClick={() => setOpen(null)} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">
                  Cancel
                </button>
              </div>
            ) : r.snoozedUntil ? null : (
              <button type="button" onClick={() => { setOpen(r.memberId); setNote(""); }} className="mt-2 text-sm font-medium text-primary hover:underline">
                Snooze
              </button>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
