import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/audit";
import { readStoredTokens, rememberToken } from "@/lib/agent-qr";

/**
 * Lead attribution: QR codes and deep links that connect a buyer's platform
 * entry to the referring agent.
 *
 * Attribution decides only whether the 25%/75% buyer-side commission split
 * applies at closing (paid by the title/escrow company from sale proceeds).
 * The Platform never pays agents or brokers.
 */

const db = supabase as unknown as { from: (table: string) => any };

export const REFERRAL_COOKIE = "divieight_ref";
/** Standard NAR Referral Agreement duration. */
export const REFERRAL_TAG_MONTHS = 12;

export interface AttributionTokenRow {
  id: string;
  agent_id: string;
  token: string;
  token_type: "qr" | "link";
  campaign_label: string | null;
  click_count: number;
  created_at: string;
}

/** Short, unambiguous token (no look-alike characters). */
function randomToken(length = 8): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function referralUrl(token: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/r/${token}`;
}

export async function listAttributionTokens(agentId: string): Promise<AttributionTokenRow[]> {
  const { data, error } = await db
    .from("attribution_tokens")
    .select("*")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data ?? []) as AttributionTokenRow[];
}

export async function createAttributionToken(params: {
  agentId: string;
  actorId: string;
  tokenType: "qr" | "link";
  campaignLabel?: string | null;
}): Promise<{ token?: AttributionTokenRow; error?: string }> {
  const { data, error } = await db
    .from("attribution_tokens")
    .insert({
      agent_id: params.agentId,
      token: randomToken(),
      token_type: params.tokenType,
      campaign_label: params.campaignLabel?.trim() || null,
    })
    .select("*")
    .maybeSingle();

  if (error) return { error: error.message };

  const row = data as AttributionTokenRow;
  await logAudit({
    actorId: params.actorId,
    actionType: "agent.attribution_token_created",
    entityType: "attribution_token",
    entityId: row.id,
    actorType: "agent",
    metadata: {
      token: row.token,
      token_type: row.token_type,
      campaign_label: row.campaign_label,
    },
  });
  return { token: row };
}

export async function deleteAttributionToken(id: string): Promise<{ error?: string }> {
  const { error } = await db.from("attribution_tokens").delete().eq("id", id);
  return error ? { error: error.message } : {};
}

/** Buyers tagged to this agent, keyed by the token they arrived through. */
export async function getTaggedBuyerCounts(
  agentId: string,
): Promise<{ total: number; byToken: Record<string, number> }> {
  const { data, error } = await db
    .from("buyer_accounts")
    .select("id, referral_token")
    .eq("referring_agent_id", agentId);
  if (error) return { total: 0, byToken: {} };

  const rows = (data ?? []) as Array<{ referral_token: string | null }>;
  const byToken: Record<string, number> = {};
  for (const r of rows) {
    if (!r.referral_token) continue;
    byToken[r.referral_token] = (byToken[r.referral_token] ?? 0) + 1;
  }
  return { total: rows.length, byToken };
}

/* ---------------------------------------------------------------- cookies */

export function setReferralCookie(value: string) {
  if (typeof document === "undefined") return;
  const maxAge = 60 * 60 * 24 * 365; // one year, matching the tag duration
  document.cookie = `${REFERRAL_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; samesite=lax`;
}

export function readReferralCookie(): { token: string; agentId: string } | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${REFERRAL_COOKIE}=`));
  if (!match) return null;
  const [token, agentId] = decodeURIComponent(match.split("=")[1] ?? "").split("|");
  return token && agentId ? { token, agentId } : null;
}

export function clearReferralCookie() {
  if (typeof document === "undefined") return;
  document.cookie = `${REFERRAL_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

/**
 * Lead Attribution Tag. A link no longer sets a referring agent: the buyer confirms the agent they were referred by on
 * the agent-selection step. An older /r cookie, set before that, is carried over as a suggestion and cleared. This marks
 * the account 'direct' only when there is no link of any kind behind it. Safe to call on every buyer sign-in; it never
 * overwrites an existing tag, and never touches a referring agent that is already set.
 */
export async function applyReferralTag(buyerAccountId: string, actorId: string): Promise<void> {
  const { data } = await db
    .from("buyer_accounts")
    .select("id, referring_agent_id, referral_source")
    .eq("id", buyerAccountId)
    .maybeSingle();
  const existing = data as
    | { referring_agent_id: string | null; referral_source: string | null }
    | null;
  if (!existing) return;
  if (existing.referring_agent_id || existing.referral_source === "direct_confirmed") return;

  const referral = readReferralCookie();

  if (referral) {
    // From a /r link followed before this changed: a suggestion now, like any other link.
    rememberToken(referral.token);
    clearReferralCookie();
    return;
  }
  if (readStoredTokens().length > 0) return; // a link is waiting to be stamped as a suggestion

  await db
    .from("buyer_accounts")
    .update({ referral_source: "direct_confirmed" })
    .eq("id", buyerAccountId);
  void actorId;
}
