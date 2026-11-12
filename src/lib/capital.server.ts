/**
 * Capital accounts (server side): the roll-forward, and the Manager's capital actions (allocate income, enter the CPA's
 * depreciation, post Month 5 events the ledger hasn't seen). The database does the real work (capital-events.sql); the owner
 * sees only their own capital account, read-only, for the current year and past years.
 */
import { holderFor } from "@/lib/votes.server";

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

const MISSING = "Database is missing the capital events: run capital-events.sql in Supabase.";
function fail(error: { message?: string }): never {
  const m = error.message ?? "";
  if (/does not exist|schema cache|Could not find/i.test(m) && /capital_roll_forward|allocate_income|post_depreciation|sync_month5_events|capital_account_ledger/i.test(m)) throw new Error(MISSING);
  throw new Error(m || "The ledger refused that.");
}

async function requireManager(db: Db, userId: string) {
  const { data } = await db.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (data !== true) throw new Error("Only the Manager can do that.");
}
const meta = (r?: RequestContext) => ({ ip_address: r?.ip ?? null, user_agent: r?.userAgent ?? null });

/** One member's capital account for a year. Amounts are cents, signed as they affect capital (distributions, expenses and depreciation are negative). */
export interface RollForwardRow {
  year: number;
  beginningCents: number;
  openingCents: number;
  contributionsCents: number;
  incomeCents: number;
  expenseCents: number;
  depreciationCents: number;
  distributionsCents: number;
  transferInCents: number;
  transferOutCents: number;
  endingCents: number;
}

type Raw = Record<string, any>;
const toRow = (year: number, r: Raw): RollForwardRow => ({
  year,
  beginningCents: Number(r.beginning_cents),
  openingCents: Number(r.opening_cents),
  contributionsCents: Number(r.contributions_cents),
  incomeCents: Number(r.income_cents),
  expenseCents: Number(r.expense_cents),
  depreciationCents: Number(r.depreciation_cents),
  distributionsCents: Number(r.distributions_cents),
  transferInCents: Number(r.transfer_in_cents),
  transferOutCents: Number(r.transfer_out_cents),
  endingCents: Number(r.ending_cents),
});

const emptyYear = (year: number, beginning: number): RollForwardRow => ({ year, beginningCents: beginning, openingCents: 0, contributionsCents: 0, incomeCents: 0, expenseCents: 0, depreciationCents: 0, distributionsCents: 0, transferInCents: 0, transferOutCents: 0, endingCents: beginning });

/** The owner's own capital account, year by year. Never another member's. Read-only. */
export async function ownerCapitalAccount(db: Db, p: { userId: string; propertyId: string; today?: Date }): Promise<{ allowed: boolean; years: RollForwardRow[] }> {
  const holder = await holderFor(db, p.userId, p.propertyId);
  if (!holder) return { allowed: false, years: [] };
  const member = holder.type === "buyer" ? holder.buyerAccountId! : holder.holderKey.replace(/^seller:/, "");
  const { data: first } = await db.from("capital_account_ledger").select("effective_date").eq("property_id", p.propertyId).eq("member_key", member).order("effective_date", { ascending: true }).limit(1);
  const firstDate = ((first ?? []) as Raw[])[0]?.effective_date as string | undefined;
  if (!firstDate) return { allowed: true, years: [] };
  const thisYear = (p.today ?? new Date()).getUTCFullYear();
  const years: RollForwardRow[] = [];
  let carry = 0;
  for (let y = Number(firstDate.slice(0, 4)); y <= thisYear; y++) {
    const { data, error } = await db.rpc("capital_roll_forward", { _property: p.propertyId, _year: y });
    if (error) fail(error);
    const mine = ((data ?? []) as Raw[]).find((r) => r.member_key === member);
    const row = mine ? toRow(y, mine) : emptyYear(y, carry);
    years.push(row);
    carry = row.endingCents;
  }
  return { allowed: true, years: years.reverse() }; // the current year first
}

export interface AdminRollForward {
  year: number;
  members: Array<RollForwardRow & { member: string }>;
  totals: RollForwardRow;
}

/** Every member's roll-forward for a year, for the Manager, with the totals. */
export async function adminRollForward(db: Db, p: { userId: string; propertyId: string; year: number }): Promise<AdminRollForward> {
  await requireManager(db, p.userId);
  const { data, error } = await db.rpc("capital_roll_forward", { _property: p.propertyId, _year: p.year });
  if (error) fail(error);
  const rows = (data ?? []) as Raw[];
  const ids = rows.map((r) => r.member_key as string);
  const { data: buyers } = ids.length ? await db.from("buyer_accounts").select("id, email").in("id", ids) : { data: [] };
  const emailBy = new Map(((buyers ?? []) as Raw[]).map((b) => [b.id as string, b.email as string | null]));
  const members = rows.map((r) => ({ ...toRow(p.year, r), member: emailBy.get(r.member_key) ?? (r.member_key as string) }));
  const sum = (k: keyof RollForwardRow) => members.reduce((s, m) => s + (m[k] as number), 0);
  return {
    year: p.year,
    members,
    totals: { year: p.year, beginningCents: sum("beginningCents"), openingCents: sum("openingCents"), contributionsCents: sum("contributionsCents"), incomeCents: sum("incomeCents"), expenseCents: sum("expenseCents"), depreciationCents: sum("depreciationCents"), distributionsCents: sum("distributionsCents"), transferInCents: sum("transferInCents"), transferOutCents: sum("transferOutCents"), endingCents: sum("endingCents") },
  };
}

export async function allocateIncome(db: Db, p: { actorId: string; propertyId: string; asOf: string; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  const { data, error } = await db.rpc("allocate_income", { _property: p.propertyId, _as_of: p.asOf, _actor: p.actorId, _meta: meta(p.request) });
  if (error) fail(error);
  const r = data as { status: string; total_cents?: number };
  return { status: r.status, totalCents: r.total_cents == null ? null : Number(r.total_cents) };
}

/** The Manager enters the figure from the CPA's schedule. The platform doesn't compute depreciation. */
export async function enterDepreciation(db: Db, p: { actorId: string; propertyId: string; year: number; amountCents: number; scheduleRef: string; note?: string | null; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) throw new Error("Enter the depreciation from the CPA's schedule, as a whole number of cents above zero.");
  if (!p.scheduleRef.trim()) throw new Error("Name the CPA's schedule this figure comes from. The platform doesn't calculate depreciation.");
  const { data, error } = await db.rpc("post_depreciation", { _property: p.propertyId, _year: p.year, _amount_cents: p.amountCents, _schedule_ref: p.scheduleRef, _note: p.note ?? null, _actor: p.actorId, _meta: meta(p.request) });
  if (error) fail(error);
  return { entryId: (data as { entry_id: string }).entry_id };
}

export async function syncMonth5Events(db: Db, p: { actorId: string; propertyId: string; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  const { data, error } = await db.rpc("sync_month5_events", { _property: p.propertyId, _actor: p.actorId, _meta: meta(p.request) });
  if (error) fail(error);
  const r = data as { expenses: number; distributions: number; transfers: number; problems: Array<{ error: string }> };
  return { expenses: Number(r.expenses), distributions: Number(r.distributions), transfers: Number(r.transfers), problems: (r.problems ?? []).map((x) => x.error) };
}

// ---------------------------------------------------------------------------------------------------------
// Operating Agreement overrides for expense allocation (Month 6, Prompt 8). Manager-entered, audit logged, with the OA section.
// ---------------------------------------------------------------------------------------------------------
import { percentsProblem, type OverrideMethod } from "@/lib/expenses";

export interface OverrideRow {
  id: string;
  expenseCategory: string | null;
  expenseId: string | null;
  method: OverrideMethod;
  percents: Array<{ holderKey: string; holder: string; percent: number }>;
  basis: string | null;
  sourceOaSection: string;
  effectiveFrom: string;
  retiredAt: string | null;
  retireReason: string | null;
}

export interface OverridesView {
  holders: Array<{ key: string; label: string; shares: number }>;
  overrides: OverrideRow[];
}

const OVERRIDES_MISSING = "Database is missing the allocation overrides: run expense-books.sql in Supabase.";
function overrideFail(error: { message?: string }): never {
  const m = error.message ?? "";
  if (/does not exist|schema cache|Could not find/i.test(m) && /allocation_overrides|save_allocation_override|retire_allocation_override/i.test(m)) throw new Error(OVERRIDES_MISSING);
  throw new Error(m || "The ledger refused that.");
}

export async function allocationOverrides(db: Db, p: { userId: string; propertyId: string }): Promise<OverridesView> {
  await requireManager(db, p.userId);
  const { rankedHolders } = await import("@/lib/use-calendar.server");
  const ranked = await rankedHolders(db as never, p.propertyId);
  const ids = ranked.filter((h) => !h.isRetainedSeller).map((h) => h.holderKey);
  const { data: buyers } = ids.length ? await db.from("buyer_accounts").select("id, email").in("id", ids) : { data: [] };
  const emailBy = new Map(((buyers ?? []) as Raw[]).map((b) => [b.id as string, b.email as string | null]));
  const holders = ranked.map((h) => ({ key: h.holderKey, label: h.isRetainedSeller ? `${h.name || "Retained seller"} (retained)` : (emailBy.get(h.holderKey) ?? (h.name || "Co-owner")), shares: h.shares }));
  const labelOf = new Map(holders.map((h) => [h.key, h.label]));
  const { data, error } = await db.from("allocation_overrides").select("*").eq("property_id", p.propertyId).order("created_at", { ascending: false });
  if (error) {
    if (/does not exist|schema cache|Could not find/i.test(error.message ?? "")) return { holders, overrides: [] }; // before expense-books.sql is run
    overrideFail(error);
  }
  const overrides = ((data ?? []) as Raw[]).map((o) => ({
    id: o.id as string,
    expenseCategory: (o.expense_category as string | null) ?? null,
    expenseId: (o.expense_id as string | null) ?? null,
    method: o.method as OverrideMethod,
    percents: Object.entries((o.parameters?.percents ?? {}) as Record<string, unknown>).map(([k, v]) => ({ holderKey: k, holder: labelOf.get(k) ?? k, percent: Number(v) })),
    basis: (o.parameters?.basis as string | undefined) ?? null,
    sourceOaSection: o.source_oa_section as string,
    effectiveFrom: o.effective_from as string,
    retiredAt: (o.retired_at as string | null) ?? null,
    retireReason: (o.retire_reason as string | null) ?? null,
  }));
  return { holders, overrides };
}

export async function saveAllocationOverride(
  db: Db,
  p: { actorId: string; propertyId: string; expenseCategory?: string | null; expenseId?: string | null; method: OverrideMethod; percents: Record<string, number>; basis?: string | null; sourceOaSection: string; effectiveFrom: string; request?: RequestContext },
) {
  await requireManager(db, p.actorId);
  if (!p.sourceOaSection.trim()) throw new Error("Name the Operating Agreement section this override comes from.");
  const problem = percentsProblem(p.percents);
  if (problem) throw new Error(problem);
  if (p.method === "usage_adjusted" && !p.basis?.trim()) throw new Error("Say what the usage adjustment is based on. The platform has no usage formula: you enter the percentages.");
  const { data, error } = await db.rpc("save_allocation_override", {
    _property: p.propertyId,
    _category: p.expenseCategory ?? null,
    _expense: p.expenseId ?? null,
    _method: p.method,
    _params: { percents: p.percents, ...(p.basis?.trim() ? { basis: p.basis.trim() } : {}) },
    _oa_section: p.sourceOaSection,
    _effective_from: p.effectiveFrom,
    _actor: p.actorId,
    _meta: meta(p.request),
  });
  if (error) overrideFail(error);
  return { id: data as string };
}

export async function retireAllocationOverride(db: Db, p: { actorId: string; overrideId: string; reason: string; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  const { error } = await db.rpc("retire_allocation_override", { _id: p.overrideId, _reason: p.reason, _actor: p.actorId, _meta: meta(p.request) });
  if (error) overrideFail(error);
}
