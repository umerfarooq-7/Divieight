import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import { formatCents } from "@/lib/bank-feed-display";
import { getOwnerLedger, raiseInquiryFn } from "@/lib/inquiries.functions";
import type { OwnerInquiry, OwnerLedgerEntry } from "@/lib/inquiries.server";
import { plainAccountName, plainEntry, sourceLabel } from "@/lib/ledger-plain";

export const Route = createFileRoute("/owner/properties/$propertyId/ledger")({
  head: () => ({
    meta: [
      { title: "Ledger — divieight" },
      { name: "description", content: "Your home's LLC transactions. Ask a question or suggest a recategorization." },
      { property: "og:title", content: "Ledger — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerLedgerPage,
});

const FIELD = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal";
const PRIMARY = "rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";
const SECONDARY = "rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-50";
const STATUS_LABEL: Record<OwnerInquiry["status"], string> = { open: "Waiting for the Manager", answered: "Answered", resolved: "Resolved", rejected: "Not changed" };

function OwnerLedgerPage() {
  const { propertyId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(getOwnerLedger);
  const queryKey = ["owner-ledger", propertyId, user?.id];
  const { data, isLoading, isError, refetch } = useQuery({ queryKey, enabled: !!user, retry: false, queryFn: () => load({ data: { propertyId } }) });

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/owner/login", search: { redirect: window.location.pathname } });
  }, [authLoading, user, navigate]);
  const denied = data?.allowed === false;
  useEffect(() => {
    if (!denied) return;
    toast.error("You don't have ownership in that property.");
    navigate({ to: "/owner" });
  }, [denied, navigate]);

  return (
    <OwnerPageShell>
      <Link to="/owner/properties/$propertyId" params={{ propertyId }} className="text-sm text-muted-foreground hover:text-foreground">
        ← Owner dashboard
      </Link>
      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground sm:text-3xl">Ledger</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Every time money moves for this home's LLC, it is listed here, newest first. If something looks wrong or you'd like to understand it, ask the Manager, or suggest where it should be recorded. Your questions are private to you, and an open question never affects anything else you can do here.
      </p>
      <ul className="mt-4 grid max-w-3xl gap-2 rounded-xl border border-border bg-muted/30 p-4 text-sm text-muted-foreground sm:grid-cols-3">
        <li>
          <span className="font-semibold text-emerald-700 dark:text-emerald-400">+ Money in</span>: reached the LLC's bank account.
        </li>
        <li>
          <span className="font-semibold text-foreground">− Money out</span>: paid from the LLC's bank account.
        </li>
        <li>
          <span className="font-semibold text-accent">Your account</span>: changes your own capital account. Other owners can't see these.
        </li>
      </ul>
      <div className="mt-6 space-y-3">
        {isLoading || authLoading ? <OwnerLoading /> : null}
        {isError ? (
          <p className="text-sm text-destructive">
            Couldn't load the ledger.{" "}
            <button type="button" className="underline" onClick={() => refetch()}>
              Try again
            </button>
          </p>
        ) : null}
        {data?.allowed && data.entries.length === 0 ? <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">No transactions yet.</p> : null}
        {data?.allowed
          ? data.entries.map((e) => <EntryCard key={e.id} entry={e} propertyId={propertyId} accounts={data.accounts} canAsk={data.inquiriesAvailable} onDone={() => void refetch()} />)
          : null}
      </div>
    </OwnerPageShell>
  );
}

function EntryCard({ entry, propertyId, accounts, canAsk, onDone }: { entry: OwnerLedgerEntry; propertyId: string; accounts: Array<{ code: string; name: string }>; canAsk: boolean; onDone: () => void }) {
  const qc = useQueryClient();
  const raise = useServerFn(raiseInquiryFn);
  const [mode, setMode] = useState<null | "clarification" | "recategorize">(null);
  const [message, setMessage] = useState("");
  const [code, setCode] = useState("");
  const [details, setDetails] = useState(false);
  const plain = plainEntry(entry);
  const m = useMutation({
    mutationFn: () => raise({ data: { propertyId, entryId: entry.id, type: mode!, message, suggestedAccountCode: mode === "recategorize" ? code : null } }),
    onSuccess: () => {
      toast.success("Sent to the Manager");
      setMode(null);
      setMessage("");
      setCode("");
      void qc.invalidateQueries({ queryKey: ["owner-ledger", propertyId] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{plain.title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {new Date(`${entry.date}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} · {sourceLabel(entry.source)}
            {plain.yours ? <span className="ml-2 rounded-full bg-accent/15 px-2 py-0.5 font-semibold text-accent">Your account</span> : null}
          </p>
        </div>
        <div className="text-right">
          <div className={`text-lg font-semibold tabular-nums ${plain.cash === "in" ? "text-emerald-700 dark:text-emerald-400" : "text-foreground"}`}>
            {plain.cash === "in" ? "+" : plain.cash === "out" ? "−" : ""}
            {formatCents(plain.amountCents)}
          </div>
          <div className="text-xs text-muted-foreground">{plain.cash === "in" ? "Money in" : plain.cash === "out" ? "Money out" : "No cash moved"}</div>
        </div>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{plain.detail}</p>
      {entry.memo ? <p className="mt-1 text-sm text-foreground">Note: {entry.memo}</p> : null}
      <button type="button" className="mt-2 text-xs font-medium text-primary underline" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
        {details ? "Hide accounting details" : "Show accounting details"}
      </button>
      {details ? (
        <table className="mt-2 w-full text-left text-xs text-muted-foreground">
          <thead>
            <tr>
              <th className="pb-1 font-medium">Account</th>
              <th className="pb-1 text-right font-medium">Increase / charge (debit)</th>
              <th className="pb-1 text-right font-medium">Decrease / source (credit)</th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((l, i) => (
              <tr key={i} className="border-t border-border">
                <td className="py-1 pr-2">
                  {plainAccountName(l.name)} <span className="opacity-70">({l.code})</span>
                </td>
                <td className="py-1 text-right tabular-nums">{l.debitCents ? formatCents(l.debitCents) : ""}</td>
                <td className="py-1 text-right tabular-nums">{l.creditCents ? formatCents(l.creditCents) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {canAsk ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={SECONDARY} onClick={() => setMode("clarification")}>
            Ask a question
          </button>
          <button type="button" className={SECONDARY} onClick={() => setMode("recategorize")}>
            This is in the wrong category
          </button>
        </div>
      ) : null}
      {mode ? (
        <div className="mt-3 space-y-2 rounded-lg bg-muted/40 p-3">
          {mode === "recategorize" ? (
            <label className="block text-xs font-medium text-foreground">
              Which category should it be in?
              <select className={FIELD} value={code} onChange={(e) => setCode(e.target.value)}>
                <option value="">Choose an account…</option>
                {accounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {plainAccountName(a.name)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block text-xs font-medium text-foreground">
            {mode === "recategorize" ? "Why?" : "Your question"}
            <textarea className={FIELD} rows={3} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <div className="flex gap-2">
            <button type="button" className={PRIMARY} disabled={m.isPending || !message.trim() || (mode === "recategorize" && !code)} onClick={() => m.mutate()}>
              Send to the Manager
            </button>
            <button type="button" className={SECONDARY} onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {entry.inquiries.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {entry.inquiries.map((q) => (
            <li key={q.id} className="rounded-lg border border-border p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-accent">{q.type === "recategorize" ? "Your suggestion" : "Your question"}</span>
                <span className="text-xs text-muted-foreground">{STATUS_LABEL[q.status]}</span>
              </div>
              <p className="mt-1 text-foreground">{q.message}</p>
              {q.suggestedAccountCode ? <p className="text-xs text-muted-foreground">Suggested account: {q.suggestedAccountCode}</p> : null}
              {q.managerResponse ? (
                <p className="mt-2 rounded-md bg-muted/50 p-2 text-foreground">
                  <span className="text-xs font-medium text-muted-foreground">The Manager: </span>
                  {q.managerResponse}
                </p>
              ) : null}
              {q.resultingEntryId ? <p className="mt-1 text-xs text-muted-foreground">A correction was posted to the books for this.</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
