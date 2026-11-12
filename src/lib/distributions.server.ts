/**
 * Distributions (server side): the Manager initiates, previews, authorizes with a typed signature and executes; owners see their
 * own history and set their own payout method. The database (distributions.sql) enforces every rule; this orchestrates the
 * simulated ACH rail around it. Retention Lock and overdue expenses are never consulted here: neither blocks a distribution.
 */
import { adminRecipients, deliver } from "@/lib/authorization.notify.server";
import { getDisbursementAdapter } from "@/lib/disbursement-adapters";
import type { DisbursementAdapter } from "@/lib/disbursement";
import {
  bankDetailsProblem,
  DEFAULT_MINIMUM_RESERVE_CENTS,
  distributionNoticeText,
  heldNoticeText,
  paidNoticeText,
  splitDistribution,
  type DistributionStatus,
  type PaymentStatus,
  type SplitMethod,
} from "@/lib/distributions";
import { assertTypedSignature } from "@/lib/signature-check";
import { fromCents, isValidMoney, percentsProblem, toCents } from "@/lib/expenses";
import { holderLabeller, holderRecipient } from "@/lib/expenses.server";
import { holdersAsOf } from "@/lib/record-date-holders.server";
import { holderFor } from "@/lib/votes.server";

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}
const MISSING = "Database is missing distributions: run distributions.sql in Supabase.";
const meta = (r?: RequestContext) => ({ ip_address: r?.ip ?? null, user_agent: r?.userAgent ?? null });

async function requireManager(db: Db, userId: string) {
  const { data } = await db.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (data !== true) throw new Error("Only the Manager can do that.");
}

async function call<T = Record<string, any>>(db: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const m = String(error.message ?? "");
    if (/does not exist|schema cache|Could not find/i.test(m) && /distribution|payout|payment/i.test(m)) throw new Error(MISSING);
    throw new Error(m || "The books refused that.");
  }
  return data as T;
}

const link = (propertyId: string) => `/owner/properties/${propertyId}/distributions`;

/** Tell the Manager something needs them (a failed payment). */
async function alertManagers(db: Db, subject: string, message: string, dedupeKey: string) {
  for (const admin of await adminRecipients(db as never)) {
    await deliver(db as never, admin, { subject, message, link: "/admin/distributions", type: "distribution_event", dedupeKey: `${dedupeKey}:${admin.authUserId}` });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Preview and create
// ---------------------------------------------------------------------------------------------------------
export interface CashPosition {
  cashCents: number;
  reserveCents: number;
  committedCents: number;
  distributableCents: number;
}
const toCash = (r: Record<string, any>): CashPosition => ({ cashCents: Number(r.cash_cents), reserveCents: Number(r.reserve_cents), committedCents: Number(r.committed_cents), distributableCents: Number(r.distributable_cents) });

export async function cashPosition(db: Db, propertyId: string): Promise<CashPosition> {
  return toCash(await call(db, "distributable_cash", { _property: propertyId, _exclude: null }));
}

export interface DistributionParams {
  userId: string;
  propertyId: string;
  totalAmount: number;
  recordDate: string;
  reason: string;
  method: SplitMethod;
  /** An Operating Agreement override: percentages by holder key and the section. */
  percents?: Record<string, number>;
  oaSection?: string | null;
}

async function buildLines(db: Db, p: DistributionParams) {
  if (!isValidMoney(p.totalAmount)) throw new Error("The total must be above zero, with at most two decimal places.");
  if (p.method === "oa_override") {
    if (!(p.oaSection ?? "").trim()) throw new Error("Name the Operating Agreement section the override comes from.");
    const problem = percentsProblem(p.percents ?? {});
    if (problem) throw new Error(problem);
  }
  // The holders ON THE RECORD DATE, rebuilt from cap_table_history, not today's cap table.
  const holders = (await holdersAsOf(db, p.propertyId, p.recordDate)).map((h) => ({ holderKey: h.holderKey, shares: h.shares, rank: h.rank }));
  if (holders.length === 0) throw new Error("Nobody held shares in this property on that record date.");
  return splitDistribution({ totalCents: toCents(p.totalAmount), holders, method: p.method, percents: p.percents });
}

/** The preview the Manager signs off on: each member's amount, whether they would be paid or held, and the cash it draws on. Writes nothing. */
export async function previewDistribution(db: Db, p: DistributionParams) {
  await requireManager(db, p.userId);
  const cash = await cashPosition(db, p.propertyId);
  const totalCents = toCents(p.totalAmount);
  let lines: Awaited<ReturnType<typeof buildLines>> = [];
  let problem: string | null = null;
  try {
    lines = await buildLines(db, p);
  } catch (e) {
    problem = (e as Error).message;
  }
  const exceeds = Number.isFinite(totalCents) && totalCents > Math.max(cash.distributableCents, 0);
  const labelOf = await holderLabeller(db);
  // Who held the shares on the record date: what an Operating Agreement override has to name.
  const holders = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.recordDate)) {
    for (const h of await holdersAsOf(db, p.propertyId, p.recordDate)) holders.push({ holderKey: h.holderKey, label: await labelOf(h.holderKey), shares: h.shares });
  }
  const out = [];
  for (const l of lines) {
    const { data: method } = await db.from("member_payout_methods").select("last4").eq("holder_key", l.holder_key).eq("status", "active").maybeSingle();
    out.push({ holderKey: l.holder_key, label: await labelOf(l.holder_key), shares: l.share_count, amountCents: toCents(l.amount), payoutLast4: (method?.last4 as string | undefined) ?? null });
  }
  return { cash, totalCents, exceeds, problem, holders, lines: out, willBeHeld: out.filter((l) => !l.payoutLast4).length };
}

/** Initiate: a draft, after the database has checked the cash and every line. */
export async function createDistribution(db: Db, p: DistributionParams & { request?: RequestContext; replacesId?: string | null }): Promise<{ id: string }> {
  await requireManager(db, p.userId);
  const lines = await buildLines(db, p);
  const id = await call<string>(db, "create_distribution", {
    _property: p.propertyId,
    _total_cents: toCents(p.totalAmount),
    _record_date: p.recordDate,
    _reason: p.reason,
    _split_method: p.method,
    _override: p.method === "oa_override" ? { percents: p.percents, oa_section: (p.oaSection ?? "").trim() } : null,
    _lines: lines,
    _actor: p.userId,
    _meta: meta(p.request),
    _replaces: p.replacesId ?? null,
  });
  return { id };
}

// ---------------------------------------------------------------------------------------------------------
// Authorize, execute
// ---------------------------------------------------------------------------------------------------------
interface EventRow {
  id: string;
  property_id: string;
  status: DistributionStatus;
  total_cents: number | null;
  total_amount: number;
  record_date: string;
  reason: string | null;
}
interface PaymentRow {
  id: string;
  distribution_id: string;
  property_id: string;
  holder_key: string;
  shares: number;
  amount_cents: number;
  status: PaymentStatus;
  bank_last4: string | null;
  payout_method_id: string | null;
  failure_reason: string | null;
}

async function eventRow(db: Db, id: string): Promise<EventRow> {
  const { data } = await db.from("distribution_events").select("*").eq("id", id).maybeSingle();
  if (!data) throw new Error("Distribution not found.");
  return data as EventRow;
}
const totalOf = (e: EventRow) => Number(e.total_cents ?? Math.round(Number(e.total_amount) * 100));

/**
 * Authorize with the Manager's typed signature (their own full legal name, checked here on the server). The Month 5 notice each
 * owner gets is made from this record, not typed by hand.
 */
export async function authorizeDistribution(db: Db, p: { userId: string; distributionId: string; signedName: string; managerName: string | null; request?: RequestContext }) {
  await requireManager(db, p.userId);
  assertTypedSignature({ typed: p.signedName, fullName: p.managerName });
  const r = await call<{ status: string; current?: string }>(db, "authorize_distribution", { _id: p.distributionId, _signed_name: p.signedName.trim(), _actor: p.userId, _meta: meta(p.request) });
  if (r.status !== "authorized") throw new Error(`This distribution is ${r.current ?? "not a draft"} and can't be authorized.`);
  const e = await eventRow(db, p.distributionId);
  const { data: payments } = await db.from("distribution_payments").select("*").eq("distribution_id", e.id);
  for (const pay of (payments ?? []) as PaymentRow[]) {
    const recipient = await holderRecipient(db, pay.holder_key);
    if (!recipient) continue;
    await deliver(db as never, recipient, {
      subject: "A distribution was authorized",
      message: distributionNoticeText({ totalCents: totalOf(e), recordDate: e.record_date, reason: e.reason, status: e.status }, { amountCents: Number(pay.amount_cents), shares: pay.shares }),
      link: link(e.property_id),
      type: "distribution_event",
      propertyId: e.property_id,
      dedupeKey: `distribution:${e.id}`,
    });
  }
  return { status: "authorized" as const };
}

export interface RunSummary {
  status: DistributionStatus;
  sent: number;
  failed: number;
  processing: number;
  held: number;
}

async function tellHeld(db: Db, e: EventRow, held: Array<{ payment_id: string; holder_key: string; amount_cents: number }>) {
  for (const h of held) {
    const recipient = await holderRecipient(db, h.holder_key);
    if (recipient) {
      await deliver(db as never, recipient, {
        subject: "Your distribution is held",
        message: heldNoticeText(Number(h.amount_cents), e.record_date),
        link: link(e.property_id),
        type: "distribution_event",
        propertyId: e.property_id,
        dedupeKey: `distribution_held:${h.payment_id}`,
      });
    }
    await db.from("distribution_payments").update({ held_notified_at: new Date().toISOString() }).eq("id", h.payment_id);
  }
}

async function afterResult(db: Db, e: EventRow, pay: { payment_id: string; holder_key: string; amount_cents: number; last4: string | null }, state: "sent" | "failed" | "processing", reason: string | null) {
  if (state === "sent") {
    const recipient = await holderRecipient(db, pay.holder_key);
    if (recipient) {
      await deliver(db as never, recipient, {
        subject: "Your distribution was sent",
        message: paidNoticeText(Number(pay.amount_cents), pay.last4),
        link: link(e.property_id),
        type: "distribution_event",
        propertyId: e.property_id,
        dedupeKey: `distribution_paid:${pay.payment_id}`,
      });
    }
  } else if (state === "failed") {
    const label = await (await holderLabeller(db))(pay.holder_key);
    await alertManagers(db, "A distribution payment failed", `The ${fromCents(Number(pay.amount_cents)).toFixed(2)} USD payment to ${label} failed${reason ? `: ${reason}` : ""}. Nothing was posted for it. You can retry it from Distributions.`, `distribution_failed:${pay.payment_id}`);
  }
}

/** Pay what can be paid now, record every result, and move the distribution on. Safe to call again: nothing is sent or posted twice. */
export async function executeDistribution(db: Db, p: { userId: string | null; distributionId: string; holderKey?: string | null; adapter?: DisbursementAdapter; request?: RequestContext }): Promise<RunSummary> {
  if (p.userId) await requireManager(db, p.userId);
  const adapter = p.adapter ?? getDisbursementAdapter();
  const e = await eventRow(db, p.distributionId);
  const claim = await call<{ send: Array<{ payment_id: string; holder_key: string; amount_cents: number; token: string; last4: string }>; held: Array<{ payment_id: string; holder_key: string; amount_cents: number }> }>(db, "claim_distribution_payments", {
    _id: p.distributionId,
    _actor: p.userId,
    _meta: meta(p.request),
    _holder_key: p.holderKey ?? null,
  });
  await tellHeld(db, e, claim.held);
  let errored: string | null = null;
  for (const pay of claim.send) {
    let result: Awaited<ReturnType<DisbursementAdapter["sendAch"]>>;
    try {
      result = await adapter.sendAch(pay.token, Number(pay.amount_cents), pay.payment_id);
    } catch (err) {
      // The outcome is unknown (the call may have gone through). It stays with the bank: checking later asks the rail by the same key, so it is neither sent twice nor lost.
      errored = (err as Error).message;
      continue;
    }
    await call(db, "record_payment_result", { _payment: pay.payment_id, _state: result.state, _ref: result.ref, _reason: result.reason ?? null, _actor: p.userId, _meta: meta(p.request) });
    await afterResult(db, e, pay, result.state, result.reason ?? null);
  }
  const summary = await finish(db, p.distributionId, p.userId, p.request);
  if (errored) throw new Error(`The payment rail didn't answer (${errored}). The payment is held with the bank: use "Check payments with the bank" to settle it.`);
  return summary;
}

async function finish(db: Db, distributionId: string, userId: string | null, request?: RequestContext): Promise<RunSummary> {
  const r = await call<Record<string, any>>(db, "finalize_distribution", { _id: distributionId, _actor: userId, _meta: meta(request) });
  const { data: held } = await db.from("distribution_payments").select("id").eq("distribution_id", distributionId).eq("status", "held");
  return { status: r.status as DistributionStatus, sent: Number(r.sent), failed: Number(r.failed), processing: Number(r.processing), held: (held ?? []).length };
}

/** Ask the rail where the payments still with the bank now stand, and record the answers. */
export async function settleDistribution(db: Db, p: { userId: string | null; distributionId: string; adapter?: DisbursementAdapter; request?: RequestContext }): Promise<RunSummary> {
  if (p.userId) await requireManager(db, p.userId);
  const adapter = p.adapter ?? getDisbursementAdapter();
  const e = await eventRow(db, p.distributionId);
  const { data: rows } = await db.from("distribution_payments").select("*").eq("distribution_id", p.distributionId).eq("status", "processing");
  for (const pay of (rows ?? []) as PaymentRow[]) {
    const { data: m } = pay.payout_method_id ? await db.from("member_payout_methods").select("token").eq("id", pay.payout_method_id).maybeSingle() : { data: null };
    if (!m?.token) continue;
    const result = await adapter.checkAch(m.token as string, pay.id);
    if (result.state === "processing") continue;
    await call(db, "record_payment_result", { _payment: pay.id, _state: result.state, _ref: result.ref, _reason: result.reason ?? null, _actor: p.userId, _meta: meta(p.request) });
    await afterResult(db, e, { payment_id: pay.id, holder_key: pay.holder_key, amount_cents: pay.amount_cents, last4: pay.bank_last4 }, result.state, result.reason ?? null);
  }
  return finish(db, p.distributionId, p.userId, p.request);
}

/** Put a failed payment back, then send it. */
export async function retryPayment(db: Db, p: { userId: string; paymentId: string; adapter?: DisbursementAdapter; request?: RequestContext }): Promise<RunSummary> {
  await requireManager(db, p.userId);
  const { data: pay } = await db.from("distribution_payments").select("distribution_id").eq("id", p.paymentId).maybeSingle();
  if (!pay) throw new Error("Payment not found.");
  const r = await call<{ status: string }>(db, "retry_failed_payment", { _payment: p.paymentId, _actor: p.userId, _meta: meta(p.request) });
  if (r.status !== "pending") throw new Error("Only a failed payment can be retried.");
  return executeDistribution(db, { userId: p.userId, distributionId: pay.distribution_id as string, adapter: p.adapter, request: p.request });
}

// ---------------------------------------------------------------------------------------------------------
// Void and re-post: every version kept
// ---------------------------------------------------------------------------------------------------------
export async function voidPayoutDistribution(db: Db, p: { userId: string; distributionId: string; reason: string; request?: RequestContext }) {
  await requireManager(db, p.userId);
  const e = await eventRow(db, p.distributionId);
  const r = await call<{ status: string; entries_reversed?: number }>(db, "void_distribution", { _id: p.distributionId, _reason: p.reason, _actor: p.userId, _meta: meta(p.request) });
  if (r.status === "voided") {
    const { data: payments } = await db.from("distribution_payments").select("holder_key").eq("distribution_id", e.id);
    for (const pay of (payments ?? []) as Array<{ holder_key: string }>) {
      const recipient = await holderRecipient(db, pay.holder_key);
      if (recipient) {
        await deliver(db as never, recipient, {
          subject: "A distribution was voided",
          message: `The distribution of ${fromCents(totalOf(e)).toFixed(2)} USD for record date ${e.record_date} was voided. Reason: ${p.reason.trim()}. Any amount that was recorded for you has been reversed in the books, and a corrected distribution may follow.`,
          link: link(e.property_id),
          type: "distribution_event",
          propertyId: e.property_id,
          dedupeKey: `distribution_voided:${e.id}`,
        });
      }
    }
  }
  return r;
}

/** Void it, then make the corrected one (linked to it). The corrected one is a fresh draft: it needs its own authorization. */
export async function repostPayoutDistribution(db: Db, p: DistributionParams & { distributionId: string; voidReason: string; request?: RequestContext }): Promise<{ id: string }> {
  await requireManager(db, p.userId);
  const old = await eventRow(db, p.distributionId);
  if (old.property_id !== p.propertyId) throw new Error("The corrected distribution must be for the same property.");
  await buildLines(db, p); // the corrected split can be made before anything is voided
  await voidPayoutDistribution(db, { userId: p.userId, distributionId: p.distributionId, reason: p.voidReason, request: p.request });
  return createDistribution(db, { ...p, replacesId: p.distributionId });
}

// ---------------------------------------------------------------------------------------------------------
// The Manager's board
// ---------------------------------------------------------------------------------------------------------
export async function setMinimumReserve(db: Db, p: { userId: string; propertyId: string; reserveAmount: number; request?: RequestContext }) {
  await requireManager(db, p.userId);
  if (!Number.isFinite(p.reserveAmount) || p.reserveAmount < 0 || Math.abs(p.reserveAmount * 100 - Math.round(p.reserveAmount * 100)) > 1e-6) throw new Error("The minimum reserve is zero or more, with at most two decimal places.");
  await call(db, "set_minimum_reserve", { _property: p.propertyId, _cents: toCents(p.reserveAmount), _actor: p.userId, _meta: meta(p.request) });
}

export async function distributionBoard(db: Db, userId: string, propertyId: string | null) {
  await requireManager(db, userId);
  const { data: cap } = await db.from("cap_table_entries").select("property_id");
  const ids = [...new Set(((cap ?? []) as Array<{ property_id: string }>).map((c) => c.property_id))];
  const { data: props } = ids.length ? await db.from("properties").select("id, address, city, state").in("id", ids) : { data: [] };
  const properties = ((props ?? []) as Array<{ id: string; address: string | null; city: string | null; state: string | null }>)
    .map((p) => ({ id: p.id, label: [p.address, p.city, p.state].filter(Boolean).join(", ") || "Property" }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const labels = new Map(properties.map((p) => [p.id, p.label]));
  let query = db.from("distribution_events").select("*").order("created_at", { ascending: false });
  if (propertyId) query = query.eq("property_id", propertyId);
  const { data: rows, error } = await query;
  if (error) throw new Error(MISSING);
  const labelOf = await holderLabeller(db);
  const events = [];
  for (const r of (rows ?? []) as Array<Record<string, any>>) {
    const { data: pays } = r.workflow === "payout" ? await db.from("distribution_payments").select("*").eq("distribution_id", r.id) : { data: [] };
    const payments = [];
    for (const p of ((pays ?? []) as PaymentRow[]).sort((a, b) => a.holder_key.localeCompare(b.holder_key))) {
      payments.push({ id: p.id, holderKey: p.holder_key, label: await labelOf(p.holder_key), shares: p.shares, amountCents: Number(p.amount_cents), status: p.status, last4: p.bank_last4, failureReason: p.failure_reason });
    }
    events.push({
      id: r.id as string,
      propertyId: r.property_id as string,
      propertyLabel: labels.get(r.property_id) ?? "Property",
      workflow: (r.workflow ?? "notice") as "notice" | "payout",
      status: (r.status ?? "posted") as DistributionStatus,
      totalCents: r.total_cents != null ? Number(r.total_cents) : Math.round(Number(r.total_amount) * 100),
      recordDate: r.record_date as string,
      reason: (r.reason ?? r.note ?? null) as string | null,
      splitMethod: (r.split_method ?? null) as SplitMethod | null,
      oaSection: (r.override_oa_section ?? null) as string | null,
      createdAt: r.created_at as string,
      authorizedAt: (r.authorized_at ?? null) as string | null,
      executedAt: (r.executed_at ?? null) as string | null,
      voidReason: (r.void_reason ?? null) as string | null,
      replacesId: (r.replaces_id ?? null) as string | null,
      replacedById: (r.replaced_by_id ?? null) as string | null,
      payments,
    });
  }
  let cash: CashPosition | null = null;
  if (propertyId) cash = await cashPosition(db, propertyId).catch(() => null);
  return { properties, events, cash, defaultReserveCents: DEFAULT_MINIMUM_RESERVE_CENTS };
}

// ---------------------------------------------------------------------------------------------------------
// The owner's side
// ---------------------------------------------------------------------------------------------------------
/** An owner's own distributions on a property, and whether they have a payout method. Never another member's amount. */
export async function ownerDistributions(db: Db, p: { userId: string; propertyId: string }) {
  const holder = await holderFor(db as never, p.userId, p.propertyId);
  if (!holder) return { allowed: false as const };
  const { data: method } = await db.from("member_payout_methods").select("last4, bank_name, created_at").eq("holder_key", holder.holderKey).eq("status", "active").maybeSingle();
  const { data: pays } = await db.from("distribution_payments").select("*").eq("property_id", p.propertyId).eq("holder_key", holder.holderKey);
  const out = [];
  for (const pay of (pays ?? []) as Array<PaymentRow & { sent_at: string | null; reversed_at: string | null }>) {
    const { data: d } = await db.from("distribution_events").select("record_date, reason, status, created_at, authorized_at, void_reason").eq("id", pay.distribution_id).maybeSingle();
    if (!d) continue;
    out.push({
      distributionId: pay.distribution_id,
      recordDate: d.record_date as string,
      reason: (d.reason ?? null) as string | null,
      distributionStatus: d.status as DistributionStatus,
      authorizedAt: (d.authorized_at ?? d.created_at) as string,
      amountCents: Number(pay.amount_cents),
      shares: pay.shares,
      status: pay.status,
      last4: pay.bank_last4,
      sentAt: pay.sent_at,
      reversed: !!pay.reversed_at,
      voidReason: (d.void_reason ?? null) as string | null,
    });
  }
  out.sort((a, b) => (a.authorizedAt < b.authorizedAt ? 1 : -1));
  return { allowed: true as const, holderKey: holder.holderKey, payoutMethod: method ? { last4: method.last4 as string, bankName: (method.bank_name ?? null) as string | null } : null, distributions: out };
}

/**
 * The member adds a payout method. The bank details are checked, tokenized by the adapter and dropped: only the token and the last four
 * are stored. Any payment that was held for them is then released.
 */
export async function savePayoutMethod(
  db: Db,
  p: { userId: string; propertyId: string; routing: string; account: string; bankName?: string | null; adapter?: DisbursementAdapter; request?: RequestContext },
): Promise<{ released: number }> {
  const holder = await holderFor(db as never, p.userId, p.propertyId);
  if (!holder) throw new Error("You don't have ownership in that property.");
  const routing = p.routing.replace(/\s/g, "");
  const account = p.account.replace(/\s/g, "");
  const problem = bankDetailsProblem(routing, account);
  if (problem) throw new Error(problem);
  const adapter = p.adapter ?? getDisbursementAdapter();
  const { token, last4 } = await adapter.tokenizeBank({ routing, account });
  await call(db, "save_payout_method", { _holder_key: holder.holderKey, _token: token, _last4: last4, _bank_name: p.bankName ?? null, _actor: p.userId, _meta: meta(p.request) });
  return { released: await releaseHeldPayments(db, { holderKey: holder.holderKey, adapter }) };
}

export async function removePayoutMethod(db: Db, p: { userId: string; propertyId: string; request?: RequestContext }) {
  const holder = await holderFor(db as never, p.userId, p.propertyId);
  if (!holder) throw new Error("You don't have ownership in that property.");
  await call(db, "remove_payout_method", { _holder_key: holder.holderKey, _actor: p.userId, _meta: meta(p.request) });
}

/** The Manager already authorized these: they go out as soon as the member has somewhere to be paid. Nothing else about the distribution changes. */
export async function releaseHeldPayments(db: Db, p: { holderKey: string; adapter?: DisbursementAdapter }): Promise<number> {
  const { data: held } = await db.from("distribution_payments").select("distribution_id").eq("holder_key", p.holderKey).eq("status", "held");
  const ids = [...new Set(((held ?? []) as Array<{ distribution_id: string }>).map((h) => h.distribution_id))];
  let released = 0;
  for (const id of ids) {
    try {
      const before = await db.from("distribution_payments").select("id").eq("distribution_id", id).eq("holder_key", p.holderKey).eq("status", "held");
      const summary = await executeDistribution(db, { userId: null, distributionId: id, holderKey: p.holderKey, adapter: p.adapter });
      if (summary) released += (before.data ?? []).length;
    } catch {
      // The Manager sees a payment that could not go out on the board, and can send it from there.
    }
  }
  return released;
}
