import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { DISPOSITION_LABELS, OFFENSES, RESULT_LABELS, RESULT_TONES, type DispositionOutcome } from "@/lib/eligibility-engine";
import { listHeldMembers, recordChargeDisposition } from "@/lib/eligibility-engine.functions";
import { when } from "@/lib/admin";

export const Route = createFileRoute("/admin/eligibility/held")({
  head: () => ({ meta: [{ title: "Held applications — divieight admin" }] }),
  component: HeldPage,
});

/**
 * Held members: a disclosed pending charge (Q3). The admin records only the FACT of how the charge
 * ended; the engine applies Standard A, B and C to it. There is no way to set a result by hand.
 */
function HeldPage() {
  const load = useServerFn(listHeldMembers);
  const { data, isLoading, error } = useQuery({ queryKey: ["admin-held"], retry: false, queryFn: () => load() });
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">Held applications</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Held is its own status, separate from every other. A held member disclosed a pending charge that would disqualify on conviction. Record how the charge ended when it is resolved; the
            Standard decides the result.
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <Link to="/admin/buyers" className="font-medium text-primary hover:underline">
            All buyers
          </Link>
          <Link to="/admin/eligibility/sanctions" className="font-medium text-primary hover:underline">
            Possible sanctions matches
          </Link>
        </div>
      </div>
      <div className="mt-6 space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-muted-foreground">{(error as Error).message}</p>
        ) : !data?.length ? (
          <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">No held applications.</p>
        ) : (
          data.map((h) => <HeldRow key={h.memberId} held={h} />)
        )}
      </div>
    </div>
  );
}

function HeldRow({ held }: { held: { memberId: string; accountId: string; fullName: string; heldSince: string; reasonCodes: string[] } }) {
  const qc = useQueryClient();
  const record = useServerFn(recordChargeDisposition);
  const [outcome, setOutcome] = useState<DispositionOutcome | "">("");
  const [offenseKey, setOffenseKey] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!outcome) return;
    setBusy(true);
    try {
      const r = await record({ data: { memberId: held.memberId, outcome, offenseKey: outcome === "convicted" ? offenseKey : null, dispositionDate: date } });
      toast.success(r.result ? `Recorded. Result under the Standard: ${RESULT_LABELS[r.result]}.` : "Recorded. The member's result is still pending other steps.");
      await qc.invalidateQueries({ queryKey: ["admin-held"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium text-foreground">{held.fullName || "Unnamed member"}</span>
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${RESULT_TONES.held}`}>{RESULT_LABELS.held}</span>
        <span className="text-xs text-muted-foreground">since {when(held.heldSince)}</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Record the disposition of the disclosed charge (facts only):</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted-foreground">
          How it ended
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as DispositionOutcome)} className="mt-1 block h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground">
            <option value="">Choose…</option>
            {Object.entries(DISPOSITION_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {outcome === "convicted" ? (
          <label className="text-xs text-muted-foreground">
            Offense of conviction
            <select value={offenseKey} onChange={(e) => setOffenseKey(e.target.value)} className="mt-1 block h-9 max-w-md rounded-md border border-border bg-background px-2 text-sm text-foreground">
              <option value="">Choose…</option>
              {OFFENSES.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.list === "none" ? o.label : `${o.list}. ${o.label}`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="text-xs text-muted-foreground">
          {outcome === "convicted" ? "Date of conviction" : "Date"}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 block h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground" />
        </label>
        <button
          type="button"
          disabled={busy || !outcome || !date || (outcome === "convicted" && !offenseKey)}
          onClick={() => void submit()}
          className="h-9 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Recording…" : "Record disposition"}
        </button>
      </div>
    </div>
  );
}
