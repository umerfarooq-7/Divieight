/**
 * Audit Vault: the rules that do not need a database. What counts as sensitive (mirrors audit_key_is_sensitive in audit-vault.sql), the canonical form a row's
 * hash is taken over (mirrors audit_canonical_json), the tests that tell an application change from an out-of-band one, and the alert wording.
 */
import { PROTECTED_TABLES } from "@/lib/audit-inventory";

// ---------------------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------------------
const SENSITIVE = /(^|_)(tin|ssn|ein|itin|password|passcode|secret|token|ciphertext|auth_tag|iv|answers?|declaration_answers|account_number|routing_number|bank_account|card_number|cvv|date_of_birth|dob)($|_)/i;
const DESCRIBES = /(last4|last_4|_kind|_type|_present|_hash|_masked|_mask|_status|_version|_method|_id|_ids|_count)$/i;
const SSN_OR_EIN = /^\d{3}-\d{2}-\d{4}$|^\d{2}-\d{7}$/;
export const REDACTED = "[redacted]";

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE.test(key) && !DESCRIBES.test(key);
}

/** The payload as the database stores it: sensitive keys and SSN/EIN-shaped values replaced. A TIN, a bank number or an answer never reaches the log. */
export function redactPayload<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactPayload(v)) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, isSensitiveKey(k) ? REDACTED : redactPayload(v)])) as T;
  }
  if (typeof value === "string" && SSN_OR_EIN.test(value)) return REDACTED as unknown as T;
  return value;
}

/** Paths in a payload that hold something sensitive in plain text (a sensitive key with a real value, or an SSN/EIN-shaped string). */
export function findSensitive(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findSensitive(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => (isSensitiveKey(k) ? (v === REDACTED || v == null ? [] : [`${path}.${k}`]) : findSensitive(v, `${path}.${k}`)));
  }
  return typeof value === "string" && SSN_OR_EIN.test(value) ? [path || "."] : [];
}

/** Sorted keys, no spaces: the same text however the JSON was written. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------------------------------------
// Suspicious activity
// ---------------------------------------------------------------------------------------------------------
export type AlertKind = "out_of_band_change" | "unreconciled_change" | "tin_decrypt_outside_rules" | "tin_decrypt_burst" | "chain_break";
export const ALERT_LABELS: Record<AlertKind, string> = {
  out_of_band_change: "Protected data changed directly in the database",
  unreconciled_change: "Protected data changed with no matching application record",
  tin_decrypt_outside_rules: "A TIN was decrypted outside the business rules",
  tin_decrypt_burst: "An unusual number of TINs decrypted in an hour",
  chain_break: "The Audit Vault hash chain is broken",
};

/** How far from a data change an application audit row may be and still account for it, and how long we wait for that row before calling a change unreconciled. */
export const RECONCILE_WINDOW_MINUTES = 15;
export const RECONCILE_GRACE_MINUTES = 15;
/** More TIN decryptions than this by one person in an hour is an alert (a year-end packet decrypts a handful, never fifty). */
export const DECRYPT_BURST_LIMIT = 50;
export const DECRYPT_BURST_WINDOW_MINUTES = 60;

export interface AuditRowLike {
  id: string;
  action_type: string;
  entity_type?: string | null;
  entity_id?: string | null;
  created_at: string;
  metadata?: Record<string, any> | null;
  source?: string | null;
}

/** A row the database wrote about a protected table, made through the application (not directly in the database). */
export const isAppProtectedChange = (r: AuditRowLike) =>
  r.action_type === "db.row_changed" && r.metadata?.protected === true && r.metadata?.direct_database_change === false && !!PROTECTED_TABLES[String(r.metadata?.table)];

/** Is there an application audit row that accounts for this protected change? Right kind of action for that table, close in time, about the same property or record. */
export function accountedFor(change: AuditRowLike, rows: AuditRowLike[], windowMinutes = RECONCILE_WINDOW_MINUTES): boolean {
  const table = String(change.metadata?.table);
  const spec = PROTECTED_TABLES[table];
  if (!spec) return true;
  const at = new Date(change.created_at).getTime();
  const property = change.metadata?.property_id ?? null;
  const pk = change.metadata?.primary_key ?? change.entity_id ?? null;
  return rows.some((r) => {
    if (r.action_type === "db.row_changed" || r.action_type.startsWith("audit.") || r.action_type.startsWith("security.")) return false;
    if (!spec.allowedPrefixes.some((p) => r.action_type.startsWith(p))) return false;
    if (Math.abs(new Date(r.created_at).getTime() - at) > windowMinutes * 60_000) return false;
    // Same property or record when both say which; a change that names neither is accounted for by the action alone.
    const mentions = [r.entity_id, r.metadata?.property_id, r.metadata?.propertyId, r.metadata?.entity_id].filter(Boolean).map(String);
    const wants = [property, pk].filter(Boolean).map(String);
    return wants.length === 0 || mentions.length === 0 || mentions.some((m) => wants.includes(m));
  });
}

export const sarSubject = (kind: AlertKind, table?: string | null) => `Suspicious Activity Alert: ${ALERT_LABELS[kind]}${table ? ` (${table})` : ""}`;
export function sarMessage(p: { kind: AlertKind; table?: string | null; pk?: string | null; detail: Record<string, unknown>; siteUrl: string }): string {
  const parts = [`${ALERT_LABELS[p.kind]}.`];
  if (p.table) parts.push(`Table: ${p.table}${p.pk ? `, record ${String(p.pk).slice(0, 8)}` : ""}.`);
  const d = p.detail;
  if (d.why) parts.push(String(d.why) + ".");
  if (d.operation) parts.push(`Operation: ${String(d.operation)}.`);
  if (Array.isArray(d.changed_columns) && d.changed_columns.length) parts.push(`Columns: ${(d.changed_columns as string[]).join(", ")}.`);
  if (d.db_role) parts.push(`Database role: ${String(d.db_role)}.`);
  parts.push(`Review it in the Audit Vault: ${p.siteUrl}/audit-vault`);
  return parts.join(" ");
}
