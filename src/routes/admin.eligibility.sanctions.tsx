import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { listPossibleSanctionsMatches, resolveSanctionsIdentity } from "@/lib/eligibility-engine.functions";
import { when } from "@/lib/admin";

export const Route = createFileRoute("/admin/eligibility/sanctions")({
  head: () => ({ meta: [{ title: "Possible sanctions matches — divieight admin" }] }),
  component: SanctionsPage,
});

/**
 * Standard Part One E. The only question for a possible match: is the member the person the list
 * names? It is answered against the identity documents already held. The account stays pending until then.
 */
function SanctionsPage() {
  const qc = useQueryClient();
  const load = useServerFn(listPossibleSanctionsMatches);
  const resolve = useServerFn(resolveSanctionsIdentity);
  const { data, isLoading, error } = useQuery({ queryKey: ["admin-sanctions"], retry: false, queryFn: () => load() });
  const [busy, setBusy] = useState<string | null>(null);

  async function answer(m: { memberId: string; screeningId: string }, samePerson: boolean) {
    if (samePerson && !window.confirm("Confirm: the identity documents show this member IS the person the list names. Under the Standard, a confirmed match disqualifies.")) return;
    setBusy(m.screeningId);
    try {
      await resolve({ data: { memberId: m.memberId, screeningId: m.screeningId, samePerson } });
      toast.success(samePerson ? "Recorded as a confirmed match." : "Recorded: not the person the list names.");
      await qc.invalidateQueries({ queryKey: ["admin-sanctions"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">Possible sanctions matches</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            The only question is whether the member is the person the list names, answered against the identity documents already held. The account stays pending until it is answered.
          </p>
        </div>
        <Link to="/admin/eligibility/held" className="text-sm font-medium text-primary hover:underline">
          Held applications
        </Link>
      </div>
      <div className="mt-6 space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-muted-foreground">{(error as Error).message}</p>
        ) : !data?.length ? (
          <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">No possible matches waiting.</p>
        ) : (
          data.map((m) => (
            <div key={m.screeningId} className="rounded-xl border border-border bg-card p-5">
              <p className="font-medium text-foreground">{m.fullName || "Unnamed member"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {m.listName ?? "List"} · listed as “{m.matchedName ?? "—"}” · since {when(m.since)}
              </p>
              <p className="mt-3 text-sm text-foreground">Is this member the person the list names?</p>
              <div className="mt-2 flex flex-wrap gap-3">
                <button type="button" disabled={busy === m.screeningId} onClick={() => void answer(m, false)} className="h-9 rounded-md border border-border px-4 text-sm font-medium disabled:opacity-50">
                  No — a different person
                </button>
                <button type="button" disabled={busy === m.screeningId} onClick={() => void answer(m, true)} className="h-9 rounded-md border border-border px-4 text-sm font-medium disabled:opacity-50">
                  Yes — the same person
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
