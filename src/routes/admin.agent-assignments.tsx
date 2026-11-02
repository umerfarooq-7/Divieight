import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { assignAgentToRequest, listAgentAssignments } from "@/lib/agent-assignment.functions";
import type { AdminAssignmentRow } from "@/lib/agent-assignment.server";
import { formatDate } from "@/lib/format-date";

export const Route = createFileRoute("/admin/agent-assignments")({
  head: () => ({
    meta: [
      { title: "Agent assignments — divieight admin" },
      { name: "description", content: "Buyers who asked divieight to choose their agent." },
      { property: "og:title", content: "Agent assignments — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AgentAssignmentsPage,
});

function AgentAssignmentsPage() {
  const load = useServerFn(listAgentAssignments);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-agent-assignments"],
    queryFn: () => load(),
    retry: false,
  });
  const rows = data?.rows ?? [];
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Agent assignments</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Buyers who chose "Let divieight choose for me". Only eligible agents are offered: Resident in that market, active,
        license verified, E&amp;O valid, and not a Listing Agent in the buyer's pod. The agent then accepts or declines; a
        decline returns the request here.
      </p>
      <div className="mt-6 space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No buyers are waiting for an agent.
          </p>
        ) : (
          rows.map((row) => <RequestCard key={row.id} row={row} />)
        )}
      </div>
    </div>
  );
}

function RequestCard({ row }: { row: AdminAssignmentRow }) {
  const qc = useQueryClient();
  const assign = useServerFn(assignAgentToRequest);
  const [agentId, setAgentId] = useState("");
  const mut = useMutation({
    mutationFn: () => assign({ data: { requestId: row.id, agentId } }),
    onSuccess: () => {
      toast.success("Agent assigned. They've been asked to accept or decline.");
      void qc.invalidateQueries({ queryKey: ["admin-agent-assignments"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="font-display text-base font-semibold text-foreground">{row.buyerRef}</h2>
        <span className="rounded-full bg-muted px-3 py-1 text-xs text-foreground">
          {row.status === "pending" ? "Waiting for assignment" : `Waiting on ${row.assignedAgentName ?? "the agent"}`}
        </span>
      </div>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Budget bucket" value={row.budgetBucket} />
        <Fact label="Market" value={row.market ?? "—"} />
        <Fact label="Property" value={row.property?.label ?? "Account-wide"} />
        <Fact label="Requested" value={formatDate(row.requestedAt)} />
      </dl>
      {row.excludedAgents.length > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Dual-agency: excluded as Listing Agent — {row.excludedAgents.join(", ")}
        </p>
      ) : null}
      {row.declinedCount > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Declined by {row.declinedCount} agent{row.declinedCount === 1 ? "" : "s"}, who won't be offered this again.
        </p>
      ) : null}

      {row.status === "pending" ? (
        row.eligible.length === 0 ? (
          <p className="mt-4 text-sm text-destructive">No eligible agent covers this market right now.</p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              aria-label="Eligible agents"
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">Choose an eligible agent…</option>
              {row.eligible.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.fullName} — {a.markets.join(", ")}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!agentId || mut.isPending}
              onClick={() => mut.mutate()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {mut.isPending ? "Assigning…" : "Assign"}
            </button>
          </div>
        )
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
