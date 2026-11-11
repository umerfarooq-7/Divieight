/**
 * Expense Management (server side). The admin (divieight as Manager) posts expenses
 * and issues capital calls; each holder sees only their own allocation and payment
 * status. Being overdue is a notice and nothing else: no owner right depends on
 * anything here (Rev 48 floor). Every step goes to the audit log, and no money moves.
 */

import { adminRecipients, deliver } from "@/lib/authorization.notify.server";
import {
  canMarkPaid,
  CAPITAL_CALL_VOTE_THRESHOLD_IS_PLACEHOLDER,
  CAPITAL_CALL_VOTE_TYPE,
  capitalCallNeedsVote,
  expenseMoney,
  isPastDue,
  splitProRata,
  todayIso,
  type CapitalCallAllocationStatus,
  type CapitalCallStatus,
  type ExpenseAllocationStatus,
  type ExpenseStatus,
  type PaymentKind,
  type SplitLine,
} from "@/lib/expenses";
import { rankedHolders } from "@/lib/use-calendar.server";
import { DEFAULT_VOTE_OPTIONS } from "@/lib/votes";
import { readVoteThresholds } from "@/lib/governance-config";
import { loadGovernanceConfig } from "@/lib/governance-config.server";
import { closeVote, createVote, holderFor, holderRecipients, openVote, type VoteRow } from "@/lib/votes.server";

type Db = { from: (t: string) => any };

const MISSING_SCHEMA = "Database is missing expenses — run expenses.sql in Supabase.";

interface ExpenseRow {
  id: string;
  property_id: string;
  description: string;
  category: string;
  total_amount: number;
  incurred_on: string;
  source: "manual" | "maintenance";
  maintenance_request_id: string | null;
  status: ExpenseStatus;
  void_reason: string | null;
  created_at: string;
}

interface CapitalCallRow {
  id: string;
  property_id: string;
  title: string;
  reason: string;
  total_amount: number;
  due_date: string;
  status: CapitalCallStatus;
  vote_id: string | null;
  created_at: string;
}

interface AllocationRow {
  id: string;
  holder_key: string;
  share_count: number;
  amount: number;
  status: string;
  paid_marked_at: string | null;
  confirmed_at: string | null;
}
type ExpenseAllocationRow = AllocationRow & { expense_id: string; status: ExpenseAllocationStatus };
type CapitalCallAllocationRow = AllocationRow & { capital_call_id: string; status: CapitalCallAllocationStatus };

const ALLOCATIONS = { expense: "expense_allocations", capital_call: "capital_call_allocations" } as const;
const PARENT_COLUMN = { expense: "expense_id", capital_call: "capital_call_id" } as const;
const PARENTS = { expense: "expenses", capital_call: "capital_calls" } as const;
const OWNER_PAGE = { expense: "expenses", capital_call: "capital-calls" } as const;

async function audit(db: Db, actor: { id: string | null; type: string }, action: string, entity: { type: PaymentKind; id: string; propertyId: string }, extra: Record<string, unknown> = {}) {
  await db.from("audit_log").insert({
    actor_id: actor.id,
    actor_type: actor.type,
    action_type: action,
    entity_type: entity.type,
    entity_id: entity.id,
    metadata: { property_id: entity.propertyId, at: new Date().toISOString(), ...extra },
  });
}

/** The holder key's own login. Only ever used to tell that holder about their own allocation. */
export async function holderRecipient(db: Db, holderKey: string): Promise<{ authUserId: string; email: string | null } | null> {
  if (holderKey.startsWith("seller:")) return { authUserId: holderKey.slice("seller:".length), email: null };
  const { data } = await db.from("buyer_accounts").select("auth_user_id, email").eq("id", holderKey).maybeSingle();
  return data?.auth_user_id ? { authUserId: data.auth_user_id as string, email: (data.email as string | null) ?? null } : null;
}

async function rpc(db: Db, fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await (db as any).rpc(fn, args);
  if (error) throw new Error(/does not exist|schema cache/i.test(error.message) ? MISSING_SCHEMA : error.message);
  return (data ?? {}) as Record<string, unknown>;
}

/** Pro-rata on the cap table as it stands right now. */
async function currentSplit(db: Db, propertyId: string, totalAmount: number): Promise<SplitLine[]> {
  const holders = await rankedHolders(db as never, propertyId);
  return splitProRata(Number(totalAmount), holders.map((h) => ({ holderKey: h.holderKey, shares: h.shares, rank: h.rank })));
}

// ---------------------------------------------------------------------------
// Overdue: a status and a notification. Nothing reads it to withhold anything.
// ---------------------------------------------------------------------------

export async function settleOverdue(db: Db, propertyId?: string): Promise<{ overdue: number }> {
  let query = db.from("capital_calls").select("*").eq("status", "issued").lt("due_date", todayIso());
  if (propertyId) query = query.eq("property_id", propertyId);
  const { data: calls, error } = await query;
  if (error) return { overdue: 0 }; // before expenses.sql is run

  let overdue = 0;
  for (const call of (calls ?? []) as CapitalCallRow[]) {
    const { data: due } = await db.from("capital_call_allocations").select("*").eq("capital_call_id", call.id).eq("status", "due");
    for (const allocation of (due ?? []) as CapitalCallAllocationRow[]) {
      const { data: moved } = await db
        .from("capital_call_allocations")
        .update({ status: "overdue" })
        .eq("id", allocation.id)
        .eq("status", "due")
        .select("id")
        .maybeSingle();
      if (!moved) continue; // another run got here first: it tells the owner, not this one
      overdue += 1;
      await audit(db, { id: null, type: "system" }, "capital_call.overdue", { type: "capital_call", id: call.id, propertyId: call.property_id }, { allocation_id: allocation.id, holder_key: allocation.holder_key });
      const recipient = await holderRecipient(db, allocation.holder_key);
      if (recipient) {
        await deliver(db as never, recipient, {
          subject: "A capital call is overdue",
          message: `Your ${expenseMoney(allocation.amount)} share of "${call.title}" is overdue. This is a notice only: your vote, calendar and other owner rights are not affected.`,
          link: `/owner/properties/${call.property_id}/capital-calls`,
          type: "capital_call_alert",
          propertyId: call.property_id,
          dedupeKey: `call_overdue:${call.id}`,
        });
      }
    }
  }
  return { overdue };
}

// ---------------------------------------------------------------------------
// Owner: the property's list, and only their own allocation
// ---------------------------------------------------------------------------

export interface MyAllocation {
  id: string;
  shareCount: number;
  amount: number;
  status: string;
  paidMarkedAt: string | null;
  canMarkPaid: boolean;
}

const mine = (kind: PaymentKind, a: AllocationRow | undefined): MyAllocation | null =>
  a
    ? {
        id: a.id,
        shareCount: a.share_count,
        amount: Number(a.amount),
        status: a.status,
        paidMarkedAt: a.paid_marked_at,
        canMarkPaid: canMarkPaid(kind, a.status, a.paid_marked_at),
      }
    : null;

/**
 * Whose allocations this user reads. A current owner sees the property's whole list.
 * Someone who has since sold everything sees only what they were allocated, so a
 * balance from their time as an owner doesn't vanish.
 */
async function viewerOf(db: Db, kind: PaymentKind, userId: string, propertyId: string, parentIds: string[]): Promise<{ holderKey: string; current: boolean } | null> {
  const holder = await holderFor(db, userId, propertyId);
  if (holder) return { holderKey: holder.holderKey, current: true };
  if (parentIds.length === 0) return null;
  const { data: buyer } = await db.from("buyer_accounts").select("id").eq("auth_user_id", userId).maybeSingle();
  const keys = [`seller:${userId}`, ...(buyer?.id ? [buyer.id as string] : [])];
  const { data } = await db.from(ALLOCATIONS[kind]).select("holder_key").in(PARENT_COLUMN[kind], parentIds).in("holder_key", keys).limit(1);
  const found = (data ?? [])[0] as { holder_key: string } | undefined;
  return found ? { holderKey: found.holder_key, current: false } : null;
}

async function myAllocations<T extends AllocationRow>(db: Db, kind: PaymentKind, parentIds: string[], holderKey: string): Promise<T[]> {
  if (parentIds.length === 0) return [];
  const { data } = await db.from(ALLOCATIONS[kind]).select("*").in(PARENT_COLUMN[kind], parentIds).eq("holder_key", holderKey);
  return (data ?? []) as T[];
}

export interface OwnerExpense {
  id: string;
  description: string;
  category: string;
  totalAmount: number;
  incurredOn: string;
  status: ExpenseStatus;
  voidReason: string | null;
  fromMaintenance: boolean;
  mine: MyAllocation | null;
}

export async function ownerExpenses(db: Db, userId: string, propertyId: string): Promise<{ allowed: boolean; rows: OwnerExpense[] }> {
  const { data, error } = await db.from("expenses").select("*").eq("property_id", propertyId).neq("status", "draft").order("incurred_on", { ascending: false });
  if (error) return { allowed: Boolean(await holderFor(db, userId, propertyId)), rows: [] }; // before expenses.sql is run
  const rows = (data ?? []) as ExpenseRow[];
  const viewer = await viewerOf(db, "expense", userId, propertyId, rows.map((r) => r.id));
  if (!viewer) return { allowed: false, rows: [] };
  const allocations = await myAllocations<ExpenseAllocationRow>(db, "expense", rows.map((r) => r.id), viewer.holderKey);
  const byExpense = new Map(allocations.map((a) => [a.expense_id, a]));
  return {
    allowed: true,
    rows: rows
      .filter((r) => viewer.current || byExpense.has(r.id))
      .map((r) => ({
        id: r.id,
        description: r.description,
        category: r.category,
        totalAmount: Number(r.total_amount),
        incurredOn: r.incurred_on,
        status: r.status,
        voidReason: r.void_reason,
        fromMaintenance: r.source === "maintenance",
        mine: mine("expense", byExpense.get(r.id)),
      })),
  };
}

export interface OwnerCapitalCall {
  id: string;
  title: string;
  reason: string;
  totalAmount: number;
  dueDate: string;
  status: CapitalCallStatus;
  mine: MyAllocation | null;
}

export async function ownerCapitalCalls(db: Db, userId: string, propertyId: string): Promise<{ allowed: boolean; rows: OwnerCapitalCall[] }> {
  await settleOverdue(db, propertyId);
  const { data, error } = await db.from("capital_calls").select("*").eq("property_id", propertyId).neq("status", "draft").order("created_at", { ascending: false });
  if (error) return { allowed: Boolean(await holderFor(db, userId, propertyId)), rows: [] }; // before expenses.sql is run
  const rows = (data ?? []) as CapitalCallRow[];
  const viewer = await viewerOf(db, "capital_call", userId, propertyId, rows.map((r) => r.id));
  if (!viewer) return { allowed: false, rows: [] };
  const allocations = await myAllocations<CapitalCallAllocationRow>(db, "capital_call", rows.map((r) => r.id), viewer.holderKey);
  const byCall = new Map(allocations.map((a) => [a.capital_call_id, a]));
  return {
    allowed: true,
    rows: rows
      .filter((r) => viewer.current || byCall.has(r.id))
      .map((r) => ({
        id: r.id,
        title: r.title,
        reason: r.reason,
        totalAmount: Number(r.total_amount),
        dueDate: r.due_date,
        status: r.status,
        mine: mine("capital_call", byCall.get(r.id)),
      })),
  };
}

/** The dashboard's notice. Only ever informs: nothing is hidden because of it. */
export async function ownerPaymentNotice(db: Db, userId: string, propertyId: string): Promise<{ overdueCount: number; overdueAmount: number }> {
  const { rows } = await ownerCapitalCalls(db, userId, propertyId);
  const overdue = rows.filter((r) => r.mine?.status === "overdue");
  return { overdueCount: overdue.length, overdueAmount: overdue.reduce((sum, r) => sum + (r.mine?.amount ?? 0), 0) };
}

async function loadAllocation(db: Db, kind: PaymentKind, allocationId: string): Promise<{ allocation: AllocationRow; parent: ExpenseRow | CapitalCallRow; parentId: string } | null> {
  const { data } = await db.from(ALLOCATIONS[kind]).select("*").eq("id", allocationId).maybeSingle();
  if (!data) return null;
  const parentId = (data as Record<string, string>)[PARENT_COLUMN[kind]]!;
  const { data: parent } = await db.from(PARENTS[kind]).select("*").eq("id", parentId).maybeSingle();
  return parent ? { allocation: data as AllocationRow, parent: parent as ExpenseRow | CapitalCallRow, parentId } : null;
}

const parentName = (kind: PaymentKind, parent: ExpenseRow | CapitalCallRow) =>
  kind === "expense" ? (parent as ExpenseRow).description : (parent as CapitalCallRow).title;

/** The owner's "I've paid this". Their own allocation only. */
export async function markPaid(db: Db, params: { userId: string; kind: PaymentKind; allocationId: string }): Promise<{ error?: string }> {
  const { kind, userId } = params;
  const found = await loadAllocation(db, kind, params.allocationId);
  const notYours = { error: "That payment isn't available." };
  if (!found) return notYours;
  const { allocation, parent, parentId } = found;
  const { data: buyer } = await db.from("buyer_accounts").select("id").eq("auth_user_id", userId).maybeSingle();
  if (allocation.holder_key !== `seller:${userId}` && allocation.holder_key !== buyer?.id) return notYours;
  if (!canMarkPaid(kind, allocation.status, allocation.paid_marked_at)) return { error: "This payment has already been marked or settled." };

  const now = new Date().toISOString();
  let update = db.from(ALLOCATIONS[kind]).update(kind === "expense" ? { paid_marked_at: now, paid_marked_by: userId } : { status: "marked_paid", paid_marked_at: now, paid_marked_by: userId }).eq("id", allocation.id);
  update = kind === "expense" ? update.eq("status", "due").is("paid_marked_at", null) : update.in("status", ["due", "overdue"]);
  const { data: moved } = await update.select("id").maybeSingle();
  if (!moved) return { error: "This payment has already been marked or settled." };

  const propertyId = parent.property_id;
  await audit(db, { id: userId, type: "owner" }, `${kind}.marked_paid`, { type: kind, id: parentId, propertyId }, { allocation_id: allocation.id, holder_key: allocation.holder_key, amount: allocation.amount });
  for (const admin of await adminRecipients(db as never)) {
    await deliver(db as never, admin, {
      subject: "An owner marked a payment as paid",
      message: `An owner marked ${expenseMoney(allocation.amount)} as paid on "${parentName(kind, parent)}". Confirm it once received.`,
      link: "/admin/expenses",
      type: kind,
    });
  }
  return {};
}

// ---------------------------------------------------------------------------
// Admin (divieight as Manager)
// ---------------------------------------------------------------------------

export interface AdminAllocation {
  id: string;
  holderKey: string;
  holderLabel: string;
  shareCount: number;
  amount: number;
  status: string;
  paidMarkedAt: string | null;
  confirmedAt: string | null;
}

export interface SplitPreview {
  lines: Array<{ holderLabel: string; shareCount: number; amount: number }>;
  problem: string | null;
}

export interface AdminExpense {
  id: string;
  propertyId: string;
  propertyLabel: string;
  description: string;
  category: string;
  totalAmount: number;
  incurredOn: string;
  status: ExpenseStatus;
  fromMaintenance: boolean;
  voidReason: string | null;
  allocations: AdminAllocation[];
  preview: SplitPreview | null;
}

export interface AdminCapitalCall {
  id: string;
  propertyId: string;
  propertyLabel: string;
  title: string;
  reason: string;
  totalAmount: number;
  dueDate: string;
  status: CapitalCallStatus;
  needsVote: boolean;
  vote: { id: string; title: string; status: string; closesAt: string; passed: boolean | null } | null;
  canStartVote: boolean;
  canIssue: boolean;
  allocations: AdminAllocation[];
  preview: SplitPreview | null;
}

function propertyLabel(p: { address?: string | null; city?: string | null; state?: string | null } | null | undefined) {
  return p ? [p.address, p.city, p.state].filter(Boolean).join(", ") : "Property";
}

async function holderLabeller(db: Db) {
  const cache = new Map<string, string>();
  return async (holderKey: string): Promise<string> => {
    if (cache.has(holderKey)) return cache.get(holderKey)!;
    let label: string;
    if (holderKey.startsWith("seller:")) {
      const { data } = await db.from("sellers").select("full_name").eq("id", holderKey.slice("seller:".length)).maybeSingle();
      label = `${(data?.full_name as string | null) || "Retained seller"} (retained)`;
    } else {
      const { data } = await db.from("buyer_accounts").select("email").eq("id", holderKey).maybeSingle();
      label = (data?.email as string | null) ?? "Co-owner";
    }
    cache.set(holderKey, label);
    return label;
  };
}

async function previewSplit(db: Db, propertyId: string, totalAmount: number, labelOf: (k: string) => Promise<string>): Promise<SplitPreview> {
  try {
    const lines = await currentSplit(db, propertyId, totalAmount);
    const out = [];
    for (const l of lines) out.push({ holderLabel: await labelOf(l.holder_key), shareCount: l.share_count, amount: l.amount });
    return { lines: out, problem: null };
  } catch (e) {
    return { lines: [], problem: (e as Error).message };
  }
}

async function adminAllocations(db: Db, kind: PaymentKind, parentId: string, labelOf: (k: string) => Promise<string>): Promise<AdminAllocation[]> {
  const { data } = await db.from(ALLOCATIONS[kind]).select("*").eq(PARENT_COLUMN[kind], parentId);
  const out: AdminAllocation[] = [];
  for (const a of (data ?? []) as AllocationRow[]) {
    out.push({
      id: a.id,
      holderKey: a.holder_key,
      holderLabel: await labelOf(a.holder_key),
      shareCount: a.share_count,
      amount: Number(a.amount),
      status: a.status,
      paidMarkedAt: a.paid_marked_at,
      confirmedAt: a.confirmed_at,
    });
  }
  return out.sort((x, y) => y.amount - x.amount || x.holderLabel.localeCompare(y.holderLabel));
}

/** A vote past its closing time closes the first time anyone looks. */
async function freshVote(db: Db, voteId: string | null): Promise<VoteRow | null> {
  if (!voteId) return null;
  const { data } = await db.from("votes").select("*").eq("id", voteId).maybeSingle();
  const vote = (data as VoteRow | null) ?? null;
  if (vote?.status === "open" && Date.now() >= new Date(vote.closes_at).getTime()) return closeVote(db, vote.id, { id: null, type: "system" });
  return vote;
}

/**
 * The dollar threshold that applies to a call: the one its vote started with when it has a vote, otherwise the live
 * config. So raising the threshold can't turn a call that is mid-vote into one that needs no vote.
 */
const thresholdFor = (vote: VoteRow | null, liveUsd: number) => (vote?.thresholds ? readVoteThresholds(vote.thresholds).capitalCallVoteThresholdUsd : liveUsd);

const votePassed = (vote: VoteRow | null) => vote?.status === "closed" && vote.result_summary?.passed === true;
/** Nothing linked yet, or the last try is over without passing. */
const voteCanRestart = (vote: VoteRow | null) => !vote || vote.status === "cancelled" || (vote.status === "closed" && vote.result_summary?.passed === false);

export async function adminExpenses(db: Db) {
  await settleOverdue(db);
  const live = (await loadGovernanceConfig(db)).capitalCallVoteThresholdUsd;
  const { data: expenseRows, error } = await db.from("expenses").select("*").order("created_at", { ascending: false });
  if (error) throw new Error(MISSING_SCHEMA);
  const { data: callRows } = await db.from("capital_calls").select("*").order("created_at", { ascending: false });

  const { data: capRows } = await db.from("cap_table_entries").select("property_id");
  const issuedByProperty = new Map<string, number>();
  for (const c of (capRows ?? []) as Array<{ property_id: string }>) issuedByProperty.set(c.property_id, (issuedByProperty.get(c.property_id) ?? 0) + 1);

  const ids = new Set<string>([
    ...issuedByProperty.keys(),
    ...((expenseRows ?? []) as ExpenseRow[]).map((r) => r.property_id),
    ...((callRows ?? []) as CapitalCallRow[]).map((r) => r.property_id),
  ]);
  const { data: propertyRows } = ids.size ? await db.from("properties").select("id, address, city, state").in("id", [...ids]) : { data: [] };
  const labels = new Map(((propertyRows ?? []) as Array<{ id: string; address: string | null; city: string | null; state: string | null }>).map((p) => [p.id, propertyLabel(p)]));
  const labelOf = await holderLabeller(db);

  const expenses: AdminExpense[] = [];
  for (const r of (expenseRows ?? []) as ExpenseRow[]) {
    expenses.push({
      id: r.id,
      propertyId: r.property_id,
      propertyLabel: labels.get(r.property_id) ?? "Property",
      description: r.description,
      category: r.category,
      totalAmount: Number(r.total_amount),
      incurredOn: r.incurred_on,
      status: r.status,
      fromMaintenance: r.source === "maintenance",
      voidReason: r.void_reason,
      allocations: await adminAllocations(db, "expense", r.id, labelOf),
      preview: r.status === "draft" ? await previewSplit(db, r.property_id, r.total_amount, labelOf) : null,
    });
  }

  const calls: AdminCapitalCall[] = [];
  for (const r of (callRows ?? []) as CapitalCallRow[]) {
    const vote = await freshVote(db, r.vote_id);
    const needsVote = capitalCallNeedsVote(Number(r.total_amount), thresholdFor(vote, live));
    calls.push({
      id: r.id,
      propertyId: r.property_id,
      propertyLabel: labels.get(r.property_id) ?? "Property",
      title: r.title,
      reason: r.reason,
      totalAmount: Number(r.total_amount),
      dueDate: r.due_date,
      status: r.status,
      needsVote,
      vote: vote ? { id: vote.id, title: vote.title, status: vote.status, closesAt: vote.closes_at, passed: vote.status === "closed" ? (vote.result_summary?.passed ?? null) : null } : null,
      canStartVote: r.status === "draft" && needsVote && voteCanRestart(vote),
      canIssue: r.status === "draft" && (!needsVote || votePassed(vote)),
      allocations: await adminAllocations(db, "capital_call", r.id, labelOf),
      preview: r.status === "draft" ? await previewSplit(db, r.property_id, r.total_amount, labelOf) : null,
    });
  }

  return {
    properties: [...issuedByProperty.entries()].map(([id, issuedShares]) => ({ id, issuedShares, label: labels.get(id) ?? "Property" })).sort((a, b) => a.label.localeCompare(b.label)),
    expenses,
    calls,
    voteThreshold: live,
    voteThresholdIsPlaceholder: CAPITAL_CALL_VOTE_THRESHOLD_IS_PLACEHOLDER,
  };
}

export async function createExpense(
  db: Db,
  params: { adminId: string; propertyId: string; description: string; category: string; totalAmount: number; incurredOn: string },
): Promise<{ id: string }> {
  const { data: property } = await db.from("properties").select("id").eq("id", params.propertyId).maybeSingle();
  if (!property) throw new Error("Property not found");
  const { data, error } = await db
    .from("expenses")
    .insert({
      property_id: params.propertyId,
      description: params.description,
      category: params.category,
      total_amount: params.totalAmount,
      incurred_on: params.incurredOn,
      source: "manual",
      created_by: params.adminId,
      status: "draft",
    })
    .select("*")
    .maybeSingle();
  if (error || !data) throw new Error(MISSING_SCHEMA);
  await audit(db, { id: params.adminId, type: "admin" }, "expense.created", { type: "expense", id: data.id as string, propertyId: params.propertyId }, { total_amount: params.totalAmount });
  return { id: data.id as string };
}

async function loadExpense(db: Db, expenseId: string): Promise<ExpenseRow> {
  const { data } = await db.from("expenses").select("*").eq("id", expenseId).maybeSingle();
  if (!data) throw new Error("Expense not found");
  return data as ExpenseRow;
}

/** Each holder is told their own amount only. */
async function tellHolders(db: Db, lines: SplitLine[], build: (line: SplitLine) => { subject: string; message: string; link: string; type: string; propertyId: string; dedupeKey: string }) {
  for (const line of lines) {
    const recipient = await holderRecipient(db, line.holder_key);
    if (recipient) await deliver(db as never, recipient, build(line));
  }
}

export async function postExpense(db: Db, params: { adminId: string; expenseId: string }) {
  const expense = await loadExpense(db, params.expenseId);
  if (expense.status !== "draft") throw new Error("Only a draft expense can be posted.");
  const lines = await currentSplit(db, expense.property_id, expense.total_amount);
  const result = await rpc(db, "post_expense", { _expense: expense.id, _allocations: lines, _actor: params.adminId });
  if (result["applied"] === false) return; // someone else just posted it, and told the owners
  await tellHolders(db, lines, (line) => ({
    subject: "A new expense was posted",
    message: `"${expense.description}" was posted to your home. Your share is ${expenseMoney(line.amount)} (${line.share_count} of the issued shares).`,
    link: `/owner/properties/${expense.property_id}/expenses`,
    type: "expense",
    propertyId: expense.property_id,
    dedupeKey: `expense_posted:${expense.id}`,
  }));
}

export async function voidExpense(db: Db, params: { adminId: string; expenseId: string; reason: string }) {
  const expense = await loadExpense(db, params.expenseId);
  if (expense.status === "voided") throw new Error("This expense is already voided.");
  const { data: allocations } = await db.from("expense_allocations").select("holder_key, share_count, amount").eq("expense_id", expense.id);
  const result = await rpc(db, "void_expense", { _expense: expense.id, _reason: params.reason, _actor: params.adminId });
  if (result["applied"] === false) return;
  await tellHolders(db, (allocations ?? []) as SplitLine[], () => ({
    subject: "An expense was voided",
    message: `"${expense.description}" was voided, so nothing is owed for it. Reason: ${params.reason}`,
    link: `/owner/properties/${expense.property_id}/expenses`,
    type: "expense",
    propertyId: expense.property_id,
    dedupeKey: `expense_voided:${expense.id}`,
  }));
}

export async function confirmPayment(db: Db, params: { adminId: string; kind: PaymentKind; allocationId: string }) {
  const { kind } = params;
  const found = await loadAllocation(db, kind, params.allocationId);
  if (!found) throw new Error("Payment not found");
  const result = await rpc(db, kind === "expense" ? "confirm_expense_payment" : "confirm_capital_call_payment", { _allocation: found.allocation.id, _actor: params.adminId });
  if (result["applied"] === false) return;
  const recipient = await holderRecipient(db, found.allocation.holder_key);
  if (recipient) {
    await deliver(db as never, recipient, {
      subject: "Your payment was confirmed",
      message: `Your ${expenseMoney(found.allocation.amount)} payment on "${parentName(kind, found.parent)}" was confirmed and added to your capital account.`,
      link: `/owner/properties/${found.parent.property_id}/${OWNER_PAGE[kind]}`,
      type: kind === "capital_call" ? "capital_call_alert" : kind,
      propertyId: found.parent.property_id,
    });
  }
}

/** The owner marked it, but the money hasn't arrived: back to owing, with a reason. */
export async function rejectPaymentMark(db: Db, params: { adminId: string; kind: PaymentKind; allocationId: string; note: string }) {
  const { kind } = params;
  const found = await loadAllocation(db, kind, params.allocationId);
  if (!found) throw new Error("Payment not found");
  const { allocation, parent, parentId } = found;
  const marked = kind === "expense" ? allocation.status === "due" && allocation.paid_marked_at : allocation.status === "marked_paid";
  if (!marked) throw new Error("This payment isn't waiting for confirmation.");

  const backTo = kind === "capital_call" ? (isPastDue((parent as CapitalCallRow).due_date) && (parent as CapitalCallRow).status === "issued" ? "overdue" : "due") : "due";
  let update = db.from(ALLOCATIONS[kind]).update({ status: backTo, paid_marked_at: null, paid_marked_by: null }).eq("id", allocation.id);
  update = kind === "expense" ? update.eq("status", "due").not("paid_marked_at", "is", null) : update.eq("status", "marked_paid");
  const { data: moved } = await update.select("id").maybeSingle();
  if (!moved) throw new Error("This payment just changed. Reload and try again.");

  await audit(db, { id: params.adminId, type: "admin" }, `${kind}.payment_mark_rejected`, { type: kind, id: parentId, propertyId: parent.property_id }, { allocation_id: allocation.id, holder_key: allocation.holder_key, note: params.note });
  const recipient = await holderRecipient(db, allocation.holder_key);
  if (recipient) {
    await deliver(db as never, recipient, {
      subject: "Your payment wasn't confirmed",
      message: `Your ${expenseMoney(allocation.amount)} payment on "${parentName(kind, parent)}" hasn't been received. Note: ${params.note}`,
      link: `/owner/properties/${parent.property_id}/${OWNER_PAGE[kind]}`,
      type: kind === "capital_call" ? "capital_call_alert" : kind,
      propertyId: parent.property_id,
    });
  }
}

export async function createCapitalCall(
  db: Db,
  params: { adminId: string; propertyId: string; title: string; reason: string; totalAmount: number; dueDate: string },
): Promise<{ id: string }> {
  const { data: property } = await db.from("properties").select("id").eq("id", params.propertyId).maybeSingle();
  if (!property) throw new Error("Property not found");
  if (isPastDue(params.dueDate)) throw new Error("The due date can't be in the past.");
  const { data, error } = await db
    .from("capital_calls")
    .insert({
      property_id: params.propertyId,
      title: params.title,
      reason: params.reason,
      total_amount: params.totalAmount,
      due_date: params.dueDate,
      status: "draft",
      created_by: params.adminId,
    })
    .select("*")
    .maybeSingle();
  if (error || !data) throw new Error(MISSING_SCHEMA);
  await audit(db, { id: params.adminId, type: "admin" }, "capital_call.created", { type: "capital_call", id: data.id as string, propertyId: params.propertyId }, { total_amount: params.totalAmount });
  return { id: data.id as string };
}

async function loadCall(db: Db, callId: string): Promise<CapitalCallRow> {
  const { data } = await db.from("capital_calls").select("*").eq("id", callId).maybeSingle();
  if (!data) throw new Error("Capital call not found");
  return data as CapitalCallRow;
}

/**
 * Puts this call to the owners. The vote states the amount, and the call's total
 * can't change after this, so a passed vote approves exactly what gets issued.
 */
export async function startCapitalCallVote(db: Db, params: { adminId: string; callId: string; closesAt: string }) {
  const call = await loadCall(db, params.callId);
  if (call.status !== "draft") throw new Error("Only a draft capital call can go to a vote.");
  const current = await freshVote(db, call.vote_id);
  const live = (await loadGovernanceConfig(db)).capitalCallVoteThresholdUsd;
  if (!capitalCallNeedsVote(Number(call.total_amount), thresholdFor(current, live))) throw new Error("This capital call is under the threshold, so it doesn't need a vote.");
  if (!voteCanRestart(current)) throw new Error(votePassed(current) ? "The owners already approved this capital call." : "A vote on this capital call is already running.");
  if (new Date(params.closesAt).getTime() <= Date.now()) throw new Error("The vote's closing time must be in the future.");

  const vote = await createVote(db, {
    actorId: params.adminId,
    propertyId: call.property_id,
    title: `Capital call: ${call.title} (${expenseMoney(call.total_amount)})`,
    description: `Approve a capital call of ${expenseMoney(call.total_amount)}, split pro-rata across all issued shares. Reason: ${call.reason}`,
    voteType: CAPITAL_CALL_VOTE_TYPE,
    options: DEFAULT_VOTE_OPTIONS,
    opensAt: new Date().toISOString(),
    closesAt: params.closesAt,
  });
  let link = db.from("capital_calls").update({ vote_id: vote.id }).eq("id", call.id).eq("status", "draft");
  link = call.vote_id ? link.eq("vote_id", call.vote_id) : link.is("vote_id", null);
  const { data: linked } = await link.select("id").maybeSingle();
  if (!linked) {
    // Someone else started one first: this draft never opened, so no owner saw it.
    await db.from("votes").update({ status: "cancelled" }).eq("id", vote.id).eq("status", "draft");
    throw new Error("A vote on this capital call was just started. Reload and check.");
  }
  await openVote(db, params.adminId, vote.id);
  await audit(db, { id: params.adminId, type: "admin" }, "capital_call.vote_started", { type: "capital_call", id: call.id, propertyId: call.property_id }, { vote_id: vote.id, previous_vote_id: call.vote_id, total_amount: call.total_amount });
}

export async function issueCapitalCall(db: Db, params: { adminId: string; callId: string; dueDate: string }) {
  const call = await loadCall(db, params.callId);
  if (call.status !== "draft") throw new Error("Only a draft capital call can be issued.");
  if (isPastDue(params.dueDate)) throw new Error("The due date can't be in the past.");
  const vote = await freshVote(db, call.vote_id);
  const needsVote = capitalCallNeedsVote(Number(call.total_amount), thresholdFor(vote, (await loadGovernanceConfig(db)).capitalCallVoteThresholdUsd));
  if (needsVote && !votePassed(vote)) throw new Error("This capital call needs a passed vote before it can be issued.");

  const lines = await currentSplit(db, call.property_id, call.total_amount);
  const result = await rpc(db, "issue_capital_call", { _call: call.id, _allocations: lines, _due_date: params.dueDate, _vote_required: needsVote, _actor: params.adminId });
  if (result["applied"] === false) return; // someone else just issued it, and told the owners
  await tellHolders(db, lines, (line) => ({
    subject: "A capital call was issued",
    message: `A capital call "${call.title}" was issued. Your share is ${expenseMoney(line.amount)}, due ${params.dueDate}.`,
    link: `/owner/properties/${call.property_id}/capital-calls`,
    type: "capital_call_alert",
    propertyId: call.property_id,
    dedupeKey: `call_issued:${call.id}`,
  }));
}

/** Discards a draft, or finishes an issued call. Payments still in flight can still be recorded. */
export async function closeCapitalCall(db: Db, params: { adminId: string; callId: string }) {
  const call = await loadCall(db, params.callId);
  if (call.status === "closed") throw new Error("This capital call is already closed.");
  const { data } = await db
    .from("capital_calls")
    .update({ status: "closed", closed_at: new Date().toISOString(), closed_by: params.adminId })
    .eq("id", call.id)
    .eq("status", call.status)
    .select("id")
    .maybeSingle();
  if (!data) throw new Error("This capital call just changed. Reload and try again.");
  await audit(db, { id: params.adminId, type: "admin" }, "capital_call.closed", { type: "capital_call", id: call.id, propertyId: call.property_id }, { was: call.status });
}
