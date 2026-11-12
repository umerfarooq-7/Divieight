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
