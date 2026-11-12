/**
 * The bank feed (server side). The database does the real work (bank-feed.sql): consent, idempotent upsert, rules, posting.
 * This is the door to it and the daily job: who may link an account (the Manager), and a run that pulls, upserts,
 * categorizes and is logged in the Audit Vault every time.
 */
import { decryptBankItemRef, encryptPii, type EncryptedValue } from "@/lib/pii-crypto.server";
import type { BankFeedAdapter, BankReconciliationRow } from "@/lib/bank-feed";

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

const MISSING = "Database is missing the bank feed tables: run bank-feed.sql in Supabase.";
const fail = (error: { message?: string }): never => {
  const m = error.message ?? "";
  if (/does not exist|schema cache|Could not find/i.test(m) && /bank|consent|categoriz|plaid/i.test(m)) throw new Error(MISSING);
  throw new Error(m || "The bank feed refused that.");
};

async function requireManager(db: Db, userId: string) {
  const { data } = await db.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (data !== true) throw new Error("Only the Manager can do that.");
}

const aad = (propertyId: string) => `llc_plaid:${propertyId}`;

/** The Manager links an LLC's operating account. This is divieight, LLC's consent as Manager, not a buyer's Block 1. */
export async function linkOperatingAccount(db: Db, adapter: BankFeedAdapter, params: { actorId: string; propertyId: string; request?: RequestContext }): Promise<{ consentId: string; institutionName: string; accountMask: string }> {
  await requireManager(db, params.actorId);
  const { data: existing } = await db.from("llc_plaid_consents").select("id").eq("property_id", params.propertyId).eq("status", "active").maybeSingle();
  if (existing) throw new Error("This LLC already has an operating account linked. Revoke it first.");
  const linked = await adapter.link({ propertyId: params.propertyId });
  const encrypted: EncryptedValue = encryptPii(linked.itemRef, aad(params.propertyId));
  const { data, error } = await db.rpc("grant_llc_plaid_consent", {
    _property: params.propertyId,
    _actor: params.actorId,
    _item: { plaid_item_ref: encrypted, institution_name: linked.institutionName, account_mask: linked.accountMask, provider: adapter.provider, scope: "transactions:read" },
    _meta: { ip_address: params.request?.ip ?? null, user_agent: params.request?.userAgent ?? null },
  });
  if (error) fail(error);
  return { consentId: data as string, institutionName: linked.institutionName, accountMask: linked.accountMask };
}

/** Revoking stops ingestion at once: the database refuses new transactions for an LLC with no active consent. */
export async function revokeOperatingAccount(db: Db, params: { actorId: string; propertyId: string; request?: RequestContext }): Promise<void> {
  await requireManager(db, params.actorId);
  const { data: consent } = await db.from("llc_plaid_consents").select("id").eq("property_id", params.propertyId).eq("status", "active").maybeSingle();
  if (!consent) throw new Error("This LLC has no operating account linked.");
  const { error } = await db.rpc("revoke_llc_plaid_consent", { _consent: consent.id, _actor: params.actorId, _meta: { ip_address: params.request?.ip ?? null, user_agent: params.request?.userAgent ?? null } });
  if (error) fail(error);
}

export interface PropertyRunResult {
  propertyId: string;
  fetched: number;
  inserted: number;
  updated: number;
  pendingToPosted: number;
  unchanged: number;
  refused: number;
  removed: number;
  posted: number;
  needsReview: number;
  error: string | null;
}

export interface BankFeedRunResult {
  runId: string;
  trigger: "schedule" | "manual";
  properties: PropertyRunResult[];
  startedAt: string;
  finishedAt: string;
}

const emptyResult = (propertyId: string): PropertyRunResult => ({ propertyId, fetched: 0, inserted: 0, updated: 0, pendingToPosted: 0, unchanged: 0, refused: 0, removed: 0, posted: 0, needsReview: 0, error: null });

/** Pull a week back from where we got to, so pending transactions that have since posted are caught. Idempotent. */
const sinceFor = (through: string | null) => (through ? new Date(new Date(`${through}T00:00:00Z`).getTime() - 7 * 86_400_000).toISOString().slice(0, 10) : null);

async function ingestProperty(db: Db, adapter: BankFeedAdapter, consent: { id: string; property_id: string; plaid_item_ref: EncryptedValue; last_ingested_through: string | null }): Promise<PropertyRunResult> {
  const out = emptyResult(consent.property_id);
  try {
    const itemRef = decryptBankItemRef(consent.plaid_item_ref, consent.property_id);
    const batch = await adapter.listTransactions(itemRef, sinceFor(consent.last_ingested_through));
    out.fetched = batch.transactions.length;
    // Oldest first, so a pending one is stored before the posted version that replaces it.
    for (const t of [...batch.transactions].sort((a, b) => a.postedDate.localeCompare(b.postedDate))) {
      const { data, error } = await db.rpc("upsert_bank_transaction", {
        _property: consent.property_id,
        _txn: { plaid_txn_id: t.plaidTxnId, pending_txn_id: t.pendingTxnId ?? null, posted_date: t.postedDate, amount_cents: t.amountCents, direction: t.direction, merchant_name: t.merchantName, raw_category: t.rawCategory, description: t.description, pending: t.pending },
      });
      if (error) throw new Error(error.message);
      const action = (data as { action?: string } | null)?.action;
      if (action === "inserted") out.inserted++;
      else if (action === "updated") out.updated++;
      else if (action === "pending_to_posted") out.pendingToPosted++;
      else if (action === "refused_after_posting") out.refused++;
      else out.unchanged++;
    }
    for (const id of batch.removed) {
      const { error } = await db.rpc("remove_bank_transaction", { _property: consent.property_id, _plaid_txn_id: id });
      if (error) throw new Error(error.message);
      out.removed++;
    }
    const { data: cat, error: catError } = await db.rpc("categorize_new_bank_transactions", { _property: consent.property_id });
    if (catError) throw new Error(catError.message);
    out.posted = Number((cat as { posted?: number } | null)?.posted ?? 0);
    out.needsReview = Number((cat as { needs_review?: number } | null)?.needs_review ?? 0);
    const newest = batch.transactions.reduce((m, t) => (t.postedDate > m ? t.postedDate : m), "");
    await db.rpc("record_bank_feed_position", { _property: consent.property_id, _through: newest || new Date().toISOString().slice(0, 10), _balance_cents: batch.balanceCents });
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}

/**
 * The daily job. Pulls new transactions for every LLC with an active consent (or one property), upserts them,
 * categorizes them, and logs the run in the Audit Vault whether or not anything came in.
 */
export async function runBankFeed(db: Db, adapterFor: (provider: string) => BankFeedAdapter, params: { trigger: "schedule" | "manual"; actorId?: string | null; propertyId?: string; request?: RequestContext }): Promise<BankFeedRunResult> {
  const started = new Date();
  const runId = crypto.randomUUID();
  let q = db.from("llc_plaid_consents").select("id, property_id, plaid_item_ref, last_ingested_through, provider").eq("status", "active");
  if (params.propertyId) q = q.eq("property_id", params.propertyId);
  const { data, error } = await q;
  let results: PropertyRunResult[] = [];
  let runError: string | null = null;
  if (error) {
    runError = error.message ?? "Could not read the consents.";
  } else {
    for (const c of (data ?? []) as Array<{ id: string; property_id: string; plaid_item_ref: EncryptedValue; last_ingested_through: string | null; provider: string }>) {
      let adapter: BankFeedAdapter;
      try {
        adapter = adapterFor(c.provider);
      } catch (e) {
        results.push({ ...emptyResult(c.property_id), error: (e as Error).message });
        continue;
      }
      results.push(await ingestProperty(db, adapter, c));
    }
  }
  const finished = new Date();
  await db.from("audit_log").insert({
    actor_id: params.actorId ?? null,
    actor_type: params.actorId ? "admin" : "system",
    action_type: "bank_feed.run",
    entity_type: "bank_feed_run",
    entity_id: runId,
    metadata: {
      run_id: runId,
      trigger: params.trigger,
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      properties: results.length,
      transactions_fetched: results.reduce((s, r) => s + r.fetched, 0),
      inserted: results.reduce((s, r) => s + r.inserted, 0),
      pending_to_posted: results.reduce((s, r) => s + r.pendingToPosted, 0),
      posted_to_ledger: results.reduce((s, r) => s + r.posted, 0),
      needs_review: results.reduce((s, r) => s + r.needsReview, 0),
      failed: results.filter((r) => r.error).length,
      error: runError,
      results,
      ip_address: params.request?.ip ?? null,
      user_agent: params.request?.userAgent ?? null,
    },
  });
  if (runError) throw new Error(runError);
  return { runId, trigger: params.trigger, properties: results, startedAt: started.toISOString(), finishedAt: finished.toISOString() };
}

export async function runBankFeedNow(db: Db, adapterFor: (provider: string) => BankFeedAdapter, params: { actorId: string; propertyId?: string; request?: RequestContext }) {
  await requireManager(db, params.actorId);
  return runBankFeed(db, adapterFor, { trigger: "manual", ...params });
}

export interface BankFeedProperty {
  propertyId: string;
  label: string;
  consent: { id: string; institutionName: string | null; accountMask: string | null; grantedAt: string; provider: string; entity: string } | null;
  reconciliation: BankReconciliationRow | null;
  review: Array<{ id: string; postedDate: string; amountCents: number; direction: "in" | "out"; merchantName: string | null; description: string | null; reason: string | null }>;
}

/** Everything the admin page needs: each property, its link, its reconciliation and what needs the Manager. */
export async function listBankFeed(db: Db, params: { userId: string }): Promise<BankFeedProperty[]> {
  await requireManager(db, params.userId);
  const { data: props } = await db.from("properties").select("id, address, city, state").order("created_at", { ascending: false });
  const { data: consents } = await db.from("llc_plaid_consents").select("id, property_id, institution_name, account_mask, granted_at, provider, granted_by_entity").eq("status", "active");
  const { data: recon } = await db.from("bank_reconciliation").select("*");
  const { data: review } = await db.from("bank_transactions").select("id, property_id, posted_date, amount_cents, direction, merchant_name, description, review_reason").eq("status", "needs_review").order("posted_date", { ascending: false });
  const reconBy = new Map(((recon ?? []) as Array<Record<string, any>>).map((r) => [r.property_id as string, r]));
  const consentBy = new Map(((consents ?? []) as Array<Record<string, any>>).map((c) => [c.property_id as string, c]));
  return ((props ?? []) as Array<{ id: string; address: string; city: string | null; state: string | null }>).map((p) => {
    const c = consentBy.get(p.id);
    const r = reconBy.get(p.id);
    return {
      propertyId: p.id,
      label: [p.address, p.city, p.state].filter(Boolean).join(", "),
      consent: c ? { id: c.id, institutionName: c.institution_name ?? null, accountMask: c.account_mask ?? null, grantedAt: c.granted_at, provider: c.provider, entity: c.granted_by_entity } : null,
      reconciliation: r
        ? { propertyId: p.id, bankBalanceCents: r.bank_balance_cents == null ? null : Number(r.bank_balance_cents), ledgerCashCents: Number(r.ledger_cash_cents), differenceCents: r.difference_cents == null ? null : Number(r.difference_cents), unmatchedCount: Number(r.unmatched_count), unmatchedInCents: Number(r.unmatched_in_cents), unmatchedOutCents: Number(r.unmatched_out_cents), needsReviewCount: Number(r.needs_review_count), pendingCount: Number(r.pending_count), unreconciledCents: r.unreconciled_cents == null ? null : Number(r.unreconciled_cents), lastIngestedThrough: r.last_ingested_through ?? null }
        : null,
      review: ((review ?? []) as Array<Record<string, any>>).filter((t) => t.property_id === p.id).map((t) => ({ id: t.id, postedDate: t.posted_date, amountCents: Number(t.amount_cents), direction: t.direction, merchantName: t.merchant_name ?? null, description: t.description ?? null, reason: t.review_reason ?? null })),
    };
  });
}
