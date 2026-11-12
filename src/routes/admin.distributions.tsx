import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatDate } from "@/lib/format-date";
import { expenseMoney, ROUNDING_RULE_TEXT } from "@/lib/expenses";
import { DISTRIBUTION_RULES_TEXT, DISTRIBUTION_STATUS_LABELS, MINIMUM_RESERVE_ASSUMPTION, PAYMENT_STATUS_LABELS, fromCents, maskedAccount } from "@/lib/distributions";
import { authorizeDistributionFn, createDistributionFn, executeDistributionFn, getDistributionBoard, previewDistributionFn, repostPayoutDistributionFn, retryPaymentFn, setMinimumReserveFn, settleDistributionFn, voidPayoutDistributionFn } from "@/lib/distributions.functions";
import { repostDistributionEvent, voidDistributionEvent } from "@/lib/owner-notifications.functions";

export const Route = createFileRoute("/admin/distributions")({
  head: () => ({
    meta: [
      { title: "Distributions — divieight admin" },
      { name: "description", content: "Initiate, authorize and execute a distribution to the owners." },
      { property: "og:title", content: "Distributions — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminDistributionsPage,
});

const FIELD = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal";
const PRIMARY = "rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";
const SECONDARY = "rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50";
const money = (cents: number) => expenseMoney(fromCents(cents));
const KEY = ["admin-distribution-board"];

type Board = Awaited<ReturnType<typeof getDistributionBoard>>;
type Event = Board["events"][number];

function PaymentsTable({ event, onRetry, busy }: { event: Event; onRetry: (paymentId: string) => void; busy: boolean }) {
  return (
    <ul className="mt-3 divide-y divide-border rounded-lg border border-border text-sm">
      {event.payments.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <span className="min-w-0 break-words">
            {p.label} <span className="text-muted-foreground">({p.shares} {p.shares === 1 ? "share" : "shares"})</span>
          </span>
          <span className="flex items-center gap-3">
            <span>{money(p.amountCents)}</span>
            <span className={p.status === "failed" ? "text-destructive" : p.status === "held" ? "text-amber-600" : "text-muted-foreground"}>
              {PAYMENT_STATUS_LABELS[p.status]}
              {p.last4 ? ` · ${maskedAccount(p.last4)}` : ""}
            </span>
            {p.status === "failed" ? (
              <button type="button" disabled={busy} onClick={() => onRetry(p.id)} className="text-sm font-medium text-primary hover:underline disabled:opacity-50">
                Retry
              </button>
            ) : null}
          </span>
          {p.failureReason ? <span className="w-full text-xs text-destructive">{p.failureReason}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function PayoutCard({ event: r }: { event: Event }) {
  const qc = useQueryClient();
  const authorize = useServerFn(authorizeDistributionFn);
  const execute = useServerFn(executeDistributionFn);
  const settle = useServerFn(settleDistributionFn);
  const retry = useServerFn(retryPaymentFn);
  const voidIt = useServerFn(voidPayoutDistributionFn);
  const repost = useServerFn(repostPayoutDistributionFn);
  const [open, setOpen] = useState<null | "authorize" | "void" | "repost">(null);
  const [total, setTotal] = useState(String(r.totalCents / 100));
  const [recordDate, setRecordDate] = useState(r.recordDate);
  const [signature, setSignature] = useState("");
  const [reason, setReason] = useState("");
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const fail = (e: Error) => {
    toast.error(e.message);
    refresh();
  };
  const summary = (s: { status: string; sent: number; failed: number; processing: number; held: number }) =>
    toast.success(`${s.sent} paid · ${s.held} held · ${s.failed} failed · ${s.processing} with the bank. Distribution: ${s.status}.`);
  const authorizeM = useMutation({
    mutationFn: () => authorize({ data: { distributionId: r.id, signedName: signature } }),
    onSuccess: () => {
      toast.success("Authorized. Each owner was told their amount.");
      setOpen(null);
      setSignature("");
      refresh();
    },
    onError: fail,
  });
  const executeM = useMutation({ mutationFn: () => execute({ data: { distributionId: r.id } }), onSuccess: (s) => { summary(s); refresh(); }, onError: fail });
  const settleM = useMutation({ mutationFn: () => settle({ data: { distributionId: r.id } }), onSuccess: (s) => { summary(s); refresh(); }, onError: fail });
  const retryM = useMutation({ mutationFn: (paymentId: string) => retry({ data: { paymentId } }), onSuccess: (s) => { summary(s); refresh(); }, onError: fail });
  const voidM = useMutation({
    mutationFn: () => voidIt({ data: { distributionId: r.id, reason } }),
    onSuccess: () => {
      toast.success("Voided. Anything posted was reversed. Owners were told.");
      setOpen(null);
      setReason("");
      refresh();
    },
    onError: fail,
  });
  const repostM = useMutation({
    mutationFn: () => repost({ data: { distributionId: r.id, voidReason: reason, propertyId: r.propertyId, totalAmount: total, recordDate, reason: r.reason ?? "Corrected distribution", method: "pro_rata" } }),
    onSuccess: () => {
      toast.success("Voided, and a corrected draft was made. Authorize it to go ahead.");
      setOpen(null);
      setReason("");
      refresh();
    },
    onError: fail,
  });
  const voided = r.status === "voided";
  const waiting = r.payments.some((p) => p.status === "pending" || p.status === "held");
  const processing = r.payments.some((p) => p.status === "processing");
  const heldOnly = r.payments.some((p) => p.status === "held");
  const busy = executeM.isPending || settleM.isPending || retryM.isPending;
  return (
    <section className={`rounded-xl border border-border bg-card p-5 shadow-sm ${voided ? "opacity-80" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 break-words font-medium text-foreground">{r.propertyLabel}</p>
        <p className={`font-semibold text-foreground ${voided ? "line-through" : ""}`}>{money(r.totalCents)}</p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {DISTRIBUTION_STATUS_LABELS[r.status]} · Record date {formatDate(r.recordDate)} · Created {formatDate(r.createdAt)}
        {r.authorizedAt ? ` · Authorized ${formatDate(r.authorizedAt)}` : ""}
        {r.executedAt ? ` · Executed ${formatDate(r.executedAt)}` : ""}
        {r.splitMethod === "oa_override" ? ` · Split by the Operating Agreement override (${r.oaSection})` : " · Split pro rata"}
        {r.replacesId ? " · Replaces an earlier, voided distribution" : ""}
        {r.replacedById ? " · A corrected distribution was made" : ""}
      </p>
      {r.reason ? <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">{r.reason}</p> : null}
      {voided ? <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">Voided: {r.voidReason}</p> : null}
      {r.payments.length > 0 ? <PaymentsTable event={r} onRetry={(id) => retryM.mutate(id)} busy={busy} /> : null}
      {!voided ? (
        <div className="mt-3 space-y-2">
          {open === null ? (
            <div className="flex flex-wrap gap-3">
              {r.status === "draft" ? (
                <button type="button" className={PRIMARY} onClick={() => setOpen("authorize")}>
                  Authorize with your signature
                </button>
              ) : null}
              {r.status === "authorized" || (r.status === "executed" && waiting) ? (
                <button type="button" className={PRIMARY} disabled={busy} onClick={() => executeM.mutate()}>
                  {executeM.isPending ? "Sending…" : r.status === "executed" ? "Send the held payments" : "Execute: pay the owners"}
                </button>
              ) : null}
              {processing ? (
                <button type="button" className={SECONDARY} disabled={busy} onClick={() => settleM.mutate()}>
                  Check payments with the bank
                </button>
              ) : null}
              {r.splitMethod !== "oa_override" ? (
                <button type="button" onClick={() => setOpen("repost")} className="text-sm font-medium text-primary hover:underline">
                  Void and make a corrected one
                </button>
              ) : null}
              <button type="button" onClick={() => setOpen("void")} className="text-sm font-medium text-muted-foreground hover:underline">
                Void
              </button>
            </div>
          ) : open === "authorize" ? (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <p className="text-sm text-muted-foreground">
                Authorizing tells every owner their amount and lets you execute the payments. Type your full legal name to sign.
              </p>
              <input value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="Your full legal name" aria-label="Your full legal name" className={FIELD} />
              <div className="flex gap-2">
                <button type="button" className={PRIMARY} disabled={!signature.trim() || authorizeM.isPending} onClick={() => authorizeM.mutate()}>
                  {authorizeM.isPending ? "Authorizing…" : "Sign and authorize"}
                </button>
                <button type="button" className={SECONDARY} onClick={() => setOpen(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <p className="text-sm text-muted-foreground">
                {r.status === "executed" ? "Entries that were posted are reversed in the books (nothing is deleted). Any money already sent by ACH has to be recovered from the owner outside divieight." : "Nothing was posted, so nothing is reversed."}
              </p>
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="Reason for voiding (owners see this)" aria-label="Reason for voiding" className={FIELD} />
              {open === "repost" ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <input type="number" min="0.01" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} aria-label="Corrected total" className={FIELD} />
                  <input type="date" value={recordDate} onChange={(e) => setRecordDate(e.target.value)} aria-label="Corrected record date" className={FIELD} />
                </div>
              ) : null}
              <div className="flex gap-2">
                <button type="button" className={PRIMARY} disabled={!reason.trim() || voidM.isPending || repostM.isPending} onClick={() => (open === "repost" ? repostM.mutate() : voidM.mutate())}>
                  {open === "repost" ? "Void and make the corrected draft" : voidM.isPending ? "Voiding…" : "Void"}
                </button>
                <button type="button" className={SECONDARY} onClick={() => setOpen(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {heldOnly ? <p className="text-xs text-muted-foreground">A held owner is paid automatically as soon as they add a payout method. Nobody else's payment waits on theirs.</p> : null}
        </div>
      ) : null}
    </section>
  );
}

/** A Month 5 notice: it was posted at once and paid nothing. Kept as it was, and can still be voided and re-posted. */
function NoticeCard({ event: r }: { event: Event }) {
  const qc = useQueryClient();
  const voidIt = useServerFn(voidDistributionEvent);
  const repost = useServerFn(repostDistributionEvent);
  const [open, setOpen] = useState<null | "void" | "repost">(null);
  const [reason, setReason] = useState("");
  const [total, setTotal] = useState(String(r.totalCents / 100));
  const [recordDate, setRecordDate] = useState(r.recordDate);
  const done = (message: string) => () => {
    toast.success(message);
    setOpen(null);
    setReason("");
    void qc.invalidateQueries({ queryKey: KEY });
  };
  const fail = (e: Error) => toast.error(e.message);
  const voidMut = useMutation({ mutationFn: () => voidIt({ data: { distributionId: r.id, reason } }), onSuccess: done("Voided. Owners were told."), onError: fail });
  const repostMut = useMutation({ mutationFn: () => repost({ data: { distributionId: r.id, reason, totalAmount: total, recordDate, note: r.reason } }), onSuccess: done("Voided and re-posted. Owners were told."), onError: fail });
  const voided = r.status === "voided";
  return (
    <section className={`rounded-xl border border-border bg-card p-5 shadow-sm ${voided ? "opacity-80" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 break-words font-medium text-foreground">{r.propertyLabel}</p>
        <p className={`font-semibold text-foreground ${voided ? "line-through" : ""}`}>{money(r.totalCents)}</p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Month 5 notice (no payment was made through divieight) · Record date {formatDate(r.recordDate)} · Posted {formatDate(r.createdAt)}</p>
      {voided ? <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">Voided: {r.voidReason}</p> : null}
      {r.reason ? <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">{r.reason}</p> : null}
      {!voided ? (
        <div className="mt-3">
          {open === null ? (
            <div className="flex gap-3">
              <button type="button" onClick={() => setOpen("repost")} className="text-sm font-medium text-primary hover:underline">
                Void and re-post
              </button>
              <button type="button" onClick={() => setOpen("void")} className="text-sm font-medium text-muted-foreground hover:underline">
                Void only
              </button>
            </div>
          ) : (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="Reason for voiding (owners see this)" aria-label="Reason for voiding" className={FIELD} />
              {open === "repost" ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <input type="number" min="0.01" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} aria-label="Corrected total" className={FIELD} />
                  <input type="date" value={recordDate} onChange={(e) => setRecordDate(e.target.value)} aria-label="Corrected record date" className={FIELD} />
                </div>
              ) : null}
              <div className="flex gap-2">
                <button type="button" disabled={!reason.trim() || voidMut.isPending || repostMut.isPending} onClick={() => (open === "repost" ? repostMut.mutate() : voidMut.mutate())} className={PRIMARY}>
                  {open === "repost" ? "Void and post the corrected one" : "Void"}
                </button>
                <button type="button" onClick={() => setOpen(null)} className={SECONDARY}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function ReserveEditor({ propertyId, reserveCents, done }: { propertyId: string; reserveCents: number; done: () => void }) {
  const set = useServerFn(setMinimumReserveFn);
  const [value, setValue] = useState(String(reserveCents / 100));
  const m = useMutation({
    mutationFn: () => set({ data: { propertyId, reserveAmount: value } }),
    onSuccess: () => {
      toast.success("Minimum reserve saved");
      done();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <label className="text-xs font-medium text-foreground">
        Minimum reserve kept in Cash
        <input type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} className={`${FIELD} w-40`} />
      </label>
      <button type="submit" className={SECONDARY} disabled={m.isPending}>
        Save reserve
      </button>
      <p className="w-full text-xs text-muted-foreground">{MINIMUM_RESERVE_ASSUMPTION}</p>
    </form>
  );
}

function InitiateForm({ properties, propertyId, setPropertyId, done }: { properties: Board["properties"]; propertyId: string; setPropertyId: (id: string) => void; done: () => void }) {
  const preview = useServerFn(previewDistributionFn);
  const create = useServerFn(createDistributionFn);
  const [total, setTotal] = useState("");
  const [recordDate, setRecordDate] = useState("");
  const [reason, setReason] = useState("");
  const [method, setMethod] = useState<"pro_rata" | "oa_override">("pro_rata");
  const [section, setSection] = useState("");
  const [pct, setPct] = useState<Record<string, string>>({});
  const input = () => ({ propertyId, totalAmount: total, recordDate, reason, method, oaSection: section, percents: method === "oa_override" ? pct : null });
  const previewM = useMutation({ mutationFn: () => preview({ data: input() }), onError: (e: Error) => toast.error(e.message) });
  const createM = useMutation({
    mutationFn: () => create({ data: input() }),
    onSuccess: () => {
      toast.success("Draft created. Review it below, then authorize it with your signature.");
      setTotal("");
      setRecordDate("");
      setReason("");
      setPct({});
      previewM.reset();
      done();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const p = previewM.data;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    previewM.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-foreground">Initiate a distribution</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm font-medium text-foreground">
          Property
          <select required value={propertyId} onChange={(e) => setPropertyId(e.target.value)} className={FIELD}>
            <option value="">Choose a property</option>
            {properties.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-foreground">
          Total
          <input required type="number" min="0.01" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} className={FIELD} />
        </label>
        <label className="block text-sm font-medium text-foreground">
          Record date
          <input required type="date" value={recordDate} onChange={(e) => setRecordDate(e.target.value)} className={FIELD} />
        </label>
      </div>
      <label className="block text-sm font-medium text-foreground">
        Reason: owners see this
        <textarea required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} className={FIELD} />
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-foreground">Split</legend>
        <label className="mr-4 text-sm">
          <input type="radio" checked={method === "pro_rata"} onChange={() => setMethod("pro_rata")} /> Pro rata to the shares held on the record date
        </label>
        <label className="text-sm">
          <input type="radio" checked={method === "oa_override"} onChange={() => setMethod("oa_override")} /> Per an Operating Agreement override
        </label>
        {method === "oa_override" ? (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <label className="block text-xs font-medium text-foreground">
              Operating Agreement section
              <input value={section} onChange={(e) => setSection(e.target.value)} className={FIELD} />
            </label>
            {(p?.holders ?? []).length === 0 ? <p className="text-xs text-muted-foreground">Preview once to list the holders on the record date, then enter each one's percentage.</p> : null}
            {(p?.holders ?? []).map((h) => (
              <label key={h.holderKey} className="grid items-center gap-2 text-xs font-medium text-foreground sm:grid-cols-[1fr_8rem]">
                <span>
                  {h.label} <span className="text-muted-foreground">({h.shares} shares)</span>
                </span>
                <input aria-label={`Percent for ${h.label}`} inputMode="decimal" className={FIELD} value={pct[h.holderKey] ?? ""} onChange={(e) => setPct({ ...pct, [h.holderKey]: e.target.value })} />
              </label>
            ))}
          </div>
        ) : null}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={previewM.isPending || !propertyId || !total || !recordDate} className={PRIMARY}>
          {previewM.isPending ? "Working it out…" : "Preview each owner's amount"}
        </button>
        <span className="text-xs text-muted-foreground">
          {DISTRIBUTION_RULES_TEXT}
          <span className="ml-1 inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-border text-[10px] font-semibold" title={ROUNDING_RULE_TEXT} aria-label={ROUNDING_RULE_TEXT} tabIndex={0}>
            i
          </span>
        </span>
      </div>
      {p ? (
        <div className="space-y-3 rounded-lg border border-border p-3 text-sm">
          <p className="text-muted-foreground">
            Cash {money(p.cash.cashCents)} − minimum reserve {money(p.cash.reserveCents)} − already owed {money(p.cash.committedCents)} = distributable{" "}
            <strong className="text-foreground">{money(Math.max(p.cash.distributableCents, 0))}</strong>
          </p>
          {p.exceeds ? <p className="font-medium text-destructive">This is more than the distributable cash. It can't be created.</p> : null}
          {p.problem ? <p className="font-medium text-destructive">{p.problem}</p> : null}
          {p.lines.length > 0 ? (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {p.lines.map((l) => (
                <li key={l.holderKey} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span>
                    {l.label} <span className="text-muted-foreground">({l.shares} {l.shares === 1 ? "share" : "shares"})</span>
                  </span>
                  <span className="flex gap-3">
                    <span className="font-medium">{money(l.amountCents)}</span>
                    <span className={l.payoutLast4 ? "text-muted-foreground" : "text-amber-600"}>{l.payoutLast4 ? maskedAccount(l.payoutLast4) : "No payout method: will be held"}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {p.lines.length > 0 && !p.exceeds && !p.problem ? (
            <button type="button" className={PRIMARY} disabled={createM.isPending} onClick={() => createM.mutate()}>
              {createM.isPending ? "Creating…" : "Create the draft"}
            </button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function AdminDistributionsPage() {
  const load = useServerFn(getDistributionBoard);
  const qc = useQueryClient();
  const [propertyId, setPropertyId] = useState("");
  const { data, isLoading, error } = useQuery({ queryKey: [...KEY, propertyId], queryFn: () => load({ data: { propertyId: propertyId || null } }), retry: false });
  const done = () => void qc.invalidateQueries({ queryKey: KEY });
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Distributions</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        A real distribution has four steps: initiate it (refused above the distributable cash), preview each owner's amount, authorize it with your signature, then execute it. Each payment that goes out posts to the books and moves that owner's capital account, once. Payments run through a simulated ACH rail: no real money moves. A mistake is voided with a reason and a corrected one is made; every version is kept.
      </p>
      <div className="mt-6 space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : !data ? null : (
          <>
            <InitiateForm properties={data.properties} propertyId={propertyId} setPropertyId={setPropertyId} done={done} />
            {propertyId && data.cash ? (
              <section className="rounded-xl border border-border bg-card p-5 text-sm shadow-sm">
                <h2 className="font-semibold text-foreground">Distributable cash</h2>
                <dl className="mt-2 grid gap-1 sm:grid-cols-4">
                  {[
                    ["Cash in the books", data.cash.cashCents],
                    ["Minimum reserve", data.cash.reserveCents],
                    ["Owed to authorized distributions", data.cash.committedCents],
                    ["Distributable", Math.max(data.cash.distributableCents, 0)],
                  ].map(([label, cents]) => (
                    <div key={String(label)}>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="font-medium text-foreground">{money(Number(cents))}</dd>
                    </div>
                  ))}
                </dl>
                <ReserveEditor key={`${propertyId}-${data.cash.reserveCents}`} propertyId={propertyId} reserveCents={data.cash.reserveCents} done={done} />
              </section>
            ) : null}
            {data.events.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">No distributions yet.</p>
            ) : (
              data.events.map((r) => (r.workflow === "payout" ? <PayoutCard key={r.id} event={r} /> : <NoticeCard key={r.id} event={r} />))
            )}
          </>
        )}
      </div>
    </div>
  );
}
