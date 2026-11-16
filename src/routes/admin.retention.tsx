import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { decideRetentionReview, getRetentionOverview, getRetentionQueue, recordLlcDissolutionFn, setRetentionLegalHold } from "@/lib/kyo-retention.functions";
import { RETENTION_ASSUMPTION, RETENTION_EXCLUSIONS, STATUS_LABELS } from "@/lib/kyo-retention";

export const Route = createFileRoute("/admin/retention")({
  head: () => ({ meta: [{ title: "Know Your Owner retention — Manager" }, { name: "robots", content: "noindex" }] }),
  component: AdminRetention,
});

const th = "px-3 py-2 text-left text-sm font-semibold text-foreground";
const td = "px-3 py-2 align-top text-sm text-foreground";
const field = "mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";

function AdminRetention() {
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: ["retention-overview"], queryFn: () => getRetentionOverview(), retry: false });
  const queue = useQuery({ queryKey: ["retention-queue"], queryFn: () => getRetentionQueue(), retry: false });
  const forbidden = (overview.error as Error | null)?.message === "Not authorized";
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["retention-overview"] });
    void qc.invalidateQueries({ queryKey: ["retention-queue"] });
  };
  const decide = useMutation({
    mutationFn: (v: { reviewId: string; decision: "approve_erasure" | "keep"; reason: string }) => decideRetentionReview({ data: v }),
    onSuccess: (r) => {
      toast.success(r.decision === "erased" ? "Erased. The event is in the Audit Vault, without the data." : "Kept. It will come back for review in a year.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const hold = useMutation({
    mutationFn: (v: { retentionId: string; hold: boolean; reason: string }) => setRetentionLegalHold({ data: v }),
    onSuccess: () => {
      toast.success("Saved.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const dissolve = useMutation({
    mutationFn: (v: { propertyId: string; date: string; reason: string }) => recordLlcDissolutionFn({ data: v }),
    onSuccess: () => {
      toast.success("Recorded. The 7 years start from that date at tonight's run.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (forbidden) return <p role="alert" className="mx-auto max-w-3xl px-4 py-16 text-center text-base text-destructive">403: only the Manager, the Compliance Officer and the founder can see this page.</p>;
  const o = overview.data;
  const q = queue.data;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="font-display text-2xl font-semibold text-foreground">Know Your Owner retention</h1>
      <p className="mt-1 rounded-md border border-border bg-muted/50 p-3 text-sm text-foreground" role="note">{RETENTION_ASSUMPTION}</p>
      <p className="mt-2 text-sm text-muted-foreground">Counts and anonymous references only. The nightly job never deletes anything: a record past its period waits here for a founder.</p>
      {overview.isLoading ? <p className="mt-4 text-base text-muted-foreground">Loading…</p> : null}
      {overview.error && !forbidden ? <p role="alert" className="mt-4 text-base text-destructive">{(overview.error as Error).message}</p> : null}

      {o ? (
        <>
          <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Totals">
            {[
              ["Records", o.totals.records],
              ["Active property", o.totals.byClass.active_property],
              ["Archived", o.totals.byClass.archived],
              ["In use (no clock)", o.totals.byClass.in_use],
              ["Retained", o.totals.byStatus.retained],
              ["Past retention", o.totals.byStatus.past_retention],
              ["Under a legal hold", o.totals.legalHolds],
              ["Erased", o.totals.byStatus.erased],
            ].map(([label, n]) => (
              <div key={String(label)} className="rounded-xl border border-border bg-card p-4">
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="font-display text-2xl font-semibold text-foreground">{n}</p>
              </div>
            ))}
          </section>

          <section className="mt-8">
            <h2 className="font-display text-lg font-semibold text-foreground">Retention review queue ({o.queue.openReviews} open)</h2>
            {q && q.reviews.filter((r) => r.status === "open").length === 0 ? <p className="mt-2 text-base text-muted-foreground">Nothing is waiting.</p> : null}
            <ul className="mt-3 space-y-3">
              {(q?.reviews ?? []).filter((r) => r.status === "open").map((r) => (
                <ReviewCard key={r.id} r={r} onDecide={(d, reason) => decide.mutate({ reviewId: r.id, decision: d, reason })} onHold={(on, reason) => hold.mutate({ retentionId: r.retentionId, hold: on, reason })} busy={decide.isPending || hold.isPending} />
              ))}
            </ul>
          </section>

          <section className="mt-8">
            <h2 className="font-display text-lg font-semibold text-foreground">Deletion requests</h2>
            <p className="text-sm text-muted-foreground">A request inside the retention period, under a legal hold, or from an account still in use is declined at once, with the reason recorded. {o.queue.openDeletionRequests} waiting for a founder; {o.queue.declinedDeletionRequests} declined.</p>
            <div className="mt-3 overflow-x-auto rounded-lg border border-border">
              <table className="min-w-full divide-y divide-border">
                <thead className="bg-muted/50"><tr>{["Record", "Requested", "Status", "Reason recorded"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-border">
                  {(q?.deletionRequests ?? []).map((d) => (
                    <tr key={d.id}>
                      <td className={td}>{d.record.ref}</td>
                      <td className={td}>{new Date(d.requestedAt).toLocaleDateString()}</td>
                      <td className={td}>{d.status}{d.decisionCode ? ` (${d.decisionCode.replace("_", " ")})` : ""}</td>
                      <td className={td}>{d.decisionReason ?? "Waiting for a founder"}</td>
                    </tr>
                  ))}
                  {(q?.deletionRequests ?? []).length === 0 ? <tr><td colSpan={4} className={`${td} text-muted-foreground`}>No requests.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-8">
            <h2 className="font-display text-lg font-semibold text-foreground">By property</h2>
            <div className="mt-3 overflow-x-auto rounded-lg border border-border">
              <table className="min-w-full divide-y divide-border">
                <thead className="bg-muted/50"><tr>{["Property", "LLC", "Dissolved", "Records", "Retained", "Past retention", "Legal hold", "Erased", ""].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-border">
                  {o.byProperty.map((p) => <PropertyRow key={p.propertyId} p={p} onDissolve={(date, reason) => dissolve.mutate({ propertyId: p.propertyId, date, reason })} />)}
                  {o.byProperty.length === 0 ? <tr><td colSpan={9} className={`${td} text-muted-foreground`}>No records are tied to a property yet.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-8">
            <h2 className="font-display text-lg font-semibold text-foreground">Archived accounts</h2>
            <p className="text-sm text-muted-foreground">{Object.entries(o.archivedByReason).map(([k, v]) => `${k}: ${v}`).join(" · ")}</p>
            <div className="mt-3 overflow-x-auto rounded-lg border border-border">
              <table className="min-w-full divide-y divide-border">
                <thead className="bg-muted/50"><tr>{["Reference", "Why", "Archived", "Retain until", "Records", "Status"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-border">
                  {o.archivedAccounts.map((a) => (
                    <tr key={a.ref}>
                      <td className={td}>{a.ref}</td>
                      <td className={td}>{a.reason}</td>
                      <td className={td}>{a.archivedAt ?? ""}</td>
                      <td className={td}>{a.retainUntil ?? "Until the LLC dissolves, then 7 years"}</td>
                      <td className={td}>{a.records}</td>
                      <td className={td}>{STATUS_LABELS[a.status]}{a.legalHold ? " · legal hold" : ""}</td>
                    </tr>
                  ))}
                  {o.archivedAccounts.length === 0 ? <tr><td colSpan={6} className={`${td} text-muted-foreground`}>No archived accounts.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-8 rounded-xl border border-border bg-card p-4">
            <h2 className="text-base font-semibold text-foreground">What retention never touches</h2>
            <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">{RETENTION_EXCLUSIONS.map((e) => <li key={e}>{e}</li>)}</ul>
          </section>
        </>
      ) : null}
    </div>
  );
}

type Review = Awaited<ReturnType<typeof getRetentionQueue>>["reviews"][number];

function ReviewCard({ r, onDecide, onHold, busy }: { r: Review; onDecide: (d: "approve_erasure" | "keep", reason: string) => void; onHold: (on: boolean, reason: string) => void; busy: boolean }) {
  const [reason, setReason] = useState("");
  return (
    <li className="rounded-xl border border-border bg-card p-4 text-base">
      <p className="font-medium text-foreground">
        {r.record.ref} <span className="font-normal text-muted-foreground">· {r.kind === "deletion_request" ? "member asked for deletion" : "past retention"} · opened {new Date(r.openedAt).toLocaleDateString()}</span>
      </p>
      <p className="text-sm text-muted-foreground">
        {r.record.class}
        {r.record.reason ? ` · ${r.record.reason}` : ""}
        {r.record.archivedAt ? ` · archived ${r.record.archivedAt}` : ""} · retain until {r.record.retainUntil ?? "the LLC dissolves, then 7 years"}
        {r.record.legalHold ? " · LEGAL HOLD" : ""}
      </p>
      <label className="mt-3 block text-sm font-medium text-foreground">
        Reason (required; no personal data)
        <input value={reason} onChange={(e) => setReason(e.target.value)} className={field} />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={busy || r.record.legalHold} onClick={() => window.confirm("Anonymize this record's personal data? This cannot be undone.") && onDecide("approve_erasure", reason)} className="h-10 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground disabled:opacity-50">
          Approve erasure (founder)
        </button>
        <button type="button" disabled={busy} onClick={() => onDecide("keep", reason)} className="h-10 rounded-md border border-border bg-background px-4 text-sm font-medium hover:bg-muted">
          {r.kind === "deletion_request" ? "Decline the request" : "Keep for another year"}
        </button>
        <button type="button" disabled={busy} onClick={() => onHold(!r.record.legalHold, reason)} className="h-10 rounded-md border border-border bg-background px-4 text-sm font-medium hover:bg-muted">
          {r.record.legalHold ? "Lift the legal hold" : "Place a legal hold"}
        </button>
      </div>
    </li>
  );
}

function PropertyRow({ p, onDissolve }: { p: { propertyId: string; label: string; llcName: string | null; dissolvedAt: string | null; records: number; retained: number; pastRetention: number; onLegalHold: number; erased: number }; onDissolve: (date: string, reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  return (
    <>
      <tr>
        <td className={td}>{p.label}</td>
        <td className={td}>{p.llcName ?? ""}</td>
        <td className={td}>{p.dissolvedAt ?? "Alive"}</td>
        <td className={td}>{p.records}</td>
        <td className={td}>{p.retained}</td>
        <td className={td}>{p.pastRetention}</td>
        <td className={td}>{p.onLegalHold}</td>
        <td className={td}>{p.erased}</td>
        <td className={td}>{p.dissolvedAt ? null : <button type="button" onClick={() => setOpen(!open)} className="text-sm font-medium text-primary underline">Record dissolution</button>}</td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={9} className={td}>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm font-medium">Dissolved on<input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} /></label>
              <label className="text-sm font-medium">Reason (founder)<input value={reason} onChange={(e) => setReason(e.target.value)} className={field} /></label>
              <button type="button" onClick={() => onDissolve(date, reason)} className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">Record</button>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
