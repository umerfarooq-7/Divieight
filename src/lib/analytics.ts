/**
 * Platform analytics and admin reports: pure calculation over recorded facts. Aggregates and anonymous references only: no names, no emails, no phone
 * numbers, no addresses, no tax identifiers. The money and pod figures come from the Founder Dashboard's own calculation (computeFounderDashboard), fed from
 * the same facts, so no figure is worked out twice.
 */
import {
  AGENT_PAYOUTS_LABEL,
  AGENT_PAYOUTS_NOTE,
  PLATFORM_REVENUE_LABEL,
  UNIT_STATUS_LABELS,
  computeFounderDashboard,
  csv,
  dollars,
  inRange,
  inState,
  unitStatus,
  type FounderFacts,
  type FounderFilters,
  type UnitStatus,
} from "@/lib/founder";
import { evaluateMaintenance, STALL_DAYS } from "@/lib/enrollment-maintenance";
import { stateForMarket } from "@/lib/markets";
import { isEoExpired } from "@/lib/eo-expiry";
import { gateStateFromForms } from "@/lib/tax-forms";
import { nthBusinessDay, STATEMENT_DEADLINE_BUSINESS_DAYS } from "@/lib/statements";

export type AnalyticsFilters = FounderFilters;
export const DAY_MS = 86_400_000;
/** An open co-owner inquiry older than this many days is a compliance flag. */
export const INQUIRY_STALE_DAYS = 14;

export interface BuyerAcct {
  id: string;
  created_at: string;
  onboarding_status: string | null;
  priority_rank_timestamp: string | null;
  golden_ticket_issued: boolean | null;
  golden_ticket_issued_at: string | null;
  market: string | null;
  last_activity_at: string | null;
  stall_warning_sent_at: string | null;
}
export interface StatementFact {
  property_id: string;
  member_key: string;
  period: string;
  version: number;
  status: string;
  issued_at: string | null;
}
export interface AnalyticsFacts {
  buyers: BuyerAcct[];
  roles: { sellers: number; agents: number; brokers: number; admins: number; designatedCpas: number };
  coOwnerAccounts: number;
  eligibilityRead: string[];
  declarationComplete: string[];
  statements: StatementFact[];
  held: Array<{ accountId: string; daysHeld: number }>;
  verificationOpen: Array<{ accountId: string; sinceDays: number | null }>;
  reservations: Array<{ property_id: string; buyer_account_id: string }>;
  agents: Array<{ id: string; eo_expires_at: string | null }>;
  brokers: Array<{ id: string; eo_expires_at: string | null }>;
  taxForms: Array<{ broker_id: string; form_type: string; status: string; expiry_date: string | null; created_at: string | null }>;
  approvalsStalled: Array<{ id: string; property_id: string; stalled_at: string }>;
  inquiries: Array<{ id: string; property_id: string; status: string; created_at: string }>;
  heldReminderDays: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const average = (values: number[]) => (values.length ? round1(values.reduce((s, v) => s + v, 0) / values.length) : null);
const daysBetween = (a: string | null, b: string | null) => {
  if (!a || !b) return null;
  const d = (new Date(b).getTime() - new Date(a).getTime()) / DAY_MS;
  return d < 0 ? null : round1(d);
};
const pct = (n: number, of: number) => (of ? round1((n / of) * 100) : null);
/** An anonymous reference: what kind of record, and the first characters of its id. Never a name. */
export const anon = (kind: string, id: string) => `${kind} #${String(id).slice(0, 6)}`;

// ---------------------------------------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------------------------------------
/** The deadline for a month's statements: the fifth business day of the month after. */
export function statementDeadline(period: string): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7)); // 1-12; next month's index is m
  return m === 12 ? nthBusinessDay(y + 1, 0, STATEMENT_DEADLINE_BUSINESS_DAYS) : nthBusinessDay(y, m, STATEMENT_DEADLINE_BUSINESS_DAYS);
}

/** Per statement (LLC, member, month): issued by the deadline, issued late, or still a draft past the deadline. */
export function statementTiming(statements: StatementFact[], today: string) {
  const groups = new Map<string, StatementFact[]>();
  for (const s of statements) groups.set(`${s.property_id}|${s.member_key}|${s.period}`, [...(groups.get(`${s.property_id}|${s.member_key}|${s.period}`) ?? []), s]);
  const out: Array<{ propertyId: string; period: string; deadline: string; state: "on_time" | "late" | "overdue_draft" | "not_due"; issuedAt: string | null; daysLate: number }> = [];
  for (const rows of groups.values()) {
    const first = rows.filter((r) => r.issued_at).sort((a, b) => String(a.issued_at).localeCompare(String(b.issued_at)))[0] ?? null;
    const deadline = statementDeadline(rows[0]!.period);
    const base = { propertyId: rows[0]!.property_id, period: rows[0]!.period, deadline, issuedAt: first?.issued_at ?? null };
    if (first) {
      const late = first.issued_at!.slice(0, 10) > deadline;
      out.push({ ...base, state: late ? "late" : "on_time", daysLate: late ? Math.round((new Date(first.issued_at!.slice(0, 10)).getTime() - new Date(deadline).getTime()) / DAY_MS) : 0 });
    } else if (today > deadline) {
      out.push({ ...base, state: "overdue_draft", daysLate: Math.round((new Date(today).getTime() - new Date(deadline).getTime()) / DAY_MS) });
    } else out.push({ ...base, state: "not_due", daysLate: 0 });
  }
  return out;
}

export function computeAnalytics(facts: AnalyticsFacts, founderFacts: FounderFacts, filters: AnalyticsFilters, now: Date = new Date()) {
  const founder = computeFounderDashboard(founderFacts, filters, now);
  const stateOfProperty = new Map(founderFacts.properties.map((p) => [p.id, p.state]));
  const acctOk = (b: BuyerAcct) => inRange(b.created_at, filters) && inState(b.market, filters);
  const accounts = facts.buyers.filter(acctOk);
  const ids = new Set(accounts.map((a) => a.id));

  const users = {
    buyerAccounts: accounts.length,
    coOwnerAccounts: facts.coOwnerAccounts,
    sellers: facts.roles.sellers,
    agents: facts.roles.agents,
    brokers: facts.roles.brokers,
    designatedCpas: facts.roles.designatedCpas,
    admins: facts.roles.admins,
  };

  const read = new Set(facts.eligibilityRead.filter((id) => ids.has(id)));
  const declared = new Set(facts.declarationComplete.filter((id) => ids.has(id)));
  const paid = accounts.filter((a) => a.priority_rank_timestamp);
  const golden = accounts.filter((a) => a.golden_ticket_issued);
  const steps = [
    { key: "registered", label: "Registered", count: accounts.length },
    { key: "eligibility_read", label: "Eligibility page read", count: read.size },
    { key: "declaration_complete", label: "Declaration complete", count: declared.size },
    { key: "fee_paid", label: "Platform Enrollment Fee paid", count: paid.length },
    { key: "golden_ticket", label: "Golden Ticket issued", count: golden.length },
  ];
  const funnel = steps.map((s, i) => ({ ...s, pctOfRegistered: pct(s.count, accounts.length), pctOfPrevious: i === 0 ? null : pct(s.count, steps[i - 1]!.count) }));

  const milestones = {
    registeredToFeePaid: average(paid.map((a) => daysBetween(a.created_at, a.priority_rank_timestamp)).filter((v): v is number => v != null)),
    feePaidToGoldenTicket: average(golden.map((a) => daysBetween(a.priority_rank_timestamp, a.golden_ticket_issued_at)).filter((v): v is number => v != null)),
    listedToEightOfEight: founder.velocity.averages.liveToFull,
    eightOfEightToClosed: founder.velocity.averages.fullToClosed,
    listedToClosed: founder.velocity.averages.liveToClosed,
  };

  const today = now.toISOString().slice(0, 10);
  const timing = statementTiming(facts.statements, today).filter((t) => {
    const state = stateForMarket(stateOfProperty.get(t.propertyId));
    return (!filters.state || state === filters.state) && (!filters.from || t.deadline >= filters.from) && (!filters.to || t.deadline <= filters.to);
  });
  const count = (s: string) => timing.filter((t) => t.state === s).length;
  const due = timing.filter((t) => t.state !== "not_due");
  const statements = { total: due.length, issuedOnTime: count("on_time"), issuedLate: count("late"), overdueDrafts: count("overdue_draft"), pctOnTime: pct(count("on_time"), due.length) };

  const heldAccts = new Set(facts.held.filter((h) => { const a = facts.buyers.find((b) => b.id === h.accountId); return !filters.state || (a && inState(a.market, filters)); }).map((h) => h.accountId));
  const verification = facts.verificationOpen.filter((v) => { const a = facts.buyers.find((b) => b.id === v.accountId); return !filters.state || (a && inState(a.market, filters)); });

  return {
    users,
    funnel,
    milestones,
    pods: { counts: founder.velocity.counts, labels: UNIT_STATUS_LABELS, total: (Object.values(founder.velocity.counts) as number[]).reduce((s, n) => s + n, 0) },
    resale: { listings: founder.retention.resaleListings, live: founder.retention.resaleLive, rofrOpen: founder.retention.rofrOpen },
    statements,
    heldAccounts: heldAccts.size,
    openVerificationRequests: verification.length,
    founder,
  };
}
export type AnalyticsBoard = ReturnType<typeof computeAnalytics>;

// ---------------------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------------------
export type ReportKind = "pod_activity" | "revenue" | "compliance";
export const REPORT_KINDS: ReportKind[] = ["pod_activity", "revenue", "compliance"];
export const REPORT_LABELS: Record<ReportKind, string> = { pod_activity: "Pod activity", revenue: "Revenue tracking", compliance: "Compliance flags" };

export function podActivityReport(founderFacts: FounderFacts, filters: AnalyticsFilters, now: Date = new Date()) {
  const f = computeFounderDashboard(founderFacts, filters, now);
  return { counts: f.velocity.counts, averages: f.velocity.averages, rows: f.velocity.rows };
}
export type PodActivityReport = ReturnType<typeof podActivityReport>;

export function revenueReport(founderFacts: FounderFacts, filters: AnalyticsFilters, now: Date = new Date()) {
  const f = computeFounderDashboard(founderFacts, filters, now);
  // Revenue is the Platform Enrollment Fee, cleared, in live mode. Test-mode payments are shown apart and never added in.
  const cleared = founderFacts.pef.filter((r) => inRange(r.cleared_at, filters) && inState(r.market, filters) && r.environment === "live");
  const byMonth = new Map<string, { month: string; buyer: number; seller: number; cents: number }>();
  for (const r of cleared) {
    const month = r.cleared_at.slice(0, 7);
    const row = byMonth.get(month) ?? { month, buyer: 0, seller: 0, cents: 0 };
    row[r.source] += 1;
    row.cents += Number(r.amount_cents);
    byMonth.set(month, row);
  }
  return {
    platformRevenue: { label: PLATFORM_REVENUE_LABEL, cents: f.streams.pef.realCents, count: f.streams.pef.realCount, buyerFees: f.streams.pef.buyerCount, sellerFees: f.streams.pef.sellerCount },
    testMode: { label: "Test-mode payments (not revenue)", cents: f.streams.pef.testCents, count: f.streams.pef.testCount },
    agentPayouts: {
      label: AGENT_PAYOUTS_LABEL,
      note: AGENT_PAYOUTS_NOTE,
      recorded: f.streams.recorded,
      heavyLifterPremiumCents: f.streams.premium.realCents,
      participatingAgentYieldCents: f.streams.agentYield.realCents,
    },
    byMonth: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
  };
}
export type RevenueReport = ReturnType<typeof revenueReport>;

export type ComplianceFlag =
  | "missing_tax_form"
  | "expired_eo"
  | "stalled_pod"
  | "listing_approval_stalled"
  | "verification_request_open"
  | "held_account_overdue"
  | "statement_late"
  | "inquiry_open_too_long";
export const COMPLIANCE_LABELS: Record<ComplianceFlag, string> = {
  missing_tax_form: "Broker of Record without a valid tax form",
  expired_eo: "Expired E&O coverage",
  stalled_pod: "Stalled pod (buyer enrollment stalled)",
  listing_approval_stalled: "Listing approval stalled",
  verification_request_open: "Unresolved verification request",
  held_account_overdue: "Held account past the reminder window",
  statement_late: "Late monthly statement",
  inquiry_open_too_long: "Open co-owner inquiry past the limit",
};
export interface ComplianceRow {
  flag: ComplianceFlag;
  label: string;
  /** An anonymous reference, never a name. */
  ref: string;
  market: string | null;
  since: string | null;
  ageDays: number | null;
  detail: string;
}

export function complianceReport(facts: AnalyticsFacts, founderFacts: FounderFacts, filters: AnalyticsFilters, now: Date = new Date(), opts: { inquiryDays?: number } = {}) {
  const today = now.toISOString().slice(0, 10);
  const inquiryDays = opts.inquiryDays ?? INQUIRY_STALE_DAYS;
  const propState = new Map(founderFacts.properties.map((p) => [p.id, stateForMarket(p.state)]));
  const acct = new Map(facts.buyers.map((b) => [b.id, b]));
  const rows: ComplianceRow[] = [];
  const age = (since: string | null) => (since ? Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / DAY_MS)) : null);
  // A flag with a date is in the date range when that date is; a flag with a market is in the market filter when it matches. A flag with no market of its own
  // (a broker's tax form, an agent's E&O) is shown only when no market is chosen.
  const keep = (since: string | null, market: string | null) => {
    if ((filters.from || filters.to) && since && !inRange(since, filters)) return false;
    if (filters.state && stateForMarket(market) !== filters.state) return false;
    return true;
  };
  const add = (r: Omit<ComplianceRow, "label" | "ageDays">) => {
    if (keep(r.since, r.market)) rows.push({ ...r, label: COMPLIANCE_LABELS[r.flag], ageDays: age(r.since) });
  };

  // Missing or expired tax forms: the same gate the payout uses.
  for (const b of facts.brokers) {
    const gate = gateStateFromForms(facts.taxForms.filter((t) => t.broker_id === b.id) as never, today);
    if (!gate.allowed) add({ flag: "missing_tax_form", ref: anon("Broker", b.id), market: null, since: gate.expiry ?? null, detail: gate.state === "expired" ? "Tax form expired" : gate.state === "rejected" ? "Tax form rejected" : "No valid tax form on file" });
  }
  // Expired E&O, for agents and brokers.
  for (const [kind, list] of [["Agent", facts.agents], ["Broker", facts.brokers]] as const) {
    for (const p of list) if (isEoExpired(p.eo_expires_at, now)) add({ flag: "expired_eo", ref: anon(kind, p.id), market: null, since: p.eo_expires_at, detail: "E&O coverage has lapsed" });
  }
  // Stalled pods: a pod holding a reserved buyer account whose enrollment has stalled under the 30-day maintenance rule.
  const byProperty = new Map<string, string[]>();
  for (const r of facts.reservations) byProperty.set(r.property_id, [...(byProperty.get(r.property_id) ?? []), r.buyer_account_id]);
  for (const [propertyId, accountIds] of byProperty) {
    const prop = founderFacts.properties.find((p) => p.id === propertyId);
    if (prop && unitStatus(prop) === "active") continue;
    let stalled = 0;
    let longest = 0;
    for (const id of new Set(accountIds)) {
      const a = acct.get(id);
      if (!a) continue;
      const m = evaluateMaintenance({ goldenTicketIssued: !!a.golden_ticket_issued, onboardingStatus: a.onboarding_status ?? "", paid: !!a.priority_rank_timestamp, lastActivityAt: a.last_activity_at, stallWarningSentAt: a.stall_warning_sent_at, now: now.getTime() });
      const isPaid = !!a.priority_rank_timestamp;
      if (isPaid && !a.golden_ticket_issued && a.onboarding_status !== "archived" && (m.action !== "none" || m.daysInactive >= STALL_DAYS)) {
        stalled += 1;
        longest = Math.max(longest, m.daysInactive);
      }
    }
    if (stalled > 0) add({ flag: "stalled_pod", ref: anon("Pod", propertyId), market: prop?.state ?? null, since: new Date(now.getTime() - longest * DAY_MS).toISOString(), detail: `${stalled} of ${new Set(accountIds).size} buyer account${new Set(accountIds).size === 1 ? "" : "s"} stalled for ${STALL_DAYS}+ days` });
  }
  for (const s of facts.approvalsStalled) add({ flag: "listing_approval_stalled", ref: anon("Listing", s.property_id), market: founderFacts.properties.find((p) => p.id === s.property_id)?.state ?? null, since: s.stalled_at, detail: "A listing approval item was flagged as stalled" });
  for (const v of facts.verificationOpen) {
    const a = acct.get(v.accountId);
    add({ flag: "verification_request_open", ref: anon("Account", v.accountId), market: a?.market ?? null, since: v.sinceDays != null ? new Date(now.getTime() - v.sinceDays * DAY_MS).toISOString() : null, detail: "A verification request has not been resolved" });
  }
  for (const h of facts.held) {
    if (h.daysHeld < facts.heldReminderDays) continue;
    add({ flag: "held_account_overdue", ref: anon("Account", h.accountId), market: acct.get(h.accountId)?.market ?? null, since: new Date(now.getTime() - h.daysHeld * DAY_MS).toISOString(), detail: `Held for ${h.daysHeld} days (reminder window ${facts.heldReminderDays})` });
  }
  for (const t of statementTiming(facts.statements, today)) {
    if (t.state !== "late" && t.state !== "overdue_draft") continue;
    add({ flag: "statement_late", ref: anon("LLC", t.propertyId), market: propState.get(t.propertyId) ?? null, since: t.deadline, detail: t.state === "late" ? `${t.period} statement issued ${t.daysLate} day${t.daysLate === 1 ? "" : "s"} after the deadline` : `${t.period} statement still a draft, ${t.daysLate} day${t.daysLate === 1 ? "" : "s"} past the deadline` });
  }
  for (const q of facts.inquiries) {
    if (q.status !== "open") continue;
    const days = age(q.created_at) ?? 0;
    if (days < inquiryDays) continue;
    add({ flag: "inquiry_open_too_long", ref: anon("Inquiry", q.id), market: propState.get(q.property_id) ?? null, since: q.created_at, detail: `Open for ${days} days (limit ${inquiryDays})` });
  }

  const order = Object.keys(COMPLIANCE_LABELS);
  rows.sort((a, b) => order.indexOf(a.flag) - order.indexOf(b.flag) || (b.ageDays ?? -1) - (a.ageDays ?? -1) || a.ref.localeCompare(b.ref));
  const byFlag = Object.fromEntries((Object.keys(COMPLIANCE_LABELS) as ComplianceFlag[]).map((k) => [k, rows.filter((r) => r.flag === k).length])) as Record<ComplianceFlag, number>;
  return { rows, byFlag, inquiryDays };
}
export type ComplianceReport = ReturnType<typeof complianceReport>;

// ---------------------------------------------------------------------------------------------------------
// CSV, and the guard that keeps personal information out of it
// ---------------------------------------------------------------------------------------------------------
const FILTER_LINE = (f: AnalyticsFilters) => [`Filters: from ${f.from ?? "any"}`, `to ${f.to ?? "any"}`, `market ${f.state ?? "all"}`].join(", ");

export function reportCsv(kind: "pod_activity", report: PodActivityReport, filters: AnalyticsFilters): string;
export function reportCsv(kind: "revenue", report: RevenueReport, filters: AnalyticsFilters): string;
export function reportCsv(kind: "compliance", report: ComplianceReport, filters: AnalyticsFilters): string;
export function reportCsv(kind: ReportKind, report: PodActivityReport | RevenueReport | ComplianceReport, filters: AnalyticsFilters): string {
  let text: string;
  if (kind === "pod_activity") {
    const r = report as PodActivityReport;
    text = csv([
      [FILTER_LINE(filters)],
      ["Status", "Pods"],
      ...(Object.keys(UNIT_STATUS_LABELS) as UnitStatus[]).map((s) => [UNIT_STATUS_LABELS[s], r.counts[s]]),
      [],
      ["Pod", "Status", "Live", "8/8", "Closed", "Days live to 8/8", "Days 8/8 to closed", "Days live to closed"],
      ...r.rows.map((x) => [x.property, x.status ? UNIT_STATUS_LABELS[x.status] : "", x.liveOn, x.filledOn, x.closedOn, x.liveToFull, x.fullToClosed, x.liveToClosed]),
      ["Average", "", "", "", "", r.averages.liveToFull, r.averages.fullToClosed, r.averages.liveToClosed],
    ]);
  } else if (kind === "revenue") {
    const r = report as RevenueReport;
    text = csv([
      [FILTER_LINE(filters)],
      ["Line", "USD", "Count", "Note"],
      [r.platformRevenue.label, dollars(r.platformRevenue.cents), r.platformRevenue.count, "Cleared Platform Enrollment Fees only"],
      [r.testMode.label, dollars(r.testMode.cents), r.testMode.count, "Test mode: not included in revenue"],
      [],
      [r.agentPayouts.label, "", "", r.agentPayouts.note],
      ["Heavy Lifter Premium recorded", r.agentPayouts.recorded ? dollars(r.agentPayouts.heavyLifterPremiumCents) : "Not yet recorded", "", r.agentPayouts.note],
      ["Participating Agent Yield recorded", r.agentPayouts.recorded ? dollars(r.agentPayouts.participatingAgentYieldCents) : "Not yet recorded", "", r.agentPayouts.note],
      [],
      ["Month", "Buyer fees", "Seller fees", "Platform revenue (USD)"],
      ...r.byMonth.map((m) => [m.month, m.buyer, m.seller, dollars(m.cents)]),
    ]);
  } else {
    const r = report as ComplianceReport;
    text = csv([
      [FILTER_LINE(filters)],
      ["Flag", "Reference", "Market", "Since", "Days", "Detail"],
      ...r.rows.map((x) => [x.label, x.ref, x.market ?? "", x.since ? x.since.slice(0, 10) : "", x.ageDays, x.detail]),
    ]);
  }
  assertNoPii(text);
  return text;
}

const PII_PATTERNS: Array<[string, RegExp]> = [
  ["an email address", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ["a phone number", /(?:\+?\d{1,2}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/],
  ["a tax identifier", /\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b/],
];
/** What looks like personal information in a text, or null. A defence in depth: the reports never read these fields in the first place. */
export function findPii(text: string): string | null {
  for (const [label, re] of PII_PATTERNS) if (re.test(text)) return label;
  return null;
}
export function assertNoPii(text: string) {
  const found = findPii(text);
  if (found) throw new Error(`The export was stopped: it appears to contain ${found}. Reports carry aggregates and anonymous references only.`);
}
