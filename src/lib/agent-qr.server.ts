/**
 * Agent QR / deep-link attribution (server side). The stamp is a suggestion for the
 * admin: nothing here reads or writes referring_agent_id, tether data or the older
 * attribution_tokens table.
 */

import { isAttributionToken, randomAttributionToken } from "@/lib/agent-qr";

type Db = { from: (t: string) => any };

const MISSING_SCHEMA = "Database is missing QR attribution — run agent-qr-attribution.sql in Supabase.";

interface TokenRow {
  id: string;
  agent_id: string;
  token: string;
  label: string | null;
  is_default: boolean;
  created_at: string;
  revoked_at: string | null;
}

export async function hashUserAgent(userAgent: string | null): Promise<string | null> {
  if (!userAgent) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userAgent));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** /a/:token. Only a live token is counted or kept; nothing personal is stored. */
export async function recordVisit(db: Db, params: { token: string; userAgent: string | null }): Promise<{ active: boolean }> {
  if (!isAttributionToken(params.token)) return { active: false };
  const { data } = await db.from("agent_attribution_tokens").select("id, revoked_at").eq("token", params.token).maybeSingle();
  if (!data || data.revoked_at) return { active: false };
  await db.from("attribution_visits").insert({ token_id: data.id, user_agent_hash: await hashUserAgent(params.userAgent) });
  return { active: true };
}

async function agentFor(db: Db, userId: string): Promise<{ id: string } | null> {
  const { data } = await db.from("agents").select("id").eq("auth_user_id", userId).maybeSingle();
  return (data as { id: string } | null) ?? null;
}

async function insertToken(db: Db, row: { agent_id: string; label: string | null; is_default: boolean }): Promise<{ row: TokenRow | null; duplicate: boolean }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await db.from("agent_attribution_tokens").insert({ ...row, token: randomAttributionToken() }).select("*").maybeSingle();
    if (!error) return { row: data as TokenRow, duplicate: false };
    if (error.code !== "23505") throw new Error(MISSING_SCHEMA);
    if (row.is_default) return { row: null, duplicate: true }; // another tab made the default first
  }
  throw new Error("Couldn't create a link. Please try again.");
}

export interface AgentQrToken {
  id: string;
  token: string;
  label: string | null;
  isDefault: boolean;
  createdAt: string;
  revokedAt: string | null;
  visits: number;
}

/** /agent/qr. The first visit creates the agent's default token. */
export async function agentQrPage(db: Db, userId: string): Promise<{ isAgent: boolean; tokens: AgentQrToken[] }> {
  const agent = await agentFor(db, userId);
  if (!agent) return { isAgent: false, tokens: [] };

  const list = async () => {
    const { data, error } = await db.from("agent_attribution_tokens").select("*").eq("agent_id", agent.id).order("created_at", { ascending: false });
    if (error) throw new Error(MISSING_SCHEMA);
    return (data ?? []) as TokenRow[];
  };
  let rows = await list();
  if (!rows.some((r) => r.is_default && !r.revoked_at)) {
    await insertToken(db, { agent_id: agent.id, label: null, is_default: true });
    rows = await list();
  }

  const tokens: AgentQrToken[] = [];
  for (const r of rows) {
    const { count } = await db.from("attribution_visits").select("id", { count: "exact", head: true }).eq("token_id", r.id);
    tokens.push({ id: r.id, token: r.token, label: r.label, isDefault: r.is_default, createdAt: r.created_at, revokedAt: r.revoked_at, visits: count ?? 0 });
  }
  return { isAgent: true, tokens: tokens.sort((a, b) => Number(b.isDefault && !b.revokedAt) - Number(a.isDefault && !a.revokedAt)) };
}

export async function createLabeledToken(db: Db, params: { userId: string; label: string }) {
  const agent = await agentFor(db, params.userId);
  if (!agent) throw new Error("Not authorized");
  const { row } = await insertToken(db, { agent_id: agent.id, label: params.label, is_default: false });
  await db.from("audit_log").insert({
    actor_id: params.userId,
    actor_type: "agent",
    action_type: "agent.qr_token_created",
    entity_type: "agent_attribution_token",
    entity_id: row!.id,
    metadata: { label: params.label },
  });
}

/** Stops new stamps. Stamps already made stay exactly as they are. */
export async function revokeToken(db: Db, params: { userId: string; tokenId: string }) {
  const agent = await agentFor(db, params.userId);
  if (!agent) throw new Error("Not authorized");
  const { data } = await db
    .from("agent_attribution_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", params.tokenId)
    .eq("agent_id", agent.id)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (!data) throw new Error("That link isn't available.");
  await db.from("audit_log").insert({
    actor_id: params.userId,
    actor_type: "agent",
    action_type: "agent.qr_token_revoked",
    entity_type: "agent_attribution_token",
    entity_id: params.tokenId,
    metadata: {},
  });
}

/**
 * The stamp. Tokens come oldest first: the first one still live wins, once. `keep`
 * tells the browser to hold on to them (no buyer account yet, or the tables aren't
 * there yet) rather than clear them.
 *
 * A buyer who has already paid their enrollment fee wasn't brought in by a link they
 * opened afterwards, so they aren't stamped.
 */
export async function stampBuyer(db: Db, params: { userId: string; tokens: string[] }): Promise<{ stamped: boolean; keep: boolean }> {
  const { data: buyer } = await db.from("buyer_accounts").select("id, priority_rank_timestamp").eq("auth_user_id", params.userId).maybeSingle();
  if (!buyer) return { stamped: false, keep: true };

  const { data: existing, error: missing } = await db.from("buyer_attribution").select("id").eq("buyer_user_id", params.userId).maybeSingle();
  if (missing) return { stamped: false, keep: true }; // before the SQL is run
  if (existing || buyer.priority_rank_timestamp) return { stamped: false, keep: false };

  for (const token of params.tokens.filter(isAttributionToken)) {
    const { data: row } = await db.from("agent_attribution_tokens").select("id, agent_id, revoked_at").eq("token", token).maybeSingle();
    if (!row || row.revoked_at) continue;
    const { data: agent } = await db.from("agents").select("auth_user_id").eq("id", row.agent_id).maybeSingle();
    if (!agent || agent.auth_user_id === params.userId) continue; // nobody refers themselves

    const { data: stamp, error } = await db
      .from("buyer_attribution")
      .insert({ buyer_user_id: params.userId, token_id: row.id, agent_id: row.agent_id })
      .select("id")
      .maybeSingle();
    if (error) return { stamped: false, keep: error.code !== "23505" }; // 23505: another tab stamped first
    await db.from("audit_log").insert({
      actor_id: params.userId,
      actor_type: "buyer",
      action_type: "buyer.attribution_stamped",
      entity_type: "buyer_account",
      entity_id: buyer.id,
      metadata: { stamp_id: stamp?.id ?? null, token_id: row.id, agent_id: row.agent_id },
    });
    return { stamped: true, keep: false };
  }
  return { stamped: false, keep: false };
}

/** The neutral note on the agent-selection step. Choosing stays with the buyer. */
export async function myReferralSuggestion(db: Db, userId: string): Promise<{ agentName: string } | null> {
  const { data: stamp, error } = await db.from("buyer_attribution").select("agent_id").eq("buyer_user_id", userId).maybeSingle();
  if (error || !stamp) return null;
  const { data: agent } = await db.from("agents").select("full_name").eq("id", stamp.agent_id).maybeSingle();
  return agent?.full_name ? { agentName: agent.full_name as string } : null;
}

/** "Attributed to Agent X" for the admin's buyers list, keyed by the buyer's login. */
export async function adminAttributions(db: Db): Promise<Record<string, { agentName: string; agentEmail: string | null; stampedAt: string }>> {
  const { data, error } = await db.from("buyer_attribution").select("buyer_user_id, agent_id, stamped_at");
  if (error) return {}; // before the SQL is run
  const rows = (data ?? []) as Array<{ buyer_user_id: string; agent_id: string; stamped_at: string }>;
  const ids = [...new Set(rows.map((r) => r.agent_id))];
  const { data: agents } = ids.length ? await db.from("agents").select("id, full_name, email").in("id", ids) : { data: [] };
  const byId = new Map(((agents ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>).map((a) => [a.id, a]));
  return Object.fromEntries(
    rows.map((r) => [r.buyer_user_id, { agentName: byId.get(r.agent_id)?.full_name || "Agent", agentEmail: byId.get(r.agent_id)?.email ?? null, stampedAt: r.stamped_at }]),
  );
}
