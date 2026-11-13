import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { formatCents, reviewReasonLabel } from "@/lib/bank-feed-display";
import { LODGING_TAX_FLAG_NOTE, LODGING_TAX_FLAG_TITLE, LODGING_TAX_LABELS, STR_LLC_WARNING } from "@/lib/str";
import { getLodgingTaxExposure } from "@/lib/str.functions";
import {
  applyRulesToNeedsReviewFn,
  capitalizeEntryFn,
  createRecurringRuleFn,
  getBooksOverview,
  getReceiptLinkFn,
  ignoreBankTransactionFn,
  reclassifyStrDepositFn,
  postBankTransactionFn,
  postManualEntryFn,
  recategorizeEntryFn,
  reopenPeriodFn,
  runRecurringNowFn,
  saveCategorizationRuleFn,
  setCategorizationRuleActiveFn,
  setRecurringRuleActiveFn,
} from "@/lib/books.functions";
import { closeLedgerPeriodFn, reverseLedgerEntryFn } from "@/lib/bookkeeping.functions";
import { StatementView } from "@/components/StatementView";
import { generateStatementsFn, getStatement, getStatementBoard, issueStatementsFn, saveStatementNotesFn } from "@/lib/statements.functions";
import { STATEMENT_HOLIDAY_ASSUMPTION, STATEMENT_STATUS_LABELS, statementMoney } from "@/lib/statements";
import { allocateIncomeFn, enterDepreciationFn, getAdminRollForward, getAllocationOverrides, retireAllocationOverrideFn, saveAllocationOverrideFn, syncMonth5EventsFn } from "@/lib/capital.functions";
import { EXPENSE_CATEGORIES, OVERRIDE_METHOD_LABELS, OVERRIDE_METHODS, ROUNDING_RULE_TEXT, USAGE_ADJUSTED_ASSUMPTION, percentsProblem, type OverrideMethod } from "@/lib/expenses";
import type { BookEntry, BooksOverview } from "@/lib/books.server";

/** The Manager's working screens for one LLC's books. Admin and founder only (the admin layout, and every call, checks). */
export const Route = createFileRoute("/admin/books/$propertyId")({
  head: () => ({
    meta: [
      { title: "Books — divieight admin" },
      { name: "description", content: "Review, post, correct and close one LLC's books." },
      { property: "og:title", content: "Books — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminBooksPage,
});

const FIELD = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal";
const PRIMARY = "rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";
const SECONDARY = "rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-50";
const TABS = [
  ["review", "Needs review"],
  ["manual", "Manual entry"],
  ["ledger", "Ledger & corrections"],
  ["recurring", "Recurring"],
  ["rules", "Rules"],
  ["capital", "Capital"],
  ["allocation", "Expense allocation"],
  ["statements", "Statements"],
  ["periods", "Periods"],
] as const;
type Tab = (typeof TABS)[number][0];

const dollars = (text: string) => Math.round(Number(text.replace(/[$,\s]/g, "")) * 100);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function AdminBooksPage() {
  const { propertyId } = Route.useParams();
  const qc = useQueryClient();
  const load = useServerFn(getBooksOverview);
  const key = ["admin-books", propertyId];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => load({ data: { propertyId } }), retry: false });
  const [tab, setTab] = useState<Tab>("review");
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const fail = (e: Error) => toast.error(e.message);

  return (
    <div>
      <Link to="/admin/properties" className="text-xs text-muted-foreground hover:underline">
        ← Properties
      </Link>
      <h1 className="mt-1 font-display text-2xl font-semibold text-foreground">Books{data ? ` — ${data.property.label}` : ""}</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Nothing here edits an entry. A correction is a reversing entry plus a new one, with the reason on both, and the original stays exactly as it was.
      </p>
      {isLoading ? <p className="mt-6 text-sm text-muted-foreground">Loading…</p> : null}
      {error ? <p className="mt-6 text-sm text-destructive">{(error as Error).message}</p> : null}
      {data ? (
        <>
          {data.reconciliation ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Bank {data.reconciliation.bankBalanceCents == null ? "—" : formatCents(data.reconciliation.bankBalanceCents)} · ledger Cash {formatCents(data.reconciliation.ledgerCashCents)} · {data.reconciliation.needsReviewCount} waiting for review
            </p>
          ) : null}
          <p className="mt-2 text-sm">
            <Link to="/admin/books/$propertyId/inquiries" params={{ propertyId }} className="font-medium text-primary hover:underline">
              Co-owner inquiries{data.openInquiries > 0 ? ` (${data.openInquiries} waiting)` : ""} →
            </Link>
          </p>
          <div role="tablist" className="mt-4 flex flex-wrap gap-2">
            {TABS.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} type="button" onClick={() => setTab(id)} className={tab === id ? PRIMARY : SECONDARY}>
                {label}
                {id === "review" && data.review.length > 0 ? ` (${data.review.length})` : ""}
              </button>
            ))}
          </div>
          <div className="mt-5">
            {tab === "review" ? <ReviewTab data={data} propertyId={propertyId} done={refresh} fail={fail} /> : null}
            {tab === "manual" ? <ManualTab data={data} propertyId={propertyId} done={refresh} fail={fail} /> : null}
            {tab === "ledger" ? <LedgerTab data={data} propertyId={propertyId} done={refresh} fail={fail} /> : null}
            {tab === "recurring" ? <RecurringTab data={data} propertyId={propertyId} done={refresh} fail={fail} /> : null}
            {tab === "rules" ? <RulesTab data={data} propertyId={propertyId} done={refresh} fail={fail} /> : null}
            {tab === "capital" ? <CapitalTab data={data} propertyId={propertyId} done={refresh} fail={fail} /> : null}
            {tab === "allocation" ? <AllocationTab propertyId={propertyId} done={refresh} fail={fail} /> : null}
            {tab === "statements" ? <StatementsTab propertyId={propertyId} done={refresh} fail={fail} /> : null}
            {tab === "periods" ? <PeriodsTab data={data} propertyId={propertyId} done={refresh} fail={fail} /> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

type TabProps = { data: BooksOverview; propertyId: string; done: () => void; fail: (e: Error) => void };

function AccountSelect({ data, value, onChange, label }: { data: BooksOverview; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <select aria-label={label} className={FIELD} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose an account…</option>
      {data.accounts.map((a) => (
        <option key={a.code} value={a.code}>
          {a.code} · {a.name}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------- 1. needs review
function ReviewTab({ data, done, fail }: TabProps) {
  const post = useServerFn(postBankTransactionFn);
  const ignore = useServerFn(ignoreBankTransactionFn);
  const reclassify = useServerFn(reclassifyStrDepositFn);
  const apply = useServerFn(applyRulesToNeedsReviewFn);
  const applyM = useMutation({ mutationFn: () => apply({ data: { propertyId: data.property.id } }), onSuccess: (r) => { toast.success(`${r.posted} posted by the rules, ${r.stillNeedsReview} still need you`); done(); }, onError: fail });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Pick the account and post, split it across accounts, or ignore it with a reason. Nothing short-term-rental is ever posted to the LLC.</p>
        <button type="button" className={SECONDARY} disabled={applyM.isPending} onClick={() => applyM.mutate()}>
          Apply the rules to everything waiting
        </button>
      </div>
      {data.review.length === 0 ? <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">Nothing is waiting for review.</p> : null}
      {data.review.map((t) => (
        <ReviewItemCard key={t.id} item={t} data={data} post={(splits) => post({ data: { transactionId: t.id, splits } })} ignore={(reason) => ignore({ data: { transactionId: t.id, reason } })} reclassify={(reason) => reclassify({ data: { transactionId: t.id, reason } })} done={done} fail={fail} />
      ))}
    </div>
  );
}

function ReviewItemCard({ item, data, post, ignore, reclassify, done, fail }: { item: BooksOverview["review"][number]; data: BooksOverview; post: (s: Array<{ code: string; cents: number }>) => Promise<unknown>; ignore: (reason: string) => Promise<unknown>; reclassify: (reason: string) => Promise<unknown>; done: () => void; fail: (e: Error) => void }) {
  const [rows, setRows] = useState<Array<{ code: string; amount: string }>>([{ code: item.suggestion?.code ?? "", amount: (item.amountCents / 100).toFixed(2) }]);
  const [reason, setReason] = useState("");
  const [ignoring, setIgnoring] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  // Short-term-rental income is the owner's, never the LLC's: it can only be ignored or reclassified.
  const isStr = item.reason === "looks_like_str_revenue";
  const total = rows.reduce((s, r) => s + (Number.isFinite(dollars(r.amount)) ? dollars(r.amount) : 0), 0);
  const balanced = total === item.amountCents;
  const postM = useMutation({ mutationFn: () => post(rows.map((r) => ({ code: r.code, cents: dollars(r.amount) }))), onSuccess: () => { toast.success("Posted to the ledger"); done(); }, onError: fail });
  const ignoreM = useMutation({ mutationFn: () => ignore(reason), onSuccess: () => { toast.success("Marked ignored"); done(); }, onError: fail });
  const reclassifyM = useMutation({ mutationFn: () => reclassify(reason), onSuccess: () => { toast.success("Reclassified as the owner's income, not the LLC's"); done(); }, onError: fail });
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="font-medium text-foreground">{item.merchantName ?? item.description ?? "Bank transaction"}</div>
          <div className="text-xs text-muted-foreground">
            {item.postedDate} · {item.description ?? ""} · {reviewReasonLabel(item.reason)}
          </div>
        </div>
        <div className="text-sm font-semibold">{item.direction === "in" ? "+" : "−"}{formatCents(item.amountCents)}</div>
      </div>
      {isStr ? <p role="alert" className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm font-medium text-destructive">{STR_LLC_WARNING}</p> : null}
      {item.suggestion && !isStr ? <p className="mt-1 text-xs text-muted-foreground">Suggested: {item.suggestion.code} · {item.suggestion.name}</p> : null}
      {!isStr ? (
      <div className="mt-3 space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_9rem_auto]">
            <AccountSelect data={data} label={`Account ${i + 1}`} value={r.code} onChange={(code) => setRows(rows.map((x, j) => (j === i ? { ...x, code } : x)))} />
            <input aria-label={`Amount ${i + 1}`} className={FIELD} inputMode="decimal" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
            {rows.length > 1 ? (
              <button type="button" className={SECONDARY} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                Remove
              </button>
            ) : null}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={SECONDARY} onClick={() => setRows([...rows, { code: "", amount: "0.00" }])}>
            Split across another account
          </button>
          <span className={`text-xs ${balanced ? "text-muted-foreground" : "text-destructive"}`}>
            {balanced ? "Splits add up." : `Splits add up to ${formatCents(total)}; the transaction is ${formatCents(item.amountCents)}.`}
          </span>
        </div>
      </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {!isStr ? (
          <button type="button" className={PRIMARY} disabled={!balanced || rows.some((r) => !r.code) || postM.isPending} onClick={() => postM.mutate()}>
            Post to the ledger
          </button>
        ) : null}
        <button type="button" className={SECONDARY} onClick={() => { setIgnoring(!ignoring); setReclassifying(false); }}>
          Ignore…
        </button>
        {isStr ? (
          <button type="button" className={SECONDARY} onClick={() => { setReclassifying(!reclassifying); setIgnoring(false); }}>
            Reclassify as the owner's…
          </button>
        ) : null}
      </div>
      {reclassifying ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex-1 text-xs font-medium text-foreground">
            Whose income is this, and why isn't it the LLC's?
            <input className={FIELD} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button type="button" className={SECONDARY} disabled={!reason.trim() || reclassifyM.isPending} onClick={() => reclassifyM.mutate()}>
            Reclassify
          </button>
        </div>
      ) : null}
      {ignoring ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex-1 text-xs font-medium text-foreground">
            Why is it being ignored?
            <input className={FIELD} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button type="button" className={SECONDARY} disabled={!reason.trim() || ignoreM.isPending} onClick={() => ignoreM.mutate()}>
            Mark ignored
          </button>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- 2. manual entry
function ManualTab({ data, propertyId, done, fail }: TabProps) {
  const post = useServerFn(postManualEntryFn);
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [code, setCode] = useState("");
  const [memo, setMemo] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      let receipt: { path: string; name: string; type: string | null } | null = null;
      if (file) {
        // The private bucket pattern: the Manager's session uploads under this property's folder.
        const path = `${propertyId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const { error: upErr } = await supabase.storage.from("ledger-receipts").upload(path, file, { contentType: file.type || undefined });
        if (upErr) throw new Error(`The receipt could not be uploaded: ${upErr.message}`);
        receipt = { path, name: file.name, type: file.type || null };
      }
      return post({ data: { propertyId, date, amountCents: dollars(amount), direction, accountCode: code, memo, receiptPath: receipt?.path ?? null, receiptName: receipt?.name ?? null, receiptType: receipt?.type ?? null } });
    },
    onSuccess: () => {
      toast.success("Posted to the ledger");
      setAmount("");
      setMemo("");
      setFile(null);
      done();
    },
    onError: fail,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <form onSubmit={submit} className="max-w-2xl space-y-3 rounded-xl border border-border bg-card p-4">
      <p className="text-sm text-muted-foreground">For cash that isn't in the bank feed. It posts to the ledger with the date, account and memo, and the receipt is kept with it.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs font-medium text-foreground">Date<input type="date" max={today} className={FIELD} value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="text-xs font-medium text-foreground">Amount ($)<input className={FIELD} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="text-xs font-medium text-foreground">
          Cash went
          <select className={FIELD} value={direction} onChange={(e) => setDirection(e.target.value as "in" | "out")}>
            <option value="out">Out</option>
            <option value="in">In</option>
          </select>
        </label>
      </div>
      <label className="block text-xs font-medium text-foreground">Account<AccountSelect data={data} label="Account" value={code} onChange={setCode} /></label>
      <label className="block text-xs font-medium text-foreground">Memo<input className={FIELD} value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
      <label className="block text-xs font-medium text-foreground">Receipt (optional)<input type="file" accept="image/*,application/pdf" className={FIELD} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      <button type="submit" className={PRIMARY} disabled={m.isPending || !code || !memo.trim() || !(dollars(amount) > 0)}>
        Post entry
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- 3 + 4. ledger, corrections, capitalize
function LedgerTab({ data, done, fail }: TabProps) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Recategorize, capitalize or reverse an entry. Each creates new entries and needs a reason; the original is never changed.</p>
      {data.entries.length === 0 ? <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">No entries yet.</p> : null}
      {data.entries.map((e) => (
        <EntryCard key={e.id} entry={e} data={data} done={done} fail={fail} />
      ))}
    </div>
  );
}

function EntryCard({ entry, data, done, fail }: { entry: BookEntry; data: BooksOverview; done: () => void; fail: (e: Error) => void }) {
  const recat = useServerFn(recategorizeEntryFn);
  const cap = useServerFn(capitalizeEntryFn);
  const rev = useServerFn(reverseLedgerEntryFn);
  const link = useServerFn(getReceiptLinkFn);
  const [mode, setMode] = useState<null | "recategorize" | "capitalize" | "reverse">(null);
  const [reason, setReason] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const settled = entry.reversed || entry.isReversal;
  const hasExpense = entry.lines.some((l) => l.type === "expense" && l.debitCents > 0);
  const movable = entry.lines.filter((l) => l.code !== "1000" && !l.memberId);
  const hasMember = entry.lines.some((l) => l.memberId);
  const act = useMutation({
    mutationFn: async () => {
      if (mode === "recategorize") return recat({ data: { entryId: entry.id, mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)), reason } });
      if (mode === "capitalize") return cap({ data: { entryId: entry.id, reason } });
      return rev({ data: { entryId: entry.id, reason } });
    },
    onSuccess: () => {
      toast.success(mode === "reverse" ? "Reversed" : "Corrected: a reversing entry and a new one were posted");
      setMode(null);
      setReason("");
      done();
    },
    onError: fail,
  });
  const open = async (id: string) => {
    try {
      const r = await link({ data: { propertyId: data.property.id, attachmentId: id } });
      window.open(r.url, "_blank", "noopener");
    } catch (e) {
      fail(e as Error);
    }
  };
  return (
    <section className={`rounded-xl border border-border bg-card p-4 ${settled ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {entry.date} · {entry.source}
          {entry.isAdjustment ? " · adjustment" : ""}
          {entry.isReversal ? " · reversal" : ""}
          {entry.reversed ? " · reversed" : ""}
          {entry.correction ? ` · ${entry.correction.kind}d: ${entry.correction.reason}` : ""}
        </span>
        <span className="font-mono">{entry.id.slice(0, 8)}</span>
      </div>
      {entry.memo ? <div className="mt-1 text-sm text-foreground">{entry.memo}</div> : null}
      <div className="mt-2 text-sm">
        {entry.lines.map((l) => (
          <div key={l.id} className="flex justify-between gap-3">
            <span>{l.code} · {l.name}</span>
            <span className="text-muted-foreground">{l.debitCents ? `Dr ${formatCents(l.debitCents)}` : `Cr ${formatCents(l.creditCents)}`}</span>
          </div>
        ))}
      </div>
      {entry.receipts.map((r) => (
        <button key={r.id} type="button" className="mt-2 mr-2 text-xs text-primary underline" onClick={() => open(r.id)}>
          Receipt: {r.fileName}
        </button>
      ))}
      {!settled ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {!hasMember ? <button type="button" className={SECONDARY} onClick={() => setMode("recategorize")}>Recategorize</button> : null}
          {hasExpense ? <button type="button" className={SECONDARY} onClick={() => setMode("capitalize")}>Capitalize</button> : null}
          <button type="button" className={SECONDARY} onClick={() => setMode("reverse")}>Reverse</button>
        </div>
      ) : null}
      {mode ? (
        <div className="mt-3 space-y-2 rounded-lg bg-muted/40 p-3">
          {mode === "recategorize" ? (
            <div className="space-y-2">
              {movable.map((l) => (
                <div key={l.id} className="grid gap-2 sm:grid-cols-[1fr_1fr] sm:items-center">
                  <span className="text-xs">{l.code} · {l.name}</span>
                  <AccountSelect data={data} label={`Move ${l.code} to`} value={mapping[l.id] ?? ""} onChange={(v) => setMapping({ ...mapping, [l.id]: v })} />
                </div>
              ))}
            </div>
          ) : null}
          {mode === "capitalize" ? <p className="text-xs text-muted-foreground">The expense is reversed and posted to 1210 · Furnishings and Capital Improvements.</p> : null}
          {mode === "reverse" ? <p className="text-xs text-muted-foreground">A reversing entry is posted; this entry stays as it is.</p> : null}
          <label className="block text-xs font-medium text-foreground">
            Reason (required)
            <input className={FIELD} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="flex gap-2">
            <button type="button" className={PRIMARY} disabled={!reason.trim() || act.isPending || (mode === "recategorize" && Object.values(mapping).every((v) => !v))} onClick={() => act.mutate()}>
              {mode === "reverse" ? "Reverse" : mode === "capitalize" ? "Capitalize" : "Recategorize"}
            </button>
            <button type="button" className={SECONDARY} onClick={() => setMode(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- 5. recurring
function RecurringTab({ data, propertyId, done, fail }: TabProps) {
  const create = useServerFn(createRecurringRuleFn);
  const toggle = useServerFn(setRecurringRuleActiveFn);
  const runNow = useServerFn(runRecurringNowFn);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [code, setCode] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [firstRun, setFirstRun] = useState(new Date().toISOString().slice(0, 10));
  const createM = useMutation({ mutationFn: () => create({ data: { propertyId, description, amountCents: dollars(amount), accountCode: code, frequency, firstRun } }), onSuccess: () => { toast.success("Recurring expense set up"); setDescription(""); setAmount(""); done(); }, onError: fail });
  const toggleM = useMutation({ mutationFn: (v: { ruleId: string; active: boolean }) => toggle({ data: v }), onSuccess: done, onError: fail });
  const runM = useMutation({ mutationFn: () => runNow({ data: { propertyId } }), onSuccess: (r) => { toast.success(`${r.posted} posted, ${r.failed} failed, ${r.alreadyApplied} already applied`); done(); }, onError: fail });
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">A daily job posts each due date once and logs it. A rule is paused rather than edited; to change the amount, add a new one.</p>
      <form className="grid max-w-3xl gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); createM.mutate(); }}>
        <label className="text-xs font-medium text-foreground sm:col-span-2">Description<input className={FIELD} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="text-xs font-medium text-foreground">Amount ($)<input className={FIELD} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="text-xs font-medium text-foreground">Account<AccountSelect data={{ ...data, accounts: data.accounts.filter((a) => a.type === "expense") }} label="Account" value={code} onChange={setCode} /></label>
        <label className="text-xs font-medium text-foreground">
          Repeats
          <select className={FIELD} value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            {["weekly", "monthly", "quarterly", "annually"].map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-foreground">First due<input type="date" className={FIELD} value={firstRun} onChange={(e) => setFirstRun(e.target.value)} /></label>
        <div className="sm:col-span-2"><button type="submit" className={PRIMARY} disabled={createM.isPending || !description.trim() || !code || !(dollars(amount) > 0)}>Add recurring expense</button></div>
      </form>
      <div className="flex justify-end"><button type="button" className={SECONDARY} disabled={runM.isPending} onClick={() => runM.mutate()}>Run what is due now</button></div>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card text-sm">
        {data.recurring.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
            <span>
              {r.description} · {formatCents(r.amountCents)} · {r.accountCode} · {r.frequency} · next {r.nextRun}
              {r.lastStatus === "failed" ? " · last run FAILED, will retry" : ""}
              {!r.active ? " · paused" : ""}
            </span>
            <button type="button" className={SECONDARY} onClick={() => toggleM.mutate({ ruleId: r.id, active: !r.active })}>{r.active ? "Pause" : "Resume"}</button>
          </li>
        ))}
        {data.recurring.length === 0 ? <li className="p-3 text-muted-foreground">No recurring expenses yet.</li> : null}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- 6. categorization rules
function RulesTab({ data, propertyId, done, fail }: TabProps) {
  const save = useServerFn(saveCategorizationRuleFn);
  const toggle = useServerFn(setCategorizationRuleActiveFn);
  const apply = useServerFn(applyRulesToNeedsReviewFn);
  const [matchType, setMatchType] = useState("keyword");
  const [pattern, setPattern] = useState("");
  const [code, setCode] = useState("");
  const [priority, setPriority] = useState("100");
  const saveM = useMutation({ mutationFn: () => save({ data: { propertyId, matchType, pattern, accountCode: code, priority: Number(priority) } }), onSuccess: () => { toast.success("Rule saved"); setPattern(""); done(); }, onError: fail });
  const toggleM = useMutation({ mutationFn: (v: { ruleId: string; active: boolean }) => toggle({ data: v }), onSuccess: done, onError: fail });
  const applyM = useMutation({ mutationFn: () => apply({ data: { propertyId } }), onSuccess: (r) => { toast.success(`${r.posted} posted by the rules, ${r.stillNeedsReview} still need you`); done(); }, onError: fail });
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Rules post matching bank transactions automatically. Money in is never posted to income, and short-term-rental payouts are never posted to the LLC, whatever the rules say.</p>
      <form className="grid max-w-3xl gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); saveM.mutate(); }}>
        <label className="text-xs font-medium text-foreground">
          Match
          <select className={FIELD} value={matchType} onChange={(e) => setMatchType(e.target.value)}>
            <option value="keyword">Keyword</option>
            <option value="merchant">Merchant (exact)</option>
            <option value="amount_range">Amount range (cents)</option>
          </select>
        </label>
        <label className="text-xs font-medium text-foreground sm:col-span-2">{matchType === "amount_range" ? "Range, like 10000-50000" : "Text"}<input className={FIELD} value={pattern} onChange={(e) => setPattern(e.target.value)} /></label>
        <label className="text-xs font-medium text-foreground">Priority<input className={FIELD} inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} /></label>
        <label className="text-xs font-medium text-foreground sm:col-span-3">Post to<AccountSelect data={data} label="Post to" value={code} onChange={setCode} /></label>
        <div className="flex items-end"><button type="submit" className={PRIMARY} disabled={saveM.isPending || !pattern.trim() || !code}>Add rule for this property</button></div>
      </form>
      <div className="flex justify-end"><button type="button" className={SECONDARY} disabled={applyM.isPending} onClick={() => applyM.mutate()}>Apply to existing needs-review ({data.review.length})</button></div>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card text-sm">
        {data.rules.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
            <span className={r.active ? "" : "text-muted-foreground line-through"}>
              {r.propertyId ? "This property" : "Global"} · {r.matchType} “{r.pattern}” → {r.accountCode} · priority {r.priority}
            </span>
            <button type="button" className={SECONDARY} onClick={() => toggleM.mutate({ ruleId: r.id, active: !r.active })}>{r.active ? "Turn off" : "Turn on"}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- 7. periods
function PeriodsTab({ data, propertyId, done, fail }: TabProps) {
  const close = useServerFn(closeLedgerPeriodFn);
  const reopen = useServerFn(reopenPeriodFn);
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() === 0 ? 12 : now.getUTCMonth());
  const [reason, setReason] = useState<Record<string, string>>({});
  const closeM = useMutation({ mutationFn: () => close({ data: { propertyId, year, month } }), onSuccess: () => { toast.success("Month closed"); done(); }, onError: fail });
  const reopenM = useMutation({ mutationFn: (v: { year: number; month: number; reason: string }) => reopen({ data: { propertyId, ...v } }), onSuccess: () => { toast.success("Month reopened and logged"); done(); }, onError: fail });
  const closed = data.periods.filter((p) => p.status === "closed");
  const row = (children: ReactNode, k: string) => <li key={k} className="flex flex-wrap items-center justify-between gap-2 p-3">{children}</li>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Close a month once its statement has been generated. A closed month refuses posting; reopening it needs a reason and is audit logged.</p>
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-4">
        <label className="text-xs font-medium text-foreground">Year<input type="number" className={FIELD} value={year} onChange={(e) => setYear(Number(e.target.value))} /></label>
        <label className="text-xs font-medium text-foreground">
          Month
          <select className={FIELD} value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </label>
        <button type="button" className={PRIMARY} disabled={closeM.isPending} onClick={() => closeM.mutate()}>Close this month</button>
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card text-sm">
        {closed.map((p) => {
          const k = `${p.year}-${p.month}`;
          return row(
            <>
              <span>{MONTHS[p.month - 1]} {p.year} · closed</span>
              <span className="flex flex-1 items-center justify-end gap-2">
                <input aria-label={`Reason to reopen ${k}`} placeholder="Reason to reopen" className={`${FIELD} max-w-xs`} value={reason[k] ?? ""} onChange={(e) => setReason({ ...reason, [k]: e.target.value })} />
                <button type="button" className={SECONDARY} disabled={!(reason[k] ?? "").trim() || reopenM.isPending} onClick={() => reopenM.mutate({ year: p.year, month: p.month, reason: reason[k] ?? "" })}>Reopen</button>
              </span>
            </>,
            k,
          );
        })}
        {closed.length === 0 ? <li className="p-3 text-muted-foreground">No closed months.</li> : null}
      </ul>
      {data.periodHistory.length > 0 ? (
        <div>
          <h3 className="text-sm font-medium text-foreground">History</h3>
          <ul className="mt-1 text-xs text-muted-foreground">
            {data.periodHistory.map((h, i) => (
              <li key={i}>{new Date(h.at).toLocaleString()} · {MONTHS[h.month - 1]} {h.year} {h.action}{h.reason ? ` — ${h.reason}` : ""}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- capital accounts
function CapitalTab({ propertyId, done, fail }: TabProps) {
  const rollForward = useServerFn(getAdminRollForward);
  const allocate = useServerFn(allocateIncomeFn);
  const depreciate = useServerFn(enterDepreciationFn);
  const sync = useServerFn(syncMonth5EventsFn);
  const thisYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(thisYear);
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [deprYear, setDeprYear] = useState(thisYear - 1);
  const [amount, setAmount] = useState("");
  const [schedule, setSchedule] = useState("");
  const [note, setNote] = useState("");
  const rf = useQuery({ queryKey: ["admin-roll-forward", propertyId, year], queryFn: () => rollForward({ data: { propertyId, year } }), retry: false });
  const after = () => {
    void rf.refetch();
    done();
  };
  const allocateM = useMutation({
    mutationFn: () => allocate({ data: { propertyId, asOf } }),
    onSuccess: (r) => {
      toast.success(r.status === "posted" ? `Allocated ${formatCents(r.totalCents ?? 0)} of income` : "No unallocated income");
      after();
    },
    onError: fail,
  });
  const deprM = useMutation({
    mutationFn: () => depreciate({ data: { propertyId, year: deprYear, amountCents: dollars(amount), scheduleRef: schedule, note: note || null } }),
    onSuccess: () => {
      toast.success("Depreciation entered and allocated");
      setAmount("");
      after();
    },
    onError: fail,
  });
  const syncM = useMutation({
    mutationFn: () => sync({ data: { propertyId } }),
    onSuccess: (r) => {
      toast.success(`${r.expenses} expenses, ${r.distributions} distributions, ${r.transfers} transfers posted${r.problems.length ? `; ${r.problems.length} could not be: ${r.problems[0]}` : ""}`);
      after();
    },
    onError: fail,
  });
  type Totals = NonNullable<typeof rf.data>["totals"];
  const cols: Array<[string, (m: Totals) => number]> = [
    ["Beginning", (m) => m.beginningCents],
    ["Opening", (m) => m.openingCents],
    ["Contributions", (m) => m.contributionsCents],
    ["Income", (m) => m.incomeCents],
    ["Expenses", (m) => m.expenseCents],
    ["Depreciation", (m) => m.depreciationCents],
    ["Distributions", (m) => m.distributionsCents],
    ["Transfers", (m) => m.transferInCents + m.transferOutCents],
    ["Ending", (m) => m.endingCents],
  ];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Every event that touches a member's capital account is a ledger entry. A joint account is one capital account. Depreciation is entered from the CPA's schedule; the platform never calculates it, and never computes a Section 754 adjustment.
      </p>
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-4">
        <label className="text-xs font-medium text-foreground">
          Roll-forward year
          <input type="number" className={FIELD} value={year} onChange={(e) => setYear(Number(e.target.value))} />
        </label>
        <button type="button" className={SECONDARY} disabled={syncM.isPending} onClick={() => syncM.mutate()}>
          Post Month 5 events the ledger hasn't seen
        </button>
      </div>
      {rf.error ? <p className="text-sm text-destructive">{(rf.error as Error).message}</p> : null}
      {rf.data ? (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="p-2">Member</th>
                {cols.map(([l]) => (
                  <th key={l} className="p-2 text-right">
                    {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rf.data.members.map((m) => (
                <tr key={m.member}>
                  <td className="p-2">{m.member}</td>
                  {cols.map(([l, f]) => (
                    <td key={l} className="p-2 text-right">
                      {formatCents(f(m))}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="font-medium">
                <td className="p-2">Total</td>
                {cols.map(([l, f]) => (
                  <td key={l} className="p-2 text-right">
                    {formatCents(f(rf.data!.totals))}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        <form
          className="space-y-2 rounded-xl border border-border bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            allocateM.mutate();
          }}
        >
          <h3 className="text-sm font-semibold text-foreground">Allocate income</h3>
          <p className="text-xs text-muted-foreground">Other Income not yet allocated, as of the date, goes to the members who held shares then, pro rata to shares.</p>
          <label className="block text-xs font-medium text-foreground">
            As of
            <input type="date" className={FIELD} max={new Date().toISOString().slice(0, 10)} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
          <button type="submit" className={PRIMARY} disabled={allocateM.isPending}>
            Allocate income
          </button>
        </form>
        <form
          className="space-y-2 rounded-xl border border-border bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            deprM.mutate();
          }}
        >
          <h3 className="text-sm font-semibold text-foreground">Enter depreciation (from the CPA's schedule)</h3>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs font-medium text-foreground">
              Tax year
              <input type="number" className={FIELD} value={deprYear} onChange={(e) => setDeprYear(Number(e.target.value))} />
            </label>
            <label className="text-xs font-medium text-foreground">
              Amount ($)
              <input className={FIELD} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
          </div>
          <label className="block text-xs font-medium text-foreground">
            CPA schedule it comes from
            <input className={FIELD} value={schedule} onChange={(e) => setSchedule(e.target.value)} />
          </label>
          <label className="block text-xs font-medium text-foreground">
            Note (optional)
            <input className={FIELD} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="submit" className={PRIMARY} disabled={deprM.isPending || !schedule.trim() || !(dollars(amount) > 0)}>
            Enter and allocate
          </button>
        </form>
      </div>
      <LodgingTaxFlag propertyId={propertyId} />
    </div>
  );
}

// Who recorded short-term-rental activity with lodging tax owed or unknown. No amounts; divieight remits nothing. The CPA
// Cooperation Worksheet reads the same list.
function LodgingTaxFlag({ propertyId }: { propertyId: string }) {
  const load = useServerFn(getLodgingTaxExposure);
  const q = useQuery({ queryKey: ["lodging-tax-exposure", propertyId], queryFn: () => load({ data: { propertyId } }), retry: false });
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">{LODGING_TAX_FLAG_TITLE}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{LODGING_TAX_FLAG_NOTE}</p>
      {q.error ? <p className="mt-2 text-sm text-destructive">{(q.error as Error).message}</p> : null}
      {q.data && q.data.rows.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No owner has recorded short-term-rental activity with lodging tax owed or unknown.</p> : null}
      {q.data && q.data.rows.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm">
          {q.data.rows.map((r) => (
            <li key={r.member} className="flex justify-between gap-3">
              <span>{r.member}</span>
              <span className="text-muted-foreground">{r.statuses.map((s) => LODGING_TAX_LABELS[s]).join(", ")}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- expense allocation (Operating Agreement overrides)
function AllocationTab({ propertyId, done, fail }: { propertyId: string; done: () => void; fail: (e: Error) => void }) {
  const load = useServerFn(getAllocationOverrides);
  const save = useServerFn(saveAllocationOverrideFn);
  const retire = useServerFn(retireAllocationOverrideFn);
  const q = useQuery({ queryKey: ["allocation-overrides", propertyId], queryFn: () => load({ data: { propertyId } }), retry: false });
  const [method, setMethod] = useState<OverrideMethod>("custom_percent");
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]!);
  const [section, setSection] = useState("");
  const [basis, setBasis] = useState("");
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [pct, setPct] = useState<Record<string, string>>({});
  const [retiring, setRetiring] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const percents = Object.fromEntries((q.data?.holders ?? []).map((h) => [h.key, Number(pct[h.key] ?? "")]));
  const problem = (q.data?.holders ?? []).some((h) => !pct[h.key]) ? "Enter a percentage for every holder." : percentsProblem(percents);
  const total = Object.values(percents).reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0);
  const after = () => {
    void q.refetch();
    done();
  };
  const saveM = useMutation({
    mutationFn: () => save({ data: { propertyId, expenseCategory: category, method, percents, basis: basis || null, sourceOaSection: section, effectiveFrom: from } }),
    onSuccess: () => {
      toast.success("Override saved");
      setPct({});
      setSection("");
      setBasis("");
      after();
    },
    onError: fail,
  });
  const retireM = useMutation({
    mutationFn: (id: string) => retire({ data: { overrideId: id, reason: why } }),
    onSuccess: () => {
      toast.success("Override retired");
      setRetiring(null);
      setWhy("");
      after();
    },
    onError: fail,
  });
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Every expense is allocated pro rata to share count when it is posted. {ROUNDING_RULE_TEXT} An Operating Agreement override replaces that for the expenses it names, and only for them. Nothing is overridden unless you enter it here, with the OA section it comes from.
      </p>
      <p className="rounded-xl border border-border bg-card p-3 text-xs text-muted-foreground">Assumption: {USAGE_ADJUSTED_ASSUMPTION}</p>
      {q.error ? <p className="text-sm text-destructive">{(q.error as Error).message}</p> : null}
      {q.data ? (
        <form
          className="space-y-3 rounded-xl border border-border bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            saveM.mutate();
          }}
        >
          <h3 className="text-sm font-semibold text-foreground">New override for an expense category</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-foreground">
              Method
              <select className={FIELD} value={method} onChange={(e) => setMethod(e.target.value as OverrideMethod)}>
                {OVERRIDE_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {OVERRIDE_METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-foreground">
              Expense category
              <select className={FIELD} value={category} onChange={(e) => setCategory(e.target.value)}>
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-foreground">
              Operating Agreement section
              <input className={FIELD} value={section} onChange={(e) => setSection(e.target.value)} />
            </label>
            <label className="text-xs font-medium text-foreground">
              Applies to expenses incurred from
              <input type="date" className={FIELD} value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
          </div>
          {method === "usage_adjusted" ? (
            <label className="block text-xs font-medium text-foreground">
              What the adjustment is based on
              <input className={FIELD} value={basis} onChange={(e) => setBasis(e.target.value)} />
            </label>
          ) : null}
          <div className="space-y-2">
            {q.data.holders.map((h) => (
              <label key={h.key} className="grid items-center gap-2 text-xs font-medium text-foreground sm:grid-cols-[1fr_8rem]">
                <span>
                  {h.label} <span className="text-muted-foreground">({h.shares} shares)</span>
                </span>
                <input aria-label={`Percent for ${h.label}`} className={FIELD} inputMode="decimal" value={pct[h.key] ?? ""} onChange={(e) => setPct({ ...pct, [h.key]: e.target.value })} />
              </label>
            ))}
            <p className={`text-xs ${problem ? "text-destructive" : "text-muted-foreground"}`}>
              {problem ?? "Adds up to 100%."} (Total entered: {total.toFixed(2)}%)
            </p>
          </div>
          <button type="submit" className={PRIMARY} disabled={!!problem || !section.trim() || (method === "usage_adjusted" && !basis.trim()) || saveM.isPending}>
            Save override
          </button>
        </form>
      ) : null}
      {q.data && q.data.overrides.length === 0 ? <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">No overrides. Every expense uses the default pro-rata split.</p> : null}
      {q.data?.overrides.map((o) => (
        <section key={o.id} className="rounded-xl border border-border bg-card p-4 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <div className="font-medium text-foreground">
              {o.expenseCategory ? `${o.expenseCategory} expenses` : "One expense"} · {OVERRIDE_METHOD_LABELS[o.method]}
            </div>
            <div className={o.retiredAt ? "text-muted-foreground" : "text-foreground"}>{o.retiredAt ? "Retired" : "In force"}</div>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {o.sourceOaSection} · from {o.effectiveFrom}
            {o.basis ? ` · based on ${o.basis}` : ""}
            {o.retireReason ? ` · retired: ${o.retireReason}` : ""}
          </div>
          <ul className="mt-2 space-y-1">
            {o.percents.map((p) => (
              <li key={p.holderKey} className="flex justify-between gap-3">
                <span>{p.holder}</span>
                <span>{p.percent}%</span>
              </li>
            ))}
          </ul>
          {!o.retiredAt ? (
            retiring === o.id ? (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="flex-1 text-xs font-medium text-foreground">
                  Why is it being retired?
                  <input className={FIELD} value={why} onChange={(e) => setWhy(e.target.value)} />
                </label>
                <button type="button" className={SECONDARY} disabled={!why.trim() || retireM.isPending} onClick={() => retireM.mutate(o.id)}>
                  Retire
                </button>
              </div>
            ) : (
              <button type="button" className={`${SECONDARY} mt-3`} onClick={() => setRetiring(o.id)}>
                Retire…
              </button>
            )
          ) : null}
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- monthly statements
function StatementPreview({ statementId }: { statementId: string }) {
  const load = useServerFn(getStatement);
  const q = useQuery({ queryKey: ["statement-preview", statementId], queryFn: () => load({ data: { statementId } }), retry: false });
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error) return <p className="text-sm text-destructive">{(q.error as Error).message}</p>;
  if (!q.data) return null;
  return <StatementView snapshot={q.data.snapshot} holder={q.data.holder} version={q.data.version} status={q.data.status} issuedAt={q.data.issuedAt} />;
}

function StatementsTab({ propertyId, done, fail }: { propertyId: string; done: () => void; fail: (e: Error) => void }) {
  const load = useServerFn(getStatementBoard);
  const generate = useServerFn(generateStatementsFn);
  const saveNotes = useServerFn(saveStatementNotesFn);
  const issue = useServerFn(issueStatementsFn);
  const [period, setPeriod] = useState("");
  const q = useQuery({ queryKey: ["statement-board", propertyId, period], queryFn: () => load({ data: { propertyId, period: period || null } }), retry: false });
  const [notes, setNotes] = useState<string | null>(null);
  const [force, setForce] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const shown = period || q.data?.period || "";
  const refresh = () => {
    void q.refetch();
    done();
  };
  const generateM = useMutation({
    mutationFn: () => generate({ data: { propertyId, period: shown } }),
    onSuccess: (r) => {
      toast.success(`${r.created} new draft(s), ${r.refreshed} refreshed, ${r.corrections} correction version(s), ${r.unchanged} unchanged`);
      refresh();
    },
    onError: fail,
  });
  const notesM = useMutation({
    mutationFn: () => saveNotes({ data: { propertyId, period: shown, notes: notes ?? q.data?.notes ?? "" } }),
    onSuccess: (r) => {
      toast.success(`Notes saved on ${r.drafts} draft(s)`);
      refresh();
    },
    onError: fail,
  });
  const issueM = useMutation({
    mutationFn: () => issue({ data: { propertyId, period: shown, forceReason: force } }),
    onSuccess: (r) => {
      toast.success(`${r.issued} statement(s) issued. ${r.notified} owner(s) told, ${r.filed} PDF(s) filed.`);
      setForce("");
      refresh();
    },
    onError: fail,
  });
  const b = q.data;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        One statement per capital account per month, built from the ledger. They stay drafts until you have been through the needs-review queue and added your notes; then Issue sends them to every owner (in the app and by email), with a PDF. An issued statement never changes: a correction to a past month makes a new version and the old one stays viewable. {STATEMENT_HOLIDAY_ASSUMPTION}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium text-foreground">
          Month
          <input type="month" className={FIELD} value={shown} onChange={(e) => { setPeriod(e.target.value); setNotes(null); }} />
        </label>
        <button type="button" className={SECONDARY} disabled={!shown || generateM.isPending} onClick={() => generateM.mutate()}>
          {generateM.isPending ? "Working…" : "Generate drafts / check for corrections"}
        </button>
      </div>
      {q.error ? <p className="text-sm text-destructive">{(q.error as Error).message}</p> : null}
      {b ? (
        <>
          <p className="rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground">
            Schedule: statements for {b.schedule.period} start {b.schedule.starts}, due {b.schedule.deadline}.
            {b.schedule.overdue && b.drafts > 0 ? <strong className="ml-1 text-destructive">The deadline has passed and drafts are waiting.</strong> : null}
          </p>
          {b.statements.length === 0 ? <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">No statements for this month yet. Generate the drafts.</p> : null}
          {b.drafts > 0 ? (
            <section className="space-y-3 rounded-xl border border-border bg-card p-4">
              <h3 className="text-sm font-semibold text-foreground">Manager&apos;s notes (on all {b.drafts} draft(s))</h3>
              <textarea rows={4} maxLength={4000} className={FIELD} placeholder="An upcoming capital call, an unusual expense, items flagged for the CPA" value={notes ?? b.notes} onChange={(e) => setNotes(e.target.value)} />
              <button type="button" className={SECONDARY} disabled={notesM.isPending} onClick={() => notesM.mutate()}>
                Save notes
              </button>
              <p className={`text-sm ${b.needsReview > 0 ? "text-destructive" : "text-muted-foreground"}`}>
                {b.needsReview > 0 ? `${b.needsReview} bank transaction(s) are still in the needs-review queue. Review them first, or issue anyway and say why:` : "The needs-review queue is clear."}
              </p>
              {b.needsReview > 0 ? <input className={FIELD} placeholder="Why you are issuing with items still in the queue" value={force} onChange={(e) => setForce(e.target.value)} /> : null}
              <button type="button" className={PRIMARY} disabled={issueM.isPending || (b.needsReview > 0 && !force.trim())} onClick={() => issueM.mutate()}>
                {issueM.isPending ? "Issuing…" : `Issue all ${b.drafts} draft(s)`}
              </button>
            </section>
          ) : null}
          {b.statements.map((s) => (
            <section key={s.id} className="rounded-xl border border-border bg-card p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground">
                  {s.holder} · version {s.version} · {STATEMENT_STATUS_LABELS[s.status]}
                </span>
                <span className="text-foreground">Closing {statementMoney(s.closingCents)}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {s.reconciles === null ? "" : s.reconciles ? "Totals match the ledger." : "Totals no longer match the ledger: generate to draft a correction."}
                {s.issuedAt ? ` Issued ${s.issuedAt.slice(0, 10)}.` : ""}
              </p>
              <button type="button" className="mt-2 text-sm font-medium text-primary hover:underline" onClick={() => setOpen(open === s.id ? null : s.id)}>
                {open === s.id ? "Hide" : "Preview"}
              </button>
              {open === s.id ? (
                <div className="mt-3">
                  <StatementPreview statementId={s.id} />
                </div>
              ) : null}
            </section>
          ))}
        </>
      ) : null}
    </div>
  );
}
