/**
 * Founder Dashboard: every number from recorded facts, in one pure calculation.
 * Nothing here is estimated. A figure that isn't recorded shows as not recorded, and
 * test-mode payments and simulated closings are kept apart from real money.
 */

import { BUDGET_BUCKETS } from "./budget-buckets";
import { stateForMarket } from "./markets";

export interface PropertyFact {
  id: string;
  city: string | null;
  state: string | null;
  listing_price: number | null;
  status: string | null;
  listing_status: string | null;
  hard_locked: boolean | null;
  published_at: string | null;
  deed_recorded_at: string | null;
  eight_of_eight_at: string | null;
  closing_simulated: boolean | null;
}
export interface PefFact {
  key: string;
  source: "buyer" | "seller";
  environment: string | null;
  amount_cents: number;
  cleared_at: string;
  market: string | null;
}
export interface CommissionFact {
  id: string;
  state: string | null;
  role: string;
  premium_received_cents: number;
  agent_yield_cents: number;
  unlocked_at: string;
  closing_simulated: boolean | null;
}
export interface BuyerFact {
  id: string;
  market: string | null;
  budget_bucket: string | null;
  onboarding_status: string | null;
  created_at: string;
  referring_agent_id: string | null;
  referring_agent_name: string | null;
  referral_token: string | null;
  referral_label: string | null;
  stamp_agent_id: string | null;
  stamp_agent_name: string | null;
  stamp_token: string | null;
  stamp_label: string | null;
}
export interface ShareFact {
  key: string;
  state: string | null;
  retention_lock_expires_at: string | null;
  exception_approved: boolean | null;
}
export interface EventFact {
  id: string;
  state: string | null;
  status: string;
  created_at: string;
}
export interface FounderFacts {
  properties: PropertyFact[];
  pef: PefFact[];
  commissions: CommissionFact[];
  buyers: BuyerFact[];
  shares: ShareFact[];
  exceptions: EventFact[];
  resale: EventFact[];
}
export interface FounderFilters {
  from: string | null;
  to: string | null;
  state: string | null;
}

const DAY_MS = 86_400_000;
export const UNKNOWN_MARKET = "Not recognized";

const inRange = (iso: string | null | undefined, f: FounderFilters) => {
  if (!iso) return false;
  const day = iso.slice(0, 10);
  return (!f.from || day >= f.from) && (!f.to || day <= f.to);
};
const inState = (raw: string | null | undefined, f: FounderFilters) => !f.state || stateForMarket(raw) === f.state;
const dayLabel = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const round1 = (n: number) => Math.round(n * 10) / 10;
const average = (values: number[]) => (values.length ? round1(values.reduce((s, v) => s + v, 0) / values.length) : null);
const daysBetween = (a: string | null, b: string | null) => {
  if (!a || !b) return null;
  const days = (new Date(b).getTime() - new Date(a).getTime()) / DAY_MS;
  return days < 0 ? null : round1(days); // out-of-order dates are bad data, not a negative speed
};

export type UnitStatus = "live" | "hard_locked" | "system_locked" | "closing_ready" | "active";
export const UNIT_STATUS_LABELS: Record<UnitStatus, string> = {
  live: "Live",
  hard_locked: "Hard-locked",
  system_locked: "System-locked",
  closing_ready: "Closing-ready",
  active: "Active",
};

/** One status per property. A listing not yet public isn't counted at all. */
export function unitStatus(p: Pick<PropertyFact, "status" | "listing_status" | "hard_locked">): UnitStatus | null {
  if (p.listing_status === "active") return "active";
  if (p.listing_status === "closing_ready") return "closing_ready";
  if (p.listing_status === "system_lock") return "system_locked";
  if (p.status !== "listed") return null;
  return p.hard_locked ? "hard_locked" : "live";
}

export function computeFounderDashboard(facts: FounderFacts, filters: FounderFilters, now = new Date()) {
  // 1. GTV
  const closed = facts.properties.filter((p) => p.deed_recorded_at && inRange(p.deed_recorded_at, filters) && inState(p.state, filters));
  const priced = closed.filter((p) => p.listing_price != null);
  const value = (rows: PropertyFact[]) => rows.reduce((s, p) => s + Number(p.listing_price), 0);
  const gtv = {
    total: value(priced.filter((p) => !p.closing_simulated)),
    closedCount: priced.filter((p) => !p.closing_simulated).length,
    simulatedTotal: value(priced.filter((p) => p.closing_simulated)),
    simulatedCount: priced.filter((p) => p.closing_simulated).length,
    missingPriceCount: closed.length - priced.length,
  };

  // 2. Revenue streams
  const pefRows = facts.pef.filter((r) => inRange(r.cleared_at, filters) && inState(r.market, filters));
  const pefReal = pefRows.filter((r) => r.environment === "live");
  const pefTest = pefRows.filter((r) => r.environment !== "live");
  const cents = (rows: PefFact[]) => rows.reduce((s, r) => s + Number(r.amount_cents), 0);
  const ledger = facts.commissions.filter((r) => inRange(r.unlocked_at, filters) && inState(r.state, filters));
  const sumLedger = (key: "premium_received_cents" | "agent_yield_cents", simulated: boolean) =>
    ledger.filter((r) => Boolean(r.closing_simulated) === simulated).reduce((s, r) => s + Number(r[key]), 0);
  const streams = {
    pef: {
      realCents: cents(pefReal),
      realCount: pefReal.length,
      buyerCount: pefReal.filter((r) => r.source === "buyer").length,
      sellerCount: pefReal.filter((r) => r.source === "seller").length,
      testCents: cents(pefTest),
      testCount: pefTest.length,
    },
    recorded: ledger.length > 0,
    premium: { realCents: sumLedger("premium_received_cents", false), testCents: sumLedger("premium_received_cents", true) },
    agentYield: { realCents: sumLedger("agent_yield_cents", false), testCents: sumLedger("agent_yield_cents", true) },
  };

  // 3. Unit velocity
  const inMarket = facts.properties.filter((p) => inState(p.state, filters));
  const counts: Record<UnitStatus, number> = { live: 0, hard_locked: 0, system_locked: 0, closing_ready: 0, active: 0 };
  for (const p of inMarket) {
    const s = unitStatus(p);
    if (s) counts[s] += 1;
  }
  const velocityRows = inMarket
    .filter((p) => inRange(p.published_at, filters))
    .map((p) => ({
      property: `${[p.city, p.state].filter(Boolean).join(", ") || "Property"} · #${p.id.slice(0, 6)}`,
      status: unitStatus(p),
      liveOn: dayLabel(p.published_at),
      filledOn: dayLabel(p.eight_of_eight_at),
      closedOn: dayLabel(p.deed_recorded_at),
      liveToFull: daysBetween(p.published_at, p.eight_of_eight_at),
      fullToClosed: daysBetween(p.eight_of_eight_at, p.deed_recorded_at),
      liveToClosed: daysBetween(p.published_at, p.deed_recorded_at),
    }))
    .sort((a, b) => b.liveOn.localeCompare(a.liveOn));
  const velocity = {
    counts,
    averages: {
      liveToFull: average(velocityRows.map((r) => r.liveToFull).filter((v): v is number => v != null)),
      fullToClosed: average(velocityRows.map((r) => r.fullToClosed).filter((v): v is number => v != null)),
      liveToClosed: average(velocityRows.map((r) => r.liveToClosed).filter((v): v is number => v != null)),
    },
    rows: velocityRows,
  };

  // 4. Referral map
  const buyers = facts.buyers.filter((b) => inRange(b.created_at, filters) && inState(b.market, filters));
  const agents = new Map<string, { agent: string; buyers: Set<string>; viaLink: number; viaQr: number }>();
  const tokens = new Map<string, { token: string; label: string; agent: string; kind: string; buyers: number }>();
  const addAgent = (id: string, name: string | null, buyerId: string, kind: "viaLink" | "viaQr") => {
    const row = agents.get(id) ?? { agent: name || "Agent", buyers: new Set<string>(), viaLink: 0, viaQr: 0 };
    row.buyers.add(buyerId);
    row[kind] += 1;
    agents.set(id, row);
  };
  const addToken = (token: string, label: string | null, agent: string | null, kind: string) => {
    const row = tokens.get(`${kind}:${token}`) ?? { token, label: label || "", agent: agent || "Agent", kind, buyers: 0 };
    row.buyers += 1;
    tokens.set(`${kind}:${token}`, row);
  };
  for (const b of buyers) {
    if (b.referring_agent_id) addAgent(b.referring_agent_id, b.referring_agent_name, b.id, "viaLink");
    if (b.stamp_agent_id) addAgent(b.stamp_agent_id, b.stamp_agent_name, b.id, "viaQr");
    if (b.referral_token) addToken(b.referral_token, b.referral_label, b.referring_agent_name, "Referral link");
    if (b.stamp_token) addToken(b.stamp_token, b.stamp_label, b.stamp_agent_name, "QR / deep link");
  }
  const referrals = {
    attributedBuyers: buyers.filter((b) => b.referring_agent_id || b.stamp_agent_id).length,
    totalBuyers: buyers.length,
    topAgents: [...agents.values()]
      .map((a) => ({ agent: a.agent, buyers: a.buyers.size, viaLink: a.viaLink, viaQr: a.viaQr }))
      .sort((a, b) => b.buyers - a.buyers || a.agent.localeCompare(b.agent))
      .slice(0, 10),
    topTokens: [...tokens.values()].sort((a, b) => b.buyers - a.buyers || a.token.localeCompare(b.token)).slice(0, 10),
  };

  // 5. Market demand
  const NOT_PROVIDED = "not_provided";
  const bucketIds = [...BUDGET_BUCKETS.map((b) => b.id), NOT_PROVIDED];
  const demandMap = new Map<string, { market: string; buyers: Record<string, number>; totalBuyers: number; listings: number }>();
  const demandRow = (market: string) => {
    const row = demandMap.get(market) ?? { market, buyers: Object.fromEntries(bucketIds.map((id) => [id, 0])), totalBuyers: 0, listings: 0 };
    demandMap.set(market, row);
    return row;
  };
  for (const b of buyers) {
    if (b.onboarding_status === "archived") continue;
    const row = demandRow(stateForMarket(b.market) ?? UNKNOWN_MARKET);
    const bucket = b.budget_bucket && bucketIds.includes(b.budget_bucket) ? b.budget_bucket : NOT_PROVIDED;
    row.buyers[bucket]! += 1;
    row.totalBuyers += 1;
  }
  for (const p of inMarket) {
    if (unitStatus(p) === "live" || unitStatus(p) === "hard_locked") {
      if (inRange(p.published_at, filters) || (!filters.from && !filters.to)) demandRow(stateForMarket(p.state) ?? UNKNOWN_MARKET).listings += 1;
    }
  }
  const demand = {
    buckets: [...BUDGET_BUCKETS.map((b) => ({ id: b.id, label: b.label })), { id: NOT_PROVIDED, label: "Not provided" }],
    rows: [...demandMap.values()].sort((a, b) => b.totalBuyers - a.totalBuyers || b.listings - a.listings || a.market.localeCompare(b.market)),
  };

  // 6. Retention pulse. Shares are as of now; exceptions and listings follow the dates.
  const shares = facts.shares.filter((s) => inState(s.state, filters));
  const within = shares.filter((s) => s.retention_lock_expires_at && new Date(s.retention_lock_expires_at).getTime() > now.getTime() && !s.exception_approved).length;
  const exceptions = facts.exceptions.filter((e) => inRange(e.created_at, filters) && inState(e.state, filters));
  const resale = facts.resale.filter((r) => inRange(r.created_at, filters) && inState(r.state, filters));
  const pct = (n: number) => (shares.length ? round1((n / shares.length) * 100) : null);
  const retention = {
    totalShares: shares.length,
    withinLock: within,
    pastLock: shares.length - within,
    pctWithin: pct(within),
    pctPast: pct(shares.length - within),
    exceptions: exceptions.length,
    exceptionsPending: exceptions.filter((e) => e.status === "pending").length,
    exceptionsApproved: exceptions.filter((e) => e.status === "approved").length,
    resaleListings: resale.length,
    resaleLive: resale.filter((r) => ["rofr_open", "rofr_exercised", "open_market"].includes(r.status)).length,
    rofrOpen: resale.filter((r) => r.status === "rofr_open").length,
  };

  const states = new Set<string>();
  for (const raw of [...facts.properties.map((p) => p.state), ...facts.buyers.map((b) => b.market)]) {
    const s = stateForMarket(raw);
    if (s) states.add(s);
  }

  return { gtv, streams, velocity, referrals, demand, retention, states: [...states].sort() };
}

export type FounderDashboard = ReturnType<typeof computeFounderDashboard>;
/**
 * What the money lines are called. Only the Platform Enrollment Fee is divieight's revenue. The Heavy Lifter Premium and
 * the Participating Agent Yield are paid broker to broker through title: they are recorded here, never added to
 * revenue, and never added to each other. (Labels only: the numbers behind them are unchanged.)
 */
export const PLATFORM_REVENUE_LABEL = "Platform revenue (Platform Enrollment Fees)";
export const AGENT_PAYOUTS_LABEL = "Agent payouts recorded (not revenue)";
export const AGENT_PAYOUTS_NOTE = "Paid broker to broker through title, not received by divieight";
export const AGENT_YIELD_DEFINITION =
  "Participating Agent Yield: the resident and referring agents' share of the commission after the Heavy Lifter Premium is taken out. Premium plus yield equals the total commission.";

export type FounderWidget = "gtv" | "revenue" | "velocity" | "referrals" | "demand" | "retention";

/** A leading = + - @ would run as a formula in a spreadsheet: names here are typed by people. */
function csvCell(value: string | number | null): string {
  if (value == null) return "";
  if (typeof value === "number") return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
const csv = (rows: Array<Array<string | number | null>>) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
const dollars = (cents: number) => Math.round(cents) / 100;

/** Aggregates only, the same figures the page shows. */
export function founderCsv(widget: FounderWidget, d: FounderDashboard): string {
  switch (widget) {
    case "gtv":
      return csv([
        ["Measure", "Value"],
        ["Total GTV (USD)", d.gtv.total],
        ["Properties closed", d.gtv.closedCount],
        ["Simulated closings GTV (USD), not included", d.gtv.simulatedTotal],
        ["Simulated closings, not included", d.gtv.simulatedCount],
        ["Closed with no price recorded, not included", d.gtv.missingPriceCount],
      ]);
    case "revenue":
      return csv([
        ["Line", "Recorded (USD)", "Count", "Test or simulated, not included (USD)", "Note"],
        [PLATFORM_REVENUE_LABEL, dollars(d.streams.pef.realCents), d.streams.pef.realCount, dollars(d.streams.pef.testCents), "Cleared Platform Enrollment Fees only"],
        [AGENT_PAYOUTS_LABEL, "", "", "", AGENT_PAYOUTS_NOTE],
        ["Heavy Lifter Premium", d.streams.recorded ? dollars(d.streams.premium.realCents) : "Not yet recorded", null, dollars(d.streams.premium.testCents), AGENT_PAYOUTS_NOTE],
        ["Participating Agent Yield", d.streams.recorded ? dollars(d.streams.agentYield.realCents) : "Not yet recorded", null, dollars(d.streams.agentYield.testCents), AGENT_PAYOUTS_NOTE],
      ]);
    case "velocity":
      return csv([
        ["Status", "Properties"],
        ...(Object.keys(UNIT_STATUS_LABELS) as UnitStatus[]).map((s) => [UNIT_STATUS_LABELS[s], d.velocity.counts[s]]),
        [],
        ["Property", "Status", "Live", "8/8", "Closed", "Days live to 8/8", "Days 8/8 to closed", "Days live to closed"],
        ...d.velocity.rows.map((r) => [r.property, r.status ? UNIT_STATUS_LABELS[r.status] : "", r.liveOn, r.filledOn, r.closedOn, r.liveToFull, r.fullToClosed, r.liveToClosed]),
        ["Average", "", "", "", "", d.velocity.averages.liveToFull, d.velocity.averages.fullToClosed, d.velocity.averages.liveToClosed],
      ]);
    case "referrals":
      return csv([
        ["Agent", "Buyers", "Via referral link", "Via QR / deep link"],
        ...d.referrals.topAgents.map((a) => [a.agent, a.buyers, a.viaLink, a.viaQr]),
        [],
        ["Token", "Label", "Agent", "Type", "Buyers"],
        ...d.referrals.topTokens.map((t) => [t.token, t.label, t.agent, t.kind, t.buyers]),
      ]);
    case "demand":
      return csv([
        ["Market", ...d.demand.buckets.map((b) => b.label), "Total buyers", "Listings"],
        ...d.demand.rows.map((r) => [r.market, ...d.demand.buckets.map((b) => r.buyers[b.id] ?? 0), r.totalBuyers, r.listings]),
      ]);
    case "retention":
      return csv([
        ["Measure", "Value"],
        ["Issued shares", d.retention.totalShares],
        ["Within Retention Lock", d.retention.withinLock],
        ["Past or released from Retention Lock", d.retention.pastLock],
        ["% within", d.retention.pctWithin],
        ["% past or released", d.retention.pctPast],
        ["Retention exceptions", d.retention.exceptions],
        ["Exceptions pending", d.retention.exceptionsPending],
        ["Exceptions approved", d.retention.exceptionsApproved],
        ["Resale listings", d.retention.resaleListings],
        ["Resale listings live", d.retention.resaleLive],
        ["ROFR open", d.retention.rofrOpen],
      ]);
  }
}
