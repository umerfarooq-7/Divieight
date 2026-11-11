/**
 * Bookkeeping (server side). The database does the real work (bookkeeping.sql): balanced entries, an append-only journal,
 * closed periods, the audit trail. This is the door to it: who may write (the Manager, through the functions only) and who
 * may read (the Manager, an Account Member of that property, its Heavy Lifting Agent without member detail, and later the
 * CPA credential).
 */
import {
  ledgerLineProblem,
  type LedgerActivityRow,
  type LedgerEntryMeta,
  type LedgerLineInput,
  type LedgerRole,
  type TrialBalance,
  type TrialBalanceRow,
} from "@/lib/bookkeeping";

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

const MISSING_SCHEMA = "Database is missing the bookkeeping tables: run bookkeeping.sql in Supabase.";

async function isAdmin(db: Db, userId: string): Promise<boolean> {
  const { data } = await db.rpc("has_role", { _user_id: userId, _role: "admin" });
  return data === true;
}

/** Writing is the Manager's (an admin or the founder), and only through these functions. */
async function requireManager(db: Db, userId: string) {
  if (!(await isAdmin(db, userId))) throw new Error("Only the Manager can post to the ledger.");
}

/**
 * How this person may read this property's ledger, or null for not at all.
 * The CPA credential (a later prompt) joins here as another read-only role.
 */
export async function ledgerRoleFor(db: Db, userId: string, propertyId: string): Promise<LedgerRole | null> {
  if (await isAdmin(db, userId)) return "manager";
  const { holderFor } = await import("@/lib/votes.server");
  if (await holderFor(db, userId, propertyId)) return "member";
  const { data: agent } = await db.from("agents").select("id").eq("auth_user_id", userId).maybeSingle();
  if (agent) {
    const { data: pod } = await db.from("pods").select("heavy_lifting_agent_id, hla_status").eq("property_id", propertyId).maybeSingle();
    if (pod && pod.heavy_lifting_agent_id === agent.id && pod.hla_status === "accepted") return "heavy_lifting_agent";
  }
  return null;
}

async function requireReader(db: Db, userId: string, propertyId: string): Promise<LedgerRole> {
  const role = await ledgerRoleFor(db, userId, propertyId);
  if (!role) throw new Error("Not authorized");
  return role;
}

const lineJson = (l: LedgerLineInput) => ({
  ...(l.accountId ? { account_id: l.accountId } : {}),
  ...(l.code ? { code: l.code } : {}),
  member_id: l.memberId ?? null,
  debit_cents: l.debitCents ?? 0,
  credit_cents: l.creditCents ?? 0,
});

const metaJson = (meta: LedgerEntryMeta, actorId: string, request?: RequestContext) => ({
  entry_date: meta.entryDate,
  source: meta.source,
  source_ref: meta.sourceRef ?? null,
  memo: meta.memo ?? null,
  created_by: actorId,
  is_adjustment: meta.isAdjustment === true,
  adjustment_reason: meta.adjustmentReason ?? null,
  ip_address: request?.ip ?? null,
  user_agent: request?.userAgent ?? null,
});

function fail(error: { message?: string }): never {
  const message = error.message ?? "";
  if (/post_entry|reverse_entry|close_period|trial_balance|account_ledger|does not exist|schema cache/i.test(message) && !/Line \d|unbalanced|period|entry/i.test(message)) throw new Error(MISSING_SCHEMA);
  throw new Error(message || "The ledger refused that.");
}

/** Post an entry. The database checks the balance, the period, the accounts and the members; the audit entry is written with it. */
export async function postLedgerEntry(db: Db, params: { actorId: string; propertyId: string; lines: LedgerLineInput[]; meta: LedgerEntryMeta; request?: RequestContext }): Promise<{ entryId: string }> {
  await requireManager(db, params.actorId);
  const problem = ledgerLineProblem(params.lines);
  if (problem) throw new Error(problem);
  const { data, error } = await db.rpc("post_entry", { _property: params.propertyId, _lines: params.lines.map(lineJson), _meta: metaJson(params.meta, params.actorId, params.request) });
  if (error) fail(error);
  return { entryId: data as string };
}

/** Reverse an entry: a new entry with every line flipped, linked to the one it reverses. Nothing is edited or deleted. */
export async function reverseLedgerEntry(
  db: Db,
  params: { actorId: string; entryId: string; reason: string; entryDate?: string; isAdjustment?: boolean; adjustmentReason?: string | null; request?: RequestContext },
): Promise<{ entryId: string }> {
  await requireManager(db, params.actorId);
  if (!params.reason.trim()) throw new Error("Say why this entry is being reversed.");
  const { data, error } = await db.rpc("reverse_entry", {
    _entry: params.entryId,
    _reason: params.reason,
    _meta: { created_by: params.actorId, entry_date: params.entryDate, is_adjustment: params.isAdjustment === true, adjustment_reason: params.adjustmentReason ?? null, ip_address: params.request?.ip ?? null, user_agent: params.request?.userAgent ?? null },
  });
  if (error) fail(error);
  return { entryId: data as string };
}

export async function closeLedgerPeriod(db: Db, params: { actorId: string; propertyId: string; year: number; month: number; request?: RequestContext }): Promise<void> {
  await requireManager(db, params.actorId);
  const { error } = await db.rpc("close_period", { _property: params.propertyId, _year: params.year, _month: params.month, _by: params.actorId, _meta: { ip_address: params.request?.ip ?? null, user_agent: params.request?.userAgent ?? null } });
  if (error) fail(error);
}

/** A chart revision is a new version. Older entries keep the version they were posted on. */
export async function reviseChart(db: Db, params: { actorId: string; notes: string; effectiveFrom?: string; changes?: Array<Record<string, unknown>> }): Promise<{ versionId: string }> {
  await requireManager(db, params.actorId);
  if (!params.notes.trim()) throw new Error("Say what changed in this chart revision.");
  const { data, error } = await db.rpc("create_coa_version", { _notes: params.notes, _effective_from: params.effectiveFrom ?? new Date().toISOString().slice(0, 10), _changes: params.changes ?? [] });
  if (error) fail(error);
  await db.from("audit_log").insert({ actor_id: params.actorId, actor_type: "admin", action_type: "ledger.chart_revised", entity_type: "coa_version", entity_id: data as string, metadata: { notes: params.notes, effective_from: params.effectiveFrom ?? null, changes: params.changes ?? [], at: new Date().toISOString() } });
  return { versionId: data as string };
}

/** Everyone who can read a ledger can read the chart. */
export async function chartOfAccounts(db: Db) {
  const { data: versions } = await db.from("coa_versions").select("id, version, effective_from, notes");
  const latest = ((versions ?? []) as Array<{ id: string; version: number; effective_from: string; notes: string | null }>).sort((a, b) => b.version - a.version)[0];
  if (!latest) throw new Error(MISSING_SCHEMA);
  const { data: accounts } = await db.from("coa_accounts").select("id, code, name, type, normal_balance, is_member_control, active").eq("version_id", latest.id);
  const rows = ((accounts ?? []) as Array<{ id: string; code: string; name: string; type: string; normal_balance: string; is_member_control: boolean; active: boolean }>).sort((a, b) => a.code.localeCompare(b.code));
  return { version: latest.version, effectiveFrom: latest.effective_from, accounts: rows.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, normalBalance: a.normal_balance, isMemberControl: a.is_member_control, active: a.active })) };
}

/** "Member 1", "Member 2": stable within one response, naming nobody. */
function memberLabels(ids: Array<string | null>): (id: string | null) => string | null {
  const order = [...new Set(ids.filter((i): i is string => Boolean(i)))].sort();
  return (id) => (id ? `Member ${order.indexOf(id) + 1}` : null);
}

export async function ledgerTrialBalance(db: Db, params: { userId: string; propertyId: string; asOf?: string }): Promise<TrialBalance & { role: LedgerRole }> {
  const role = await requireReader(db, params.userId, params.propertyId);
  const asOf = params.asOf ?? new Date().toISOString().slice(0, 10);
  const { data, error } = await db.rpc("trial_balance", { _property: params.propertyId, _as_of: asOf });
  if (error) fail(error);
  const raw = (data ?? []) as Array<{ account_id: string; coa_version: number; code: string; name: string; type: TrialBalanceRow["type"]; normal_balance: TrialBalanceRow["normalBalance"]; member_id: string | null; debit_cents: number | string; credit_cents: number | string; balance_cents: number | string }>;
  const label = role === "heavy_lifting_agent" ? memberLabels(raw.map((r) => r.member_id)) : (id: string | null) => id;
  const rows: TrialBalanceRow[] = raw.map((r) => ({ accountId: r.account_id, coaVersion: r.coa_version, code: r.code, name: r.name, type: r.type, normalBalance: r.normal_balance, member: label(r.member_id), debitCents: Number(r.debit_cents), creditCents: Number(r.credit_cents), balanceCents: Number(r.balance_cents) }));
  const totalDebitCents = rows.reduce((s, r) => s + r.debitCents, 0);
  const totalCreditCents = rows.reduce((s, r) => s + r.creditCents, 0);
  return { asOf, rows, totalDebitCents, totalCreditCents, balanced: totalDebitCents === totalCreditCents, role };
}

export async function ledgerAccountActivity(db: Db, params: { userId: string; propertyId: string; accountId: string; from?: string; to?: string }): Promise<{ role: LedgerRole; rows: LedgerActivityRow[] }> {
  const role = await requireReader(db, params.userId, params.propertyId);
  const { data, error } = await db.rpc("account_ledger", { _property: params.propertyId, _account: params.accountId, _from: params.from ?? null, _to: params.to ?? null });
  if (error) fail(error);
  const raw = (data ?? []) as Array<{ entry_id: string; entry_date: string; posted_at: string; source: string; source_ref: string | null; memo: string | null; reverses_entry_id: string | null; member_id: string | null; debit_cents: number | string; credit_cents: number | string; running_balance_cents: number | string }>;
  const label = role === "heavy_lifting_agent" ? memberLabels(raw.map((r) => r.member_id)) : (id: string | null) => id;
  return {
    role,
    rows: raw.map((r) => ({
      entryId: r.entry_id,
      entryDate: r.entry_date,
      postedAt: r.posted_at,
      source: r.source,
      sourceRef: r.source_ref,
      // A Heavy Lifting Agent sees the amounts and the account, not the memo (it can carry a member's name).
      memo: role === "heavy_lifting_agent" ? null : r.memo,
      reversesEntryId: r.reverses_entry_id,
      member: label(r.member_id),
      debitCents: Number(r.debit_cents),
      creditCents: Number(r.credit_cents),
      runningBalanceCents: Number(r.running_balance_cents),
    })),
  };
}
