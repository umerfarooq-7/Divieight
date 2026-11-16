/**
 * Know Your Owner retention (server side).
 *
 * The nightly job classifies every KYO record, archives accounts that have ended, computes retain_until, and opens a Retention review for each record that is past
 * its period. It NEVER deletes or anonymizes anything. Only a founder, approving a review with a reason, causes an erasure (retention_erase in kyo-retention.sql),
 * and only for a record that is past its period and not under a legal hold. The erasure is logged in the Audit Vault with counts and dates, never with the data.
 *
 * ASSUMPTION: the retention periods and the wording are pending compliance review (flagged on the launch readiness page).
 */
import { requireActingMember } from "@/lib/account-members.server";
import { complianceRecipients } from "@/lib/audit-vault.server";
import { deliver } from "@/lib/authorization.notify.server";
import { currentResultOf } from "@/lib/eligibility-engine";
import {
  CLASS_LABELS,
  REASON_LABELS,
  REVIEW_AGAIN_AFTER_DAYS,
  KYO_ITEM_KINDS,
  addDays,
  classifyMember,
  classifySeller,
  dayOf,
  deletionDecision,
  statusFor,
  type ArchiveReason,
  type Classification,
  type Llc,
  type RetentionClass,
  type RetentionStatus,
} from "@/lib/kyo-retention";

type Db = { from: (t: string) => any; rpc?: (n: string, a: Record<string, unknown>) => any; auth?: { admin?: { getUserById?: (id: string) => Promise<{ data?: { user?: unknown } | null; error?: unknown }> } }; storage?: { from: (b: string) => { remove: (paths: string[]) => Promise<{ error: { message?: string } | null }> } } };
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}
const MISSING = "Database is missing the KYO retention tables: run kyo-retention.sql in Supabase.";
const PAGE = 1000;

// ---------------------------------------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------------------------------------
async function hasRole(db: Db, userId: string, role: string) {
  const { data } = await db.rpc!("has_role", { _user_id: userId, _role: role });
  return data === true;
}
export type RetentionRole = "founder" | "compliance_officer" | "admin";
/** The Manager, the founder and the Compliance Officer see the retention status and the queue. */
export async function retentionRole(db: Db, userId: string): Promise<RetentionRole | null> {
  for (const r of ["founder", "compliance_officer", "admin"] as const) if (await hasRole(db, userId, r)) return r;
  return null;
}
export async function requireRetentionReader(db: Db, userId: string) {
  const role = await retentionRole(db, userId);
  if (!role) throw new Error("Not authorized");
  return role;
}
export async function requireFounder(db: Db, userId: string) {
  if (!(await hasRole(db, userId, "founder"))) throw new Error("Only the founder can approve an erasure.");
}

async function audit(db: Db, row: { actor?: string | null; actorType?: string; action: string; entityType?: string; entityId?: string | null; metadata: Record<string, unknown> }) {
  await db.from("audit_log").insert({ actor_id: row.actor ?? null, actor_type: row.actorType ?? (row.actor ? "admin" : "system"), action_type: row.action, entity_type: row.entityType ?? "kyo_retention", entity_id: row.entityId ?? null, metadata: row.metadata });
}

async function readAll<T>(db: Db, table: string, cols: string, key = "id"): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await db.from(table).select(cols).order(key, { ascending: true }).range(start, start + PAGE - 1);
    if (error) return out; // a table that does not exist yet reads as empty
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < PAGE) return out;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------------------------------------
interface Facts {
  accounts: Array<Record<string, any>>;
  members: Array<Record<string, any>>;
  sellers: Array<Record<string, any>>;
  properties: Array<Record<string, any>>;
  llcOf: Map<string, Llc>;
  accountProps: Map<string, Set<string>>;
  sellerProps: Map<string, Set<string>>;
  signedProps: Map<string, Set<string>>;
  currentResult: Map<string, { result: string; at: string }>;
  counts: Map<string, Map<string, number>>;
  idDocument: Set<string>;
}

async function loadFacts(db: Db, scope: { accountId?: string } = {}): Promise<Facts> {
  const only = <T extends Record<string, any>>(rows: T[], col: string) => (scope.accountId ? rows.filter((r) => r[col] === scope.accountId) : rows);
  const accounts = only(await readAll<Record<string, any>>(db, "buyer_accounts", "id, auth_user_id, onboarding_status, archived_at, archive_reason, priority_forfeited_at, last_activity_at, updated_at"), "id");
  const members = only(await readAll<Record<string, any>>(db, "account_members", "id, buyer_account_id, status, removed_at, created_at, id_document_url"), "buyer_account_id");
  const sellers = scope.accountId ? [] : await readAll<Record<string, any>>(db, "sellers", "id, onboarding_status, archived_at, updated_at");
  const properties = scope.accountId ? [] : await readAll<Record<string, any>>(db, "properties", "id, seller_id, status, listing_status, updated_at");
  const genesis = await readAll<{ property_id: string; llc_dissolved_at: string | null }>(db, "entity_genesis", "id, property_id, llc_dissolved_at");
  const llcOf = new Map(genesis.map((g) => [g.property_id, { propertyId: g.property_id, dissolvedAt: g.llc_dissolved_at ?? null }]));
  const add = (m: Map<string, Set<string>>, k: string | null | undefined, v: string | null | undefined) => {
    if (!k || !v || !llcOf.has(v)) return; // only an LLC counts
    m.set(k, (m.get(k) ?? new Set()).add(v));
  };
  const accountProps = new Map<string, Set<string>>();
  const sellerProps = new Map<string, Set<string>>();
  for (const c of await readAll<Record<string, any>>(db, "cap_table_entries", "id, property_id, buyer_account_id, seller_id")) {
    add(accountProps, c.buyer_account_id, c.property_id);
    add(sellerProps, c.seller_id, c.property_id);
  }
  for (const h of await readAll<Record<string, any>>(db, "cap_table_history", "id, property_id, from_buyer_account_id, to_buyer_account_id, from_seller_id, to_seller_id")) {
    add(accountProps, h.from_buyer_account_id, h.property_id);
    add(accountProps, h.to_buyer_account_id, h.property_id);
    add(sellerProps, h.from_seller_id, h.property_id);
    add(sellerProps, h.to_seller_id, h.property_id);
  }
  for (const p of properties) add(sellerProps, p.seller_id, p.id);
  const signedProps = new Map<string, Set<string>>();
  for (const s of await readAll<Record<string, any>>(db, "operating_agreement_signatures", "id, account_member_id, property_id")) add(signedProps, s.account_member_id, s.property_id);

  // The current eligibility result of each member (the same rule the held-account job uses).
  const decls = await readAll<{ id: string; account_member_id: string; status: string }>(db, "eligibility_declarations", "id, account_member_id, status");
  const results = await readAll<{ account_member_id: string; declaration_id: string; determined_at: string; result: string }>(db, "eligibility_results", "id, account_member_id, declaration_id, determined_at, result");
  const currentResult = new Map<string, { result: string; at: string }>();
  for (const m of members) {
    const decl = decls.find((d) => d.account_member_id === m.id && d.status === "complete");
    const cur = currentResultOf(results, m.id, decl?.id ?? null);
    if (cur) currentResult.set(m.id, { result: cur.result, at: cur.determined_at });
  }

  // How many personal-data rows sit under each member: counts only.
  const counts = new Map<string, Map<string, number>>();
  for (const t of ["member_liveness_checks", "member_w9", "eligibility_declarations", "member_sanctions_screenings", "kyo_correction_requests"]) {
    const rows = await readAll<{ account_member_id: string }>(db, t, "id, account_member_id");
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.account_member_id, (m.get(r.account_member_id) ?? 0) + 1);
    counts.set(t, m);
  }
  const idDocument = new Set(members.filter((m) => m.id_document_url && m.id_document_url !== "[erased]").map((m) => String(m.id)));
  return { accounts, members, sellers, properties, llcOf, accountProps, sellerProps, signedProps, currentResult, counts, idDocument };
}

const llcsOf = (f: Facts, ids: Set<string> | undefined): Llc[] => [...(ids ?? [])].map((id) => f.llcOf.get(id)!).filter(Boolean);

/** Why an account has ended, when nothing ties it to an LLC. Empty when it has not. */
function accountEnd(f: Facts, account: Record<string, any>, loginGone: boolean): { reason: ArchiveReason; at: string | null } | null {
  const status = String(account.onboarding_status ?? "");
  const at = account.archived_at ?? account.priority_forfeited_at ?? account.last_activity_at ?? account.updated_at ?? null;
  if (account.archived_at || status === "archived") return { reason: (account.archive_reason as ArchiveReason) ?? "abandoned", at };
  if (status === "withdrawn") return { reason: "withdrawn", at };
  if (status === "rejected") return { reason: "rejected", at };
  const active = f.members.filter((m) => m.buyer_account_id === account.id && m.status === "active");
  const results = active.map((m) => f.currentResult.get(m.id));
  if (active.length > 0 && results.every((r) => r?.result === "not_eligible")) return { reason: "not_eligible", at: results.map((r) => r!.at).sort().at(-1) ?? null };
  if (loginGone) return { reason: "login_deleted", at: null };
  return null;
}

function sellerEnd(f: Facts, seller: Record<string, any>, loginGone: boolean): { reason: ArchiveReason; at: string | null } | null {
  const status = String(seller.onboarding_status ?? "");
  const mine = f.properties.filter((p) => p.seller_id === seller.id);
  const at = seller.archived_at ?? mine.map((p) => p.updated_at).filter(Boolean).sort().at(-1) ?? seller.updated_at ?? null;
  if (seller.archived_at || status === "archived") return { reason: "abandoned", at };
  if (status === "rejected") return { reason: "rejected", at };
  if (status === "withdrawn") return { reason: "withdrawn", at };
  if (mine.length > 0 && mine.every((p) => ["rejected", "withdrawn", "removed", "archived"].includes(String(p.status ?? p.listing_status)))) return { reason: mine.some((p) => (p.status ?? p.listing_status) === "rejected") ? "rejected" : "withdrawn", at };
  if (loginGone) return { reason: "login_deleted", at: null };
  return null;
}

/** Does this login still exist? Without the auth admin API we assume it does: an account is never archived on a guess. */
async function defaultLoginExists(db: Db, authUserId: string | null | undefined): Promise<boolean> {
  if (!authUserId) return true;
  const get = db.auth?.admin?.getUserById;
  if (!get) return true;
  try {
    const r = await get.call(db.auth!.admin, authUserId);
    return !!r?.data?.user && !r?.error;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------------------------------------
// The nightly job
// ---------------------------------------------------------------------------------------------------------
interface LedgerRow {
  id: string;
  subject_kind: "account_member" | "seller";
  subject_id: string;
  buyer_account_id: string | null;
  property_ids: string[] | null;
  retention_class: RetentionClass;
  archive_reason: ArchiveReason | null;
  archived_at: string | null;
  retain_until: string | null;
  status: RetentionStatus;
  legal_hold: boolean;
  next_review_at: string | null;
}

interface Computed {
  kind: "account_member" | "seller";
  id: string;
  accountId: string | null;
  propertyIds: string[];
  c: Classification;
}

export interface SweepResult {
  records: number;
  accountsArchived: number;
  reviewsOpened: number;
  pastRetention: number;
  onLegalHold: number;
  erased: 0;
}

/**
 * The nightly job. Safe to run again. It reads, classifies, records, and opens reviews. It has no delete in it and calls no erasure: a record past its period waits
 * in the Retention review queue for a founder.
 */
export async function runRetentionSweep(db: Db, p: { now?: Date; loginExists?: (authUserId: string) => Promise<boolean> } = {}): Promise<SweepResult> {
  const now = p.now ?? new Date();
  const nowIso = now.toISOString();
  const today = dayOf(now);
  const f = await loadFacts(db);
  const loginExists = p.loginExists ?? ((id: string) => defaultLoginExists(db, id));
  const { data: ledgerData, error: ledgerError } = await db.from("kyo_retention").select("*");
  if (ledgerError) throw new Error(MISSING);
  const ledger = new Map(((ledgerData ?? []) as LedgerRow[]).map((r) => [`${r.subject_kind}:${r.subject_id}`, r]));

  // 1. Accounts that have ended move to 'archived', with archived_at.
  let accountsArchived = 0;
  const endOf = new Map<string, { reason: ArchiveReason; at: string | null } | null>();
  for (const a of f.accounts) {
    const tied = (f.accountProps.get(a.id)?.size ?? 0) > 0;
    const end = tied ? null : accountEnd(f, a, !(await loginExists(a.auth_user_id)));
    endOf.set(a.id, end);
    if (end && (!a.archived_at || a.onboarding_status !== "archived")) {
      const at = a.archived_at ?? end.at ?? nowIso;
      const { error } = await db.from("buyer_accounts").update({ onboarding_status: "archived", archived_at: at, archive_reason: a.archive_reason ?? end.reason }).eq("id", a.id);
      if (!error) {
        accountsArchived += 1;
        await audit(db, { action: "retention.account_archived", entityType: "buyer_account", entityId: a.id, metadata: { buyer_account_id: a.id, reason: a.archive_reason ?? end.reason, archived_at: at } });
        a.archived_at = at;
      }
    }
  }

  // 2. Classify every record.
  const computed: Computed[] = [];
  for (const m of f.members) {
    const existing = ledger.get(`account_member:${m.id}`);
    const fallback = existing?.archived_at ?? nowIso;
    const end = endOf.get(m.buyer_account_id) ?? null;
    const c = classifyMember({ removed: m.status === "removed", removedAt: m.removed_at ?? null, accountLlcs: llcsOf(f, f.accountProps.get(m.buyer_account_id)), signedLlcs: llcsOf(f, f.signedProps.get(m.id)), accountEnd: end && !end.at ? { ...end, at: fallback } : end }, fallback);
    computed.push({ kind: "account_member", id: m.id, accountId: m.buyer_account_id, propertyIds: [...new Set([...(f.accountProps.get(m.buyer_account_id) ?? []), ...(f.signedProps.get(m.id) ?? [])])], c });
  }
  for (const s of f.sellers) {
    const existing = ledger.get(`seller:${s.id}`);
    const fallback = existing?.archived_at ?? nowIso;
    const tied = (f.sellerProps.get(s.id)?.size ?? 0) > 0;
    const end = tied ? null : sellerEnd(f, s, !(await loginExists(s.id)));
    const c = classifySeller({ llcs: llcsOf(f, f.sellerProps.get(s.id)), ended: end && !end.at ? { ...end, at: fallback } : end }, fallback);
    computed.push({ kind: "seller", id: s.id, accountId: null, propertyIds: [...(f.sellerProps.get(s.id) ?? [])], c });
  }

  // 3. Record them. A record already erased is never touched.
  const rows = new Map<string, LedgerRow>();
  for (const x of computed) {
    const existing = ledger.get(`${x.kind}:${x.id}`);
    if (existing?.status === "erased") {
      rows.set(`${x.kind}:${x.id}`, existing);
      continue;
    }
    const status = statusFor(x.c, today);
    const body = {
      buyer_account_id: x.accountId,
      property_ids: x.propertyIds,
      retention_class: x.c.retentionClass,
      archive_reason: x.c.archiveReason,
      archived_at: x.c.archivedAt,
      retain_until: x.c.retainUntil,
      retention_basis: x.c.basis,
      status,
      computed_at: nowIso,
    };
    if (!existing) {
      const { data, error } = await db.from("kyo_retention").insert({ subject_kind: x.kind, subject_id: x.id, ...body }).select("*").single();
      if (error || !data) throw new Error(error?.message ?? MISSING);
      rows.set(`${x.kind}:${x.id}`, data as LedgerRow);
    } else {
      const same = existing.retention_class === body.retention_class && existing.archive_reason === body.archive_reason && existing.retain_until === body.retain_until && existing.status === body.status && (existing.archived_at ?? null) === (body.archived_at ?? null) && JSON.stringify(existing.property_ids ?? []) === JSON.stringify(body.property_ids);
      if (!same) {
        const { error } = await db.from("kyo_retention").update(body).eq("id", existing.id);
        if (error) throw new Error(error.message);
      }
      rows.set(`${x.kind}:${x.id}`, { ...existing, ...body } as LedgerRow);
    }
  }

  // 4. The PII sub-vault items under each record, with the same class and dates.
  for (const x of computed.filter((c) => c.c.retentionClass !== "in_use")) {
    const rec = rows.get(`${x.kind}:${x.id}`);
    if (!rec || rec.status === "erased") continue;
    for (const item of KYO_ITEM_KINDS.filter((k) => k.subject === x.kind)) {
      const count =
        item.kind === "kyo_record" || item.kind === "seller_record"
          ? 1
          : item.kind === "identity_document"
            ? (f.idDocument.has(x.id) ? 1 : 0)
            : (f.counts.get(item.table)?.get(x.id) ?? 0);
      await db.from("kyo_retention_items").upsert({ retention_id: rec.id, item_kind: item.kind, item_table: item.table, item_count: count, retention_class: x.c.retentionClass, archived_at: x.c.archivedAt, retain_until: x.c.retainUntil, updated_at: nowIso }, { onConflict: "retention_id,item_kind" });
    }
  }

  // 5. Past retention and not on hold: into the Retention review queue (never deleted).
  const all = [...rows.values()];
  const past = all.filter((r) => r.status === "past_retention");
  const { data: openData } = await db.from("retention_reviews").select("retention_id, kind, status").eq("status", "open");
  const open = new Set(((openData ?? []) as Array<{ retention_id: string; kind: string }>).filter((o) => o.kind === "past_retention").map((o) => o.retention_id));
  let reviewsOpened = 0;
  for (const r of past) {
    if (r.legal_hold || open.has(r.id)) continue;
    if (r.next_review_at && r.next_review_at > today) continue;
    const { error } = await db.from("retention_reviews").insert({ retention_id: r.id, kind: "past_retention" });
    if (error) continue;
    reviewsOpened += 1;
    await audit(db, { action: "retention.review_opened", entityId: r.id, metadata: { retention_id: r.id, subject_kind: r.subject_kind, retention_class: r.retention_class, retain_until: r.retain_until } });
  }
  if (reviewsOpened > 0) await notifyCompliance(db, `Retention review: ${reviewsOpened} record${reviewsOpened === 1 ? "" : "s"} past retention`, `${reviewsOpened} Know Your Owner record${reviewsOpened === 1 ? " is" : "s are"} past the retention period and waiting in the Retention review queue. Nothing has been deleted: a founder decides each one, with a reason, and a legal hold blocks it. Counts only here; open the queue to review.`, `retention_review:${today}`);

  const result: SweepResult = { records: all.length, accountsArchived, reviewsOpened, pastRetention: past.length, onLegalHold: all.filter((r) => r.legal_hold).length, erased: 0 };
  await audit(db, { action: "retention.sweep_run", metadata: { ...result, today } });
  return result;
}

async function notifyCompliance(db: Db, subject: string, message: string, dedupeKey: string) {
  for (const userId of await complianceRecipients(db as never)) {
    let email: string | null = null;
    try {
      const r = (await db.auth?.admin?.getUserById?.(userId)) as { data?: { user?: { email?: string | null } | null } } | undefined;
      email = r?.data?.user?.email ?? null;
    } catch {
      email = null;
    }
    await deliver(db as never, { authUserId: userId, email }, { subject, message, link: "/admin/retention", type: "retention_review", dedupeKey: `${dedupeKey}:${userId}` });
  }
}

// ---------------------------------------------------------------------------------------------------------
// The admin view: counts, no personal data
// ---------------------------------------------------------------------------------------------------------
export async function retentionOverview(db: Db, p: { userId: string; now?: Date }) {
  await requireRetentionReader(db, p.userId);
  const today = dayOf(p.now ?? new Date());
  const { data, error } = await db.from("kyo_retention").select("*");
  if (error) throw new Error(MISSING);
  const rows = (data ?? []) as Array<LedgerRow & { erased_at: string | null }>;
  const count = (fn: (r: LedgerRow) => boolean) => rows.filter(fn).length;
  const totals = {
    records: rows.length,
    byClass: Object.fromEntries((Object.keys(CLASS_LABELS) as RetentionClass[]).map((c) => [c, count((r) => r.retention_class === c)])) as Record<RetentionClass, number>,
    byStatus: Object.fromEntries((["in_use", "retained", "past_retention", "erased"] as RetentionStatus[]).map((s) => [s, count((r) => r.status === s)])) as Record<RetentionStatus, number>,
    legalHolds: count((r) => r.legal_hold),
  };
  const { data: reviews } = await db.from("retention_reviews").select("id, kind, status");
  const { data: requests } = await db.from("kyo_deletion_requests").select("id, status, decision_code, decided_at");
  const rv = (reviews ?? []) as Array<{ kind: string; status: string }>;
  const rq = (requests ?? []) as Array<{ status: string; decision_code: string | null }>;
  const queue = { openReviews: rv.filter((r) => r.status === "open").length, openDeletionRequests: rq.filter((r) => r.status === "open").length, declinedDeletionRequests: rq.filter((r) => r.status === "declined").length };

  // Per property: counts of the records tied to its LLC.
  const propIds = [...new Set(rows.flatMap((r) => r.property_ids ?? []))];
  const { data: props } = propIds.length ? await db.from("properties").select("id, address, city, state").in("id", propIds) : { data: [] };
  const { data: gen } = propIds.length ? await db.from("entity_genesis").select("property_id, llc_name, llc_dissolved_at").in("property_id", propIds) : { data: [] };
  const genOf = new Map(((gen ?? []) as Array<{ property_id: string; llc_name: string | null; llc_dissolved_at: string | null }>).map((g) => [g.property_id, g]));
  const byProperty = ((props ?? []) as Array<{ id: string; address: string | null; city: string | null; state: string | null }>)
    .map((pr) => {
      const mine = rows.filter((r) => (r.property_ids ?? []).includes(pr.id));
      return {
        propertyId: pr.id,
        label: [pr.address, pr.city, pr.state].filter(Boolean).join(", ") || `Property #${pr.id.slice(0, 6)}`,
        llcName: genOf.get(pr.id)?.llc_name ?? null,
        dissolvedAt: genOf.get(pr.id)?.llc_dissolved_at ?? null,
        records: mine.length,
        retained: mine.filter((r) => r.status === "retained").length,
        pastRetention: mine.filter((r) => r.status === "past_retention").length,
        onLegalHold: mine.filter((r) => r.legal_hold).length,
        erased: mine.filter((r) => r.status === "erased").length,
      };
    })
    .sort((a, b) => b.records - a.records);

  // Per archived account: a reference, a reason and dates. No names.
  const archived = rows.filter((r) => r.retention_class === "archived");
  const groups = new Map<string, LedgerRow[]>();
  for (const r of archived) groups.set(r.buyer_account_id ?? `seller:${r.subject_id}`, [...(groups.get(r.buyer_account_id ?? `seller:${r.subject_id}`) ?? []), r]);
  const archivedAccounts = [...groups.entries()]
    .map(([key, rs]) => {
      const first = rs[0]!;
      const latestUntil = rs.map((r) => r.retain_until).filter((x): x is string => !!x).sort().at(-1) ?? null;
      return {
        ref: key.startsWith("seller:") ? `Seller #${key.slice(7, 13)}` : `Account #${key.slice(0, 6)}`,
        reason: REASON_LABELS[first.archive_reason as ArchiveReason] ?? "Archived",
        archivedAt: first.archived_at ? dayOf(first.archived_at) : null,
        retainUntil: rs.some((r) => !r.retain_until) ? null : latestUntil,
        records: rs.length,
        status: rs.every((r) => r.status === "erased") ? ("erased" as const) : rs.some((r) => r.status === "past_retention") ? ("past_retention" as const) : ("retained" as const),
        legalHold: rs.some((r) => r.legal_hold),
        pastDue: !!latestUntil && latestUntil < today && !rs.some((r) => !r.retain_until),
      };
    })
    .sort((a, b) => String(a.archivedAt).localeCompare(String(b.archivedAt)));
  const archivedByReason = Object.fromEntries(Object.entries(REASON_LABELS).map(([k, label]) => [label, archived.filter((r) => r.archive_reason === k).length]));
  return { totals, queue, byProperty, archivedAccounts, archivedByReason };
}

// ---------------------------------------------------------------------------------------------------------
// The review queue, and the founder's decision
// ---------------------------------------------------------------------------------------------------------
export async function listRetentionQueue(db: Db, p: { userId: string }) {
  await requireRetentionReader(db, p.userId);
  const { data: reviews } = await db.from("retention_reviews").select("*").order("opened_at", { ascending: false }).limit(200);
  const { data: requests } = await db.from("kyo_deletion_requests").select("id, retention_id, requested_at, status, decision_code, decision_reason, decided_at, retention_snapshot").order("requested_at", { ascending: false }).limit(200);
  const ids = [...new Set([...(reviews ?? []).map((r: any) => r.retention_id), ...(requests ?? []).map((r: any) => r.retention_id)])];
  const { data: recs } = ids.length ? await db.from("kyo_retention").select("*").in("id", ids) : { data: [] };
  const rec = new Map(((recs ?? []) as LedgerRow[]).map((r) => [r.id, r]));
  const ref = (r: LedgerRow | undefined) => (r ? `${r.subject_kind === "seller" ? "Seller" : "Member"} #${r.subject_id.slice(0, 6)}` : "Record");
  const view = (r: LedgerRow | undefined) => ({ ref: ref(r), class: r ? CLASS_LABELS[r.retention_class] : "", reason: r?.archive_reason ? REASON_LABELS[r.archive_reason] : null, archivedAt: r?.archived_at ? dayOf(r.archived_at) : null, retainUntil: r?.retain_until ?? null, legalHold: !!r?.legal_hold, status: r?.status ?? null });
  return {
    reviews: ((reviews ?? []) as Array<Record<string, any>>).map((r) => ({ id: r.id as string, kind: r.kind as string, status: r.status as string, openedAt: r.opened_at as string, decidedAt: (r.decided_at as string | null) ?? null, decisionReason: (r.decision_reason as string | null) ?? null, record: view(rec.get(r.retention_id)), retentionId: r.retention_id as string })),
    deletionRequests: ((requests ?? []) as Array<Record<string, any>>).map((r) => ({ id: r.id as string, status: r.status as string, requestedAt: r.requested_at as string, decisionCode: (r.decision_code as string | null) ?? null, decisionReason: (r.decision_reason as string | null) ?? null, decidedAt: (r.decided_at as string | null) ?? null, record: view(rec.get(r.retention_id)) })),
  };
}

async function storageFilesFor(db: Db, rec: LedgerRow): Promise<Array<{ bucket: string; path: string }>> {
  const files: Array<{ bucket: string; path: string }> = [];
  const add = (bucket: string, path: unknown) => {
    if (typeof path === "string" && path && path !== "[erased]" && !files.some((f) => f.bucket === bucket && f.path === path)) files.push({ bucket, path });
  };
  if (rec.subject_kind === "account_member") {
    const { data: m } = await db.from("account_members").select("id_document_url").eq("id", rec.subject_id).maybeSingle();
    add("identity-documents", (m as { id_document_url?: string } | null)?.id_document_url);
    const { data: live } = await db.from("member_liveness_checks").select("id_document_ref, selfie_url").eq("account_member_id", rec.subject_id);
    for (const l of (live ?? []) as Array<{ id_document_ref: string; selfie_url: string }>) {
      add("identity-documents", l.id_document_ref);
      add("liveness-selfies", l.selfie_url);
    }
  } else {
    const { data: s } = await db.from("sellers").select("id_document_url").eq("id", rec.subject_id).maybeSingle();
    add("identity-documents", (s as { id_document_url?: string } | null)?.id_document_url);
  }
  return files;
}

async function removeFiles(db: Db, files: Array<{ bucket: string; path: string }>) {
  const byBucket = new Map<string, string[]>();
  for (const f of files) byBucket.set(f.bucket, [...(byBucket.get(f.bucket) ?? []), f.path]);
  for (const [bucket, paths] of byBucket) {
    const { error } = await db.storage!.from(bucket).remove(paths);
    if (error && !/not found|does not exist/i.test(String(error.message))) throw new Error("The stored files could not be removed, so nothing was erased. Try again.");
  }
}

export type ReviewDecision = "approve_erasure" | "keep";
/**
 * A founder decides a Retention review, with a reason. Approving erases: the personal data is anonymized, the stored files removed, and the event logged without the data.
 * It is refused for a record under a legal hold and for one still inside its retention period. Keeping a record (or declining a member's request) is the other answer.
 */
export async function decideReview(db: Db, p: { userId: string; reviewId: string; decision: ReviewDecision; reason: string; now?: Date; request?: RequestContext }) {
  await requireFounder(db, p.userId);
  const reason = p.reason.trim();
  if (reason.length < 10) throw new Error("Give the reason, in at least ten characters. Do not put personal data in it.");
  const today = dayOf(p.now ?? new Date());
  const { data: review } = await db.from("retention_reviews").select("*").eq("id", p.reviewId).maybeSingle();
  const rv = review as { id: string; retention_id: string; kind: "past_retention" | "deletion_request"; status: string } | null;
  if (!rv) throw new Error("Review not found.");
  if (rv.status !== "open") throw new Error("This review has already been decided.");
  const { data: recData } = await db.from("kyo_retention").select("*").eq("id", rv.retention_id).maybeSingle();
  const rec = recData as LedgerRow | null;
  if (!rec) throw new Error("Record not found.");

  if (p.decision === "keep") {
    const decidedAt = (p.now ?? new Date()).toISOString();
    await db.from("retention_reviews").update({ status: rv.kind === "deletion_request" ? "declined" : "kept", decided_by: p.userId, decided_at: decidedAt, decision_reason: reason }).eq("id", rv.id);
    await db.from("kyo_retention").update({ next_review_at: addDays(today, REVIEW_AGAIN_AFTER_DAYS) }).eq("id", rec.id);
    if (rv.kind === "deletion_request") await db.from("kyo_deletion_requests").update({ status: "declined", decision_code: "founder_declined", decision_reason: reason, decided_by: p.userId, decided_at: decidedAt }).eq("retention_id", rec.id).eq("status", "open");
    await audit(db, { actor: p.userId, action: rv.kind === "deletion_request" ? "kyo.deletion_declined" : "retention.review_kept", entityId: rec.id, metadata: { retention_id: rec.id, review_id: rv.id, review_kind: rv.kind, reason, next_review_at: addDays(today, REVIEW_AGAIN_AFTER_DAYS), ip_address: p.request?.ip ?? null } });
    return { decision: "kept" as const };
  }

  // Approving an erasure. Everything that could stop it is checked before anything is touched.
  const gate = deletionDecision({ retentionClass: rec.retention_class, retainUntil: rec.retain_until, legalHold: rec.legal_hold }, today);
  if (rec.status === "erased") return { decision: "erased" as const, already: true };
  if (gate.outcome === "declined") {
    await audit(db, { actor: p.userId, action: gate.code === "legal_hold" ? "retention.erasure_blocked_legal_hold" : "retention.erasure_blocked_inside_retention", entityId: rec.id, metadata: { retention_id: rec.id, review_id: rv.id, retention_class: rec.retention_class, retain_until: rec.retain_until, code: gate.code } });
    throw new Error(gate.code === "legal_hold" ? "This record is under a legal hold. Release the hold first; nothing was erased." : `This record cannot be erased yet. ${gate.reason}`);
  }
  await removeFiles(db, await storageFilesFor(db, rec));
  const { data, error } = await db.rpc!("retention_erase", { _retention: rec.id, _founder: p.userId, _review: rv.id, _reason: reason });
  if (error) throw new Error(/does not exist|schema cache/i.test(String(error.message)) ? MISSING : String(error.message));
  const out = data as { ok: boolean; reason?: string; counts?: Record<string, number>; already?: boolean };
  if (!out?.ok) {
    const why: Record<string, string> = { legal_hold: "This record is under a legal hold; nothing was erased.", inside_retention: "This record is still inside its retention period; nothing was erased.", founder_only: "Only the founder can approve an erasure.", reason_required: "Give the reason, in at least ten characters.", no_open_review: "There is no open review for this record." };
    throw new Error(why[out?.reason ?? ""] ?? "The erasure was refused; nothing was erased.");
  }
  return { decision: "erased" as const, counts: out.counts ?? {}, already: out.already === true };
}

// ---------------------------------------------------------------------------------------------------------
// Legal hold
// ---------------------------------------------------------------------------------------------------------
/** Placing a hold is open to the Manager, the Compliance Officer and the founder; lifting it only to the Compliance Officer and the founder. A hold blocks every erasure. */
export async function setLegalHold(db: Db, p: { userId: string; retentionId: string; hold: boolean; reason: string; request?: RequestContext }) {
  const role = await requireRetentionReader(db, p.userId);
  if (!p.hold && role === "admin") throw new Error("Only the founder or the Compliance Officer can lift a legal hold.");
  const reason = p.reason.trim();
  if (reason.length < 5) throw new Error("Say why: a reason of at least five characters (a matter number, not personal data).");
  const { data } = await db.from("kyo_retention").select("id, status, legal_hold").eq("id", p.retentionId).maybeSingle();
  const rec = data as { id: string; status: string; legal_hold: boolean } | null;
  if (!rec) throw new Error("Record not found.");
  if (rec.status === "erased") throw new Error("This record has already been erased.");
  if (rec.legal_hold === p.hold) return { changed: false };
  const now = new Date().toISOString();
  const patch = p.hold ? { legal_hold: true, legal_hold_reason: reason.slice(0, 500), legal_hold_set_by: p.userId, legal_hold_set_at: now } : { legal_hold: false, legal_hold_reason: null, legal_hold_set_by: null, legal_hold_set_at: null };
  const { error } = await db.from("kyo_retention").update(patch).eq("id", rec.id);
  if (error) throw new Error(error.message);
  await audit(db, { actor: p.userId, actorType: role, action: p.hold ? "retention.legal_hold_placed" : "retention.legal_hold_released", entityId: rec.id, metadata: { retention_id: rec.id, reason: reason.slice(0, 500), ip_address: p.request?.ip ?? null } });
  return { changed: true };
}

// ---------------------------------------------------------------------------------------------------------
// LLC dissolution: it starts the 7 years for everyone tied to the LLC
// ---------------------------------------------------------------------------------------------------------
export async function recordLlcDissolution(db: Db, p: { userId: string; propertyId: string; date: string; reason: string; request?: RequestContext }) {
  await requireFounder(db, p.userId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date) || Number.isNaN(new Date(p.date).getTime())) throw new Error("Enter the dissolution date.");
  if (p.reason.trim().length < 10) throw new Error("Give the reason, in at least ten characters.");
  const { data } = await db.from("entity_genesis").select("property_id, llc_dissolved_at").eq("property_id", p.propertyId).maybeSingle();
  if (!data) throw new Error("No LLC for that property.");
  await db.from("entity_genesis").update({ llc_dissolved_at: p.date }).eq("property_id", p.propertyId);
  await audit(db, { actor: p.userId, action: "retention.llc_dissolution_recorded", entityType: "property", entityId: p.propertyId, metadata: { property_id: p.propertyId, dissolved_at: p.date, previous: (data as { llc_dissolved_at: string | null }).llc_dissolved_at, reason: p.reason.trim().slice(0, 500), ip_address: p.request?.ip ?? null } });
  return { propertyId: p.propertyId, dissolvedAt: p.date };
}

// ---------------------------------------------------------------------------------------------------------
// The member's side: their own retention, and a request to delete
// ---------------------------------------------------------------------------------------------------------
/** The ledger row for one member, made now if the nightly job has not reached them yet. */
async function recordForMember(db: Db, accountId: string, memberId: string, now: Date): Promise<LedgerRow> {
  const { data } = await db.from("kyo_retention").select("*").eq("subject_kind", "account_member").eq("subject_id", memberId).maybeSingle();
  if (data) return data as LedgerRow;
  const f = await loadFacts(db, { accountId });
  const a = f.accounts[0];
  const m = f.members.find((x) => x.id === memberId);
  if (!a || !m) throw new Error("That member isn't on your account.");
  const tied = (f.accountProps.get(accountId)?.size ?? 0) > 0;
  const end = tied ? null : accountEnd(f, a, false);
  const nowIso = now.toISOString();
  const c = classifyMember({ removed: m.status === "removed", removedAt: m.removed_at ?? null, accountLlcs: llcsOf(f, f.accountProps.get(accountId)), signedLlcs: llcsOf(f, f.signedProps.get(memberId)), accountEnd: end && !end.at ? { ...end, at: nowIso } : end }, nowIso);
  const { data: inserted, error } = await db
    .from("kyo_retention")
    .insert({ subject_kind: "account_member", subject_id: memberId, buyer_account_id: accountId, property_ids: [...new Set([...(f.accountProps.get(accountId) ?? []), ...(f.signedProps.get(memberId) ?? [])])], retention_class: c.retentionClass, archive_reason: c.archiveReason, archived_at: c.archivedAt, retain_until: c.retainUntil, retention_basis: c.basis, status: statusFor(c, dayOf(now)), computed_at: nowIso })
    .select("*")
    .single();
  if (error || !inserted) throw new Error(MISSING);
  return inserted as LedgerRow;
}

export async function myRetention(db: Db, p: { userId: string; actingMemberId: string; now?: Date }) {
  const { account, member } = await requireActingMember(db as never, p.userId, p.actingMemberId);
  const rec = await recordForMember(db, account.id, member.id, p.now ?? new Date());
  const { data } = await db.from("kyo_deletion_requests").select("id, requested_at, status, decision_code, decision_reason, decided_at").eq("account_member_id", member.id).order("requested_at", { ascending: false });
  return {
    retention: { class: CLASS_LABELS[rec.retention_class], status: rec.status, retainUntil: rec.retain_until, archivedAt: rec.archived_at ? dayOf(rec.archived_at) : null },
    requests: ((data ?? []) as Array<Record<string, any>>).map((r) => ({ id: r.id as string, requestedAt: r.requested_at as string, status: r.status as string, decisionReason: (r.decision_reason as string | null) ?? null, decidedAt: (r.decided_at as string | null) ?? null })),
  };
}

/**
 * A member asks for their data to be deleted. Inside the retention period, under a legal hold, or while the account is in use, the request is declined at once, with
 * the reason recorded and logged. Past the period it goes to the founder's queue. What the member wrote is kept off the Audit Vault.
 */
export async function requestKyoDeletion(db: Db, p: { userId: string; actingMemberId: string; note?: string | null; now?: Date; request?: RequestContext }) {
  const now = p.now ?? new Date();
  const { account, member } = await requireActingMember(db as never, p.userId, p.actingMemberId);
  const rec = await recordForMember(db, account.id, member.id, now);
  if (rec.status === "erased") return { status: "declined" as const, reason: "Your data has already been erased.", code: null };
  const { data: open } = await db.from("kyo_deletion_requests").select("id, status").eq("account_member_id", member.id).eq("status", "open").maybeSingle();
  if (open) return { status: "open" as const, reason: "You already have a request waiting for a decision.", code: null };
  const decision = deletionDecision({ retentionClass: rec.retention_class, retainUntil: rec.retain_until, legalHold: rec.legal_hold }, dayOf(now));
  const snapshot = { retention_class: rec.retention_class, retain_until: rec.retain_until, legal_hold: rec.legal_hold, status: rec.status, archive_reason: rec.archive_reason };
  const base = { retention_id: rec.id, account_member_id: member.id, buyer_account_id: account.id, member_note: (p.note ?? "").trim().slice(0, 2000) || null, retention_snapshot: snapshot, ip: p.request?.ip ?? null, user_agent: p.request?.userAgent ?? null };
  const decidedAt = now.toISOString();
  const { data: row, error } = await db
    .from("kyo_deletion_requests")
    .insert(decision.outcome === "declined" ? { ...base, status: "declined", decision_code: decision.code, decision_reason: decision.reason, decided_at: decidedAt } : { ...base, status: "open" })
    .select("id")
    .single();
  if (error || !row) throw new Error(/does not exist|schema cache/i.test(String(error?.message)) ? MISSING : String(error?.message ?? "The request could not be recorded."));
  const requestId = (row as { id: string }).id;
  await audit(db, { actor: p.userId, actorType: "buyer", action: "kyo.deletion_requested", entityType: "buyer_account", entityId: account.id, metadata: { request_id: requestId, account_member_id: member.id, acted_by_member_id: member.id, retention_id: rec.id, ip_address: p.request?.ip ?? null, user_agent: p.request?.userAgent ?? null } });
  if (decision.outcome === "declined") {
    await audit(db, { actor: p.userId, actorType: "buyer", action: "kyo.deletion_declined", entityType: "buyer_account", entityId: account.id, metadata: { request_id: requestId, account_member_id: member.id, retention_id: rec.id, code: decision.code, reason: decision.reason, retention_class: rec.retention_class, retain_until: rec.retain_until, legal_hold: rec.legal_hold } });
    return { status: "declined" as const, reason: decision.reason, code: decision.code };
  }
  await db.from("retention_reviews").insert({ retention_id: rec.id, kind: "deletion_request" });
  await notifyCompliance(db, "Retention review: a deletion request is waiting", "A member has asked for their Know Your Owner data to be deleted. It is past the retention period and no legal hold applies, so it is waiting in the Retention review queue for a founder's decision.", `kyo_deletion:${requestId}`);
  return { status: "open" as const, reason: decision.reason, code: null };
}
