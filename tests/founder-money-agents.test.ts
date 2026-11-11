/**
 * The second round of decided answers: the founder role, revenue labels, rounding, tagged contributions, distributions
 * by record date with void and re-post, /r links as suggestions, agent counts, the landing page, the library approver
 * and the expense notice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { getFounderDashboard } from "@/lib/founder.functions";
import { AGENT_PAYOUTS_LABEL, AGENT_PAYOUTS_NOTE, AGENT_YIELD_DEFINITION, PLATFORM_REVENUE_LABEL, computeFounderDashboard, founderCsv, type FounderFacts } from "@/lib/founder";
import { ROUNDING_RULE_TEXT, splitProRata } from "@/lib/expenses";
import { getOwnerProperty } from "@/lib/owner.functions";
import { holdersAsOf } from "@/lib/record-date-holders.server";
import { listDistributionsForAdmin, postDistributionEvent, repostDistributionEvent, voidDistributionEvent } from "@/lib/owner-notifications.functions";
import { confirmMyReferringAgent, declineMyReferringAgent, getAgentQrPage, getAttributionLanding, getMyReferralSuggestion, listBuyerAttributionsForAdmin, stampBuyerAttribution } from "@/lib/agent-qr.functions";
import { isAnyAttributionToken, isAttributionToken, isLegacyReferralToken, parseStoredTokens } from "@/lib/agent-qr";
import { computeShareCascade } from "@/lib/commission-cascade";
import { deliver } from "@/lib/authorization.notify.server";
import { getOwnerNotificationPreferences, setOwnerNotificationPreference } from "@/lib/owner-notifications.functions";
import { isMandatoryNotification } from "@/lib/owner-notifications";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const A = IDS.property;
const FOUNDER = "u-founder";

function roles() {
  db().rpcResults.has_role = (a: { _user_id: string; _role: string }) => (a._role === "admin" && [USERS.admin, FOUNDER].includes(a._user_id)) || (a._role === "founder" && a._user_id === FOUNDER);
}

// ---------------------------------------------------------------------------
// 1. Founder role
// ---------------------------------------------------------------------------

describe("1. only founders open the Founder dashboard", () => {
  beforeEach(() => {
    seedPod(db());
    roles();
    db().seed("founder_dashboard_refreshes", [{ id: 1, refreshed_at: "2026-11-01T01:00:00Z" }]);
  });

  it("an admin who isn't a founder gets a 403; a founder reads it", async () => {
    const { setResponseStatus } = await import("@tanstack/react-start/server");
    as(USERS.admin);
    vi.mocked(setResponseStatus).mockClear();
    await expect(getFounderDashboard({ data: {} })).rejects.toThrow("Not authorized");
    expect(setResponseStatus).toHaveBeenCalledWith(403);
    as(FOUNDER);
    expect((await getFounderDashboard({ data: {} })).refreshedAt).toBe("2026-11-01T01:00:00Z");
  });

  it("the link is only in a founder's navigation, and the page shows a 403 to anyone else", () => {
    const nav = readFileSync("src/routes/admin.tsx", "utf8");
    expect(nav).toMatch(/item\.to !== "\/admin\/founder" \|\| roles\?\.isFounder === true/);
    expect(readFileSync("src/routes/admin.founder.tsx", "utf8")).toMatch(/Only founders can open the Founder dashboard/);
  });

  it("the SQL gives the current main admin (the earliest admin account) the founder role", () => {
    const sql = readFileSync("money-decisions.sql", "utf8");
    expect(sql).toMatch(/INSERT INTO public\.user_roles[\s\S]*'founder'[\s\S]*WHERE role = 'admin'[\s\S]*ORDER BY created_at ASC LIMIT 1/);
  });
});

// ---------------------------------------------------------------------------
// 2. Revenue labels
// ---------------------------------------------------------------------------

describe("2. revenue labels: labels change, numbers never do", () => {
  const ledger = (id: string, role: string, premium: number, agentYield: number, simulated = false) => ({ id, state: "WY", role, premium_received_cents: premium, agent_yield_cents: agentYield, unlocked_at: "2026-03-01T00:00:00Z", closing_simulated: simulated });
  const facts: FounderFacts = {
    properties: [],
    pef: [
      { key: "p1", source: "buyer", environment: "live", amount_cents: 257000, cleared_at: "2026-03-01T00:00:00Z", market: "WY" },
      { key: "p2", source: "buyer", environment: "sandbox", amount_cents: 257000, cleared_at: "2026-03-02T00:00:00Z", market: "WY" },
    ],
    commissions: [ledger("r", "resident_agent", 0, 63750), ledger("f", "referring_agent", 0, 21250), ledger("h", "heavy_lifting_agent", 15000, 0)],
    buyers: [],
    shares: [],
    exceptions: [],
    resale: [],
  } as never;
  const d = computeFounderDashboard(facts, { from: null, to: null, state: null }, new Date("2026-11-01T00:00:00Z"));

  it("the numbers are exactly what they were: PEF cleared only, premium and yield as recorded, test kept out", () => {
    expect(d.streams.pef).toMatchObject({ realCents: 257000, realCount: 1, testCents: 257000, testCount: 1 });
    expect(d.streams.premium.realCents).toBe(15000);
    expect(d.streams.agentYield.realCents).toBe(85000);
  });

  it("the streams are never added together", () => {
    expect(Object.keys(d.streams).sort()).toEqual(["agentYield", "pef", "premium", "recorded"]);
    const csv = founderCsv("revenue", d);
    expect(csv).not.toMatch(/total revenue|combined|sum/i);
  });

  it("the CSV calls the fee 'Platform revenue (Platform Enrollment Fees)' and the other two 'Agent payouts recorded (not revenue)', with the note", () => {
    const csv = founderCsv("revenue", d);
    expect(PLATFORM_REVENUE_LABEL).toBe("Platform revenue (Platform Enrollment Fees)");
    expect(AGENT_PAYOUTS_LABEL).toBe("Agent payouts recorded (not revenue)");
    expect(AGENT_PAYOUTS_NOTE).toBe("Paid broker to broker through title, not received by divieight");
    expect(csv).toContain(PLATFORM_REVENUE_LABEL);
    expect(csv).toContain(AGENT_PAYOUTS_LABEL);
    expect(csv.split("\r\n").filter((l) => /Heavy Lifter Premium|Participating Agent Yield/.test(l)).every((l) => l.includes(AGENT_PAYOUTS_NOTE))).toBe(true);
    expect(csv).toContain("2570");
    expect(csv).toContain("150");
    expect(csv).toContain("850");
    expect(csv).not.toMatch(/Triple-Stream|Revenue Tracker/);
  });

  it("the widget shows the same labels, the note, and the yield definition as a tooltip", () => {
    const page = readFileSync("src/routes/admin.founder.tsx", "utf8");
    expect(page).toContain("PLATFORM_REVENUE_LABEL");
    expect(page).toContain("AGENT_PAYOUTS_LABEL");
    expect(page).toContain("AGENT_PAYOUTS_NOTE");
    expect(page).toMatch(/tip=\{AGENT_YIELD_DEFINITION\}/);
    expect(page).not.toMatch(/Triple-Stream|Revenue Tracker/);
    expect(AGENT_YIELD_DEFINITION).toBe("Participating Agent Yield: the resident and referring agents' share of the commission after the Heavy Lifter Premium is taken out. Premium plus yield equals the total commission.");
  });

  it("no other place calls the premium or the yield revenue", () => {
    for (const f of ["src/lib/founder.ts", "src/routes/admin.founder.tsx"]) {
      const text = readFileSync(f, "utf8").replace(/^import .*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(text, f).not.toMatch(/(premium|yield)[^\n]{0,40}revenue|revenue[^\n]{0,40}(premium|yield)/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Rounding
// ---------------------------------------------------------------------------

describe("3. the rounding rule", () => {
  const holders = (n: number) => Array.from({ length: n }, (_, i) => ({ holderKey: `h${i + 1}`, shares: 1, rank: i + 1 }));

  it("rounds down to the cent and gives every leftover cent to rank 1, at most 7", () => {
    const lines = splitProRata(10.07, holders(8));
    expect(lines.map((l) => l.amount)).toEqual([1.32, 1.25, 1.25, 1.25, 1.25, 1.25, 1.25, 1.25]);
    expect(lines.reduce((s, l) => Math.round(s * 100 + l.amount * 100) / 100, 0)).toBe(10.07);
    for (const total of [0.8, 1.03, 10.07, 99.99, 1234.56, 100.03]) {
      const split = splitProRata(total, holders(8));
      const base = Math.floor((Math.round(total * 100)) / 8);
      const leftover = Math.round(split[0]!.amount * 100) - base;
      expect(leftover).toBeGreaterThanOrEqual(0);
      expect(leftover).toBeLessThanOrEqual(7);
      expect(split.slice(1).every((l) => Math.round(l.amount * 100) === base)).toBe(true);
    }
  });

  it("rank 1 is the lowest rank number, whatever order the holders arrive in", () => {
    const lines = splitProRata(10.07, [...holders(8)].reverse());
    expect(lines[0]).toMatchObject({ holder_key: "h1", amount: 1.32 });
  });

  it("is documented in the code and in the admin tooltips", () => {
    expect(ROUNDING_RULE_TEXT).toMatch(/rounded down to the cent/);
    expect(ROUNDING_RULE_TEXT).toMatch(/at most 7/);
    expect(ROUNDING_RULE_TEXT).toMatch(/rank 1/);
    expect(readFileSync("src/lib/expenses.ts", "utf8")).toMatch(/THE ROUNDING RULE/);
    expect(readFileSync("src/routes/admin.expenses.tsx", "utf8")).toContain("ROUNDING_RULE_TEXT");
    expect(readFileSync("src/routes/admin.distributions.tsx", "utf8")).toContain("ROUNDING_RULE_TEXT");
  });
});

// ---------------------------------------------------------------------------
// 4. Tagged contributions
// ---------------------------------------------------------------------------

describe("4. contributions are tagged expense or capital_call", () => {
  it("the owner's capital account shows the type of each contribution, with the same totals as before", async () => {
    seedPod(db());
    db().seed("cap_table_entries", [{ property_id: A, share_number: 1, holder_type: "buyer_account", buyer_account_id: IDS.b1, seller_id: null, account_member_names: [], acquisition_date: "2026-01-01T00:00:00Z", retention_lock_expires_at: "2027-01-01T00:00:00Z" }]);
    db().seed("entity_genesis", [{ property_id: A, llc_name: "D8 Lusk, LLC", ein_status: "verified", oa_executed_at: "2026-02-01T00:00:00Z" }]);
    db().seed("co_owner_digital_keys", [{ property_id: A, holder_type: "buyer_account", buyer_account_id: IDS.b1, seller_id: null, shares: 1 }]);
    db().seed("owner_capital_accounts", [{ property_id: A, user_id: USERS.b1, contributed_amount: 600, distributions_amount: 0 }]);
    db().seed("owner_capital_contributions", [
      { property_id: A, user_id: USERS.b1, amount: 100, contribution_type: "expense", created_at: "2026-10-01T00:00:00Z" },
      { property_id: A, user_id: USERS.b1, amount: 500, contribution_type: "capital_call", created_at: "2026-10-02T00:00:00Z" },
      { property_id: A, user_id: USERS.b2, amount: 999, contribution_type: "expense", created_at: "2026-10-03T00:00:00Z" },
    ]);
    as(USERS.b1);
    const r = await getOwnerProperty({ data: { propertyId: A } });
    expect(r.property.capital).toMatchObject({ contributed: 600, distributions: 0, net: 600 });
    expect(r.property.capital!.contributions.map((c) => [c.type, c.amount]).sort()).toEqual([["capital_call", 500], ["expense", 100]]);
    expect(readFileSync("src/routes/owner.properties.$propertyId.index.tsx", "utf8")).toMatch(/of which capital calls[\s\S]*of which expenses/);
  });

  it("the database tags every confirmed payment, once, and fills in the ones already confirmed", () => {
    const sql = readFileSync("money-decisions.sql", "utf8");
    expect(sql).toMatch(/contribution_type text NOT NULL CHECK \(contribution_type IN \('capital_call', 'expense'\)\)/);
    expect(sql).toMatch(/credit_capital_contribution\(property, a\.holder_key, a\.amount, 'expense', a\.id\)/);
    expect(sql).toMatch(/credit_capital_contribution\(property, a\.holder_key, a\.amount, 'capital_call', a\.id\)/);
    expect(sql).toMatch(/owner_capital_contributions_one_per_payment/);
    expect(sql).toMatch(/Backfill/);
    // The running total still moves the same way as before.
    expect(sql).toMatch(/contributed_amount = public\.owner_capital_accounts\.contributed_amount \+ EXCLUDED\.contributed_amount/);
  });
});

// ---------------------------------------------------------------------------
// 5. Distributions
// ---------------------------------------------------------------------------

describe("5. distributions by the holders on the record date", () => {
  const T = "2026-11-05T12:00:00Z";
  function seed() {
    seedPod(db());
    roles();
    const cap = (share_number: number, buyer: string) => db().seed("cap_table_entries", [{ property_id: A, share_number, holder_type: "buyer_account", buyer_account_id: buyer, seller_id: null, account_member_names: [] }]);
    cap(1, IDS.b1);
    cap(2, IDS.b2);
    cap(3, IDS.b3); // share 3 was B2's until it was sold on T
    for (const [id, at] of [[IDS.b1, "2026-01-01"], [IDS.b2, "2026-02-01"], [IDS.b3, "2026-03-01"]] as const) db().table("buyer_accounts").find((b) => b.id === id)!.priority_rank_timestamp = at;
    db().seed("cap_table_history", [{ property_id: A, share_number: 3, from_holder_type: "buyer_account", from_buyer_account_id: IDS.b2, from_seller_id: null, to_holder_type: "buyer_account", to_buyer_account_id: IDS.b3, to_seller_id: null, changed_at: T }]);
  }
  const post = (recordDate: string, total = 300) => (as(USERS.admin), postDistributionEvent({ data: { propertyId: A, totalAmount: total, recordDate, note: null } }));
  const dist = (id: string) => db().table("distribution_events").find((d) => d.id === id)!;
  const told = (user: string) => db().notificationsFor(user).filter((n) => n.type === "distribution_event");
  beforeEach(seed);

  it("rebuilds the holders as they were on the record date from cap_table_history", async () => {
    const before = await holdersAsOf(db() as never, A, "2026-11-01");
    expect(before.map((h) => [h.holderKey, h.shares]).sort()).toEqual([[IDS.b1, 1], [IDS.b2, 2]].sort());
    const after = await holdersAsOf(db() as never, A, "2026-11-05"); // a change ON the record date counts as made
    expect(after.map((h) => [h.holderKey, h.shares]).sort()).toEqual([[IDS.b1, 1], [IDS.b2, 1], [IDS.b3, 1]].sort());
    expect((await holdersAsOf(db() as never, A, "2026-12-01")).map((h) => h.holderKey).sort()).toEqual([IDS.b1, IDS.b2, IDS.b3].sort());
  });

  it("a distribution with a record date before the sale goes to the old holder, not today's", async () => {
    const { id } = await post("2026-11-01", 300);
    expect(dist(id).lines).toEqual([
      { holder_key: IDS.b1, share_count: 1, amount: 100 },
      { holder_key: IDS.b2, share_count: 2, amount: 200 },
    ]);
    expect(told(USERS.b2).some((n) => /\$200\.00/.test(n.message))).toBe(true);
    expect(told(USERS.b1).some((n) => /\$100\.00/.test(n.message))).toBe(true);
    expect(told(USERS.b3)).toHaveLength(0); // didn't hold anything on the record date
    expect(db().audits("distribution.posted")[0]!.metadata).toMatchObject({ holders_as_of: "2026-11-01" });
  });

  it("a record date after the sale goes to the new holder", async () => {
    const { id } = await post("2026-11-20", 300);
    expect(dist(id).lines.map((l: { holder_key: string }) => l.holder_key).sort()).toEqual([IDS.b1, IDS.b2, IDS.b3].sort());
    expect(told(USERS.b3).some((n) => /\$100\.00/.test(n.message))).toBe(true);
  });

  it("is still a notice only: no capital account or balance changes", async () => {
    db().seed("owner_capital_accounts", [{ property_id: A, user_id: USERS.b1, contributed_amount: 50, distributions_amount: 0 }]);
    const before = JSON.stringify(db().table("owner_capital_accounts"));
    await post("2026-11-01");
    expect(JSON.stringify(db().table("owner_capital_accounts"))).toBe(before);
  });

  it("void and re-post: the old one is voided with its reason, the new one points back, and every version is kept", async () => {
    const { id: first } = await post("2026-11-01", 300);
    as(USERS.admin);
    const { id: second } = await repostDistributionEvent({ data: { distributionId: first, reason: "Wrong total", totalAmount: 450, recordDate: "2026-11-01", note: "Corrected" } });
    expect(dist(first)).toMatchObject({ status: "voided", void_reason: "Wrong total", voided_by: USERS.admin, replaced_by_id: second });
    expect(dist(second)).toMatchObject({ status: "posted", replaces_id: first, total_amount: 450 });
    expect(db().table("distribution_events")).toHaveLength(2);
    expect(dist(first).total_amount).toBe(300); // never edited
    expect(dist(second).lines.map((l: { amount: number }) => l.amount)).toEqual([150, 300]);
    // Owners saw it voided, with a notice, and the corrected amount.
    expect(told(USERS.b2).some((n) => /voided/.test(n.message) && /Wrong total/.test(n.message))).toBe(true);
    expect(told(USERS.b2).some((n) => /\$300\.00/.test(n.message) && /Your pro-rata amount/.test(n.message))).toBe(true);
    // Everything is audit logged.
    expect(db().audits("distribution.voided")).toHaveLength(1);
    expect(db().audits("distribution.voided")[0]!.metadata).toMatchObject({ reason: "Wrong total", total_amount: 300 });
    expect(db().audits("distribution.posted")).toHaveLength(2);
    expect(db().audits("distribution.posted")[1]!.metadata).toMatchObject({ replaces_id: first });
  });

  it("voiding needs a reason, can't be done twice, and an invalid corrected total voids nothing", async () => {
    const { id } = await post("2026-11-01");
    as(USERS.admin);
    await expect(voidDistributionEvent({ data: { distributionId: id, reason: "  " } })).rejects.toThrow("Say why");
    await expect(repostDistributionEvent({ data: { distributionId: id, reason: "x", totalAmount: -5, recordDate: "2026-11-01", note: null } })).rejects.toThrow();
    expect(dist(id).status ?? "posted").toBe("posted");
    await voidDistributionEvent({ data: { distributionId: id, reason: "Mistake" } });
    await expect(voidDistributionEvent({ data: { distributionId: id, reason: "again" } })).rejects.toThrow("already voided");
    expect(db().audits("distribution.voided")).toHaveLength(1);
    expect(told(USERS.b1).filter((n) => /voided/.test(n.message))).toHaveLength(1);
  });

  it("only an admin can void or re-post; the admin list shows status, reason and the chain", async () => {
    const { id } = await post("2026-11-01");
    as(USERS.b1);
    await expect(voidDistributionEvent({ data: { distributionId: id, reason: "x" } })).rejects.toThrow("Not authorized");
    await expect(repostDistributionEvent({ data: { distributionId: id, reason: "x", totalAmount: 5, recordDate: "2026-11-01", note: null } })).rejects.toThrow("Not authorized");
    as(USERS.admin);
    await repostDistributionEvent({ data: { distributionId: id, reason: "Typo", totalAmount: 310, recordDate: "2026-11-01", note: null } });
    const rows = (await listDistributionsForAdmin()).rows;
    expect(rows.find((r) => r.id === id)).toMatchObject({ status: "voided", voidReason: "Typo" });
    expect(rows.find((r) => r.replacesId === id)).toMatchObject({ status: "posted", totalAmount: 310 });
    expect(readFileSync("src/routes/admin.distributions.tsx", "utf8")).toMatch(/Void and re-post/);
  });

  it("the database never deletes or edits a posted notice, and a void needs a reason", () => {
    const sql = readFileSync("money-decisions.sql", "utf8");
    expect(sql).toMatch(/Distributions are never deleted/);
    expect(sql).toMatch(/A posted distribution can''t be edited/);
    expect(sql).toMatch(/A voided distribution needs a reason/);
  });
});

// ---------------------------------------------------------------------------
// 6. /r links
// ---------------------------------------------------------------------------

describe("6. /r links are suggestions", () => {
  const LEGACY = "abcd2345";
  function seed() {
    seedPod(db());
    for (const b of db().table("buyer_accounts")) b.priority_rank_timestamp = null;
    db().seed("attribution_tokens", [{ id: "legacy-1", agent_id: IDS.ra, token: LEGACY, token_type: "link", click_count: 0 }]);
  }
  const buyer = (id: string) => db().table("buyer_accounts").find((b) => b.id === id)!;
  const stamp = (user: string, tokens: string[]) => (as(user), stampBuyerAttribution({ data: { tokens } }));
  const stamps = () => db().table("buyer_attribution");
  const agentName = (id: string) => db().table("agents").find((a) => a.id === id)!.full_name;

  it("the /r page no longer sets a cookie or a referring agent: it stores a suggestion, like /a, and still redirects", () => {
    const page = readFileSync("src/routes/r.$token.tsx", "utf8");
    expect(page).not.toMatch(/setReferralCookie/);
    expect(page).toMatch(/rememberToken\(result\.token\)/);
    expect(page).toMatch(/stampStoredAttribution/);
    expect(page).toMatch(/navigate\(\{ to: landing/);
    expect(page).toMatch(/resolveAttributionToken/); // the click is still counted
  });

  it("an older token is kept in the same storage as a /a token (first stamp wins), nothing else changes about them", () => {
    expect(isLegacyReferralToken(LEGACY)).toBe(true);
    expect(isAttributionToken(LEGACY)).toBe(false);
    expect(isAnyAttributionToken("aaaaaaaaaaaa")).toBe(true);
    expect(isAnyAttributionToken("nope")).toBe(false);
    const kept = parseStoredTokens(JSON.stringify([{ t: LEGACY, at: Date.now() }, { t: "bad token!", at: Date.now() }]));
    expect(kept.map((k) => k.t)).toEqual([LEGACY]);
  });

  it("a /r visit sets nothing on the buyer: the stamp is a suggestion and referring_agent_id stays empty", async () => {
    seed();
    expect(buyer(IDS.b1).referring_agent_id ?? null).toBeNull();
    const r = await stamp(USERS.b1, [LEGACY]);
    expect(r.stamped).toBe(true);
    expect(stamps()).toHaveLength(1);
    expect(stamps()[0]).toMatchObject({ buyer_user_id: USERS.b1, agent_id: IDS.ra, token_id: null });
    expect(buyer(IDS.b1).referring_agent_id ?? null).toBeNull();
    expect(buyer(IDS.b1).referral_source ?? null).toBeNull();
    expect(buyer(IDS.b1).referral_token ?? null).toBeNull();
    as(USERS.admin);
    expect((await listBuyerAttributionsForAdmin())[USERS.b1]).toMatchObject({ agentName: agentName(IDS.ra) }); // the Conversions page reads the same stamp
  });

  it("first stamp wins, whichever kind of link it came from", async () => {
    seed();
    db().seed("agent_attribution_tokens", [{ id: "t-a", agent_id: IDS.ra2, token: "bbbbbbbbbbbb", revoked_at: null }]);
    await stamp(USERS.b1, ["bbbbbbbbbbbb", LEGACY]);
    expect(stamps()).toHaveLength(1);
    expect(stamps()[0]!.agent_id).toBe(IDS.ra2);
    await stamp(USERS.b1, [LEGACY]);
    expect(stamps()).toHaveLength(1);
    expect(stamps()[0]!.agent_id).toBe(IDS.ra2);
  });

  it("an unknown older token stamps nothing, and nobody stamps themselves", async () => {
    seed();
    await stamp(USERS.b1, ["zzzz2222"]);
    expect(stamps()).toHaveLength(0);
    await stamp(USERS.ra, [LEGACY]);
    expect(stamps()).toHaveLength(0);
  });

  it("the buyer is asked, and only Confirm sets the referring agent", async () => {
    seed();
    await stamp(USERS.b1, [LEGACY]);
    as(USERS.b1);
    expect(await getMyReferralSuggestion()).toEqual({ agentName: agentName(IDS.ra), status: "pending" });
    expect(buyer(IDS.b1).referring_agent_id ?? null).toBeNull();
    await confirmMyReferringAgent();
    expect(buyer(IDS.b1)).toMatchObject({ referring_agent_id: IDS.ra, referral_source: "agent_referral" });
    expect(new Date(buyer(IDS.b1).referral_tag_expires_at).getTime()).toBeGreaterThan(Date.now() + 360 * 86_400_000);
    expect(stamps()[0]).toMatchObject({ response: "confirmed" });
    expect(db().audits("buyer.referral_confirmed")).toHaveLength(1);
    expect(await getMyReferralSuggestion()).toEqual({ agentName: agentName(IDS.ra), status: "confirmed" });
  });

  it("No thanks is remembered: the question isn't asked again and nothing is set", async () => {
    seed();
    await stamp(USERS.b1, [LEGACY]);
    as(USERS.b1);
    await declineMyReferringAgent();
    expect(stamps()[0]).toMatchObject({ response: "declined" });
    expect(await getMyReferralSuggestion()).toBeNull();
    expect(buyer(IDS.b1).referring_agent_id ?? null).toBeNull();
    await expect(confirmMyReferringAgent()).rejects.toThrow("chose not to");
    expect(buyer(IDS.b1).referring_agent_id ?? null).toBeNull();
    expect(db().audits("buyer.referral_declined")).toHaveLength(1);
  });

  it("existing tagged buyers are unchanged: an existing referring agent is never replaced, and the same one is a no-op", async () => {
    seed();
    Object.assign(buyer(IDS.b1), { referring_agent_id: IDS.ra2, referral_source: "agent_referral", referral_token: "oldtoken", referral_tag_expires_at: "2027-01-01T00:00:00.000Z" });
    const before = JSON.stringify(buyer(IDS.b1));
    await stamp(USERS.b1, [LEGACY]); // a suggestion for a different agent
    as(USERS.b1);
    await expect(confirmMyReferringAgent()).rejects.toThrow("already has a referring agent");
    expect(JSON.stringify(buyer(IDS.b1))).toBe(before);
    // The same agent: confirming changes nothing on the account.
    Object.assign(buyer(IDS.b2), { referring_agent_id: IDS.ra, referral_source: "agent_referral", referral_token: "keep", referral_tag_expires_at: "2027-02-02T00:00:00.000Z" });
    const b2 = JSON.stringify(buyer(IDS.b2));
    await stamp(USERS.b2, [LEGACY]);
    as(USERS.b2);
    await confirmMyReferringAgent();
    expect(JSON.stringify(buyer(IDS.b2))).toBe(b2);
  });

  it("commission results are identical for an existing referred buyer: the cascade and who the referring agent is are untouched", async () => {
    seed();
    const input = { commissionCents: 1_234_567, residentAgentId: IDS.ra, referringAgentId: IDS.ra2, heavyLiftingAgentId: IDS.hla };
    const before = computeShareCascade(input);
    Object.assign(buyer(IDS.b1), { referring_agent_id: IDS.ra2 });
    await stamp(USERS.b1, [LEGACY]);
    as(USERS.b1);
    await declineMyReferringAgent();
    expect(buyer(IDS.b1).referring_agent_id).toBe(IDS.ra2);
    expect(computeShareCascade({ ...input, referringAgentId: buyer(IDS.b1).referring_agent_id })).toEqual(before);
    const lines = before.lines;
    expect(lines.reduce((s, l) => s + l.grossCents, 0)).toBe(1_234_567);
    for (const f of ["src/lib/commission-cascade.ts"]) expect(readFileSync(f, "utf8")).toMatch(/REFERRAL_SPLIT_PERCENT = 25/);
  });

  it("the sign-in hook never sets a referring agent any more: no link means 'direct', an old cookie becomes a suggestion", async () => {
    seed();
    const jar: Record<string, string> = {};
    const doc = {
      get cookie() {
        return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
      },
      set cookie(v: string) {
        const [pair, ...rest] = v.split(";");
        const [k, val] = pair!.split("=");
        if (/max-age=0/.test(rest.join(";"))) delete jar[k!];
        else jar[k!] = val ?? "";
      },
    };
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } });
    // The module keeps the client it was loaded with, so load it fresh against this test's database.
    vi.resetModules();
    const { applyReferralTag } = await import("@/lib/attribution");
    try {
      jar["divieight_ref"] = encodeURIComponent(`${LEGACY}|${IDS.ra}`);
      await applyReferralTag(IDS.b1, USERS.b1);
      expect(buyer(IDS.b1).referring_agent_id ?? null).toBeNull();
      expect(buyer(IDS.b1).referral_source ?? null).toBeNull();
      expect(jar["divieight_ref"]).toBeUndefined();
      expect(decodeURIComponent(jar["divieight_agent_attribution"]!)).toContain(LEGACY);
      // No link at all: marked direct, as before.
      for (const k of Object.keys(jar)) delete jar[k];
      await applyReferralTag(IDS.b2, USERS.b2);
      expect(buyer(IDS.b2)).toMatchObject({ referral_source: "direct_confirmed" });
      expect(buyer(IDS.b2).referring_agent_id ?? null).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the agent-selection step asks 'Confirm this agent as your referring agent?' with Confirm and No thanks", () => {
    const ui = readFileSync("src/components/AgentChoice.tsx", "utf8");
    expect(ui).toMatch(/You were referred by \{data\.agentName\}\. Confirm this agent as your referring agent\?/);
    expect(ui).toMatch(/>\s*Confirm\s*</);
    expect(ui).toMatch(/No thanks/);
  });
});

// ---------------------------------------------------------------------------
// 7 + 8. Agent counts and the landing page
// ---------------------------------------------------------------------------

describe("7. agent counts", () => {
  beforeEach(() => {
    seedPod(db());
    for (const b of db().table("buyer_accounts")) b.priority_rank_timestamp = null;
  });

  it("each link shows its visits and how many buyers were stamped through it, and nothing about who", async () => {
    as(USERS.ra);
    const first = (await getAgentQrPage()).tokens[0]!;
    db().seed("attribution_visits", [{ token_id: first.id }, { token_id: first.id }, { token_id: first.id }]);
    for (const user of [USERS.b1, USERS.b2]) {
      as(user);
      await stampBuyerAttribution({ data: { tokens: [first.token] } });
    }
    as(USERS.ra);
    const page = await getAgentQrPage();
    expect(page.tokens[0]).toMatchObject({ visits: 3, buyers: 2 });
    const text = JSON.stringify(page);
    expect(text).not.toMatch(/b1@test|b2@test|Alice|Carol|u-b1|u-b2|buyer-1|buyer-2/);
    expect(Object.keys(page.tokens[0]!).sort()).toEqual(["buyers", "createdAt", "id", "isDefault", "label", "revokedAt", "token", "visits"]);
    expect(readFileSync("src/routes/agent.qr.tsx", "utf8")).toMatch(/stamped/);
  });

  it("another agent's stamps don't count here", async () => {
    as(USERS.ra);
    const mine = (await getAgentQrPage()).tokens[0]!;
    as(USERS.ra2);
    const theirs = (await getAgentQrPage()).tokens[0]!;
    as(USERS.b1);
    await stampBuyerAttribution({ data: { tokens: [theirs.token] } });
    as(USERS.ra);
    expect((await getAgentQrPage()).tokens.find((t) => t.id === mine.id)!.buyers).toBe(0);
  });
});

describe("8. where /a and /r links land", () => {
  beforeEach(() => {
    seedPod(db());
    db().seed("library_clusters", [{ id: "c1", name: "Basics", sort_order: 1 }]);
  });
  const video = (status: string) => db().seed("library_videos", [{ id: `v-${status}`, cluster_id: "c1", title: "T", slug: `t-${status}`, status, sort_order: 0 }]);

  it("the homepage while no video is published (drafts, review and approved don't count)", async () => {
    expect(await getAttributionLanding()).toBe("/");
    for (const s of ["draft", "compliance_review", "approved"]) video(s);
    expect(await getAttributionLanding()).toBe("/");
  });

  it("the library once at least one video is published", async () => {
    video("published");
    expect(await getAttributionLanding()).toBe("/library");
  });

  it("both links use it, and the stamp works either way", async () => {
    for (const f of ["src/routes/a.$token.tsx", "src/routes/r.$token.tsx"]) {
      const page = readFileSync(f, "utf8");
      expect(page).toMatch(/getAttributionLanding/);
      expect(page).not.toMatch(/to: "\/library"|LANDING/);
    }
    for (const b of db().table("buyer_accounts")) b.priority_rank_timestamp = null;
    as(USERS.ra);
    const t = (await getAgentQrPage()).tokens[0]!;
    as(USERS.b1);
    expect((await stampBuyerAttribution({ data: { tokens: [t.token] } })).stamped).toBe(true); // with no video published
    video("published");
    as(USERS.b2);
    expect((await stampBuyerAttribution({ data: { tokens: [t.token] } })).stamped).toBe(true); // with one published
  });
});

// ---------------------------------------------------------------------------
// 10. Expense notices
// ---------------------------------------------------------------------------

describe("10. notices", () => {
  const B1_EMAIL = "b1@test.local";
  const sent = () => (globalThis.fetch as unknown as { mock: { calls: Array<[string, { body: string }]> } }).mock.calls.map((c) => JSON.parse(c[1].body).to as string[]).flat();
  beforeEach(() => {
    seedPod(db());
    db().seed("cap_table_entries", [{ property_id: A, share_number: 1, holder_type: "buyer_account", buyer_account_id: IDS.b1, seller_id: null }]);
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true }) as Response));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("voting windows, capital calls and governance notices stay mandatory; expense_posted is optional", async () => {
    for (const type of ["governance_vote_window", "capital_call_alert", "notice_posted"]) expect(isMandatoryNotification(type)).toBe(true);
    expect(isMandatoryNotification("expense_posted")).toBe(false);
    as(USERS.b1);
    const { preferences } = await getOwnerNotificationPreferences();
    expect(preferences.find((p) => p.type === "expense_posted")).toMatchObject({ mandatory: false, emailEnabled: true, label: "Expenses" });
    expect(preferences.filter((p) => p.mandatory).map((p) => p.type).sort()).toEqual(["capital_call_alert", "governance_vote_window", "notice_posted"]);
  });

  it("the expense email can be switched off; the bell stays on", async () => {
    as(USERS.b1);
    await setOwnerNotificationPreference({ data: { type: "expense_posted", emailEnabled: false } });
    await deliver(db() as never, { authUserId: USERS.b1, email: B1_EMAIL }, { subject: "A new expense was posted", message: "M", type: "expense_posted", propertyId: A });
    expect(sent()).not.toContain(B1_EMAIL);
    expect(db().notificationsFor(USERS.b1).filter((n) => n.type === "expense_posted")).toHaveLength(1);
    // Switched back on: it sends again.
    await setOwnerNotificationPreference({ data: { type: "expense_posted", emailEnabled: true } });
    await deliver(db() as never, { authUserId: USERS.b1, email: B1_EMAIL }, { subject: "A new expense was posted", message: "M2", type: "expense_posted", propertyId: A });
    expect(sent()).toContain(B1_EMAIL);
  });

  it("the mandatory ones can't be switched off, even by trying, and still email", async () => {
    as(USERS.b1);
    for (const type of ["governance_vote_window", "capital_call_alert", "notice_posted"] as const) {
      await expect(setOwnerNotificationPreference({ data: { type, emailEnabled: false } })).rejects.toThrow("required");
    }
    db().seed("owner_notification_preferences", [{ user_id: USERS.b1, type: "capital_call_alert", email_enabled: false }]);
    await deliver(db() as never, { authUserId: USERS.b1, email: B1_EMAIL }, { subject: "S", message: "M", type: "capital_call_alert", propertyId: A });
    expect(sent()).toContain(B1_EMAIL);
  });

  it("expense notices (posted, voided, payment confirmed) all use the new type", () => {
    const server = readFileSync("src/lib/expenses.server.ts", "utf8");
    expect(server.match(/type: "expense_posted"/g)!.length).toBeGreaterThanOrEqual(2);
    expect(server.match(/"capital_call_alert" : "expense_posted"/g)).toHaveLength(2);
  });
});
