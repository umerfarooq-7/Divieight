/**
 * Audit Vault (server side): read-only access that is itself logged, the nightly chain verification, Suspicious Activity Alerts and their delivery to the
 * Compliance Officer (an in-app notification and an email).
 *
 * The chain, the append-only rule and the redaction live in the database (audit-vault.sql), so they hold whatever code writes the log. This file is the
 * part the database cannot do: noticing, telling a person, and handing the log to a reader.
 */
import { deliver } from "@/lib/authorization.notify.server";
import {
  ALERT_LABELS,
  DECRYPT_BURST_LIMIT,
  DECRYPT_BURST_WINDOW_MINUTES,
  RECONCILE_GRACE_MINUTES,
  RECONCILE_WINDOW_MINUTES,
  accountedFor,
  isAppProtectedChange,
  sarMessage,
  sarSubject,
  type AlertKind,
  type AuditRowLike,
} from "@/lib/audit-vault";

type Db = { from: (t: string) => any; rpc?: (n: string, a: Record<string, unknown>) => any; auth?: { admin?: { getUserById?: (id: string) => Promise<{ data?: { user?: { email?: string | null } | null } }> } } };
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}
const MISSING = "Database is missing the Audit Vault hardening: run audit-roles.sql and then audit-vault.sql in Supabase.";
const siteUrl = () => (process.env.SITE_URL ?? "https://divieight.vercel.app").replace(/\/$/, "");

// ---------------------------------------------------------------------------------------------------------
// Who may read
// ---------------------------------------------------------------------------------------------------------
export type VaultRole = "admin" | "compliance_officer" | "auditor";

async function hasRole(db: Db, userId: string, role: string): Promise<boolean> {
  const { data } = await db.rpc!("has_role", { _user_id: userId, _role: role });
  return data === true;
}

/** The Manager, the Compliance Officer and external auditors read the Audit Vault, read-only. Anyone else is refused. */
export async function vaultRole(db: Db, userId: string): Promise<VaultRole | null> {
  for (const role of ["admin", "compliance_officer", "auditor"] as const) if (await hasRole(db, userId, role)) return role;
  return null;
}
export async function requireVaultReader(db: Db, userId: string): Promise<VaultRole> {
  const role = await vaultRole(db, userId);
  if (!role) throw new Error("Not authorized");
  return role;
}
/** Only the Manager and the Compliance Officer act on alerts. An external auditor only reads. */
export async function requireVaultOfficer(db: Db, userId: string): Promise<VaultRole> {
  const role = await requireVaultReader(db, userId);
  if (role === "auditor") throw new Error("Not authorized");
  return role;
}

// ---------------------------------------------------------------------------------------------------------
// Reading the vault: read-only, and every read is itself a row
// ---------------------------------------------------------------------------------------------------------
export interface VaultFilters {
  action?: string | null;
  actor?: string | null;
  entity?: string | null;
  from?: string | null;
  to?: string | null;
}

export async function readVault(db: Db, p: { userId: string; filters?: VaultFilters; limit?: number; request?: RequestContext; route?: string }) {
  const role = await requireVaultReader(db, p.userId);
  const limit = Math.min(Math.max(Math.round(p.limit ?? 200), 1), 1000);
  const filters = Object.fromEntries(Object.entries(p.filters ?? {}).filter(([, v]) => v)) as Record<string, string>;
  // The access is logged first. If it cannot be logged, nothing is returned.
  const { error: logError } = await db.from("audit_log").insert({
    actor_id: p.userId,
    actor_type: role,
    action_type: "audit.vault_accessed",
    entity_type: "audit_log",
    metadata: { via: "app", filters, limit, route: p.route ?? "/admin/audit-vault", ip_address: p.request?.ip ?? null, user_agent: p.request?.userAgent ?? null },
  });
  if (logError) throw new Error("The Audit Vault cannot be read: the access could not be logged.");
  let q = db.from("audit_log").select("*");
  if (filters.action) q = q.eq("action_type", filters.action);
  if (filters.actor) q = q.eq("actor_id", filters.actor);
  if (filters.entity) q = q.eq("entity_id", filters.entity);
  if (filters.from) q = q.gte("created_at", filters.from);
  if (filters.to) q = q.lte("created_at", filters.to);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error("The Audit Vault could not be read.");
  return { role, rows: (data ?? []) as Array<Record<string, any>> };
}

// ---------------------------------------------------------------------------------------------------------
// Chain verification
// ---------------------------------------------------------------------------------------------------------
export interface ChainCheck {
  installed: boolean;
  ok: boolean;
  rowsChecked: number;
  lastSeq: number | null;
  firstBadSeq: number | null;
  reason: string | null;
  verifiedAt: string | null;
}

/** Recomputes the whole chain in the database and keeps the result (a checkpoint). On a break, a critical alert goes to the Compliance Officer. */
export async function verifyChain(db: Db, p: { source: "nightly" | "manual"; actorId?: string | null }): Promise<ChainCheck> {
  const { data, error } = await db.rpc!("record_audit_checkpoint", { _source: p.source });
  if (error) {
    if (/does not exist|schema cache|Could not find/i.test(String(error.message))) return { installed: false, ok: false, rowsChecked: 0, lastSeq: null, firstBadSeq: null, reason: MISSING, verifiedAt: null };
    throw new Error(String(error.message));
  }
  const r = (Array.isArray(data) ? data[0] : data) as Record<string, any> | null;
  if (!r) return { installed: false, ok: false, rowsChecked: 0, lastSeq: null, firstBadSeq: null, reason: MISSING, verifiedAt: null };
  const check: ChainCheck = { installed: true, ok: r.ok === true, rowsChecked: Number(r.rows_checked ?? 0), lastSeq: r.last_seq == null ? null : Number(r.last_seq), firstBadSeq: r.first_bad_seq == null ? null : Number(r.first_bad_seq), reason: r.reason ?? null, verifiedAt: r.verified_at ?? null };
  if (!check.ok) {
    await raiseSuspiciousActivity(db, {
      kind: "chain_break",
      severity: "critical",
      detail: { why: check.reason ?? "The hash chain does not verify", first_bad_seq: check.firstBadSeq, rows_checked: check.rowsChecked },
      dedupeKey: `chain:${check.firstBadSeq ?? "tail"}:${String(check.reason).slice(0, 40)}`,
    });
  }
  await db.from("audit_log").insert({
    actor_id: p.actorId ?? null,
    actor_type: p.actorId ? "admin" : "system",
    action_type: "audit.chain_verified",
    entity_type: "audit_log",
    metadata: { ok: check.ok, rows_checked: check.rowsChecked, last_seq: check.lastSeq, first_bad_seq: check.firstBadSeq, source: p.source },
  });
  return check;
}

// ---------------------------------------------------------------------------------------------------------
// Suspicious Activity Alerts
// ---------------------------------------------------------------------------------------------------------
export interface RaiseParams {
  kind: AlertKind;
  severity?: "high" | "critical";
  table?: string | null;
  pk?: string | null;
  auditRowId?: string | null;
  detail: Record<string, unknown>;
  dedupeKey: string;
}

/** Who is told: the Compliance Officer(s). If none is named, every Manager (an alert must never go to nobody). */
export async function complianceRecipients(db: Db): Promise<string[]> {
  const read = async (role: string) => ((await db.from("user_roles").select("user_id").eq("role", role)).data ?? []) as Array<{ user_id: string }>;
  const officers = [...new Set((await read("compliance_officer")).map((r) => r.user_id))];
  if (officers.length) return officers;
  return [...new Set((await read("admin")).map((r) => r.user_id))];
}

async function emailOf(db: Db, userId: string): Promise<string | null> {
  try {
    const r = await db.auth?.admin?.getUserById?.(userId);
    return r?.data?.user?.email ?? null;
  } catch {
    return null;
  }
}

/** Tells the Compliance Officer: an in-app notification and an email, once per person per alert. */
export async function notifyAlert(db: Db, alert: { id: string; kind: AlertKind; subject_table?: string | null; subject_pk?: string | null; detail: Record<string, unknown> }): Promise<{ notified: number }> {
  const recipients = await complianceRecipients(db);
  const message = sarMessage({ kind: alert.kind, table: alert.subject_table, pk: alert.subject_pk, detail: alert.detail, siteUrl: siteUrl() });
  let notified = 0;
  for (const userId of recipients) {
    const r = await deliver(db as never, { authUserId: userId, email: await emailOf(db, userId) }, { subject: sarSubject(alert.kind, alert.subject_table), message, link: "/audit-vault", type: "suspicious_activity", dedupeKey: `sar:${alert.id}:${userId}` });
    if (r.portal || r.emailed || r.duplicate) notified += 1;
  }
  if (notified > 0) await db.from("suspicious_activity_alerts").update({ notified_at: new Date().toISOString() }).eq("id", alert.id);
  return { notified };
}

/** Records an alert (once per event) and tells the Compliance Officer. Never throws: a fault here must not block the action that raised it. */
export async function raiseSuspiciousActivity(db: Db, p: RaiseParams): Promise<{ raised: boolean; alertId: string | null }> {
  try {
    const { data: existing } = await db.from("suspicious_activity_alerts").select("id").eq("dedupe_key", p.dedupeKey).maybeSingle();
    if (existing) return { raised: false, alertId: (existing as { id: string }).id };
    const { data: row, error } = await db
      .from("suspicious_activity_alerts")
      .insert({ kind: p.kind, severity: p.severity ?? "high", subject_table: p.table ?? null, subject_pk: p.pk ?? null, audit_row_id: p.auditRowId ?? null, detail: p.detail, dedupe_key: p.dedupeKey })
      .select("id")
      .single();
    if (error || !row) return { raised: false, alertId: null };
    const alertId = (row as { id: string }).id;
    await db.from("audit_log").insert({ actor_id: null, actor_type: "system", action_type: "security.suspicious_activity", entity_type: p.table ?? "audit_log", entity_id: p.pk ?? alertId, metadata: { alert_id: alertId, kind: p.kind, severity: p.severity ?? "high", ...p.detail } });
    await notifyAlert(db, { id: alertId, kind: p.kind, subject_table: p.table, subject_pk: p.pk, detail: p.detail });
    return { raised: true, alertId };
  } catch {
    return { raised: false, alertId: null };
  }
}

/**
 * Protected data (commission splits, referral shares, ownership, the cap table) changed through the application with no application record to account for
 * it: someone edited it by some other route. The database already raises its own alert for a change made directly in it; this catches the rest.
 * Safe to run again: an alert is made once per change.
 */
export async function reconcileProtectedChanges(db: Db, p: { now?: Date; lookbackHours?: number } = {}) {
  const now = p.now ?? new Date();
  const since = new Date(now.getTime() - (p.lookbackHours ?? 72) * 3_600_000).toISOString();
  const cutoff = new Date(now.getTime() - RECONCILE_GRACE_MINUTES * 60_000).getTime();
  const { data } = await db.from("audit_log").select("*").gte("created_at", since);
  const rows = (data ?? []) as AuditRowLike[];
  let checked = 0;
  let raised = 0;
  for (const change of rows.filter(isAppProtectedChange)) {
    if (new Date(change.created_at).getTime() > cutoff) continue; // the application's own row may still be on its way
    checked += 1;
    if (accountedFor(change, rows, RECONCILE_WINDOW_MINUTES)) continue;
    const m = change.metadata ?? {};
    const r = await raiseSuspiciousActivity(db, {
      kind: "unreconciled_change",
      severity: "high",
      table: String(m.table),
      pk: String(m.primary_key ?? change.entity_id ?? ""),
      auditRowId: change.id,
      detail: { why: "No application record accounts for this change", operation: m.operation, changed_columns: m.changed_columns, db_role: m.db_role, property_id: m.property_id ?? null, request_role: m.request_role ?? null },
      dedupeKey: `unrec:${change.id}`,
    });
    if (r.raised) raised += 1;
  }
  return { checked, raised };
}

/** Alerts the database raised itself (a direct change to protected data) that nobody has been told about yet. */
export async function notifyPendingAlerts(db: Db): Promise<{ notified: number }> {
  const { data } = await db.from("suspicious_activity_alerts").select("*").is("notified_at", null);
  let notified = 0;
  for (const a of (data ?? []) as Array<{ id: string; kind: AlertKind; subject_table: string | null; subject_pk: string | null; detail: Record<string, unknown> }>) {
    notified += (await notifyAlert(db, a)).notified > 0 ? 1 : 0;
  }
  return { notified };
}

/** The nightly job: verify the chain, look for unaccounted changes, tell the Compliance Officer about anything new. */
export async function runAuditVaultSweep(db: Db, p: { now?: Date } = {}) {
  const chain = await verifyChain(db, { source: "nightly" });
  const reconciled = await reconcileProtectedChanges(db, { now: p.now });
  const pending = await notifyPendingAlerts(db);
  return { chain, reconciled, notified: pending.notified };
}

export async function listAlerts(db: Db, p: { userId: string; request?: RequestContext }) {
  await requireVaultReader(db, p.userId);
  const { data } = await db.from("suspicious_activity_alerts").select("*").order("detected_at", { ascending: false }).limit(200);
  const rows: Array<Record<string, any> & { label: string }> = ((data ?? []) as Array<Record<string, any>>).map((a) => Object.assign({}, a, { label: ALERT_LABELS[a.kind as AlertKind] ?? String(a.kind) }));
  return { alerts: rows };
}

export async function acknowledgeAlert(db: Db, p: { userId: string; alertId: string; note: string; request?: RequestContext }) {
  const role = await requireVaultOfficer(db, p.userId);
  const note = p.note.trim();
  if (note.length < 5) throw new Error("Say what you found and what you did: a note of at least five characters.");
  const { data: alert } = await db.from("suspicious_activity_alerts").select("id, kind, acknowledged_at").eq("id", p.alertId).maybeSingle();
  if (!alert) throw new Error("Alert not found.");
  if ((alert as { acknowledged_at: string | null }).acknowledged_at) return { already: true };
  await db.from("suspicious_activity_alerts").update({ acknowledged_at: new Date().toISOString(), acknowledged_by: p.userId, acknowledgement_note: note.slice(0, 1000) }).eq("id", p.alertId);
  await db.from("audit_log").insert({ actor_id: p.userId, actor_type: role, action_type: "security.alert_acknowledged", entity_type: "suspicious_activity_alert", entity_id: p.alertId, metadata: { kind: (alert as { kind: string }).kind, note: note.slice(0, 1000), ip_address: p.request?.ip ?? null, user_agent: p.request?.userAgent ?? null } });
  return { already: false };
}

export async function vaultStatus(db: Db, p: { userId: string }) {
  await requireVaultReader(db, p.userId);
  const { data: cps } = await db.from("audit_vault_checkpoints").select("*").order("verified_at", { ascending: false }).limit(10);
  const { data: alerts } = await db.from("suspicious_activity_alerts").select("id, acknowledged_at");
  const a = (alerts ?? []) as Array<{ acknowledged_at: string | null }>;
  return { checkpoints: (cps ?? []) as Array<Record<string, any>>, openAlerts: a.filter((x) => !x.acknowledged_at).length, totalAlerts: a.length };
}

// ---------------------------------------------------------------------------------------------------------
// TIN decryption outside the business rules
// ---------------------------------------------------------------------------------------------------------
const DECRYPT_ACTIONS = ["admin.w9_tin_decrypted", "cpa.w9_tin_viewed", "tax_vault.broker_tax_form_tin_viewed", "tax_vault.influencer_payee_tin_viewed"];

/** A person who decrypts an unusual number of TINs in an hour is an alert, even though each one was audited and had a reason. */
export async function checkDecryptBurst(db: Db, p: { actorId: string | null; now?: Date }) {
  if (!p.actorId) return { alerted: false };
  const now = p.now ?? new Date();
  const since = new Date(now.getTime() - DECRYPT_BURST_WINDOW_MINUTES * 60_000).toISOString();
  const { data } = await db.from("audit_log").select("id, action_type").eq("actor_id", p.actorId).gte("created_at", since);
  const n = ((data ?? []) as Array<{ action_type: string }>).filter((r) => DECRYPT_ACTIONS.includes(r.action_type)).length;
  if (n <= DECRYPT_BURST_LIMIT) return { alerted: false };
  const bucket = Math.floor(now.getTime() / (DECRYPT_BURST_WINDOW_MINUTES * 60_000));
  const r = await raiseSuspiciousActivity(db, { kind: "tin_decrypt_burst", severity: "critical", detail: { why: `${n} TINs were decrypted by one person within ${DECRYPT_BURST_WINDOW_MINUTES} minutes (limit ${DECRYPT_BURST_LIMIT})`, actor_id: p.actorId, count: n }, dedupeKey: `burst:${p.actorId}:${bucket}` });
  return { alerted: r.raised };
}

/** A TIN was decrypted by code that did not go through the audited, reasoned path. */
export async function reportDecryptOutsideRules(db: Db, p: { aad: string; now?: Date }) {
  const kind = p.aad.split(":")[0] ?? "unknown";
  const bucket = Math.floor((p.now ?? new Date()).getTime() / 60_000);
  return raiseSuspiciousActivity(db, {
    kind: "tin_decrypt_outside_rules",
    severity: "critical",
    table: kind,
    pk: p.aad.split(":")[1] ?? null,
    detail: { why: "A TIN was decrypted without an audited reason: it did not go through the tax vault, the tax export or the CPA view", record_kind: kind },
    dedupeKey: `decrypt:${p.aad}:${bucket}`,
  });
}
