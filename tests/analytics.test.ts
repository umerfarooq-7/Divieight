/** Platform analytics and admin reports: access, reconciliation with the underlying tables, revenue labelling, compliance flags, and exports with no PII. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { analyticsBoard, exportReport, reportData } from "@/lib/analytics.server";
import { getAnalyticsBoard, getAdminReport, exportAdminReport } from "@/lib/analytics.functions";
import { assertNoPii, findPii, statementDeadline, statementTiming, reportCsv, type ComplianceReport } from "@/lib/analytics";
import * as serverRuntime from "@tanstack/react-start/server";

const db = () => harness.db;
const as = (u: string) => (harness.userId = u);
const NOW = new Date("2026-11-14T12:00:00Z");
const ALL = { from: null, to: null, state: null };
const FOUNDER = "u-founder";

beforeEach(() => {
  seedPod(db());
  db().rpcResults.has_role = (a: { _user_id: string; _role: string }) => (a._role === "admin" && a._user_id === USERS.admin) || (a._role === "founder" && a._user_id === FOUNDER);

  // Buyer accounts: b1 through to a Golden Ticket, b2 paid and gone quiet, b3 just registered in another market. Names and emails are PII and must never come out.
  Object.assign(db().table("buyer_accounts").find((a) => a.id === IDS.b1)!, { created_at: "2026-06-01T00:00:00Z", primary_target_market: "Lusk, WY", priority_rank_timestamp: "2026-06-11T00:00:00Z", golden_ticket_issued: true, golden_ticket_issued_at: "2026-07-01T00:00:00Z", onboarding_status: "active", last_activity_at: "2026-11-10T00:00:00Z", email: "secret.buyer@pii.example" });
  Object.assign(db().table("buyer_accounts").find((a) => a.id === IDS.b2)!, { created_at: "2026-06-05T00:00:00Z", primary_target_market: "WY", priority_rank_timestamp: "2026-06-06T00:00:00Z", golden_ticket_issued: false, onboarding_status: "vetting_pending", last_activity_at: "2026-08-01T00:00:00Z" });
  Object.assign(db().table("buyer_accounts").find((a) => a.id === IDS.b3)!, { created_at: "2026-07-01T00:00:00Z", primary_target_market: "Austin, TX", priority_rank_timestamp: null, golden_ticket_issued: false, onboarding_status: "payment_pending", last_activity_at: "2026-11-01T00:00:00Z" });
  for (const m of db().table("account_members")) Object.assign(m, { status: "active", email: `${String(m.full_name).split(" ")[0]!.toLowerCase()}@pii.example`, phone: "555-123-4567" });

  db().seed("sellers", [{ id: IDS.seller, email: "seller@pii.example", full_name: "Sam Seller" }]);
  db().table("agents").find((a) => a.id === IDS.ra)!.eo_expires_at = "2026-01-01T00:00:00Z"; // expired
  db().table("agents").find((a) => a.id === IDS.ra2)!.eo_expires_at = "2027-06-01T00:00:00Z";
  db().seed("cpa_designations", [{ id: "c1", status: "active", auth_user_id: "u-cpa", email: "cpa@pii.example" }]);
  db().seed("cap_table_entries", [{ id: "ct1", property_id: IDS.property, buyer_account_id: IDS.b1 }]);
  db().seed("eligibility_page_acknowledgements", [{ id: "e1", buyer_account_id: IDS.b1 }, { id: "e2", buyer_account_id: IDS.b1 }, { id: "e3", buyer_account_id: IDS.b2 }]);
  db().seed("eligibility_declarations", [{ id: "d1", account_member_id: IDS.b1m1, buyer_account_id: IDS.b1, status: "complete" }, { id: "d2", account_member_id: IDS.b2m1, buyer_account_id: IDS.b2, status: "complete" }, { id: "d3", account_member_id: IDS.b3m1, buyer_account_id: IDS.b3, status: "draft" }]);
  // Carol (account b2) is held, since August.
  db().seed("eligibility_results", [{ account_member_id: IDS.b2m1, declaration_id: "d2", determined_at: "2026-08-01T00:00:00Z", result: "held" }]);
  // Dan (b3) has a verification request nobody resolved.
  db().table("account_members").find((m) => m.id === IDS.b3m1)!.vetting_status = "verification_pending";
  db().seed("audit_log", [{ id: "av1", action_type: "buyer.verification_requested", entity_id: IDS.b3, created_at: "2026-10-01T00:00:00Z", metadata: {} }]);
  db().seed("pod_reservations", []); // seedPod already reserved b1 and b2 on the property
  db().seed("monthly_statements", [
    { id: "s1", property_id: IDS.property, member_key: IDS.b1, period: "2026-09", version: 1, status: "issued", issued_at: "2026-10-05T10:00:00Z" }, // on time
    { id: "s2", property_id: IDS.property, member_key: IDS.b1, period: "2026-08", version: 1, status: "issued", issued_at: "2026-09-20T10:00:00Z" }, // late
    { id: "s3", property_id: IDS.property, member_key: IDS.b1, period: "2026-10", version: 1, status: "draft", issued_at: null }, // overdue draft
  ]);
  db().seed("coowner_inquiries", [
    { id: "q1", property_id: IDS.property, status: "open", created_at: "2026-10-01T00:00:00Z" },
    { id: "q2", property_id: IDS.property, status: "open", created_at: "2026-11-10T00:00:00Z" },
    { id: "q3", property_id: IDS.property, status: "resolved", created_at: "2026-09-01T00:00:00Z" },
  ]);
  db().seed("listing_content_items", [{ id: "li1", property_id: IDS.property, stalled_at: "2026-11-01T00:00:00Z" }, { id: "li2", property_id: IDS.property, stalled_at: null }]);

  // The Founder Dashboard's own facts.
  db().seed("founder_mv_properties", [
    { id: "prop-1", city: "Lusk", state: "WY", listing_price: 2_500_000, status: "listed", listing_status: "forming", hard_locked: true, published_at: "2026-08-01T00:00:00Z", deed_recorded_at: null, eight_of_eight_at: "2026-09-01T00:00:00Z", closing_simulated: false },
    { id: "prop-2", city: "Austin", state: "TX", listing_price: 1_000_000, status: "listed", listing_status: "active", hard_locked: true, published_at: "2026-05-01T00:00:00Z", deed_recorded_at: "2026-09-10T00:00:00Z", eight_of_eight_at: "2026-06-01T00:00:00Z", closing_simulated: false },
    { id: "prop-3", city: "Bend", state: "OR", listing_price: 900_000, status: "listed", listing_status: "forming", hard_locked: false, published_at: "2026-10-01T00:00:00Z", deed_recorded_at: null, eight_of_eight_at: null, closing_simulated: false },
  ]);
  db().seed("founder_mv_pef", [
    { key: "buyer:1", source: "buyer", environment: "live", amount_cents: 257000, cleared_at: "2026-09-05T00:00:00Z", market: "Lusk, WY" },
    { key: "buyer:2", source: "buyer", environment: "live", amount_cents: 257000, cleared_at: "2026-10-05T00:00:00Z", market: "Austin, TX" },
    { key: "seller:1", source: "seller", environment: "live", amount_cents: 514000, cleared_at: "2026-10-20T00:00:00Z", market: "WY" },
    { key: "buyer:t", source: "buyer", environment: "sandbox", amount_cents: 257000, cleared_at: "2026-10-06T00:00:00Z", market: "WY" },
  ]);
  db().seed("founder_mv_commissions", [{ id: "c1", state: "TX", role: "heavy_lifting_agent", premium_received_cents: 15000, agent_yield_cents: 0, unlocked_at: "2026-09-10T00:00:00Z", closing_simulated: false }]);
  db().seed("founder_mv_resale", [{ id: "r1", state: "WY", status: "rofr_open", created_at: "2026-10-01T00:00:00Z" }, { id: "r2", state: "WY", status: "sold", created_at: "2026-09-01T00:00:00Z" }]);
});

const board = (filters = ALL) => analyticsBoard(db() as never, { userId: USERS.admin, filters, now: NOW });
const report = (kind: "pod_activity" | "revenue" | "compliance", filters = ALL, inquiryDays?: number) => reportData(db() as never, { userId: USERS.admin, kind, filters, now: NOW, inquiryDays });

describe("access: admins and the founder only", () => {
  it("anyone else gets a 403 on the board, every report and every export", async () => {
    const status = vi.mocked(serverRuntime.setResponseStatus);
    for (const user of [USERS.b1, USERS.ra, "u-nobody"]) {
      as(user);
      status.mockClear();
      await expect(getAnalyticsBoard({ data: ALL })).rejects.toThrow("Not authorized");
      expect(status).toHaveBeenCalledWith(403);
      await expect(getAdminReport({ data: { kind: "revenue", filters: ALL } })).rejects.toThrow("Not authorized");
      await expect(exportAdminReport({ data: { kind: "compliance", filters: ALL } })).rejects.toThrow("Not authorized");
    }
    expect(db().table("audit_log").filter((a) => a.action_type === "analytics.report_exported")).toHaveLength(0);
  });
  it("a Manager and the founder are let in", async () => {
    as(USERS.admin);
    expect((await getAnalyticsBoard({ data: ALL })).users.buyerAccounts).toBe(3);
    as(FOUNDER);
    expect((await getAdminReport({ data: { kind: "pod_activity", filters: ALL } })).kind).toBe("pod_activity");
  });
});

describe("the dashboard reconciles with the underlying tables", () => {
  it("users by role", async () => {
    const b = await board();
    expect(b.users).toEqual({ buyerAccounts: db().table("buyer_accounts").length, coOwnerAccounts: 1, sellers: db().table("sellers").length, agents: db().table("agents").length, brokers: db().table("brokers").length, designatedCpas: 1, admins: 1 });
  });
  it("the onboarding funnel, step by step", async () => {
    const f = Object.fromEntries((await board()).funnel.map((s) => [s.key, s.count]));
    expect(f).toEqual({ registered: 3, eligibility_read: 2, declaration_complete: 2, fee_paid: 2, golden_ticket: 1 });
    expect((await board()).funnel[1]).toMatchObject({ pctOfRegistered: 66.7, pctOfPrevious: 66.7 });
  });
  it("average days between milestones", async () => {
    const m = (await board()).milestones;
    expect(m.registeredToFeePaid).toBe(5.5); // b1 10 days, b2 1 day
    expect(m.feePaidToGoldenTicket).toBe(20); // b1 only
    expect(m.listedToEightOfEight).toBe(31); // prop-1 31 days, prop-2 31 days
  });
  it("pods by status and resale activity come from the Founder Dashboard's own figures", async () => {
    const b = await board();
    expect(b.pods.counts).toEqual({ live: 1, hard_locked: 1, system_locked: 0, closing_ready: 0, active: 1 });
    expect(b.resale).toEqual({ listings: 2, live: 1, rofrOpen: 1 });
  });
  it("statements on time, late and overdue, against the fifth business day", async () => {
    expect(statementDeadline("2026-09")).toBe("2026-10-07");
    expect(statementDeadline("2026-12")).toBe("2027-01-07");
    const s = (await board()).statements;
    expect(s).toEqual({ total: 3, issuedOnTime: 1, issuedLate: 1, overdueDrafts: 1, pctOnTime: 33.3 });
  });
  it("held accounts and open verification requests", async () => {
    const b = await board();
    expect(b.heldAccounts).toBe(1);
    expect(b.openVerificationRequests).toBe(1);
  });
  it("the market and date filters narrow it", async () => {
    expect((await board({ ...ALL, state: "TX" })).funnel[0]!.count).toBe(1);
    expect((await board({ from: "2026-06-30", to: null, state: null })).funnel[0]!.count).toBe(1);
    expect((await board({ ...ALL, state: "TX" })).heldAccounts).toBe(0);
  });
  it("a statement still inside its window is not counted as late", () => {
    const t = statementTiming([{ property_id: "p", member_key: "m", period: "2026-10", version: 1, status: "draft", issued_at: null }], "2026-11-04");
    expect(t[0]!.state).toBe("not_due");
  });
});

describe("revenue tracking", () => {
  it("platform revenue is the cleared Platform Enrollment Fees only, in live mode", async () => {
    const r = await report("revenue");
    if (r.kind !== "revenue") throw new Error("kind");
    const live = db().table("founder_mv_pef").filter((p) => p.environment === "live");
    expect(r.report.platformRevenue.cents).toBe(live.reduce((s, p) => s + Number(p.amount_cents), 0));
    expect(r.report.platformRevenue).toMatchObject({ cents: 1_028_000, count: 3, buyerFees: 2, sellerFees: 1, label: "Platform revenue (Platform Enrollment Fees)" });
    expect(r.report.testMode).toMatchObject({ cents: 257000, count: 1 });
    expect(r.report.byMonth.reduce((s, m) => s + m.cents, 0)).toBe(r.report.platformRevenue.cents);
  });
  it("commissions and the Heavy Lifter Premium are shown apart as Agent payouts recorded, never added to revenue", async () => {
    const r = await report("revenue");
    if (r.kind !== "revenue") throw new Error("kind");
    expect(r.report.agentPayouts).toMatchObject({ label: "Agent payouts recorded (not revenue)", heavyLifterPremiumCents: 15000, recorded: true });
    expect(r.report.platformRevenue.cents).not.toBe(1_028_000 + 15000);
    const csv = reportCsv("revenue", r.report, ALL);
    expect(csv).toContain("Agent payouts recorded (not revenue)");
    expect(csv).toContain("Platform revenue (Platform Enrollment Fees)");
    expect(csv).toMatch(/Test-mode payments \(not revenue\),2570/);
  });
  it("follows the date and market filters", async () => {
    const tx = await report("revenue", { ...ALL, state: "TX" });
    if (tx.kind !== "revenue") throw new Error("kind");
    expect(tx.report.platformRevenue.cents).toBe(257000);
    const oct = await report("revenue", { from: "2026-10-01", to: "2026-10-31", state: null });
    if (oct.kind !== "revenue") throw new Error("kind");
    expect(oct.report.platformRevenue.cents).toBe(257000 + 514000);
  });
});

describe("pod activity", () => {
  it("is each pod's timeline and status, from the Founder Dashboard's rows", async () => {
    const r = await report("pod_activity");
    if (r.kind !== "pod_activity") throw new Error("kind");
    expect(r.report.rows.map((x) => x.property.split(" · ")[0]).sort()).toEqual(["Austin, TX", "Bend, OR", "Lusk, WY"]);
    const austin = r.report.rows.find((x) => x.property.startsWith("Austin"))!;
    expect(austin).toMatchObject({ status: "active", liveToFull: 31, fullToClosed: 101 });
    expect((await report("pod_activity", { ...ALL, state: "OR" })).kind === "pod_activity" && (await report("pod_activity", { ...ALL, state: "OR" }) as { report: { rows: unknown[] } }).report.rows.length).toBe(1);
  });
});

describe("compliance flags", () => {
  it("every kind of flag is raised from its own rule", async () => {
    const r = await report("compliance");
    if (r.kind !== "compliance") throw new Error("kind");
    expect(r.report.byFlag).toEqual({
      missing_tax_form: 1, // the one Broker of Record has no form
      expired_eo: 1, // Rita Resident's coverage ended in January
      stalled_pod: 1, // b2 paid in June and has been quiet since August
      listing_approval_stalled: 1,
      verification_request_open: 1,
      held_account_overdue: 1, // held since August, reminder window 30 days
      statement_late: 2, // one late, one still a draft
      inquiry_open_too_long: 1, // q1 only: q2 is 4 days old, q3 is resolved
    });
    const stalled = r.report.rows.find((x) => x.flag === "stalled_pod")!;
    expect(stalled.detail).toMatch(/1 of 2 buyer accounts stalled for 30\+ days/);
    expect(stalled.market).toBe("WY");
  });
  it("the limit for an open inquiry is set by the caller", async () => {
    const strict = await report("compliance", ALL, 3);
    const lax = await report("compliance", ALL, 90);
    if (strict.kind !== "compliance" || lax.kind !== "compliance") throw new Error("kind");
    expect(strict.report.byFlag.inquiry_open_too_long).toBe(2);
    expect(lax.report.byFlag.inquiry_open_too_long).toBe(0);
  });
  it("a held account is flagged only after the reminder window", async () => {
    db().table("eligibility_results")[0]!.determined_at = "2026-11-10T00:00:00Z";
    const r = await report("compliance");
    if (r.kind !== "compliance") throw new Error("kind");
    expect(r.report.byFlag.held_account_overdue).toBe(0);
  });
  it("a market filter keeps only flags that belong to that market; a date filter keeps the flags dated inside it", async () => {
    const wy = await report("compliance", { ...ALL, state: "WY" });
    const nov = await report("compliance", { from: "2026-11-01", to: null, state: null });
    if (wy.kind !== "compliance" || nov.kind !== "compliance") throw new Error("kind");
    expect(wy.report.byFlag.missing_tax_form).toBe(0);
    expect(wy.report.byFlag.stalled_pod).toBe(1);
    expect(nov.report.byFlag.inquiry_open_too_long).toBe(0);
    expect(nov.report.byFlag.listing_approval_stalled).toBe(1);
  });
  it("a broker with a valid tax form, and an agent with live coverage, are not flagged", async () => {
    db().seed("broker_tax_forms", [{ id: "f1", broker_id: IDS.broker, form_type: "W-9", status: "valid", expiry_date: null, created_at: "2026-01-01T00:00:00Z" }]);
    db().table("agents").find((a) => a.id === IDS.ra)!.eo_expires_at = "2027-01-01T00:00:00Z";
    const r = await report("compliance");
    if (r.kind !== "compliance") throw new Error("kind");
    expect(r.report.byFlag.missing_tax_form).toBe(0);
    expect(r.report.byFlag.expired_eo).toBe(0);
  });
});

describe("exports: logged, and no PII", () => {
  it("each export is audit logged with who, what, the filters, the row count and a hash of exactly what was handed over", async () => {
    const out = await exportReport(db() as never, { userId: USERS.admin, kind: "compliance", filters: { from: null, to: null, state: "WY" }, now: NOW, request: { ip: "203.0.113.5", userAgent: "ua" } });
    const log = db().table("audit_log").filter((a) => a.action_type === "analytics.report_exported");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: USERS.admin, entity_type: "admin_report" });
    expect(log[0]!.metadata).toMatchObject({ report: "compliance", format: "csv", filters: { state: "WY" }, rows: out.rows, sha256: out.sha256, ip_address: "203.0.113.5" });
    expect(out.filename).toMatch(/^compliance-\d{4}-\d{2}-\d{2}\.csv$/);
    await exportReport(db() as never, { userId: USERS.admin, kind: "revenue", filters: ALL, now: NOW });
    expect(db().table("audit_log").filter((a) => a.action_type === "analytics.report_exported")).toHaveLength(2);
  });

  it("no export contains a name, an email, a phone number or a tax identifier, whatever sits in the underlying tables", async () => {
    for (const kind of ["pod_activity", "revenue", "compliance"] as const) {
      const { csv } = await exportReport(db() as never, { userId: USERS.admin, kind, filters: ALL, now: NOW });
      expect(findPii(csv), kind).toBeNull();
      for (const secret of ["pii.example", "secret.buyer", "Alice", "Bob", "Carol", "Dan", "Sam Seller", "Rita", "555-123-4567", "b1@test.local"]) expect(csv, `${kind}: ${secret}`).not.toContain(secret);
      // Names are not even read: the references are short anonymous ids.
      if (kind === "compliance") expect(csv).toMatch(/Broker #broker|Agent #agent-/);
    }
  });

  it("the guard stops an export that would carry personal information", () => {
    expect(() => assertNoPii("flag,ref\nx,someone@example.com")).toThrow(/email address/);
    expect(() => assertNoPii("a,b\n(555) 123-4567")).toThrow(/phone number/);
    expect(() => assertNoPii("a,b\n123-45-6789")).toThrow(/tax identifier/);
    const forged: ComplianceReport = { rows: [{ flag: "expired_eo", label: "x", ref: "owner@leak.example", market: null, since: null, ageDays: null, detail: "d" }], byFlag: {} as never, inquiryDays: 14 };
    expect(() => reportCsv("compliance", forged, ALL)).toThrow(/stopped/);
  });

  it("a CSV cell that starts with = + - @ cannot run as a spreadsheet formula", async () => {
    db().table("founder_mv_properties")[0]!.city = "=HYPERLINK(1)";
    const { csv } = await exportReport(db() as never, { userId: USERS.admin, kind: "pod_activity", filters: ALL, now: NOW });
    expect(csv).toContain("'=HYPERLINK(1)");
  });
});

describe("read-only, and one query layer", () => {
  it("viewing the board and every report changes nothing; only an export adds an audit row", async () => {
    const snapshot = () => JSON.stringify(Object.fromEntries(["buyer_accounts", "account_members", "founder_mv_pef", "monthly_statements", "coowner_inquiries", "agents", "brokers", "notifications"].map((t) => [t, db().table(t)])));
    const before = snapshot();
    await board();
    await report("pod_activity");
    await report("revenue");
    await report("compliance");
    await exportReport(db() as never, { userId: USERS.admin, kind: "revenue", filters: ALL, now: NOW });
    expect(snapshot()).toBe(before);
    expect(db().table("audit_log").filter((a) => a.action_type === "analytics.report_exported")).toHaveLength(1);
  });

  it("the Founder Dashboard and the analytics read the same facts and use the same calculation", () => {
    const founder = readFileSync("src/lib/founder.server.ts", "utf8");
    expect(founder).toContain("export async function loadFounderFacts");
    expect(founder).toMatch(/founderDashboard[\s\S]*loadFounderFacts\(db\)/);
    const server = readFileSync("src/lib/analytics.server.ts", "utf8");
    expect(server).toContain("loadFounderFacts");
    expect(server).not.toMatch(/founder_mv_/);
    const pure = readFileSync("src/lib/analytics.ts", "utf8");
    expect(pure).toContain("computeFounderDashboard");
    expect(pure).toContain("PLATFORM_REVENUE_LABEL");
    expect(pure).toContain("AGENT_PAYOUTS_LABEL");
  });

  it("the queries never select a personal field", () => {
    const server = readFileSync("src/lib/analytics.server.ts", "utf8");
    for (const col of ["email", "full_name", "phone", "address", "tin", "date_of_birth", "id_document"]) {
      expect(server, col).not.toMatch(new RegExp(`select\\([^)]*\\b${col}\\b`, "i"));
      expect(server, col).not.toMatch(new RegExp(`readAll[^;]*"[^"]*\\b${col}\\b[^"]*"`, "i"));
    }
  });

  it("the screens exist and are in the Manager's menu", () => {
    expect(readFileSync("src/routes/admin.analytics.tsx", "utf8")).toContain("Platform analytics");
    expect(readFileSync("src/routes/admin.reports.tsx", "utf8")).toContain("Export CSV");
    const nav = readFileSync("src/routes/admin.tsx", "utf8");
    expect(nav).toContain('"/admin/analytics"');
    expect(nav).toContain('"/admin/reports"');
  });
});
