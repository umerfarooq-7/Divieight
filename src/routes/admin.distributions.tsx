import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatDate } from "@/lib/format-date";
import { expenseMoney } from "@/lib/expenses";
import { listDistributionsForAdmin, postDistributionEvent } from "@/lib/owner-notifications.functions";

export const Route = createFileRoute("/admin/distributions")({
  head: () => ({
    meta: [
      { title: "Distributions — divieight admin" },
      { name: "description", content: "Post a distribution and tell each owner their pro-rata amount." },
      { property: "og:title", content: "Distributions — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminDistributionsPage,
});

const FIELD = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal";
const KEY = ["admin-distributions"];

function AdminDistributionsPage() {
  const load = useServerFn(listDistributionsForAdmin);
  const post = useServerFn(postDistributionEvent);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: KEY, queryFn: () => load(), retry: false });
  const [propertyId, setPropertyId] = useState("");
  const [total, setTotal] = useState("");
  const [recordDate, setRecordDate] = useState("");
  const [note, setNote] = useState("");
  const mut = useMutation({
    mutationFn: () => post({ data: { propertyId, totalAmount: total, recordDate, note } }),
    onSuccess: () => {
      toast.success("Posted. Each owner was told their amount.");
      setTotal("");
      setRecordDate("");
      setNote("");
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    mut.mutate();
  };
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Distributions</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        A notice only. Posting tells each owner their pro-rata amount, split on today's cap table. No money moves and no balance changes. A posted distribution can't be edited or recalled.
      </p>
      <div className="mt-6 space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : !data ? null : (
          <>
            <form onSubmit={submit} className="space-y-3 rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block text-sm font-medium text-foreground">
                  Property
                  <select required value={propertyId} onChange={(e) => setPropertyId(e.target.value)} className={FIELD}>
                    <option value="">Choose a property</option>
                    {data.properties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-medium text-foreground">
                  Total
                  <input required type="number" min="0.01" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} className={FIELD} />
                </label>
                <label className="block text-sm font-medium text-foreground">
                  Record date
                  <input required type="date" value={recordDate} onChange={(e) => setRecordDate(e.target.value)} className={FIELD} />
                </label>
              </div>
              <label className="block text-sm font-medium text-foreground">
                Note (optional): owners see this
                <textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className={FIELD} />
              </label>
              <button type="submit" disabled={mut.isPending || !propertyId || !total || !recordDate} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
                {mut.isPending ? "Posting…" : "Post and notify owners"}
              </button>
            </form>
            {data.rows.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">No distributions yet.</p>
            ) : (
              data.rows.map((r) => (
                <section key={r.id} className="rounded-xl border border-border bg-card p-5 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 break-words font-medium text-foreground">{r.propertyLabel}</p>
                    <p className="font-semibold text-foreground">{expenseMoney(r.totalAmount)}</p>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Record date {formatDate(r.recordDate)} · Posted {formatDate(r.createdAt)}
                  </p>
                  {r.note ? <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">{r.note}</p> : null}
                </section>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}
