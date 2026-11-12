/**
 * Short-term rental (server side). The owner's tracker is recordkeeping only: it reads and writes owner_str_records and nothing
 * else. It never posts to the ledger and nothing here sums it into an LLC figure. The Manager sees only who has lodging tax
 * owed or unknown, never an amount.
 */
import { holderFor } from "@/lib/votes.server";
import { strRecordProblem, strTrackerAllowed, type LodgingTaxExposureRow, type LodgingTaxStatus, type OwnerStrRecord } from "@/lib/str";

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };
type Raw = Record<string, any>;

const MISSING = "Database is missing the short-term-rental tables: run str-treatment.sql in Supabase.";
function fail(error: { message?: string }): never {
  const m = error.message ?? "";
  if (/does not exist|schema cache|Could not find/i.test(m) && /owner_str_records|save_owner_str_record|lodging_tax_exposure|reclassify_str_deposit/i.test(m)) throw new Error(MISSING);
  throw new Error(m || "That didn't save.");
}

const toRecord = (r: Raw): OwnerStrRecord => ({
  id: r.id,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  nights: Number(r.nights),
  grossCents: Number(r.gross_amount_cents),
  feesCents: Number(r.platform_fees_cents),
  lodgingTaxStatus: r.lodging_tax_status as LodgingTaxStatus,
  lodgingTaxNote: r.lodging_tax_note ?? null,
});

async function propertyAllowsStr(db: Db, propertyId: string): Promise<boolean> {
  const { data } = await db.from("properties").select("usage_tag").eq("id", propertyId).maybeSingle();
  return strTrackerAllowed((data as Raw | null)?.usage_tag as string | null | undefined);
}

/** The owner's own records for this home. The tracker is hidden (and nothing is read) when the home's intent doesn't allow STR. */
export async function ownerStrView(db: Db, p: { userId: string; propertyId: string }): Promise<{ allowed: boolean; trackerEnabled: boolean; records: OwnerStrRecord[] }> {
  const holder = await holderFor(db, p.userId, p.propertyId);
  if (!holder) return { allowed: false, trackerEnabled: false, records: [] };
  if (!(await propertyAllowsStr(db, p.propertyId))) return { allowed: true, trackerEnabled: false, records: [] };
  const member = holder.type === "buyer" ? holder.buyerAccountId! : holder.holderKey.replace(/^seller:/, "");
  const { data, error } = await db.from("owner_str_records").select("*").eq("property_id", p.propertyId).eq("member_key", member).order("period_start", { ascending: false });
  if (error) fail(error);
  return { allowed: true, trackerEnabled: true, records: ((data ?? []) as Raw[]).map(toRecord) };
}

export interface StrRecordInput {
  id?: string | null;
  periodStart: string;
  periodEnd: string;
  nights: number;
  grossCents: number;
  feesCents: number;
  lodgingTaxStatus: LodgingTaxStatus;
  lodgingTaxNote?: string | null;
}

export async function saveStrRecord(db: Db, p: { userId: string; propertyId: string } & StrRecordInput): Promise<{ id: string }> {
  const problem = strRecordProblem(p);
  if (problem) throw new Error(problem);
  if (!(await holderFor(db, p.userId, p.propertyId))) throw new Error("You don't have ownership in that property.");
  if (!(await propertyAllowsStr(db, p.propertyId))) throw new Error("This home's intent profile doesn't include short-term rental.");
  const { data, error } = await db.rpc("save_owner_str_record", {
    _property: p.propertyId,
    _user: p.userId,
    _id: p.id ?? null,
    _period_start: p.periodStart,
    _period_end: p.periodEnd,
    _nights: p.nights,
    _gross_cents: p.grossCents,
    _fees_cents: p.feesCents,
    _tax_status: p.lodgingTaxStatus,
    _tax_note: p.lodgingTaxNote ?? null,
  });
  if (error) fail(error);
  return { id: data as string };
}

export async function deleteStrRecord(db: Db, p: { userId: string; propertyId: string; id: string }): Promise<void> {
  const { error } = await db.rpc("delete_owner_str_record", { _property: p.propertyId, _user: p.userId, _id: p.id });
  if (error) fail(error);
}

/** For the CPA Cooperation Worksheet: which owners recorded STR activity with lodging tax owed or unknown. No amounts. */
export async function lodgingTaxExposure(db: Db, p: { userId: string; propertyId: string }): Promise<{ rows: LodgingTaxExposureRow[] }> {
  const { data: isAdmin } = await db.rpc("has_role", { _user_id: p.userId, _role: "admin" });
  if (isAdmin !== true) throw new Error("Only the Manager can do that.");
  const { data, error } = await db.rpc("lodging_tax_exposure", { _property: p.propertyId, _actor: p.userId });
  if (error) fail(error);
  const raw = (data ?? []) as Raw[];
  const ids = raw.map((r) => r.member_key as string);
  const { data: buyers } = ids.length ? await db.from("buyer_accounts").select("id, email").in("id", ids) : { data: [] };
  const emailBy = new Map(((buyers ?? []) as Raw[]).map((b) => [b.id as string, b.email as string | null]));
  return { rows: raw.map((r) => ({ member: emailBy.get(r.member_key) ?? (r.member_key as string), statuses: r.statuses as LodgingTaxStatus[], recordCount: Number(r.record_count) })) };
}
