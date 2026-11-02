import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { VoteResults, VoteStatusChip, voteTimingLabel } from "@/components/owner/VoteBits";
import { formatDate } from "@/lib/format-date";
import {
  cancelVoteAsAdmin,
  closeVoteAsAdmin,
  createVoteAsAdmin,
  listVotesForAdmin,
  openVoteAsAdmin,
} from "@/lib/votes.functions";
import { DEFAULT_VOTE_OPTIONS, VOTE_THRESHOLDS, VOTE_TYPE_LABELS, VOTE_TYPES, type VoteType } from "@/lib/votes";

export const Route = createFileRoute("/admin/properties/$id/votes")({
  head: () => ({
    meta: [
      { title: "Votes — divieight admin" },
      { name: "description", content: "Create, open, close and cancel votes on a property." },
      { property: "og:title", content: "Votes — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminVotes,
});

const FIELD = "block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";

function AdminVotes() {
  const { id } = Route.useParams();
  const load = useServerFn(listVotesForAdmin);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-votes", id],
    retry: false,
    queryFn: () => load({ data: { propertyId: id } }),
  });

  return (
    <div>
      <Link to="/admin/properties" className="text-sm text-muted-foreground hover:text-foreground">
        ← Properties
      </Link>
      <h1 className="mt-3 font-display text-2xl font-semibold text-foreground">Votes</h1>
      {data ? <p className="mt-1 text-sm text-muted-foreground">{data.label}</p> : null}
      <p className="mt-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        Thresholds are PLACEHOLDERS pending Operating Agreement review. The first option is the one that must reach the threshold.
      </p>
      <CreateVote propertyId={id} />
      <div className="mt-6 space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : (data?.votes ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No votes yet.</p>
        ) : (
          data!.votes.map((v) => <VoteRowCard key={v.id} propertyId={id} vote={v} />)
        )}
      </div>
    </div>
  );
}

function CreateVote({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const create = useServerFn(createVoteAsAdmin);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [voteType, setVoteType] = useState<VoteType>("ordinary");
  const [options, setOptions] = useState(DEFAULT_VOTE_OPTIONS.join(", "));
  const [opensAt, setOpensAt] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const mut = useMutation({
    mutationFn: () =>
      create({
        data: {
          propertyId,
          title,
          description,
          voteType,
          options: options.split(",").map((o) => o.trim()).filter(Boolean),
          opensAt: new Date(opensAt).toISOString(),
          closesAt: new Date(closesAt).toISOString(),
        },
      }),
    onSuccess: () => {
      toast.success("Draft created. Open it when you're ready.");
      setTitle("");
      setDescription("");
      void qc.invalidateQueries({ queryKey: ["admin-votes", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="mt-5 space-y-3 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-foreground">New vote</h2>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" className={FIELD} />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Description" aria-label="Description" className={FIELD} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-muted-foreground">
          Type
          <select value={voteType} onChange={(e) => setVoteType(e.target.value as VoteType)} className={`${FIELD} mt-1`}>
            {VOTE_TYPES.map((t) => (
              <option key={t} value={t}>
                {VOTE_TYPE_LABELS[t]}: {VOTE_THRESHOLDS[t].label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Options (comma separated)
          <input value={options} onChange={(e) => setOptions(e.target.value)} className={`${FIELD} mt-1`} />
        </label>
        <label className="text-xs text-muted-foreground">
          Opens
          <input type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} className={`${FIELD} mt-1`} />
        </label>
        <label className="text-xs text-muted-foreground">
          Closes
          <input type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} className={`${FIELD} mt-1`} />
        </label>
      </div>
      <button
        type="button"
        disabled={mut.isPending || !title.trim() || !opensAt || !closesAt}
        onClick={() => mut.mutate()}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {mut.isPending ? "Creating…" : "Create draft"}
      </button>
    </section>
  );
}

type AdminVote = Awaited<ReturnType<typeof listVotesForAdmin>>["votes"][number];

function VoteRowCard({ propertyId, vote }: { propertyId: string; vote: AdminVote }) {
  const qc = useQueryClient();
  const open = useServerFn(openVoteAsAdmin);
  const close = useServerFn(closeVoteAsAdmin);
  const cancel = useServerFn(cancelVoteAsAdmin);
  const mut = useMutation({
    mutationFn: (action: "open" | "close" | "cancel") => {
      const fn = action === "open" ? open : action === "close" ? close : cancel;
      return fn({ data: { voteId: vote.id } });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin-votes", propertyId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 text-sm font-semibold text-foreground">{vote.title}</h2>
        <VoteStatusChip status={vote.status} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {VOTE_TYPE_LABELS[vote.vote_type]} · {formatDate(vote.opens_at)} to {formatDate(vote.closes_at)} ·{" "}
        {voteTimingLabel(vote.status, vote.opens_at, vote.closes_at)}
      </p>
      {vote.status === "open" ? (
        <p className="mt-1 text-xs text-foreground">
          {vote.castShares} of {vote.issuedShares} issued shares have voted.
        </p>
      ) : null}
      {vote.status === "closed" && vote.result_summary ? (
        <div className="mt-3">
          <VoteResults result={vote.result_summary} />
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {vote.status === "draft" ? (
          <button type="button" disabled={mut.isPending} onClick={() => mut.mutate("open")} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
            Open
          </button>
        ) : null}
        {vote.status === "open" ? (
          <button type="button" disabled={mut.isPending} onClick={() => mut.mutate("close")} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
            Close and tally
          </button>
        ) : null}
        {vote.status === "draft" || vote.status === "open" ? (
          <button type="button" disabled={mut.isPending} onClick={() => mut.mutate("cancel")} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground disabled:opacity-50">
            Cancel
          </button>
        ) : null}
      </div>
    </section>
  );
}
