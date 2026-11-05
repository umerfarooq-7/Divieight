/** Founder Dashboard (server side): reads the materialized views, never the base tables. */

import { computeFounderDashboard, type FounderFacts, type FounderFilters } from "@/lib/founder";

type Db = { from: (t: string) => any };

const MISSING_SCHEMA = "Database is missing the founder dashboard — run founder-dashboard.sql in Supabase.";
const PAGE = 1000;

/** Supabase hands back 1,000 rows at a time, and a total that stops there would be wrong. */
async function readAll<T>(db: Db, view: string, key: string): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await db.from(view).select("*").order(key, { ascending: true }).range(start, start + PAGE - 1);
    if (error) throw new Error(MISSING_SCHEMA);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < PAGE) return out;
  }
}

export async function founderDashboard(db: Db, filters: FounderFilters) {
  const [properties, pef, commissions, buyers, shares, exceptions, resale] = await Promise.all([
    readAll<FounderFacts["properties"][number]>(db, "founder_mv_properties", "id"),
    readAll<FounderFacts["pef"][number]>(db, "founder_mv_pef", "key"),
    readAll<FounderFacts["commissions"][number]>(db, "founder_mv_commissions", "id"),
    readAll<FounderFacts["buyers"][number]>(db, "founder_mv_buyers", "id"),
    readAll<FounderFacts["shares"][number]>(db, "founder_mv_shares", "key"),
    readAll<FounderFacts["exceptions"][number]>(db, "founder_mv_exceptions", "id"),
    readAll<FounderFacts["resale"][number]>(db, "founder_mv_resale", "id"),
  ]);
  const { data: stamp } = await db.from("founder_dashboard_refreshes").select("refreshed_at").eq("id", 1).maybeSingle();
  return {
    ...computeFounderDashboard({ properties, pef, commissions, buyers, shares, exceptions, resale }, filters),
    refreshedAt: (stamp?.refreshed_at as string | undefined) ?? null,
  };
}

export async function refreshFounder(db: Db): Promise<{ refreshedAt: string }> {
  const { data, error } = await (db as any).rpc("refresh_founder_dashboard");
  if (error) throw new Error(/does not exist|schema cache/i.test(error.message) ? MISSING_SCHEMA : error.message);
  return { refreshedAt: data as string };
}
