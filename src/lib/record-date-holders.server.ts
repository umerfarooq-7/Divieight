/**
 * Who held the shares on a given date, rebuilt from today's cap table and cap_table_history. A resale moves one share from
 * one holder to another and writes one history row, so the holder on a date is today's holder, unless the share changed
 * hands after that date, in which case it is whoever held it just before the earliest later change. A change made ON the
 * record date counts as already made (the record date is the end of that day, UTC).
 */
import { rankHolderRows, type HolderRow, type RankedHolder } from "@/lib/use-calendar.server";

type Db = { from: (t: string) => any };

const endOfDay = (isoDate: string) => new Date(`${isoDate}T00:00:00.000Z`).getTime() + 86_400_000;

export async function holdersAsOf(db: Db, propertyId: string, recordDate: string): Promise<RankedHolder[]> {
  const { data: current } = await db.from("cap_table_entries").select("share_number, holder_type, buyer_account_id, seller_id, account_member_names").eq("property_id", propertyId);
  const { data: history } = await db
    .from("cap_table_history")
    .select("share_number, from_holder_type, from_buyer_account_id, from_seller_id, changed_at")
    .eq("property_id", propertyId);
  const cutoff = endOfDay(recordDate);
  type Change = { share_number: number; from_holder_type: string; from_buyer_account_id: string | null; from_seller_id: string | null; changed_at: string };
  const later = new Map<number, Change>();
  for (const h of ((history ?? []) as Change[]).sort((a, b) => new Date(a.changed_at).getTime() - new Date(b.changed_at).getTime())) {
    if (new Date(h.changed_at).getTime() >= cutoff && !later.has(h.share_number)) later.set(h.share_number, h);
  }
  const rows: HolderRow[] = ((current ?? []) as Array<HolderRow & { share_number: number }>).map((r) => {
    const change = later.get(r.share_number);
    if (!change) return r;
    return { holder_type: change.from_holder_type, buyer_account_id: change.from_buyer_account_id, seller_id: change.from_seller_id, account_member_names: null };
  });
  return rankHolderRows(db, rows);
}
