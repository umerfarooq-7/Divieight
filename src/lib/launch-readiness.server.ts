/**
 * Launch readiness (server side). Only a founder reads or changes the list; every change is audit logged with what it was
 * before. The warnings are for any admin.
 */
import { isFounder } from "@/lib/governance-config.server";
import { DEFAULT_LIVENESS_PROVIDER } from "@/lib/liveness-adapters";
import { DEFAULT_SANCTIONS_PROVIDER } from "@/lib/sanctions-adapters";
import { LAUNCH_ITEMS, LAUNCH_STATUSES, isLaunchStatus, type LaunchItemView, type LaunchWarning } from "@/lib/launch-readiness";

type Db = { from: (t: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => any };

const TABLE = "launch_readiness_items";
const MISSING_SCHEMA = "Database is missing the launch-readiness table: run launch-readiness.sql in Supabase.";

export async function listLaunchItems(db: Db): Promise<LaunchItemView[]> {
  const { data } = await db.from(TABLE).select("key, status, owner, notes, updated_at");
  const stored = new Map(((data ?? []) as Array<{ key: string; status: string; owner: string | null; notes: string | null; updated_at: string | null }>).map((r) => [r.key, r]));
  return LAUNCH_ITEMS.map((item) => {
    const s = stored.get(item.key);
    return { ...item, status: s && isLaunchStatus(s.status) ? s.status : item.status, owner: s?.owner ?? "", notes: s?.notes ?? "", updatedAt: s?.updated_at ?? null };
  });
}

export async function updateLaunchItem(
  db: Db,
  params: { actorId: string; key: string; status: string; owner: string; notes: string; request?: { ip: string | null; userAgent: string | null } },
): Promise<LaunchItemView[]> {
  if (!(await isFounder(db, params.actorId))) throw new Error("Only the founder can change launch readiness.");
  if (!LAUNCH_ITEMS.some((i) => i.key === params.key)) throw new Error("Unknown item.");
  if (!isLaunchStatus(params.status)) throw new Error(`Status must be one of: ${LAUNCH_STATUSES.join(", ")}.`);
  const before = (await listLaunchItems(db)).find((i) => i.key === params.key)!;
  const next = { status: params.status, owner: params.owner.trim().slice(0, 200), notes: params.notes.trim().slice(0, 4000) };
  const now = new Date().toISOString();
  const { error } = await db.from(TABLE).upsert({ key: params.key, ...next, updated_by: params.actorId, updated_at: now }, { onConflict: "key" });
  if (error) throw new Error(MISSING_SCHEMA);
  await db.from("audit_log").insert({
    actor_id: params.actorId,
    actor_type: "admin",
    action_type: "launch_readiness.updated",
    entity_type: "launch_readiness_item",
    entity_id: null,
    metadata: { key: params.key, before: { status: before.status, owner: before.owner, notes: before.notes }, after: next, ip_address: params.request?.ip ?? null, user_agent: params.request?.userAgent ?? null, at: now },
  });
  return listLaunchItems(db);
}

type Env = Record<string, string | undefined>;

/**
 * What an admin should know about this deployment. A missing W-9 key and a Stripe test key are always worth saying; a
 * simulated vendor only matters when IS_PRODUCTION is true (the environment says this is the real thing).
 */
export function computeLaunchWarnings(env: Env = process.env, providers: { liveness: string; sanctions: string } = { liveness: DEFAULT_LIVENESS_PROVIDER, sanctions: DEFAULT_SANCTIONS_PROVIDER }): LaunchWarning[] {
  const out: LaunchWarning[] = [];
  if (!env["W9_TIN_ENCRYPTION_KEY"]) out.push({ key: "w9_key_missing", message: "W9_TIN_ENCRYPTION_KEY is not set: nobody can save a W-9 until it is." });
  const stripeKey = env["STRIPE_SECRET_KEY"] ?? "";
  if (stripeKey.startsWith("sk_test_")) out.push({ key: "stripe_test_mode", message: "Stripe is in test mode (a test key is configured): no real fee can be charged." });
  if (env["IS_PRODUCTION"] === "true") {
    if (providers.liveness === "simulated") out.push({ key: "liveness_simulated", message: "IS_PRODUCTION is true but the liveness vendor is simulated." });
    if (providers.sanctions === "simulated") out.push({ key: "sanctions_simulated", message: "IS_PRODUCTION is true but the sanctions vendor is simulated." });
    if (!env["QUALIA_API_URL"] || !env["QUALIA_API_TOKEN"]) out.push({ key: "title_simulated", message: "IS_PRODUCTION is true but title and escrow is simulated (no Qualia credentials)." });
    out.push({ key: "plaid_sandbox", message: "IS_PRODUCTION is true but Plaid is on sandbox balances." });
  }
  return out;
}
