import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { RESULT_LABELS, RESULT_TONES } from "@/lib/eligibility-engine";
import { CORRECTION_FIELDS, KYO_MOST_SENSITIVE_PII, KYO_REVIEW_BANNER } from "@/lib/kyo";
import { getKyoForAdmin, listKyoCorrectionsForAdmin, resolveKyoCorrectionFn } from "@/lib/kyo.functions";

/**
 * The Know Your Owner record, admin only: per Account Member, the eligibility result and the version of
 * the Participant Eligibility Standard it was determined against, and the declaration's hash, Standard
 * version and date. Opening it is logged. It has no field for the outcome of a report: the platform does not obtain
 * a consumer report in the ordinary course.
 */
export function KyoPanel({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const load = useServerFn(getKyoForAdmin);
  const loadCorrections = useServerFn(listKyoCorrectionsForAdmin);
  const resolve = useServerFn(resolveKyoCorrectionFn);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const { data, isLoading, error } = useQuery({ queryKey: ["admin-kyo", accountId], enabled: open, retry: false, queryFn: () => load({ data: { accountId } }) });
  const { data: corrections } = useQuery({ queryKey: ["admin-kyo-corrections"], enabled: open, retry: false, queryFn: () => loadCorrections() });
  const mine = (corrections ?? []).filter((c) => c.buyer_account_id === accountId);

  async function done(requestId: string) {
    try {
      await resolve({ data: { requestId, note: notes[requestId] ?? "" } });
      toast.success("Marked as handled.");
      await qc.invalidateQueries({ queryKey: ["admin-kyo-corrections"] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-3 text-xs font-medium text-primary hover:underline">
        Open the KYO record (admin only, logged)
      </button>
    );
  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-4 text-xs">
      <p className="mb-2 rounded-md border border-border bg-muted px-2 py-1 text-muted-foreground" role="note">
        {KYO_REVIEW_BANNER}
      </p>
      <p className="font-semibold text-foreground">Know Your Owner record</p>
      <p className="mt-1 text-muted-foreground">Most sensitive PII held, access limited and logged: {KYO_MOST_SENSITIVE_PII.join("; ")}.</p>
      {isLoading ? <p className="mt-3 text-muted-foreground">Loading…</p> : null}
      {error ? <p className="mt-3 text-muted-foreground">{(error as Error).message}</p> : null}
      <ul className="mt-3 space-y-3">
        {(data ?? []).map((m) => (
          <li key={m.memberId} className="rounded-md border border-border bg-background p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{m.name}</span>
              <span className="text-muted-foreground">({m.role})</span>
              {(m as { removed?: boolean }).removed ? <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-muted-foreground">Removed from the account</span> : null}
              {m.eligibility ? (
                <span className={`rounded-full border px-2 py-0.5 font-medium ${RESULT_TONES[m.eligibility.result]}`}>{RESULT_LABELS[m.eligibility.result]}</span>
              ) : (
                <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-muted-foreground">No result yet</span>
              )}
            </div>
            <dl className="mt-2 grid gap-1 text-muted-foreground sm:grid-cols-2">
              <div>
                Eligibility result: <span className="text-foreground">{m.eligibility ? RESULT_LABELS[m.eligibility.result] : "none"}</span>
              </div>
              <div>
                Standard version: <span className="text-foreground">{m.eligibility ? m.eligibility.standardVersion : "—"}</span>
                {m.eligibility ? ` · determined ${new Date(m.eligibility.determinedAt).toLocaleDateString()}` : ""}
              </div>
              <div>
                Declaration: <span className="text-foreground">{m.declaration ? `${m.declaration.status}, Standard ${m.declaration.standardVersion}, ${new Date(m.declaration.declaredAt).toLocaleDateString()}` : "none"}</span>
                {m.declaration && m.declaration.versions > 1 ? ` · ${m.declaration.versions} versions` : ""}
              </div>
              <div className="break-all">
                Declaration hash: <span className="font-mono text-foreground">{m.declaration?.declarationHash ?? "—"}</span>
              </div>
              {m.reasonCodes.length ? <div className="sm:col-span-2">Reason codes (admin only): {m.reasonCodes.join(", ")}</div> : null}
            </dl>
          </li>
        ))}
      </ul>
      {mine.length ? (
        <div className="mt-4">
          <p className="font-semibold text-foreground">Open correction requests</p>
          <ul className="mt-2 space-y-2">
            {mine.map((c) => (
              <li key={c.id} className="rounded-md border border-border bg-background p-3">
                <p className="text-foreground">
                  {CORRECTION_FIELDS.find((f) => f.value === c.field)?.label ?? c.field}: {c.requested_change}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input aria-label="How it was handled" className="h-8 w-64 rounded-md border border-border bg-background px-2" placeholder="How it was handled (required)" value={notes[c.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [c.id]: e.target.value }))} />
                  <button type="button" disabled={!(notes[c.id] ?? "").trim()} onClick={() => void done(c.id)} className="font-medium text-primary disabled:opacity-50">
                    Mark handled
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <button type="button" onClick={() => setOpen(false)} className="mt-3 text-muted-foreground hover:underline">
        Close
      </button>
    </div>
  );
}
