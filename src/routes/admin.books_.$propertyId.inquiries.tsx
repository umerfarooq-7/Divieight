import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatCents } from "@/lib/bank-feed-display";
import { answerInquiryFn, getAdminInquiries, rejectInquiryFn, resolveInquiryFn } from "@/lib/inquiries.functions";
import type { AdminInquiry } from "@/lib/inquiries.server";

/** The Manager's queue of co-owner inquiries for one LLC. Admin and founder only. URL: /admin/books/:propertyId/inquiries */
export const Route = createFileRoute("/admin/books_/$propertyId/inquiries")({
  head: () => ({
    meta: [
      { title: "Inquiries — divieight admin" },
      { name: "description", content: "Answer co-owners' questions about the books, or resolve them with a correction." },
      { property: "og:title", content: "Inquiries — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminInquiriesPage,
});

const FIELD = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal";
const PRIMARY = "rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";
const SECONDARY = "rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-50";

function AdminInquiriesPage() {
  const { propertyId } = Route.useParams();
  const qc = useQueryClient();
  const load = useServerFn(getAdminInquiries);
  const key = ["admin-inquiries", propertyId];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => load({ data: { propertyId } }), retry: false });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["admin-books", propertyId] });
  };
  const waiting = (data?.inquiries ?? []).filter((q) => q.status === "open" || q.status === "answered");
  const settled = (data?.inquiries ?? []).filter((q) => q.status === "resolved" || q.status === "rejected");
  return (
    <div>
      <Link to="/admin/books/$propertyId" params={{ propertyId }} className="text-xs text-muted-foreground hover:underline">
        ← Books
      </Link>
      <h1 className="mt-1 font-display text-2xl font-semibold text-foreground">Co-owner inquiries{data ? ` — ${data.property}` : ""}</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Answer, or resolve by posting a correction (a reversing entry plus a corrected one; the original stays as it was). The co-owner sees your response and the status. An open inquiry never holds anything back.
      </p>
      {isLoading ? <p className="mt-6 text-sm text-muted-foreground">Loading…</p> : null}
      {error ? <p className="mt-6 text-sm text-destructive">{(error as Error).message}</p> : null}
      {data ? (
        <div className="mt-5 space-y-4">
          <h2 className="text-sm font-semibold text-foreground">Waiting ({waiting.length})</h2>
          {waiting.length === 0 ? <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">Nothing is waiting.</p> : null}
          {waiting.map((q) => (
            <InquiryCard key={q.id} q={q} accounts={data.accounts} done={refresh} />
          ))}
          {settled.length > 0 ? <h2 className="pt-2 text-sm font-semibold text-foreground">Settled ({settled.length})</h2> : null}
          {settled.map((q) => (
            <InquiryCard key={q.id} q={q} accounts={data.accounts} done={refresh} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function InquiryCard({ q, accounts, done }: { q: AdminInquiry; accounts: Array<{ code: string; name: string }>; done: () => void }) {
  const answer = useServerFn(answerInquiryFn);
  const reject = useServerFn(rejectInquiryFn);
  const resolve = useServerFn(resolveInquiryFn);
  const settled = q.status === "resolved" || q.status === "rejected";
  const [response, setResponse] = useState(q.managerResponse ?? "");
  const [correction, setCorrection] = useState<"none" | "recategorize" | "capitalize" | "reverse">("none");
  const movable = (q.entry?.lines ?? []).filter((l) => l.code !== "1000" && !l.memberId);
  const [mapping, setMapping] = useState<Record<string, string>>(() => Object.fromEntries(movable.map((l) => [l.id, q.suggestedAccountCode ?? ""])));
  const [reason, setReason] = useState("");
  const fail = (e: Error) => toast.error(e.message);
  const answerM = useMutation({ mutationFn: () => answer({ data: { inquiryId: q.id, response } }), onSuccess: () => { toast.success("Answer sent"); done(); }, onError: fail });
  const rejectM = useMutation({ mutationFn: () => reject({ data: { inquiryId: q.id, response } }), onSuccess: () => { toast.success("Suggestion declined, with your reason"); done(); }, onError: fail });
  const resolveM = useMutation({
    mutationFn: () =>
      resolve({
        data: {
          inquiryId: q.id,
          response,
          correction: correction === "none" ? null : { kind: correction, mapping: correction === "recategorize" ? Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)) : undefined, reason: reason || undefined },
        },
      }),
    onSuccess: (r) => {
      toast.success(r.resultingEntryId ? "Resolved, and the correction is linked" : "Resolved");
      done();
    },
    onError: fail,
  });
  const busy = answerM.isPending || rejectM.isPending || resolveM.isPending;
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {q.type === "recategorize" ? "Suggested recategorization" : "Question"} from {q.askedBy} · {new Date(q.createdAt).toLocaleString()}
        </span>
        <span className="font-semibold uppercase">{q.status}</span>
      </div>
      <p className="mt-2 text-sm text-foreground">{q.message}</p>
      {q.suggestedAccountCode ? <p className="text-xs text-muted-foreground">Suggests account {q.suggestedAccountCode}</p> : null}
      {q.entry ? (
        <div className="mt-2 rounded-lg bg-muted/40 p-2 text-xs">
          <div className="text-muted-foreground">
            {q.entry.date} · {q.entry.source}
            {q.entry.memo ? ` · ${q.entry.memo}` : ""}
          </div>
          {q.entry.lines.map((l) => (
            <div key={l.id} className="flex justify-between gap-3">
              <span>
                {l.code} · {l.name}
              </span>
              <span>{l.debitCents ? `Dr ${formatCents(l.debitCents)}` : `Cr ${formatCents(l.creditCents)}`}</span>
            </div>
          ))}
        </div>
      ) : null}
      {q.resultingEntryId ? <p className="mt-2 text-xs text-muted-foreground">Correction entry: {q.resultingEntryId.slice(0, 8)}</p> : null}
      {settled ? (
        <p className="mt-2 rounded-md bg-muted/50 p-2 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Your response: </span>
          {q.managerResponse}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <label className="block text-xs font-medium text-foreground">
            Response (the co-owner sees this)
            <textarea className={FIELD} rows={3} value={response} onChange={(e) => setResponse(e.target.value)} />
          </label>
          <fieldset className="rounded-lg border border-border p-3">
            <legend className="px-1 text-xs font-medium text-foreground">Resolve with</legend>
            <select className={FIELD} aria-label="Correction" value={correction} onChange={(e) => setCorrection(e.target.value as typeof correction)}>
              <option value="none">No change to the books</option>
              <option value="recategorize">Recategorize (reversing entry + corrected entry)</option>
              <option value="capitalize">Capitalize the expense</option>
              <option value="reverse">Reverse the entry</option>
            </select>
            {correction === "recategorize" ? (
              <div className="mt-2 space-y-2">
                {movable.map((l) => (
                  <div key={l.id} className="grid gap-2 sm:grid-cols-2 sm:items-center">
                    <span className="text-xs">
                      {l.code} · {l.name}
                    </span>
                    <select className={FIELD} aria-label={`Move ${l.code} to`} value={mapping[l.id] ?? ""} onChange={(e) => setMapping({ ...mapping, [l.id]: e.target.value })}>
                      <option value="">Leave as is</option>
                      {accounts.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            ) : null}
            {correction !== "none" ? (
              <label className="mt-2 block text-xs font-medium text-foreground">
                Reason on the books (optional; defaults to the inquiry)
                <input className={FIELD} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
            ) : null}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={SECONDARY} disabled={busy || !response.trim()} onClick={() => answerM.mutate()}>
              Send answer (keep open)
            </button>
            <button type="button" className={PRIMARY} disabled={busy || !response.trim() || (correction === "recategorize" && Object.values(mapping).every((v) => !v))} onClick={() => resolveM.mutate()}>
              {correction === "none" ? "Resolve" : "Resolve with correction"}
            </button>
            {q.type === "recategorize" ? (
              <button type="button" className={SECONDARY} disabled={busy || !response.trim()} onClick={() => rejectM.mutate()}>
                Decline the suggestion
              </button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
