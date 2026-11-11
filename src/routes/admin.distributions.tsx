import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatDate } from "@/lib/format-date";
import { expenseMoney, ROUNDING_RULE_TEXT } from "@/lib/expenses";
import { listDistributionsForAdmin, postDistributionEvent, repostDistributionEvent, voidDistributionEvent } from "@/lib/owner-notifications.functions";

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

type Row = NonNullable<Awaited<ReturnType<typeof listDistributionsForAdmin>>>["rows"][number];

function DistributionCard({ row: r }: { row: Row }) {
  const qc = useQueryClient();
  const voidIt = useServerFn(voidDistributionEvent);
  const repost = useServerFn(repostDistributionEvent);
  const [open, setOpen] = useState<null | "void" | "repost">(null);
  const [reason, setReason] = useState("");
  const [total, setTotal] = useState(String(r.totalAmount));
  const [recordDate, setRecordDate] = useState(r.recordDate);
  const [note, setNote] = useState(r.note ?? "");
  const done = (message: string) => () => {
    toast.success(message);
    setOpen(null);
    setReason("");
    void qc.invalidateQueries({ queryKey: KEY });
  };
  const fail = (e: Error) => toast.error(e.message);
  const voidMut = useMutation({ mutationFn: () => voidIt({ data: { distributionId: r.id, reason } }), onSuccess: done("Voided. Owners were told."), onError: fail });
  const repostMut = useMutation({ mutationFn: () => repost({ data: { distributionId: r.id, reason, totalAmount: total, recordDate, note } }), onSuccess: done("Voided and re-posted. Owners were told."), onError: fail });
  const voided = r.status === "voided";
  return (
    <section className={`rounded-xl border border-border bg-card p-5 shadow-sm ${voided ? "opacity-80" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 break-words font-medium text-foreground">{r.propertyLabel}</p>
        <p className={`font-semibold text-foreground ${voided ? "line-through" : ""}`}>{expenseMoney(r.totalAmount)}</p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Record date {formatDate(r.recordDate)} · Posted {formatDate(r.createdAt)}
        {voided ? ` · Voided ${r.voidedAt ? formatDate(r.voidedAt) : ""}` : ""}
        {r.replacesId ? " · Replaces an earlier, voided distribution" : ""}
        {r.replacedById ? " · A corrected distribution was posted" : ""}
      </p>
      {voided ? <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">Voided: {r.voidReason}</p> : null}
      {r.note ? <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">{r.note}</p> : null}
      {!voided ? (
        <div className="mt-3">
          {open === null ? (
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => setOpen("repost")} className="text-sm font-medium text-primary hover:underline">
                Void and re-post
              </button>
              <button type="button" onClick={() => setOpen("void")} className="text-sm font-medium text-muted-foreground hover:underline">
                Void only
              </button>
            </div>
          ) : (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="Reason for voiding (owners see this)" aria-label="Reason for voiding" className={FIELD} />
              {open === "repost" ? (
                <div className="grid gap-2 sm:grid-cols-3">
                  <input type="number" min="0.01" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} aria-label="Corrected total" className={FIELD} />
                  <input type="date" value={recordDate} onChange={(e) => setRecordDate(e.target.value)} aria-label="Corrected record date" className={FIELD} />
                  <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Note" aria-label="Note" className={FIELD} />
                </div>
              ) : null}
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!reason.trim() || voidMut.isPending || repostMut.isPending}
                  onClick={() => (open === "repost" ? repostMut.mutate() : voidMut.mutate())}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {open === "repost" ? "Void and post the corrected one" : "Void"}
                </button>
                <button type="button" onClick={() => setOpen(null)} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

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
        A notice only. Posting tells each owner their pro-rata amount, split on the holders on the record date. No money moves and no balance changes. A posted distribution can't be edited: if it is wrong, void it with a reason (owners are told) and post a corrected one. Every version is kept.
        <span className="ml-1 inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-border text-[10px] font-semibold" title={ROUNDING_RULE_TEXT} aria-label={ROUNDING_RULE_TEXT} tabIndex={0}>
          i
        </span>
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
              data.rows.map((r) => <DistributionCard key={r.id} row={r} />)
            )}
          </>
        )}
      </div>
    </div>
  );
}
