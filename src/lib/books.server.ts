/**
 * The Manager's working screens for the books (server side). The database does the real work (books.sql): every change is a
 * new entry, nothing is edited in place. This is the door to it: the Manager (admin or founder) does everything; the pod's
 * Heavy Lifting Agent gets a read-only coordination view with nothing personal in it.
 */
import { ledgerRoleFor, ledgerTrialBalance } from "@/lib/bookkeeping.server";
import { openInquiryCount } from "@/lib/inquiries.server";
import type { BankReconciliationRow } from "@/lib/bank-feed";

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any; storage?: any };

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

const MISSING = "Database is missing the books tables: run books.sql in Supabase.";
function fail(error: { message?: string }): never {
  const m = error.message ?? "";
  if (/does not exist|schema cache|Could not find/i.test(m) && /post_bank_transaction|ignore_bank_transaction|post_manual_entry|recategorize_entry|capitalize_entry|recurring|reopen_period|categorization|suggest_bank_account|entry_corrections|ledger_attachments/i.test(m)) throw new Error(MISSING);
  throw new Error(m || "The books refused that.");
}

async function requireManager(db: Db, userId: string) {
  const { data } = await db.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (data !== true) throw new Error("Only the Manager can do that.");
}

const meta = (request?: RequestContext, extra: Record<string, unknown> = {}) => ({ ip_address: request?.ip ?? null, user_agent: request?.userAgent ?? null, ...extra });
const adjustmentMeta = (p: { entryDate?: string; isAdjustment?: boolean; adjustmentReason?: string | null }, request?: RequestContext) =>
  meta(request, { entry_date: p.entryDate, is_adjustment: p.isAdjustment === true, adjustment_reason: p.adjustmentReason ?? null });

async function call<T>(db: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) fail(error);
  return data as T;
}

// ---------------------------------------------------------------------------------------------------------
// The Manager's actions
// ---------------------------------------------------------------------------------------------------------
export interface Split {
  code: string;
  cents: number;
}

export async function postBankTransaction(db: Db, p: { actorId: string; transactionId: string; splits: Split[]; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  const entryId = await call<string>(db, "post_bank_transaction", { _txn: p.transactionId, _splits: p.splits.map((s) => ({ code: s.code, cents: s.cents })), _actor: p.actorId, _meta: meta(p.request) });
  return { entryId };
}

export async function ignoreBankTransaction(db: Db, p: { actorId: string; transactionId: string; reason: string; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  await call(db, "ignore_bank_transaction", { _txn: p.transactionId, _reason: p.reason, _actor: p.actorId, _meta: meta(p.request) });
}

export async function postManualEntry(
  db: Db,
  p: { actorId: string; propertyId: string; date: string; amountCents: number; direction: "in" | "out"; accountCode: string; memo: string; attachment?: { path: string; fileName: string; contentType: string | null } | null; isAdjustment?: boolean; adjustmentReason?: string | null; request?: RequestContext },
) {
  await requireManager(db, p.actorId);
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) throw new Error("The amount is a whole number of cents above zero.");
  const entryId = await call<string>(db, "post_manual_entry", {
    _property: p.propertyId,
    _date: p.date,
    _amount_cents: p.amountCents,
    _direction: p.direction,
    _account_code: p.accountCode,
    _memo: p.memo,
    _attachment: p.attachment ? { path: p.attachment.path, file_name: p.attachment.fileName, content_type: p.attachment.contentType } : null,
    _actor: p.actorId,
    _meta: adjustmentMeta(p, p.request),
  });
  return { entryId };
}

export interface CorrectionResult {
  reversalEntryId: string;
  correctedEntryId: string;
}
const corrected = (r: { reversal_entry_id: string; corrected_entry_id: string }): CorrectionResult => ({ reversalEntryId: r.reversal_entry_id, correctedEntryId: r.corrected_entry_id });

/** Recategorize: a reversing entry plus a corrected one. mapping is { journal line id: new account code }. */
export async function recategorizeEntry(db: Db, p: { actorId: string; entryId: string; mapping: Record<string, string>; reason: string; entryDate?: string; isAdjustment?: boolean; adjustmentReason?: string | null; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  if (!p.reason.trim()) throw new Error("Say why this entry is being corrected.");
  return corrected(await call(db, "recategorize_entry", { _entry: p.entryId, _mapping: p.mapping, _reason: p.reason, _actor: p.actorId, _meta: adjustmentMeta(p, p.request) }));
}

/** Capitalize an expense: reverse it and post it to Furnishings and Capital Improvements. */
export async function capitalizeEntry(db: Db, p: { actorId: string; entryId: string; reason: string; entryDate?: string; isAdjustment?: boolean; adjustmentReason?: string | null; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  if (!p.reason.trim()) throw new Error("Say why this expense is being capitalized.");
  return corrected(await call(db, "capitalize_entry", { _entry: p.entryId, _reason: p.reason, _actor: p.actorId, _meta: adjustmentMeta(p, p.request) }));
}

export async function createRecurringRule(db: Db, p: { actorId: string; propertyId: string; description: string; amountCents: number; accountCode: string; frequency: "weekly" | "monthly" | "quarterly" | "annually"; firstRun: string; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) throw new Error("The amount is a whole number of cents above zero.");
  return { ruleId: await call<string>(db, "create_recurring_rule", { _property: p.propertyId, _description: p.description, _amount_cents: p.amountCents, _account_code: p.accountCode, _frequency: p.frequency, _first_run: p.firstRun, _actor: p.actorId, _meta: meta(p.request) }) };
}

export async function setRecurringRuleActive(db: Db, p: { actorId: string; ruleId: string; active: boolean; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  await call(db, "set_recurring_rule_active", { _rule: p.ruleId, _active: p.active, _actor: p.actorId, _meta: meta(p.request) });
}

/** The scheduled job (and a "run now" for one property). Posts each due date once and logs every application. */
export async function applyDueRecurring(db: Db, p: { asOf?: string; actorId?: string | null; propertyId?: string }) {
  if (p.actorId) await requireManager(db, p.actorId);
  const r = await call<{ posted: number; failed: number; already_applied: number; as_of: string }>(db, "apply_due_recurring", { _as_of: p.asOf ?? new Date().toISOString().slice(0, 10), _actor: p.actorId ?? null, _property: p.propertyId ?? null });
  return { posted: Number(r.posted), failed: Number(r.failed), alreadyApplied: Number(r.already_applied), asOf: r.as_of };
}

export async function saveCategorizationRule(db: Db, p: { actorId: string; propertyId: string | null; matchType: "merchant" | "keyword" | "amount_range"; pattern: string; accountCode: string; priority?: number; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  return { ruleId: await call<string>(db, "save_categorization_rule", { _property: p.propertyId, _match_type: p.matchType, _pattern: p.pattern, _account_code: p.accountCode, _priority: p.priority ?? 100, _actor: p.actorId, _meta: meta(p.request) }) };
}

export async function setCategorizationRuleActive(db: Db, p: { actorId: string; ruleId: string; active: boolean; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  await call(db, "set_categorization_rule_active", { _rule: p.ruleId, _active: p.active, _actor: p.actorId, _meta: meta(p.request) });
}

export async function applyRulesToNeedsReview(db: Db, p: { actorId: string; propertyId: string; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  const r = await call<{ posted: number; still_needs_review: number }>(db, "apply_rules_to_needs_review", { _property: p.propertyId, _actor: p.actorId, _meta: meta(p.request) });
  return { posted: Number(r.posted), stillNeedsReview: Number(r.still_needs_review) };
}

export async function reopenPeriod(db: Db, p: { actorId: string; propertyId: string; year: number; month: number; reason: string; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  if (!p.reason.trim()) throw new Error("Say why this period is being reopened.");
  await call(db, "reopen_period", { _property: p.propertyId, _year: p.year, _month: p.month, _by: p.actorId, _reason: p.reason, _meta: meta(p.request) });
}

/** A receipt is under this property's folder in the private bucket; a short-lived link to open it. */
export async function receiptLink(db: Db, p: { userId: string; propertyId: string; attachmentId: string }): Promise<string> {
  await requireManager(db, p.userId);
  const { data } = await db.from("ledger_attachments").select("storage_path").eq("id", p.attachmentId).eq("property_id", p.propertyId).maybeSingle();
  if (!data) throw new Error("Receipt not found.");
  const { data: signed } = await db.storage.from("ledger-receipts").createSignedUrl(data.storage_path, 600);
  if (!signed?.signedUrl) throw new Error("Could not open the receipt.");
  return signed.signedUrl as string;
}

// ---------------------------------------------------------------------------------------------------------
// The screens' data
// ---------------------------------------------------------------------------------------------------------
export interface ReviewItem {
  id: string;
  postedDate: string;
  amountCents: number;
  direction: "in" | "out";
  merchantName: string | null;
  description: string | null;
  reason: string | null;
  suggestion: { code: string; name: string } | null;
}
export interface BookAccount {
  code: string;
  name: string;
  type: string;
}
export interface BookEntry {
  id: string;
  date: string;
  source: string;
  memo: string | null;
  reason: string | null;
  isReversal: boolean;
  reversed: boolean;
  isAdjustment: boolean;
  correction: { kind: string; reason: string } | null;
  receipts: Array<{ id: string; fileName: string }>;
  lines: Array<{ id: string; code: string; name: string; type: string; debitCents: number; creditCents: number; memberId: string | null }>;
}
export interface BooksOverview {
  property: { id: string; label: string };
  review: ReviewItem[];
  accounts: BookAccount[];
  entries: BookEntry[];
  recurring: Array<{ id: string; description: string; amountCents: number; accountCode: string; frequency: string; nextRun: string; active: boolean; lastStatus: string | null }>;
  rules: Array<{ id: string; propertyId: string | null; matchType: string; pattern: string; accountCode: string; priority: number; active: boolean }>;
  periods: Array<{ year: number; month: number; status: string }>;
  periodHistory: Array<{ year: number; month: number; action: string; reason: string | null; at: string }>;
  reconciliation: BankReconciliationRow | null;
  /** Co-owner inquiries still waiting (open or answered but not settled). */
  openInquiries: number;
}

type Row = Record<string, any>;

export async function booksOverview(db: Db, p: { userId: string; propertyId: string }): Promise<BooksOverview> {
  await requireManager(db, p.userId);
  const { data: prop } = await db.from("properties").select("id, address, city, state").eq("id", p.propertyId).maybeSingle();
  if (!prop) throw new Error("Property not found");
  const { data: versions } = await db.from("coa_versions").select("id, version");
  const latest = ((versions ?? []) as Row[]).sort((a, b) => b.version - a.version)[0];
  const { data: accountRows } = latest ? await db.from("coa_accounts").select("id, code, name, type, is_member_control, active, version_id").eq("version_id", latest.id) : { data: [] };
  const accounts = ((accountRows ?? []) as Row[]).filter((a) => a.active && !a.is_member_control).sort((a, b) => a.code.localeCompare(b.code)).map((a) => ({ code: a.code as string, name: a.name as string, type: a.type as string }));

  const { data: reviewRows } = await db.from("bank_transactions").select("id, posted_date, amount_cents, direction, merchant_name, description, review_reason, status").eq("property_id", p.propertyId).eq("status", "needs_review").order("posted_date", { ascending: false });
  const review: ReviewItem[] = [];
  for (const t of (reviewRows ?? []) as Row[]) {
    const { data: sug } = await db.rpc("suggest_bank_account", { _txn: t.id });
    const s = Array.isArray(sug) ? sug[0] : sug;
    review.push({ id: t.id, postedDate: t.posted_date, amountCents: Number(t.amount_cents), direction: t.direction, merchantName: t.merchant_name ?? null, description: t.description ?? null, reason: t.review_reason ?? null, suggestion: s?.code ? { code: s.code, name: s.name } : null });
  }

  const { data: entryRows } = await db.from("journal_entries").select("id, entry_date, source, memo, reverses_entry_id, reversal_reason, is_adjustment, posted_at").eq("property_id", p.propertyId).order("posted_at", { ascending: false }).limit(80);
  const entries = (entryRows ?? []) as Row[];
  const ids = entries.map((e) => e.id as string);
  const { data: lineRows } = ids.length ? await db.from("journal_lines").select("id, entry_id, account_id, member_id, debit_cents, credit_cents").in("entry_id", ids) : { data: [] };
  const accountIds = [...new Set(((lineRows ?? []) as Row[]).map((l) => l.account_id as string))];
  const { data: acctRows } = accountIds.length ? await db.from("coa_accounts").select("id, code, name, type").in("id", accountIds) : { data: [] };
  const acctBy = new Map(((acctRows ?? []) as Row[]).map((a) => [a.id as string, a]));
  const { data: reversals } = ids.length ? await db.from("journal_entries").select("reverses_entry_id").in("reverses_entry_id", ids) : { data: [] };
  const reversedSet = new Set(((reversals ?? []) as Row[]).map((r) => r.reverses_entry_id as string));
  const { data: corrections } = await db.from("entry_corrections").select("original_entry_id, kind, reason").eq("property_id", p.propertyId);
  const correctionBy = new Map(((corrections ?? []) as Row[]).map((c) => [c.original_entry_id as string, { kind: c.kind as string, reason: c.reason as string }]));
  const { data: attachRows } = await db.from("ledger_attachments").select("id, entry_id, file_name").eq("property_id", p.propertyId);
  const bookEntries: BookEntry[] = entries.map((e) => ({
    id: e.id,
    date: e.entry_date,
    source: e.source,
    memo: e.memo ?? null,
    reason: e.reversal_reason ?? null,
    isReversal: Boolean(e.reverses_entry_id),
    reversed: reversedSet.has(e.id),
    isAdjustment: e.is_adjustment === true,
    correction: correctionBy.get(e.id) ?? null,
    receipts: ((attachRows ?? []) as Row[]).filter((a) => a.entry_id === e.id).map((a) => ({ id: a.id as string, fileName: a.file_name as string })),
    lines: ((lineRows ?? []) as Row[])
      .filter((l) => l.entry_id === e.id)
      .map((l) => {
        const a = acctBy.get(l.account_id);
        return { id: l.id as string, code: (a?.code ?? "") as string, name: (a?.name ?? "") as string, type: (a?.type ?? "") as string, debitCents: Number(l.debit_cents), creditCents: Number(l.credit_cents), memberId: (l.member_id ?? null) as string | null };
      }),
  }));

  const { data: ruleRows } = await db.from("recurring_rules").select("id, description, amount_cents, coa_account_id, frequency, next_run, active").eq("property_id", p.propertyId);
  const { data: appRows } = await db.from("recurring_applications").select("rule_id, status, run_date").eq("property_id", p.propertyId).order("run_date", { ascending: false });
  const { data: recAcct } = await db.from("coa_accounts").select("id, code");
  const codeBy = new Map(((recAcct ?? []) as Row[]).map((a) => [a.id as string, a.code as string]));
  const recurring = ((ruleRows ?? []) as Row[]).map((r) => ({ id: r.id as string, description: r.description as string, amountCents: Number(r.amount_cents), accountCode: codeBy.get(r.coa_account_id) ?? "", frequency: r.frequency as string, nextRun: r.next_run as string, active: r.active === true, lastStatus: (((appRows ?? []) as Row[]).find((a) => a.rule_id === r.id)?.status ?? null) as string | null }));

  const { data: catRules } = await db.from("categorization_rules").select("id, property_id, match_type, pattern, coa_account_id, priority, active");
  const rules = ((catRules ?? []) as Row[])
    .filter((r) => r.property_id === null || r.property_id === undefined || r.property_id === p.propertyId)
    .map((r) => ({ id: r.id as string, propertyId: (r.property_id ?? null) as string | null, matchType: r.match_type as string, pattern: r.pattern as string, accountCode: codeBy.get(r.coa_account_id) ?? "", priority: Number(r.priority), active: r.active === true }))
    .sort((a, b) => a.priority - b.priority);

  const { data: periodRows } = await db.from("accounting_periods").select("year, month, status").eq("property_id", p.propertyId);
  const { data: historyRows } = await db.from("accounting_period_events").select("year, month, action, reason, at").eq("property_id", p.propertyId).order("at", { ascending: false });
  const { data: recon } = await db.from("bank_reconciliation").select("*").eq("property_id", p.propertyId).maybeSingle();

  return {
    openInquiries: await openInquiryCount(db, p.propertyId),
    property: { id: prop.id, label: [prop.address, prop.city, prop.state].filter(Boolean).join(", ") },
    review,
    accounts,
    entries: bookEntries,
    recurring,
    rules,
    periods: ((periodRows ?? []) as Row[]).map((r) => ({ year: Number(r.year), month: Number(r.month), status: r.status as string })).sort((a, b) => b.year * 12 + b.month - (a.year * 12 + a.month)),
    periodHistory: ((historyRows ?? []) as Row[]).map((r) => ({ year: Number(r.year), month: Number(r.month), action: r.action as string, reason: (r.reason ?? null) as string | null, at: r.at as string })),
    reconciliation: recon
      ? { propertyId: p.propertyId, bankBalanceCents: recon.bank_balance_cents == null ? null : Number(recon.bank_balance_cents), ledgerCashCents: Number(recon.ledger_cash_cents), differenceCents: recon.difference_cents == null ? null : Number(recon.difference_cents), unmatchedCount: Number(recon.unmatched_count), unmatchedInCents: Number(recon.unmatched_in_cents), unmatchedOutCents: Number(recon.unmatched_out_cents), needsReviewCount: Number(recon.needs_review_count), pendingCount: Number(recon.pending_count), unreconciledCents: recon.unreconciled_cents == null ? null : Number(recon.unreconciled_cents), lastIngestedThrough: recon.last_ingested_through ?? null }
      : null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The Heavy Lifting Agent's coordination view: read-only, property level, nothing personal
// ---------------------------------------------------------------------------------------------------------
export interface HlaBooksView {
  trial: Array<{ code: string; name: string; type: string; balanceCents: number }>;
  totals: { debitCents: number; creditCents: number; balanced: boolean };
  entries: Array<{ date: string; source: string; reversal: boolean; lines: Array<{ account: string; debitCents: number; creditCents: number }> }>;
  needsReviewCount: number;
  pendingBankCount: number;
  closedPeriods: Array<{ year: number; month: number }>;
  openRecurring: number;
}

/**
 * What the pod's Heavy Lifting Agent sees. Account balances and entry amounts, by account: no member names or ids, no
 * per-member capital balances (member accounts are rolled into one line), no memos, no merchants, no receipts, no
 * bank descriptions. The Manager is sent to the full screen instead.
 */
export async function hlaBooksView(db: Db, p: { userId: string; propertyId: string }): Promise<HlaBooksView> {
  const role = await ledgerRoleFor(db, p.userId, p.propertyId);
  if (role !== "heavy_lifting_agent") throw new Error("Not authorized");
  const tb = await ledgerTrialBalance(db, { userId: p.userId, propertyId: p.propertyId });
  const merged = new Map<string, { code: string; name: string; type: string; balanceCents: number }>();
  for (const r of tb.rows) {
    const key = r.member === null ? `${r.code}` : `${r.code}:members`;
    const cur = merged.get(key);
    const name = r.member === null ? r.name : `${r.name} (all members)`;
    if (cur) cur.balanceCents += r.balanceCents;
    else merged.set(key, { code: r.code, name, type: r.type, balanceCents: r.balanceCents });
  }
  const { data: entryRows } = await db.from("journal_entries").select("id, entry_date, source, reverses_entry_id, posted_at").eq("property_id", p.propertyId).order("posted_at", { ascending: false }).limit(50);
  const entries = (entryRows ?? []) as Row[];
  const ids = entries.map((e) => e.id as string);
  const { data: lineRows } = ids.length ? await db.from("journal_lines").select("entry_id, account_id, debit_cents, credit_cents").in("entry_id", ids) : { data: [] };
  const accountIds = [...new Set(((lineRows ?? []) as Row[]).map((l) => l.account_id as string))];
  const { data: acctRows } = accountIds.length ? await db.from("coa_accounts").select("id, code, name, is_member_control").in("id", accountIds) : { data: [] };
  const acctBy = new Map(((acctRows ?? []) as Row[]).map((a) => [a.id as string, a]));
  const { data: review } = await db.from("bank_transactions").select("id").eq("property_id", p.propertyId).eq("status", "needs_review");
  const { data: pending } = await db.from("bank_transactions").select("id").eq("property_id", p.propertyId).eq("is_pending", true);
  const { data: periods } = await db.from("accounting_periods").select("year, month, status").eq("property_id", p.propertyId).eq("status", "closed");
  const { data: rec } = await db.from("recurring_rules").select("id").eq("property_id", p.propertyId).eq("active", true);
  return {
    trial: [...merged.values()].sort((a, b) => a.code.localeCompare(b.code)),
    totals: { debitCents: tb.totalDebitCents, creditCents: tb.totalCreditCents, balanced: tb.balanced },
    entries: entries.map((e) => ({
      date: e.entry_date as string,
      source: e.source as string,
      reversal: Boolean(e.reverses_entry_id),
      lines: ((lineRows ?? []) as Row[])
        .filter((l) => l.entry_id === e.id)
        .map((l) => {
          const a = acctBy.get(l.account_id);
          return { account: a?.is_member_control ? "Member capital (all members)" : `${a?.code ?? ""} ${a?.name ?? ""}`.trim(), debitCents: Number(l.debit_cents), creditCents: Number(l.credit_cents) };
        }),
    })),
    needsReviewCount: ((review ?? []) as Row[]).length,
    pendingBankCount: ((pending ?? []) as Row[]).length,
    closedPeriods: ((periods ?? []) as Row[]).map((r) => ({ year: Number(r.year), month: Number(r.month) })),
    openRecurring: ((rec ?? []) as Row[]).length,
  };
}
