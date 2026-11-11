/**
 * Governance settings (server side): the stored overrides on top of the defaults, and the founder-only change.
 * Every change is audit logged with the old and new value. Reading never fails: before governance-config.sql is
 * run there is no table, and the defaults apply.
 */
import { GOVERNANCE_DEFAULTS, GOVERNANCE_KEYS, GOVERNANCE_SETTINGS, governanceValueProblem, resolveConfig, type GovernanceConfig, type GovernanceKey } from "@/lib/governance-config";

type Db = { from: (t: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => any };

const TABLE = "governance_settings";

export async function loadGovernanceConfig(db: Db): Promise<GovernanceConfig> {
  const { data, error } = await db.from(TABLE).select("key, value");
  if (error) return { ...GOVERNANCE_DEFAULTS };
  const overrides: Record<string, unknown> = {};
  for (const row of (data ?? []) as Array<{ key: string; value: number | string }>) overrides[row.key] = row.value;
  return resolveConfig(overrides);
}

export interface GovernanceSettingView {
  key: GovernanceKey;
  label: string;
  unit: string;
  help: string;
  value: number;
  defaultValue: number;
  changed: boolean;
  updatedAt: string | null;
}

export async function governanceSettingsView(db: Db): Promise<GovernanceSettingView[]> {
  const config = await loadGovernanceConfig(db);
  const { data } = await db.from(TABLE).select("key, updated_at");
  const when = new Map(((data ?? []) as Array<{ key: string; updated_at: string | null }>).map((r) => [r.key, r.updated_at]));
  return GOVERNANCE_SETTINGS.map((s) => ({
    key: s.key,
    label: s.label,
    unit: s.unit,
    help: s.help,
    value: config[s.key],
    defaultValue: GOVERNANCE_DEFAULTS[s.key],
    changed: config[s.key] !== GOVERNANCE_DEFAULTS[s.key],
    updatedAt: when.get(s.key) ?? null,
  }));
}

/** Only the founder role changes a setting. Other admins read. */
export async function isFounder(db: Db, userId: string): Promise<boolean> {
  if (!db.rpc) return false;
  const { data } = await db.rpc("has_role", { _user_id: userId, _role: "founder" });
  return data === true;
}

export async function updateGovernanceSetting(db: Db, params: { actorId: string; key: string; value: number; reason: string; request?: { ip: string | null; userAgent: string | null } }): Promise<GovernanceSettingView[]> {
  if (!(await isFounder(db, params.actorId))) throw new Error("Only the founder can change these settings.");
  if (!(GOVERNANCE_KEYS as readonly string[]).includes(params.key)) throw new Error("Unknown setting.");
  const key = params.key as GovernanceKey;
  const problem = governanceValueProblem(key, params.value);
  if (problem) throw new Error(problem);
  const reason = params.reason.trim();
  if (!reason) throw new Error("Say why it is changing.");

  const before = (await loadGovernanceConfig(db))[key];
  const now = new Date().toISOString();
  const { error } = await db.from(TABLE).upsert({ key, value: params.value, updated_by: params.actorId, updated_at: now, reason: reason.slice(0, 1000) }, { onConflict: "key" });
  if (error) throw new Error("Database is missing the governance settings: run governance-config.sql in Supabase.");
  await db.from("audit_log").insert({
    actor_id: params.actorId,
    actor_type: "admin",
    action_type: "governance.setting_changed",
    entity_type: "governance_setting",
    entity_id: null,
    metadata: { key, before, after: params.value, default: GOVERNANCE_DEFAULTS[key], reason, ip_address: params.request?.ip ?? null, user_agent: params.request?.userAgent ?? null, at: now },
  });
  return governanceSettingsView(db);
}
