import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatDate } from "@/lib/format-date";
import { CAPITAL_CALL_STATUS_LABELS, EXPENSE_CATEGORIES, EXPENSE_STATUS_LABELS, expenseMoney, todayIso, type PaymentKind } from "@/lib/expenses";
import {
  closeCapitalCallFn,
  confirmPaymentReceived,
  createCapitalCallDraft,
  createExpenseDraft,
  issueCapitalCallFn,
  listExpensesForAdmin,
  postExpenseDraft,
  rejectPaymentMarkRecord,
  startCapitalCallVoteFn,
  voidExpenseRecord,
} from "@/lib/expenses.functions";
import type { AdminAllocation, AdminCapitalCall, AdminExpense, SplitPreview } from "@/lib/expenses.server";

export const Route = createFileRoute("/admin/expenses")({
  head: () => ({
    meta: [
      { title: "Expenses — divieight admin" },
      { name: "description", content: "Post expenses, issue capital calls and confirm owners' payments." },
      { property: "og:title", content: "Expenses — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminExpensesPage,
});

const FIELD = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal";
const PRIMARY = "rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";
const SECONDARY = "rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50";
const KEY = ["admin-expenses"];

type Property = { id: string; label: string; issuedShares: number };

function useAdminAction<T>(fn: (input: T) => Promise<unknown>, success: string, after?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(success);
      after?.();
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

function AdminExpensesPage() {
  const load = useServerFn(listExpensesForAdmin);
  const { data, isLoading, error } = useQuery({ queryKey: KEY, queryFn: () => load(), retry: false });
  const [tab, setTab] = useState<"expenses" | "calls">("expenses");

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Expenses</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Post expenses and issue capital calls, split pro-rata across the cap table at that moment. No money moves here: an owner marks a payment as paid and you confirm it once received,
        which adds it to their capital account.
      </p>
      <div role="tablist" className="mt-5 flex gap-2">
        {(
          [
            ["expenses", "Expenses"],
            ["calls", "Capital calls"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} type="button" onClick={() => setTab(id)} className={tab === id ? PRIMARY : SECONDARY}>
            {label}
          </button>
        ))}
      </div>
      <div className="mt-5 space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : !data ? null : tab === "expenses" ? (
          <>
            <NewExpense properties={data.properties} />
            {data.expenses.length === 0 ? <Empty text="No expenses yet." /> : data.expenses.map((e) => <ExpenseCard key={e.id} row={e} />)}
          </>
        ) : (
          <>
            <p className="rounded-lg border border-border bg-secondary/40 p-3 text-sm text-foreground">
              A call above {expenseMoney(data.voteThreshold)} needs a passed vote before it can be issued.
              {data.voteThresholdIsPlaceholder ? " This threshold is a placeholder until the Operating Agreement is final." : ""}
            </p>
            <NewCapitalCall properties={data.properties} />
            {data.calls.length === 0 ? <Empty text="No capital calls yet." /> : data.calls.map((c) => <CallCard key={c.id} row={c} />)}
          </>
        )}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">{text}</p>;
}

function PropertySelect({ properties, value, onChange }: { properties: Property[]; value: string; onChange: (id: string) => void }) {
  return (
    <label className="block text-sm font-medium text-foreground">
      Property
      <select required value={value} onChange={(e) => onChange(e.target.value)} className={FIELD}>
        <option value="">Choose a property</option>
        {properties.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label} ({p.issuedShares} issued)
          </option>
        ))}
      </select>
    </label>
  );
}

function NewExpense({ properties }: { properties: Property[] }) {
  const create = useServerFn(createExpenseDraft);
  const [propertyId, setPropertyId] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(EXPENSE_CATEGORIES[0]!);
  const [total, setTotal] = useState("");
  const [incurredOn, setIncurredOn] = useState(todayIso());
  const mut = useAdminAction(() => create({ data: { propertyId, description, category, totalAmount: total, incurredOn } }), "Draft saved. Check the split, then post it.", () => {
    setDescription("");
    setTotal("");
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    mut.mutate(undefined);
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="font-display text-lg font-semibold text-foreground">New expense</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <PropertySelect properties={properties} value={propertyId} onChange={setPropertyId} />
        <label className="block text-sm font-medium text-foreground">
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={FIELD}>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-foreground">
          Total
          <input required type="number" min="0.01" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} className={FIELD} />
        </label>
        <label className="block text-sm font-medium text-foreground">
          Incurred on
          <input required type="date" value={incurredOn} onChange={(e) => setIncurredOn(e.target.value)} className={FIELD} />
        </label>
      </div>
      <label className="block text-sm font-medium text-foreground">
        Description
        <input required maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} className={FIELD} />
      </label>
      <button type="submit" disabled={mut.isPending || !propertyId || !description.trim() || !total} className={PRIMARY}>
        {mut.isPending ? "Saving…" : "Save draft"}
      </button>
    </form>
  );
}

function NewCapitalCall({ properties }: { properties: Property[] }) {
  const create = useServerFn(createCapitalCallDraft);
  const [propertyId, setPropertyId] = useState("");
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [total, setTotal] = useState("");
  const [dueDate, setDueDate] = useState("");
  const mut = useAdminAction(() => create({ data: { propertyId, title, reason, totalAmount: total, dueDate } }), "Draft saved.", () => {
    setTitle("");
    setReason("");
    setTotal("");
    setDueDate("");
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    mut.mutate(undefined);
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="font-display text-lg font-semibold text-foreground">New capital call</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <PropertySelect properties={properties} value={propertyId} onChange={setPropertyId} />
        <label className="block text-sm font-medium text-foreground">
          Title
          <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} className={FIELD} />
        </label>
        <label className="block text-sm font-medium text-foreground">
          Total
          <input required type="number" min="0.01" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} className={FIELD} />
        </label>
        <label className="block text-sm font-medium text-foreground">
          Due date
          <input required type="date" min={todayIso()} value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={FIELD} />
        </label>
      </div>
      <label className="block text-sm font-medium text-foreground">
        Reason: owners see this
        <textarea required rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} className={FIELD} />
      </label>
      <button type="submit" disabled={mut.isPending || !propertyId || !title.trim() || !reason.trim() || !total || !dueDate} className={PRIMARY}>
        {mut.isPending ? "Saving…" : "Save draft"}
      </button>
    </form>
  );
}

function Preview({ preview }: { preview: SplitPreview | null }) {
  if (!preview) return null;
  if (preview.problem) return <p className="mt-3 text-sm text-destructive">{preview.problem}</p>;
  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Split on today's cap table</p>
      <ul className="mt-1.5 space-y-1 text-sm">
        {preview.lines.map((l) => (
          <li key={l.holderLabel} className="flex flex-wrap justify-between gap-2 text-foreground">
            <span className="min-w-0 break-words">
              {l.holderLabel} <span className="text-muted-foreground">({l.shareCount})</span>
            </span>
            <span className="font-medium">{expenseMoney(l.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const ALLOCATION_LABELS: Record<string, string> = { due: "Due", paid: "Paid", waived: "Waived", marked_paid: "Marked paid", confirmed: "Confirmed", overdue: "Overdue" };

function Allocations({ kind, rows }: { kind: PaymentKind; rows: AdminAllocation[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="mt-3 space-y-2 border-t border-border pt-3 text-sm">
      {rows.map((a) => (
        <AllocationRow key={a.id} kind={kind} row={a} />
      ))}
    </ul>
  );
}

function AllocationRow({ kind, row }: { kind: PaymentKind; row: AdminAllocation }) {
  const confirm = useServerFn(confirmPaymentReceived);
  const reject = useServerFn(rejectPaymentMarkRecord);
  const [note, setNote] = useState("");
  const confirmMut = useAdminAction(() => confirm({ data: { kind, allocationId: row.id } }), "Confirmed and added to their capital account.");
  const rejectMut = useAdminAction(() => reject({ data: { kind, allocationId: row.id, note } }), "Sent back to the owner.", () => setNote(""));
  const waiting = kind === "expense" ? row.status === "due" && Boolean(row.paidMarkedAt) : row.status === "marked_paid";
  return (
    <li>
      <div className="flex flex-wrap items-center justify-between gap-2 text-foreground">
        <span className="min-w-0 break-words">
          {row.holderLabel} <span className="text-muted-foreground">({row.shareCount})</span>
        </span>
        <span>
          <span className="font-medium">{expenseMoney(row.amount)}</span> <span className="text-muted-foreground">· {waiting ? "Marked paid" : (ALLOCATION_LABELS[row.status] ?? row.status)}</span>
        </span>
      </div>
      {waiting ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button type="button" disabled={confirmMut.isPending} onClick={() => confirmMut.mutate(undefined)} className={PRIMARY}>
            Confirm received
          </button>
          <input aria-label="Why it wasn't received" placeholder="Why it wasn't received" value={note} onChange={(e) => setNote(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          <button type="button" disabled={rejectMut.isPending || !note.trim()} onClick={() => rejectMut.mutate(undefined)} className={SECONDARY}>
            Not received
          </button>
        </div>
      ) : null}
    </li>
  );
}

function ExpenseCard({ row }: { row: AdminExpense }) {
  const post = useServerFn(postExpenseDraft);
  const voidFn = useServerFn(voidExpenseRecord);
  const [reason, setReason] = useState("");
  const postMut = useAdminAction(() => post({ data: { expenseId: row.id } }), "Posted. Each owner was told their share.");
  const voidMut = useAdminAction(() => voidFn({ data: { expenseId: row.id, reason } }), "Voided.", () => setReason(""));
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 break-words font-display text-base font-semibold text-foreground">{row.description}</h2>
        <p className="font-semibold text-foreground">{expenseMoney(row.totalAmount)}</p>
      </div>
      <p className="mt-1 break-words text-xs text-muted-foreground">
        {row.propertyLabel} · {row.category} · {formatDate(row.incurredOn)} · {EXPENSE_STATUS_LABELS[row.status]}
        {row.fromMaintenance ? " · From a maintenance request" : ""}
      </p>
      {row.voidReason ? <p className="mt-2 break-words text-sm text-muted-foreground">Voided: {row.voidReason}</p> : null}
      <Preview preview={row.preview} />
      <Allocations kind="expense" rows={row.allocations} />
      {row.status !== "voided" ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {row.status === "draft" ? (
            <button type="button" disabled={postMut.isPending || !row.preview || Boolean(row.preview.problem)} onClick={() => postMut.mutate(undefined)} className={PRIMARY}>
              {postMut.isPending ? "Posting…" : "Post expense"}
            </button>
          ) : null}
          <input aria-label="Reason to void" placeholder="Reason to void" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          <button type="button" disabled={voidMut.isPending || !reason.trim()} onClick={() => voidMut.mutate(undefined)} className={SECONDARY}>
            Void
          </button>
        </div>
      ) : null}
    </section>
  );
}

function CallCard({ row }: { row: AdminCapitalCall }) {
  const startVote = useServerFn(startCapitalCallVoteFn);
  const issue = useServerFn(issueCapitalCallFn);
  const close = useServerFn(closeCapitalCallFn);
  const [closesAt, setClosesAt] = useState("");
  const [dueDate, setDueDate] = useState(row.dueDate);
  const voteMut = useAdminAction(() => startVote({ data: { callId: row.id, closesAt } }), "Vote opened. Owners were told.", () => setClosesAt(""));
  const issueMut = useAdminAction(() => issue({ data: { callId: row.id, dueDate } }), "Issued. Each owner was told their share.");
  const closeMut = useAdminAction(() => close({ data: { callId: row.id } }), "Closed.");
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 break-words font-display text-base font-semibold text-foreground">{row.title}</h2>
        <p className="font-semibold text-foreground">{expenseMoney(row.totalAmount)}</p>
      </div>
      <p className="mt-1 break-words text-xs text-muted-foreground">
        {row.propertyLabel} · {CAPITAL_CALL_STATUS_LABELS[row.status]} · Due {formatDate(row.dueDate)}
      </p>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">{row.reason}</p>
      {row.needsVote ? (
        <p className="mt-2 text-sm text-foreground">
          {!row.vote ? (
            "Above the threshold: needs a passed vote."
          ) : (
            <>
              Vote:{" "}
              <Link to="/admin/properties/$id/votes" params={{ id: row.propertyId }} className="font-medium text-primary hover:underline">
                {row.vote.status === "closed" ? (row.vote.passed ? "passed" : "did not pass") : row.vote.status === "open" ? `open until ${formatDate(row.vote.closesAt)}` : row.vote.status}
              </Link>
            </>
          )}
        </p>
      ) : null}
      <Preview preview={row.preview} />
      <Allocations kind="capital_call" rows={row.allocations} />
      {row.status !== "closed" ? (
        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-3">
          {row.canStartVote ? (
            <>
              <label className="block text-sm font-medium text-foreground">
                Vote closes
                <input type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} className={FIELD} />
              </label>
              <button
                type="button"
                disabled={voteMut.isPending || !closesAt}
                onClick={() => voteMut.mutate(undefined)}
                className={PRIMARY}
              >
                {voteMut.isPending ? "Opening…" : row.vote ? "Open a new vote" : "Open a vote"}
              </button>
            </>
          ) : null}
          {row.canIssue ? (
            <>
              <label className="block text-sm font-medium text-foreground">
                Due date
                <input type="date" min={todayIso()} value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={FIELD} />
              </label>
              <button type="button" disabled={issueMut.isPending || !dueDate || !row.preview || Boolean(row.preview.problem)} onClick={() => issueMut.mutate(undefined)} className={PRIMARY}>
                {issueMut.isPending ? "Issuing…" : "Issue capital call"}
              </button>
            </>
          ) : null}
          <button type="button" disabled={closeMut.isPending} onClick={() => closeMut.mutate(undefined)} className={SECONDARY}>
            {row.status === "draft" ? "Discard draft" : "Close call"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
