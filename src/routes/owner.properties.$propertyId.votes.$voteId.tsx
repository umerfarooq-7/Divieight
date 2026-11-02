import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { VoteResults, VoteStatusChip, voteTimingLabel } from "@/components/owner/VoteBits";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import { formatDate } from "@/lib/format-date";
import type { OwnerVoteDetail } from "@/lib/votes.server";
import { castVoteBallot, getVoteForOwner, recordVotePosition } from "@/lib/votes.functions";
import { VOTE_TYPE_LABELS } from "@/lib/votes";

export const Route = createFileRoute("/owner/properties/$propertyId/votes/$voteId")({
  head: () => ({
    meta: [
      { title: "Vote — divieight" },
      { name: "description", content: "Review this vote and cast your ballot." },
      { property: "og:title", content: "Vote — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerVotePage,
});

function OwnerVotePage() {
  const { propertyId, voteId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(getVoteForOwner);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["owner-vote", voteId, user?.id],
    enabled: !!user,
    retry: false,
    queryFn: () => load({ data: { propertyId, voteId } }),
  });

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/buyer/login" });
  }, [authLoading, user, navigate]);

  const denied = !isLoading && !isError && data === null;
  useEffect(() => {
    if (!denied) return;
    toast.error("That vote isn't available to you.");
    navigate({ to: "/owner/properties/$propertyId/votes", params: { propertyId } });
  }, [denied, navigate, propertyId]);

  return (
    <OwnerPageShell>
      <Link to="/owner/properties/$propertyId/votes" params={{ propertyId }} className="text-sm text-muted-foreground hover:text-foreground">
        ← All votes
      </Link>
      <div className="mt-4">
        {isError ? (
          <p className="text-sm text-muted-foreground">
            We couldn't load this vote.{" "}
            <button type="button" onClick={() => void refetch()} className="font-medium text-primary hover:underline">
              Try again
            </button>
          </p>
        ) : authLoading || isLoading || !data ? (
          <OwnerLoading />
        ) : (
          <VoteDetail propertyId={propertyId} detail={data} />
        )}
      </div>
    </OwnerPageShell>
  );
}

function VoteDetail({ propertyId, detail }: { propertyId: string; detail: OwnerVoteDetail }) {
  const { vote } = detail;
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["owner-vote", vote.id] });
    void qc.invalidateQueries({ queryKey: ["owner-votes", propertyId] });
  };
  const needsConsensus = detail.consensus.state !== "not_required";

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h1 className="min-w-0 font-display text-2xl font-semibold text-foreground">{vote.title}</h1>
        <VoteStatusChip status={vote.status} />
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {VOTE_TYPE_LABELS[vote.voteType]} · {voteTimingLabel(vote.status, vote.opens_at, vote.closes_at)} · Closes {formatDate(vote.closes_at)}
      </p>
      {vote.description ? <p className="mt-3 whitespace-pre-wrap text-sm text-foreground">{vote.description}</p> : null}

      <section className="mt-5 rounded-xl border border-border bg-card p-5 shadow-sm">
        <p className="text-sm text-foreground">
          <span className="font-semibold">Your weight: {detail.myWeight}</span> (share{detail.myShareNumbers.length === 1 ? "" : "s"}{" "}
          {detail.myShareNumbers.join(", ")})
        </p>
        <p className="mt-1 text-sm text-muted-foreground">Your ballot: {detail.myChoice ?? "Not cast"}</p>
        {vote.status === "open" ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Passing needs {detail.thresholdLabel}.{detail.thresholdsArePlaceholder ? " Threshold pending Operating Agreement review." : ""}
          </p>
        ) : null}
      </section>

      {vote.status === "closed" && detail.result ? (
        <section className="mt-4 rounded-xl border border-border bg-card p-5 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-foreground">Results</h2>
          <VoteResults result={detail.result} />
        </section>
      ) : null}

      {needsConsensus && detail.canCast ? <ConsensusPanel propertyId={propertyId} detail={detail} onChanged={refresh} /> : null}
      {detail.canCast ? <BallotPanel propertyId={propertyId} detail={detail} onChanged={refresh} /> : null}
    </>
  );
}

function ConsensusPanel({ propertyId, detail, onChanged }: { propertyId: string; detail: OwnerVoteDetail; onChanged: () => void }) {
  const record = useServerFn(recordVotePosition);
  const { members, state } = detail.consensus;
  const [memberId, setMemberId] = useState(members.find((m) => !m.position)?.memberId ?? members[0]?.memberId ?? "");
  const [position, setPosition] = useState("");
  const [initials, setInitials] = useState("");
  const mut = useMutation({
    mutationFn: () => record({ data: { propertyId, voteId: detail.vote.id, accountMemberId: memberId, position, initials } }),
    onSuccess: (r) => {
      if (r.error) return void toast.error(r.error);
      toast.success("Position recorded.");
      setInitials("");
      setPosition("");
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const pending = members.filter((m) => !m.position).map((m) => m.name);

  return (
    <section className="mt-4 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-foreground">Your account's consensus</h2>
      <p className="mt-1 text-xs text-muted-foreground">Every member of your account must record the same position before your ballot can be cast.</p>
      <ul className="mt-3 space-y-1.5 text-sm">
        {members.map((m) => (
          <li key={m.memberId} className="flex flex-wrap justify-between gap-2">
            <span className="text-foreground">{m.name}</span>
            <span className={m.position ? "font-medium text-foreground" : "text-muted-foreground"}>{m.position ?? "Not responded"}</span>
          </li>
        ))}
      </ul>
      {state === "disagree" ? <p className="mt-3 text-sm text-destructive">Your account members disagree — reach consensus to cast.</p> : null}
      {state === "pending" ? <p className="mt-3 text-sm text-muted-foreground">Waiting for {pending.join(", ")}.</p> : null}
      {state === "agreed" ? <p className="mt-3 text-sm text-foreground">Your account agrees: {detail.consensus.choice}.</p> : null}
      {detail.myChoice && state !== "agreed" ? (
        <p className="mt-1 text-xs text-muted-foreground">Your earlier ballot ({detail.myChoice}) still counts until a new one is cast.</p>
      ) : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <select value={memberId} onChange={(e) => setMemberId(e.target.value)} aria-label="Responding as" className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
          {members.map((m) => (
            <option key={m.memberId} value={m.memberId}>
              {m.name}
            </option>
          ))}
        </select>
        <select value={position} onChange={(e) => setPosition(e.target.value)} aria-label="Position" className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
          <option value="">Choose a position…</option>
          {detail.vote.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <input
          value={initials}
          onChange={(e) => setInitials(e.target.value)}
          placeholder="Member's initials"
          aria-label="Member's initials"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
        />
      </div>
      <button
        type="button"
        disabled={mut.isPending || !memberId || !position || !initials.trim()}
        onClick={() => mut.mutate()}
        className="mt-3 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50"
      >
        {mut.isPending ? "Saving…" : "Record position"}
      </button>
    </section>
  );
}

function BallotPanel({ propertyId, detail, onChanged }: { propertyId: string; detail: OwnerVoteDetail; onChanged: () => void }) {
  const cast = useServerFn(castVoteBallot);
  const { state, choice: agreed } = detail.consensus;
  const direct = state === "not_required";
  const [choice, setChoice] = useState(detail.myChoice ?? "");
  const finalChoice = direct ? choice : agreed;
  const mut = useMutation({
    mutationFn: () => cast({ data: { propertyId, voteId: detail.vote.id, choice: finalChoice! } }),
    onSuccess: (r) => {
      if (r.error) return void toast.error(r.error);
      toast.success(r.changed ? "Ballot changed." : "Ballot cast.");
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="mt-4 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-foreground">Cast your ballot</h2>
      {direct ? (
        <fieldset className="mt-3 space-y-2">
          <legend className="sr-only">Options</legend>
          {detail.vote.options.map((o) => (
            <label key={o} className="flex min-h-9 items-center gap-2 text-sm text-foreground">
              <input type="radio" name="ballot" value={o} checked={choice === o} onChange={() => setChoice(o)} />
              {o}
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          {state === "agreed" ? `Your account's agreed position: ${agreed}` : "Available once your account reaches consensus."}
        </p>
      )}
      <button
        type="button"
        disabled={mut.isPending || !finalChoice || finalChoice === detail.myChoice}
        onClick={() => mut.mutate()}
        className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {mut.isPending ? "Saving…" : detail.myChoice ? "Change ballot" : "Cast ballot"}
      </button>
      <p className="mt-2 text-xs text-muted-foreground">You can change your ballot until the vote closes.</p>
    </section>
  );
}
