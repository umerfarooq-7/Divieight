/**
 * The Conversion Event, for the admin. The rows are written only by the Postgres
 * functions in conversion-events.sql; this reads them and asks for a sync.
 */

type Db = { from: (t: string) => any };

const MISSING_SCHEMA = "Database is missing conversion events — run conversion-events.sql in Supabase.";
const MAX_ROWS = 1000;

export type ConversionStatus = "partial" | "converted";

export interface ConversionFilters {
  status: ConversionStatus | null;
  agentId: string | null;
  propertyId: string | null;
  from: string | null;
  to: string | null;
}

export interface ConversionRow {
  id: string;
  buyerEmail: string;
  propertyId: string | null;
  propertyLabel: string | null;
  agentId: string | null;
  agentName: string | null;
  praExecutedAt: string | null;
  pefClearedAt: string | null;
  convertedAt: string | null;
  status: ConversionStatus;
  createdAt: string;
}

interface EventRow {
  id: string;
  buyer_account_id: string;
  property_id: string | null;
  agent_attribution_id: string | null;
  pra_executed_at: string | null;
  pef_cleared_at: string | null;
  converted_at: string | null;
  status: ConversionStatus;
  created_at: string;
}

async function lookup<T extends { id: string }>(db: Db, table: string, columns: string, ids: Array<string | null>): Promise<Map<string, T>> {
  const unique = [...new Set(ids.filter(Boolean))] as string[];
  if (unique.length === 0) return new Map();
  const { data } = await db.from(table).select(columns).in("id", unique);
  return new Map(((data ?? []) as T[]).map((r) => [r.id, r]));
}

/** The date a row counts under: when it converted, or when it first appeared. */
const eventDate = (r: Pick<ConversionRow, "convertedAt" | "createdAt">) => (r.convertedAt ?? r.createdAt).slice(0, 10);

export async function adminConversions(db: Db, filters: ConversionFilters) {
  const { data, error } = await db.from("conversion_events").select("*").order("created_at", { ascending: false }).limit(MAX_ROWS);
  if (error) throw new Error(MISSING_SCHEMA);
  const events = (data ?? []) as EventRow[];

  const buyers = await lookup<{ id: string; email: string | null }>(db, "buyer_accounts", "id, email", events.map((e) => e.buyer_account_id));
  const properties = await lookup<{ id: string; address: string | null; city: string | null; state: string | null }>(db, "properties", "id, address, city, state", events.map((e) => e.property_id));
  const stamps = await lookup<{ id: string; agent_id: string }>(db, "buyer_attribution", "id, agent_id", events.map((e) => e.agent_attribution_id));
  const agents = await lookup<{ id: string; full_name: string | null }>(db, "agents", "id, full_name", [...stamps.values()].map((s) => s.agent_id));

  const all: ConversionRow[] = events.map((e) => {
    const p = e.property_id ? properties.get(e.property_id) : null;
    const agentId = e.agent_attribution_id ? (stamps.get(e.agent_attribution_id)?.agent_id ?? null) : null;
    return {
      id: e.id,
      buyerEmail: buyers.get(e.buyer_account_id)?.email ?? "Buyer",
      propertyId: e.property_id,
      propertyLabel: p ? [p.address, p.city, p.state].filter(Boolean).join(", ") : null,
      agentId,
      agentName: agentId ? (agents.get(agentId)?.full_name ?? "Agent") : null,
      praExecutedAt: e.pra_executed_at,
      pefClearedAt: e.pef_cleared_at,
      convertedAt: e.converted_at,
      status: e.status,
      createdAt: e.created_at,
    };
  });

  const rows = all.filter(
    (r) =>
      (!filters.status || r.status === filters.status) &&
      (!filters.agentId || r.agentId === filters.agentId) &&
      (!filters.propertyId || r.propertyId === filters.propertyId) &&
      (!filters.from || eventDate(r) >= filters.from) &&
      (!filters.to || eventDate(r) <= filters.to),
  );
  const distinct = (pairs: Array<[string | null, string | null]>) =>
    [...new Map(pairs.filter(([id]) => id) as Array<[string, string]>).entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));

  return {
    rows,
    totals: { converted: rows.filter((r) => r.status === "converted").length, partial: rows.filter((r) => r.status === "partial").length },
    agents: distinct(all.map((r) => [r.agentId, r.agentName])),
    properties: distinct(all.map((r) => [r.propertyId, r.propertyLabel])),
    truncated: events.length === MAX_ROWS,
  };
}

export async function runConversionSync(db: Db): Promise<{ processed: number; converted: number; partial: number }> {
  const { data, error } = await (db as any).rpc("sync_conversion_events");
  if (error) throw new Error(/does not exist|schema cache/i.test(error.message) ? MISSING_SCHEMA : error.message);
  return data as { processed: number; converted: number; partial: number };
}
