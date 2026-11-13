/**
 * Platform analytics and admin reports (server side). Read-only. Admins and the founder only; anyone else gets a 403. Every export is audit logged.
 *
 * One query layer: the founder facts come from loadFounderFacts (the same read the Founder Dashboard uses), and the pod, revenue and resale figures are
 * the Founder Dashboard's own calculation. What this file adds is only what the Founder Dashboard does not hold: users, the onboarding funnel, statements,
 * held accounts, verification requests and the compliance sources. It never selects a name, an email, a phone number, an address or a tax identifier.
 */
import { createHash } from "node:crypto";
import { complianceReport, computeAnalytics, podActivityReport, reportCsv, revenueReport, type AnalyticsFacts, type AnalyticsFilters, type BuyerAcct, type ReportKind } from "@/lib/analytics";
import { loadFounderFacts } from "@/lib/founder.server";
import { heldMembers } from "@/lib/held-reminders.server";
import { loadGovernanceConfig } from "@/lib/governance-config.server";
import { stateForMarket } from "@/lib/markets";

type Db = { from: (t: string) => any; rpc?: (n: string, a: Record<string, unknown>) => any };
const PAGE = 1000;
const DAY = 86_400_000;

/** Admins and the founder. Anyone else is refused, and the screen shows a 403. */
export async function requireAnalyticsAccess(db: Db, userId: string) {
  for (const role of ["admin", "founder"]) {
    const { data } = await db.rpc!("has_role", { _user_id: userId, _role: role });
    if (data === true) return role;
  }
  throw new Error("Not authorized");
}

/** Supabase hands back 1,000 rows at a time: read them all, or a total would stop at 1,000. */
async function readAll<T>(db: Db, table: string, cols: string, key = "id"): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await db.from(table).select(cols).order(key, { ascending: true }).range(start, start + PAGE - 1);
    if (error) return out; // a table that does not exist yet reads as empty: the figure is zero, and the page says so
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < PAGE) return out;
  }
}

/** Everything the analytics need beyond the founder facts. Columns are chosen so that no personal information is ever read. */
export async function loadAnalyticsFacts(db: Db, now: Date = new Date()): Promise<AnalyticsFacts> {
  const buyers = (await readAll<Record<string, any>>(db, "buyer_accounts", "id, created_at, onboarding_status, priority_rank_timestamp, golden_ticket_issued, golden_ticket_issued_at, primary_target_market, last_activity_at, stall_warning_sent_at")).map(
    (b): BuyerAcct => ({ id: b.id, created_at: b.created_at, onboarding_status: b.onboarding_status ?? null, priority_rank_timestamp: b.priority_rank_timestamp ?? null, golden_ticket_issued: b.golden_ticket_issued ?? null, golden_ticket_issued_at: b.golden_ticket_issued_at ?? null, market: b.primary_target_market ?? null, last_activity_at: b.last_activity_at ?? null, stall_warning_sent_at: b.stall_warning_sent_at ?? null }),
  );
  const [sellers, agents, brokers, taxForms, cpas, capTable] = await Promise.all([
    readAll<{ id: string }>(db, "sellers", "id"),
    readAll<{ id: string; eo_expires_at: string | null }>(db, "agents", "id, eo_expires_at"),
    readAll<{ id: string; eo_expires_at: string | null }>(db, "brokers", "id, eo_expires_at"),
    readAll<AnalyticsFacts["taxForms"][number]>(db, "broker_tax_forms", "id, broker_id, form_type, status, expiry_date, created_at"),
    readAll<{ id: string; status: string; auth_user_id: string | null }>(db, "cpa_designations", "id, status, auth_user_id"),
    readAll<{ buyer_account_id: string | null }>(db, "cap_table_entries", "id, buyer_account_id"),
  ]);
  const { data: admins } = await db.from("user_roles").select("user_id").eq("role", "admin");
  const [acks, decls, statements, reservations, approvals, inquiries, memberVerification] = await Promise.all([
    readAll<{ buyer_account_id: string }>(db, "eligibility_page_acknowledgements", "id, buyer_account_id"),
    readAll<{ buyer_account_id: string; status: string }>(db, "eligibility_declarations", "id, buyer_account_id, status"),
    readAll<AnalyticsFacts["statements"][number]>(db, "monthly_statements", "id, property_id, member_key, period, version, status, issued_at"),
    readAll<{ property_id: string; buyer_account_id: string; status: string }>(db, "pod_reservations", "id, property_id, buyer_account_id, status"),
    readAll<{ id: string; property_id: string; stalled_at: string | null }>(db, "listing_content_items", "id, property_id, stalled_at"),
    readAll<AnalyticsFacts["inquiries"][number]>(db, "coowner_inquiries", "id, property_id, status, created_at"),
    readAll<{ id: string; buyer_account_id: string; vetting_status: string | null }>(db, "account_members", "id, buyer_account_id, vetting_status"),
  ]);
  const held = await heldMembers(db as never).catch(() => []);
  const heldByAccount = new Map<string, number>();
  for (const h of held) heldByAccount.set(h.accountId, Math.max(heldByAccount.get(h.accountId) ?? 0, Math.floor((now.getTime() - h.heldSince) / DAY)));

  // When each verification request was made: the audit entry is the record of it. Only the date is read.
  const verifying = new Set(memberVerification.filter((m) => m.vetting_status === "verification_pending").map((m) => m.buyer_account_id));
  const { data: events } = verifying.size ? await db.from("audit_log").select("entity_id, created_at").eq("action_type", "buyer.verification_requested") : { data: [] };
  const since = new Map<string, string>();
  for (const e of (events ?? []) as Array<{ entity_id: string; created_at: string }>) if (!since.has(e.entity_id) || e.created_at < since.get(e.entity_id)!) since.set(e.entity_id, e.created_at);

  return {
    buyers,
    roles: { sellers: sellers.length, agents: agents.length, brokers: brokers.length, admins: new Set(((admins ?? []) as Array<{ user_id: string }>).map((a) => a.user_id)).size, designatedCpas: cpas.filter((c) => c.status === "active").length },
    coOwnerAccounts: new Set(capTable.map((c) => c.buyer_account_id).filter(Boolean)).size,
    eligibilityRead: [...new Set(acks.map((a) => a.buyer_account_id))],
    declarationComplete: [...new Set(decls.filter((d) => d.status === "complete").map((d) => d.buyer_account_id))],
    statements,
    held: [...heldByAccount].map(([accountId, daysHeld]) => ({ accountId, daysHeld })),
    verificationOpen: [...verifying].map((accountId) => ({ accountId, sinceDays: since.has(accountId) ? Math.floor((now.getTime() - new Date(since.get(accountId)!).getTime()) / DAY) : null })),
    reservations: reservations.filter((r) => r.status !== "released" && r.status !== "cancelled").map((r) => ({ property_id: r.property_id, buyer_account_id: r.buyer_account_id })),
    agents,
    brokers,
    taxForms,
    approvalsStalled: approvals.filter((a) => a.stalled_at).map((a) => ({ id: a.id, property_id: a.property_id, stalled_at: a.stalled_at! })),
    inquiries,
    heldReminderDays: (await loadGovernanceConfig(db as never)).heldReminderDays,
  };
}

async function load(db: Db, now: Date) {
  const [founder, facts] = await Promise.all([loadFounderFacts(db), loadAnalyticsFacts(db, now)]);
  const { refreshedAt, ...founderFacts } = founder;
  return { founderFacts, facts, refreshedAt };
}

export async function analyticsBoard(db: Db, p: { userId: string; filters: AnalyticsFilters; now?: Date }) {
  await requireAnalyticsAccess(db, p.userId);
  const now = p.now ?? new Date();
  const { founderFacts, facts, refreshedAt } = await load(db, now);
  const { founder: _founder, ...board } = computeAnalytics(facts, founderFacts, p.filters, now);
  return { ...board, refreshedAt, markets: marketsOf(founderFacts.properties.map((x) => x.state), facts.buyers.map((b) => b.market)) };
}

const marketsOf = (...lists: Array<Array<string | null>>) => [...new Set(lists.flat().map((m) => stateForMarket(m)).filter((s): s is string => !!s))].sort();

export async function reportData(db: Db, p: { userId: string; kind: ReportKind; filters: AnalyticsFilters; now?: Date; inquiryDays?: number }) {
  await requireAnalyticsAccess(db, p.userId);
  const now = p.now ?? new Date();
  const { founderFacts, facts, refreshedAt } = await load(db, now);
  const markets = marketsOf(founderFacts.properties.map((x) => x.state), facts.buyers.map((b) => b.market));
  if (p.kind === "pod_activity") return { kind: p.kind as "pod_activity", report: podActivityReport(founderFacts, p.filters, now), refreshedAt, markets };
  if (p.kind === "revenue") return { kind: p.kind as "revenue", report: revenueReport(founderFacts, p.filters, now), refreshedAt, markets };
  return { kind: p.kind as "compliance", report: complianceReport(facts, founderFacts, p.filters, now, { inquiryDays: p.inquiryDays }), refreshedAt, markets };
}

/** A CSV of a report. Logged every time: who, which report, which filters, how many rows, and a hash of exactly what was handed over. */
export async function exportReport(db: Db, p: { userId: string; kind: ReportKind; filters: AnalyticsFilters; request?: { ip: string | null; userAgent: string | null }; now?: Date; inquiryDays?: number }) {
  const role = await requireAnalyticsAccess(db, p.userId);
  const r = await reportData(db, p);
  const text = r.kind === "pod_activity" ? reportCsv("pod_activity", r.report, p.filters) : r.kind === "revenue" ? reportCsv("revenue", r.report, p.filters) : reportCsv("compliance", r.report, p.filters);
  const rows = r.kind === "pod_activity" ? r.report.rows.length : r.kind === "revenue" ? r.report.byMonth.length : r.report.rows.length;
  const hash = createHash("sha256").update(text).digest("hex");
  await db.from("audit_log").insert({
    actor_id: p.userId,
    actor_type: role,
    action_type: "analytics.report_exported",
    entity_type: "admin_report",
    entity_id: null,
    metadata: { report: p.kind, format: "csv", filters: p.filters, rows, sha256: hash, ip_address: p.request?.ip ?? null, user_agent: p.request?.userAgent ?? null },
  });
  const day = (p.now ?? new Date()).toISOString().slice(0, 10);
  return { filename: `${p.kind.replace("_", "-")}-${day}.csv`, csv: text, rows, sha256: hash };
}
