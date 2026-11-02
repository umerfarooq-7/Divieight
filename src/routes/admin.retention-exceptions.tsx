import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatDate } from "@/lib/format-date";
import { RETENTION_EXCEPTION_LABELS } from "@/lib/retention";
import { decideRetentionException, listRetentionExceptionsForAdmin } from "@/lib/retention.functions";
import type { AdminRetentionException } from "@/lib/retention.server";

export const Route = createFileRoute("/admin/retention-exceptions")({
  head: () => ({
    meta: [
      { title: "Retention exceptions — divieight admin" },
      { name: "description", content: "Requests to release a share from the 12-month Retention Lock." },
      { property: "og:title", content: "Retention exceptions — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: RetentionExceptionsPage,
});

function RetentionExceptionsPage() {
  const load = useServerFn(listRetentionExceptionsForAdmin);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-retention-exceptions"],
    queryFn: () => load(),
    retry: false,
  });
  const rows = data?.rows ?? [];
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Retention exceptions</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Hardship requests are decided here. A unanimous-consent request is decided by its vote: it is approved automatically if
        the vote passes.
      </p>
      <div className="mt-6 space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No exception requests yet.
          </p>
        ) : (
          rows.map((row) => <ExceptionCard key={row.id} row={row} />)
        )}
      </div>
    </div>
  );
}

function ExceptionCard({ row }: { row: AdminRetentionException }) {
  const qc = useQueryClient();
  const decide = useServerFn(decideRetentionException);
  const [note, setNote] = useState("");
  const mut = useMutation({
    mutationFn: (decision: "approved" | "rejected") => decide({ data: { exceptionId: row.id, decision, note } }),
    onSuccess: (_r, decision) => {
      toast.success(decision === "approved" ? "Approved. The share is unlocked for listing." : "Request rejected.");
      void qc.invalidateQueries({ queryKey: ["admin-retention-exceptions"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 font-display text-base font-semibold text-foreground">
          {row.propertyLabel} · Share #{row.shareNumber}
        </h2>
        <span className="rounded-full bg-muted px-3 py-1 text-xs capitalize text-foreground">{row.status}</span>
      </div>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Type" value={RETENTION_EXCEPTION_LABELS[row.exceptionType]} />
        <Fact label="Requested by" value={row.requester} />
        <Fact label="Requested" value={formatDate(row.createdAt)} />
        <Fact label="Lock ends" value={row.lockExpiresAt ? formatDate(row.lockExpiresAt) : "—"} />
      </dl>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm text-foreground">{row.reason}</p>
      <div className="mt-2 flex flex-wrap gap-4 text-sm font-medium">
        {row.documentUrl ? (
          <a href={row.documentUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
            Open supporting document
          </a>
        ) : null}
        {row.voteId ? (
          <Link to="/admin/properties/$id/votes" params={{ id: row.propertyId }} className="text-primary hover:underline">
            Open property votes
          </Link>
        ) : null}
      </div>
      {row.decisionNote ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {row.decidedAt ? `${formatDate(row.decidedAt)}: ` : ""}
          {row.decisionNote}
        </p>
      ) : null}

      {row.status === "pending" && row.exceptionType === "hardship" ? (
        <div className="mt-4 space-y-2 border-t border-border pt-4">
          <label className="block text-sm font-medium text-foreground">
            Decision note
            <textarea
              rows={2}
              maxLength={5000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!note.trim() || mut.isPending}
              onClick={() => mut.mutate("approved")}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={!note.trim() || mut.isPending}
              onClick={() => mut.mutate("rejected")}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words font-medium text-foreground">{value}</dd>
    </div>
  );
}
