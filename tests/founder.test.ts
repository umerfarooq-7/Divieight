/** Founder Dashboard: the calculation, reconciled by hand; access; filters; CSV; empty states. Real views run on Postgres. */
import { describe, it, expect, vi } from "vitest";
import { harness } from "./setup";
import { seedPod, USERS } from "./fixtures";
import { computeFounderDashboard, founderCsv, unitStatus, type FounderFacts, type FounderFilters } from "@/lib/founder";
import { getFounderDashboard, refreshFounderDashboard } from "@/lib/founder.functions";
import { stateForMarket } from "@/lib/markets";

const ALL: FounderFilters = { from: null, to: null, state: null };
const NOW = new Date("2026-11-01T00:00:00Z");
const empty: FounderFacts = { properties: [], pef: [], commissions: [], buyers: [], shares: [], exceptions: [], resale: [] };
const prop = (o: Partial<FounderFacts["properties"][number]>): FounderFacts["properties"][number] => ({
  id: "abcdef-1", city: "Lusk", state: "WY", listing_price: null, status: "listed", listing_status: "forming", hard_locked: false, published_at: null, deed_recorded_at: null, eight_of_eight_at: null, closing_simulated: false, ...o,
});
const buyer = (o: Partial<FounderFacts["buyers"][number]>): FounderFacts["buyers"][number] => ({
  id: "b", market: "WY", budget_bucket: null, onboarding_status: "active", created_at: "2026-06-01T00:00:00Z", referring_agent_id: null, referring_agent_name: null, referral_token: null, referral_label: null, stamp_agent_id: null, stamp_agent_name: null, stamp_token: null, stamp_label: null, ...o,
});
const run = (facts: Partial<FounderFacts>, filters: Partial<FounderFilters> = {}) => computeFounderDashboard({ ...empty, ...facts }, { ...ALL, ...filters }, NOW);

describe("Total GTV", () => {
  const facts = {
    properties: [
      prop({ id: "real-1", listing_price: 2_500_000, deed_recorded_at: "2026-03-01T00:00:00Z" }),
      prop({ id: "real-2", state: "CO", listing_price: 1_000_000, deed_recorded_at: "2026-05-01T00:00:00Z" }),
      prop({ id: "test-1", listing_price: 900_000, deed_recorded_at: "2026-03-01T00:00:00Z", closing_simulated: true }),
      prop({ id: "open-1", listing_price: 7_000_000 }),
      prop({ id: "noprice", listing_price: null, deed_recorded_at: "2026-03-01T00:00:00Z" }),
    ],
  };
  it("adds real closings only; simulated, unclosed and unpriced stay out and are shown", () => {
    expect(run(facts).gtv).toEqual({ total: 3_500_000, closedCount: 2, simulatedTotal: 900_000, simulatedCount: 1, missingPriceCount: 1 });
  });
  it("follows the date and the market", () => {
    expect(run(facts, { to: "2026-04-01" }).gtv.total).toBe(2_500_000);
    expect(run(facts, { from: "2026-05-01", to: "2026-05-01" }).gtv.total).toBe(1_000_000);
    expect(run(facts, { state: "CO" }).gtv.total).toBe(1_000_000);
  });
});

describe("the three streams", () => {
  const pef = (key: string, o: Partial<FounderFacts["pef"][number]>): FounderFacts["pef"][number] => ({ key, source: "buyer", environment: "live", amount_cents: 257000, cleared_at: "2026-03-01T00:00:00Z", market: "WY", ...o });
  it("counts the recorded amount; test mode is kept apart", () => {
    const { pef: p } = run({ pef: [pef("a", {}), pef("b", { source: "seller", amount_cents: 514000 }), pef("c", { environment: "sandbox" })] }).streams;
    expect(p).toEqual({ realCents: 771000, realCount: 2, buyerCount: 1, sellerCount: 1, testCents: 257000, testCount: 1 });
  });
  it("anything not clearly live counts as test, not revenue", () => {
    const { pef: p } = run({ pef: [pef("a", { environment: null }), pef("b", { environment: "staging" })] }).streams;
    expect(p).toMatchObject({ realCents: 0, realCount: 0, testCents: 514000, testCount: 2 });
  });
  it("follows the date and market", () => {
    const facts = { pef: [pef("a", { market: "Austin, TX" }), pef("b", { cleared_at: "2026-09-01T00:00:00Z" })] };
    expect(run(facts, { state: "TX" }).streams.pef.realCount).toBe(1);
    expect(run(facts, { from: "2026-08-01" }).streams.pef.realCount).toBe(1);
  });
  it("no ledger rows: not recorded, never a made-up zero from a formula", () => {
    const s = run({}).streams;
    expect(s.recorded).toBe(false);
    expect(founderCsv("revenue", run({}))).toContain("Not yet recorded");
  });
  it("premium and yield come straight from the ledger and rebuild the commission", () => {
    const ledger = (id: string, role: string, premium: number, agentYield: number, simulated = false) => ({ id, state: "WY", role, premium_received_cents: premium, agent_yield_cents: agentYield, unlocked_at: "2026-03-01T00:00:00Z", closing_simulated: simulated });
    const s = run({ commissions: [ledger("r", "resident_agent", 0, 63750), ledger("f", "referring_agent", 0, 21250), ledger("h", "heavy_lifting_agent", 15000, 0), ledger("t", "resident_agent", 999, 111, true)] }).streams;
    expect(s.recorded).toBe(true);
    expect(s.premium).toEqual({ realCents: 15000, testCents: 999 });
    expect(s.agentYield).toEqual({ realCents: 85000, testCents: 111 });
    expect(s.premium.realCents + s.agentYield.realCents).toBe(100000);
  });
});

describe("Unit Velocity", () => {
  it("gives each property exactly one status", () => {
    expect(unitStatus({ status: "listed", listing_status: "forming", hard_locked: false })).toBe("live");
    expect(unitStatus({ status: "listed", listing_status: "forming", hard_locked: true })).toBe("hard_locked");
    expect(unitStatus({ status: "listed", listing_status: "system_lock", hard_locked: true })).toBe("system_locked");
    expect(unitStatus({ status: "listed", listing_status: "closing_ready", hard_locked: true })).toBe("closing_ready");
    expect(unitStatus({ status: "listed", listing_status: "active", hard_locked: true })).toBe("active");
    expect(unitStatus({ status: "pending_review", listing_status: "forming", hard_locked: false })).toBeNull();
  });

  it("works out days and averages; a missing date stays out of the average", () => {
    const v = run({
      properties: [
        prop({ id: "aaaaaa-1", published_at: "2026-01-01T00:00:00Z", eight_of_eight_at: "2026-01-11T00:00:00Z", deed_recorded_at: "2026-02-10T00:00:00Z", listing_status: "active" }),
        prop({ id: "bbbbbb-2", published_at: "2026-01-01T00:00:00Z", eight_of_eight_at: "2026-01-21T00:00:00Z", listing_status: "system_lock" }),
        prop({ id: "cccccc-3", published_at: "2026-02-01T00:00:00Z" }),
        prop({ id: "dddddd-4", published_at: null }),
      ],
    }).velocity;
    expect(v.averages).toEqual({ liveToFull: 15, fullToClosed: 30, liveToClosed: 40 });
    expect(v.counts).toEqual({ live: 2, hard_locked: 0, system_locked: 1, closing_ready: 0, active: 1 });
    expect(v.rows).toHaveLength(3);
    expect(v.rows.find((r) => r.property.includes("aaaaaa"))).toMatchObject({ liveToFull: 10, fullToClosed: 30, liveToClosed: 40 });
    expect(JSON.stringify(v.rows)).not.toContain("Independence");
  });

  it("dates out of order show as nothing, not a negative speed", () => {
    const v = run({ properties: [prop({ published_at: "2026-02-01T00:00:00Z", eight_of_eight_at: "2026-01-01T00:00:00Z" })] }).velocity;
    expect(v.rows[0]!.liveToFull).toBeNull();
    expect(v.averages.liveToFull).toBeNull();
  });
});

describe("Referral Map", () => {
  it("counts a buyer once per agent, across both link kinds, top 10 only", () => {
    const buyers = [
      buyer({ id: "1", referring_agent_id: "A", referring_agent_name: "Ann", referral_token: "old1", stamp_agent_id: "A", stamp_agent_name: "Ann", stamp_token: "new1", stamp_label: "Flyer" }),
      buyer({ id: "2", stamp_agent_id: "A", stamp_agent_name: "Ann", stamp_token: "new1", stamp_label: "Flyer" }),
      buyer({ id: "3", referring_agent_id: "B", referring_agent_name: "Bob", referral_token: "old2" }),
      buyer({ id: "4" }),
      ...Array.from({ length: 12 }, (_, i) => buyer({ id: `x${i}`, stamp_agent_id: `Z${i}`, stamp_agent_name: `Zed ${i}`, stamp_token: `t${i}` })),
    ];
    const r = run({ buyers }).referrals;
    expect(r.topAgents).toHaveLength(10);
    expect(r.topAgents[0]).toEqual({ agent: "Ann", buyers: 2, viaLink: 1, viaQr: 2 });
    expect(r.topTokens).toHaveLength(10);
    expect(r.topTokens[0]).toMatchObject({ token: "new1", label: "Flyer", buyers: 2, kind: "QR / deep link" });
    expect(r.attributedBuyers).toBe(15);
    expect(r.totalBuyers).toBe(16);
  });
  it("ranks by buyers, whichever came first", () => {
    const buyers = [buyer({ id: "1", stamp_agent_id: "A", stamp_agent_name: "Ann", stamp_token: "a" }), buyer({ id: "2", stamp_agent_id: "B", stamp_agent_name: "Bob", stamp_token: "b" }), buyer({ id: "3", stamp_agent_id: "B", stamp_agent_name: "Bob", stamp_token: "b" })];
    const r = run({ buyers }).referrals;
    expect(r.topAgents.map((a) => a.agent)).toEqual(["Bob", "Ann"]);
    expect(r.topTokens.map((t) => t.token)).toEqual(["b", "a"]);
  });
  it("follows the market and the date", () => {
    const buyers = [buyer({ id: "1", market: "78701", stamp_agent_id: "A", stamp_agent_name: "Ann" }), buyer({ id: "2", market: "WY", created_at: "2026-09-01T00:00:00Z", stamp_agent_id: "B", stamp_agent_name: "Bob" })];
    expect(run({ buyers }, { state: "TX" }).referrals.topAgents.map((a) => a.agent)).toEqual(["Ann"]);
    expect(run({ buyers }, { from: "2026-08-01" }).referrals.topAgents.map((a) => a.agent)).toEqual(["Bob"]);
  });
});

describe("Market Demand", () => {
  it("places free-typed markets in a state, and keeps what it can't read", () => {
    expect(stateForMarket("Austin, TX")).toBe("TX");
    expect(stateForMarket("TX")).toBe("TX");
    expect(stateForMarket("texas")).toBe("TX");
    expect(stateForMarket("78701")).toBe("TX");
    expect(stateForMarket("Austin TX 78701")).toBe("TX");
    expect(stateForMarket("Charleston, West Virginia")).toBe("WV");
    expect(stateForMarket("Austin")).toBeNull();
    expect(stateForMarket("Indiana Dunes area")).toBeNull();
    expect(stateForMarket("Austin in")).toBeNull();
    expect(stateForMarket("Martin")).toBeNull();
    expect(stateForMarket(null)).toBeNull();
  });

  it("buckets only, listings beside them, nothing lost, archived out", () => {
    const d = run({
      buyers: [
        buyer({ id: "1", market: "WY", budget_bucket: "200k_300k" }),
        buyer({ id: "2", market: "Lusk, WY", budget_bucket: "200k_300k" }),
        buyer({ id: "3", market: "82225", budget_bucket: null }),
        buyer({ id: "4", market: "Somewhere", budget_bucket: "500k_plus" }),
        buyer({ id: "5", market: "WY", onboarding_status: "archived", budget_bucket: "500k_plus" }),
        buyer({ id: "6", market: "WY", budget_bucket: "weird" }),
      ],
      properties: [prop({ id: "l1", published_at: "2026-02-01T00:00:00Z" }), prop({ id: "l2", state: "Colorado", published_at: "2026-02-01T00:00:00Z" }), prop({ id: "l3", listing_status: "active" }), prop({ id: "l4", status: "pending_review" })],
    }).demand;
    const wy = d.rows.find((r) => r.market === "WY")!;
    expect(wy).toMatchObject({ totalBuyers: 4, listings: 1 });
    expect(wy.buyers["200k_300k"]).toBe(2);
    expect(wy.buyers["not_provided"]).toBe(2);
    expect(wy.buyers["500k_plus"]).toBe(0);
    expect(d.rows.find((r) => r.market === "CO")).toMatchObject({ totalBuyers: 0, listings: 1 });
    expect(d.rows.find((r) => r.market === "Not recognized")!.totalBuyers).toBe(1);
    expect(d.rows.reduce((s, r) => s + r.totalBuyers, 0)).toBe(5);
    expect(JSON.stringify(d)).not.toMatch(/target_budget\b/);
  });
});

describe("Retention Pulse", () => {
  it("uses the same rule as the lock: future date, no approved exception", () => {
    const share = (key: string, expires: string | null, exception = false) => ({ key, state: "WY", retention_lock_expires_at: expires, exception_approved: exception });
    const event = (id: string, status: string, o = {}) => ({ id, state: "WY", status, created_at: "2026-03-01T00:00:00Z", ...o });
    const r = run({
      shares: [share("1", "2027-01-01T00:00:00Z"), share("2", "2027-01-01T00:00:00Z"), share("3", "2027-01-01T00:00:00Z", true), share("4", "2026-01-01T00:00:00Z")],
      exceptions: [event("e1", "pending"), event("e2", "approved"), event("e3", "rejected")],
      resale: [event("r1", "rofr_open"), event("r2", "open_market"), event("r3", "sold")],
    }).retention;
    expect(r).toEqual({ totalShares: 4, withinLock: 2, pastLock: 2, pctWithin: 50, pctPast: 50, exceptions: 3, exceptionsPending: 1, exceptionsApproved: 1, resaleListings: 3, resaleLive: 2, rofrOpen: 1 });
  });
  it("a share with no lock date isn't locked, the same as is_share_locked", () => {
    const r = run({ shares: [{ key: "1", state: "WY", retention_lock_expires_at: null, exception_approved: false }] }).retention;
    expect(r).toMatchObject({ withinLock: 0, pastLock: 1, pctPast: 100 });
  });
  it("no shares: no percentage", () => {
    expect(run({}).retention.pctWithin).toBeNull();
  });
});

describe("CSV", () => {
  const d = run({
    buyers: [buyer({ id: "1", stamp_agent_id: "A", stamp_agent_name: '=HYPERLINK("http://x"),Evil', stamp_token: "t", stamp_label: "+Flyer" })],
    properties: [prop({ id: "abcdef-1", listing_price: 100, deed_recorded_at: "2026-01-01T00:00:00Z", published_at: "2026-01-01T00:00:00Z" })],
    shares: [{ key: "1", state: "WY", retention_lock_expires_at: null, exception_approved: false }],
  });
  it("every widget exports with a header", () => {
    for (const w of ["gtv", "revenue", "velocity", "referrals", "demand", "retention"] as const) expect(founderCsv(w, d).split("\r\n").length).toBeGreaterThan(1);
  });
  it("a typed name can't run as a spreadsheet formula, and quotes stay inside their cell", () => {
    const text = founderCsv("referrals", d);
    expect(text).toContain(`"'=HYPERLINK(""http://x""),Evil"`);
    expect(text).toContain("'+Flyer");
  });
  it("holds nothing about a buyer but counts", () => {
    const text = (["gtv", "revenue", "velocity", "referrals", "demand", "retention"] as const).map((w) => founderCsv(w, d)).join("\n");
    expect(text).not.toMatch(/@|buyer-|abcdef-1/);
  });
});

describe("access", () => {
  const seedViews = () => {
    seedPod(harness.db);
    harness.db.seed("founder_dashboard_refreshes", [{ id: 1, refreshed_at: "2026-11-01T01:00:00Z" }]);
  };
  it("anyone but an admin is refused with a 403, reading or refreshing", async () => {
    seedViews();
    const { setResponseStatus } = await import("@tanstack/react-start/server");
    for (const user of [USERS.b1, USERS.ra, USERS.broker, "u-nobody"]) {
      harness.userId = user;
      vi.mocked(setResponseStatus).mockClear();
      await expect(getFounderDashboard({ data: {} })).rejects.toThrow("Not authorized");
      expect(setResponseStatus).toHaveBeenCalledWith(403);
      await expect(refreshFounderDashboard()).rejects.toThrow("Not authorized");
    }
  });
  it("an admin reads it; with nothing recorded every widget is empty", async () => {
    seedViews();
    harness.userId = USERS.admin;
    const d = await getFounderDashboard({ data: {} });
    expect(d.refreshedAt).toBe("2026-11-01T01:00:00Z");
    expect(d.gtv.closedCount).toBe(0);
    expect(d.velocity.rows).toEqual([]);
    expect(d.referrals.topAgents).toEqual([]);
    expect(d.demand.rows).toEqual([]);
    expect(d.retention.totalShares).toBe(0);
    expect(d.streams.recorded).toBe(false);
  });
  it("reads past Supabase's 1,000-row page", async () => {
    seedViews();
    harness.db.seed("founder_mv_buyers", Array.from({ length: 2345 }, (_, i) => buyer({ id: String(i).padStart(5, "0") })));
    harness.userId = USERS.admin;
    expect((await getFounderDashboard({ data: {} })).referrals.totalBuyers).toBe(2345);
  });
  it("refresh runs the function and is audited", async () => {
    seedViews();
    let runs = 0;
    harness.db.rpcResults.refresh_founder_dashboard = () => ((runs += 1), "2026-11-02T00:00:00Z");
    harness.userId = USERS.admin;
    expect(await refreshFounderDashboard()).toEqual({ refreshedAt: "2026-11-02T00:00:00Z" });
    expect(runs).toBe(1);
    expect(harness.db.audits("founder_dashboard.refreshed")).toHaveLength(1);
  });
  it("refuses a bad date or market", async () => {
    seedViews();
    harness.userId = USERS.admin;
    await expect(getFounderDashboard({ data: { from: "soon" } })).rejects.toThrow("date");
    await expect(getFounderDashboard({ data: { state: "Texas" } })).rejects.toThrow("market");
  });
});
