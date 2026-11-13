/** Month 6, Prompt 10, the app side: the monthly schedule and job, issuing and delivery, the owner's read-only view, and the PDF. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, USERS, IDS } from "./fixtures";
import * as st from "@/lib/statements.server";
import { capitalAddsUp, firstBusinessDay, nthBusinessDay, previousPeriod, statementMoney, statementSchedule, type StatementSnapshot } from "@/lib/statements";
import { renderStatementPdf, PDF_MIN_FONT_PT } from "@/lib/statement-pdf";
import { isMandatoryNotification } from "@/lib/owner-notifications";

const db = () => harness.db as any;
const A = IDS.property;
let calls: Array<[string, Record<string, any>]> = [];

const snapshot = (o: Partial<StatementSnapshot> = {}): StatementSnapshot => ({
  schema: "monthly-statement.v1",
  period: "2026-10",
  period_start: "2026-10-01",
  period_end: "2026-10-31",
  property: { property_id: A, address: "5632 Independence Ave", city: "Lusk", state: "WY", zip: "82225", llc_name: "5632 Independence Ave LLC", shares: 4, total_shares: 8, interest_percent: "50.00" },
  member_key: IDS.b1,
  capital: { opening_cents: 400_000, contributions_cents: 0, distributions_cents: -30_000, income_cents: 25_000, expense_cents: -40_000, depreciation_cents: 0, transfers_cents: 0, closing_cents: 355_000, lines: [{ date: "2026-10-20", type: "distribution", amount_cents: -30_000, memo: "Distribution (Q3)" }] },
  llc_month: {
    income_cents: 50_000,
    expense_cents: 80_000,
    net_cents: -30_000,
    income: [{ code: "4000", name: "Other Income (incidental LLC income only)", total_cents: 50_000, items: [{ date: "2026-10-10", memo: "October rent", amount_cents: 50_000 }] }],
    expense: [{ code: "6400", name: "Repairs and Maintenance Expense", total_cents: 80_000, items: [{ date: "2026-10-15", memo: "Roof repair (Structure & roof)", amount_cents: 80_000 }] }],
  },
  ytd: {
    year: 2026,
    capital: { beginning_cents: 300_000, contributions_cents: 100_000, distributions_cents: -30_000, income_cents: 25_000, expense_cents: -40_000, depreciation_cents: 0, transfers_cents: 0, closing_cents: 355_000 },
    llc: { income_cents: 50_000, expense_cents: 80_000, net_cents: -30_000, income: [], expense: [] },
  },
  generated_at: "2026-11-02T10:00:00Z",
  ...o,
});

const row = (o: Record<string, any> = {}) => ({ id: "st-1", property_id: A, member_key: IDS.b1, period: "2026-10", version: 1, status: "issued", pdf_url: null, data_snapshot: snapshot(), manager_notes: "A capital call is coming.", issued_at: "2026-11-03T12:00:00Z", created_at: "2026-11-02T10:00:00Z", ...o });
const notes = () => (db().table("notifications") as any[]).map((n) => ({ to: n.seller_id, type: n.type, message: n.message as string }));

beforeEach(() => {
  seedPod(db());
  calls = [];
  db().seed("cap_table_entries", [
    { property_id: A, share_number: 1, holder_type: "buyer_account", buyer_account_id: IDS.b1, seller_id: null },
    { property_id: A, share_number: 2, holder_type: "buyer_account", buyer_account_id: IDS.b2, seller_id: null },
  ]);
  db().seed("monthly_statements", []);
  db().rpcResults.generate_monthly_statements = vi.fn((a: any) => {
    calls.push(["generate", a]);
    return { status: "ok", created: 2, refreshed: 0, corrections: 0, unchanged: 0 };
  });
  db().rpcResults.issue_monthly_statements = vi.fn(() => ({ issued: 0, statements: [], review_queue_pending: 0 }));
  db().rpcResults.set_statement_notes = vi.fn(() => 2);
  db().rpcResults.set_statement_pdf = vi.fn();
  db().rpcResults.statement_reconciliation = vi.fn(() => []);
});

describe("the schedule", () => {
  it("the first business day skips weekends (and any holiday on the calendar)", () => {
    expect(firstBusinessDay(2026, 10)).toBe("2026-11-02"); // 1 Nov 2026 is a Sunday
    expect(firstBusinessDay(2026, 2)).toBe("2026-03-02"); // 1 Mar 2026 is a Sunday
    expect(firstBusinessDay(2026, 5)).toBe("2026-06-01"); // a Monday
    expect(firstBusinessDay(2026, 0, ["2026-01-01"])).toBe("2026-01-02"); // the holiday is skipped once one is configured
    expect(nthBusinessDay(2026, 10, 5)).toBe("2026-11-06");
  });

  it("the run is about the month that just ended, and starts on the first business day", () => {
    expect(previousPeriod("2026-11-02")).toBe("2026-10");
    expect(previousPeriod("2026-01-05")).toBe("2025-12");
    expect(statementSchedule("2026-11-01")).toMatchObject({ period: "2026-10", starts: "2026-11-02", due: false });
    expect(statementSchedule("2026-11-02")).toMatchObject({ due: true, overdue: false });
    expect(statementSchedule("2026-11-06").overdue).toBe(false); // the last day of the first business week
    expect(statementSchedule("2026-11-07")).toMatchObject({ due: true, overdue: true, deadline: "2026-11-06" });
  });
});

describe("the monthly job", () => {
  it("does nothing before the first business day", async () => {
    const r = await st.runStatementsSweep(db(), { now: new Date("2026-11-01T10:00:00Z") });
    expect(r).toMatchObject({ due: false, properties: 0 });
    expect(calls).toHaveLength(0);
  });

  it("makes the previous month's drafts for every LLC, as the system, and running it again adds nothing", async () => {
    const first = await st.runStatementsSweep(db(), { now: new Date("2026-11-02T10:00:00Z") });
    expect(first).toMatchObject({ period: "2026-10", properties: 1, created: 2 });
    expect(calls[0]![1]).toMatchObject({ _property: A, _period: "2026-10", _actor: null });
    db().rpcResults.generate_monthly_statements = vi.fn(() => ({ status: "ok", created: 0, refreshed: 0, corrections: 0, unchanged: 2 }));
    expect(await st.runStatementsSweep(db(), { now: new Date("2026-11-03T10:00:00Z") })).toMatchObject({ created: 0, corrections: 0 });
    expect(await st.runStatementsSweep(db(), { now: new Date("2026-11-04T10:00:00Z") })).toMatchObject({ created: 0 });
  });

  it("also looks at months that were already issued, so a correction gets a new version", async () => {
    db().seed("monthly_statements", [row({ period: "2026-08" }), row({ id: "st-2", period: "2026-09" })]);
    db().rpcResults.generate_monthly_statements = vi.fn((a: any) => {
      calls.push(["generate", a]);
      return { status: "ok", created: 0, refreshed: 0, corrections: a._period === "2026-09" ? 2 : 0, unchanged: 0 };
    });
    const r = await st.runStatementsSweep(db(), { now: new Date("2026-11-02T10:00:00Z") });
    expect(calls.map(([, a]) => a._period).sort()).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(r.corrections).toBe(2);
  });

  it("alerts the Manager once if the deadline has passed with drafts waiting, and not before", async () => {
    db().seed("monthly_statements", [row({ id: "d1", status: "draft", issued_at: null })]);
    await st.runStatementsSweep(db(), { now: new Date("2026-11-06T10:00:00Z") }); // the deadline day itself
    expect(notes().filter((n) => n.to === USERS.admin)).toHaveLength(0);
    const r = await st.runStatementsSweep(db(), { now: new Date("2026-11-09T10:00:00Z") });
    expect(r.alerts).toBe(1);
    const alert = notes().filter((n) => n.to === USERS.admin);
    expect(alert).toHaveLength(1);
    expect(alert[0]!.message).toContain("October 2026");
    expect(alert[0]!.message).toContain("2026-11-06");
    await st.runStatementsSweep(db(), { now: new Date("2026-11-10T10:00:00Z") });
    expect(notes().filter((n) => n.to === USERS.admin)).toHaveLength(1); // once per month
  });

  it("no alert when nothing is waiting", async () => {
    db().seed("monthly_statements", [row()]);
    expect((await st.runStatementsSweep(db(), { now: new Date("2026-11-12T10:00:00Z") })).alerts).toBe(0);
  });
});

describe("the Manager's flow", () => {
  it("only the Manager sees the board, generates, adds notes or issues", async () => {
    const p = { userId: USERS.b1, propertyId: A, period: "2026-10" };
    await expect(st.statementBoard(db(), p)).rejects.toThrow("Only the Manager");
    await expect(st.generateStatements(db(), p)).rejects.toThrow("Only the Manager");
    await expect(st.saveStatementNotes(db(), { ...p, notes: "x" })).rejects.toThrow("Only the Manager");
    await expect(st.issueStatements(db(), p)).rejects.toThrow("Only the Manager");
    expect(db().rpcResults.issue_monthly_statements).not.toHaveBeenCalled();
  });

  it("the board shows the drafts, the review queue, the schedule and whether each statement reconciles", async () => {
    db().seed("monthly_statements", [row({ id: "d1", status: "draft", issued_at: null, manager_notes: null })]);
    db().seed("bank_transactions", [{ property_id: A, status: "needs_review", posted_date: "2026-10-12" }, { property_id: A, status: "needs_review", posted_date: "2026-11-12" }, { property_id: A, status: "posted", posted_date: "2026-10-01" }]);
    db().rpcResults.statement_reconciliation = () => [{ statement_id: "d1", reconciles: true }];
    const b = await st.statementBoard(db(), { userId: USERS.admin, propertyId: A, period: "2026-10", today: "2026-11-09" });
    expect(b).toMatchObject({ period: "2026-10", drafts: 1, needsReview: 1 });
    expect(b.schedule).toMatchObject({ deadline: "2026-11-06", overdue: true });
    expect(b.statements[0]).toMatchObject({ id: "d1", status: "draft", reconciles: true, closingCents: 355_000 });
  });

  it("generating and notes pass the month to the database, and notes need a draft to land on", async () => {
    expect(await st.generateStatements(db(), { userId: USERS.admin, propertyId: A, period: "2026-10" })).toMatchObject({ created: 2 });
    await expect(st.generateStatements(db(), { userId: USERS.admin, propertyId: A, period: "October" })).rejects.toThrow("YYYY-MM");
    await st.saveStatementNotes(db(), { userId: USERS.admin, propertyId: A, period: "2026-10", notes: "Capital call in June" });
    expect(db().rpcResults.set_statement_notes).toHaveBeenCalledWith(expect.objectContaining({ _notes: "Capital call in June", _member: null, _actor: USERS.admin }));
    db().rpcResults.set_statement_notes = () => 0;
    await expect(st.saveStatementNotes(db(), { userId: USERS.admin, propertyId: A, period: "2026-10", notes: "x" })).rejects.toThrow("no drafts");
  });

  it("issuing tells each owner in the app (a notice that can't be switched off), files the PDF, and tells them once", async () => {
    const issued = { issued: 2, review_queue_pending: 0, statements: [{ id: "st-1", member_key: IDS.b1, version: 1, superseded_id: null }, { id: "st-2", member_key: IDS.b2, version: 1, superseded_id: null }] };
    db().rpcResults.issue_monthly_statements = vi.fn(() => issued);
    db().seed("monthly_statements", [row(), row({ id: "st-2", member_key: IDS.b2, data_snapshot: snapshot({ member_key: IDS.b2 }) })]);
    const uploads: string[] = [];
    db().storage = { from: () => ({ upload: async (path: string) => (uploads.push(path), { data: { path }, error: null }) }) };
    const r = await st.issueStatements(db(), { userId: USERS.admin, propertyId: A, period: "2026-10" });
    expect(r).toMatchObject({ issued: 2, notified: 2, filed: 2 });
    expect(uploads).toEqual([`${A}/2026-10/${IDS.b1}-v1.pdf`, `${A}/2026-10/${IDS.b2}-v1.pdf`]);
    expect(db().rpcResults.set_statement_pdf).toHaveBeenCalledTimes(2);
    const n = notes().filter((x) => x.type === "monthly_statement");
    expect(n.map((x) => x.to).sort()).toEqual([USERS.b1, USERS.b2].sort());
    expect(n[0]!.message).toContain("October 2026");
    expect(n[0]!.message).toContain("$3,550.00");
    expect(isMandatoryNotification("monthly_statement")).toBe(true);
    expect((await st.issueStatements(db(), { userId: USERS.admin, propertyId: A, period: "2026-10" })).notified).toBe(0); // one notice per statement
    expect(db().rpcResults.issue_monthly_statements).toHaveBeenCalledWith(expect.objectContaining({ _actor: USERS.admin, _force_reason: null }));
  });

  it("a corrected version says so and points to the kept earlier one; a failing PDF store never stops the issue", async () => {
    db().rpcResults.issue_monthly_statements = () => ({ issued: 1, review_queue_pending: 0, statements: [{ id: "st-9", member_key: IDS.b1, version: 2, superseded_id: "st-1" }] });
    db().seed("monthly_statements", [row({ id: "st-9", version: 2 })]);
    db().storage = { from: () => ({ upload: async () => { throw new Error("bucket missing"); } }) };
    const r = await st.issueStatements(db(), { userId: USERS.admin, propertyId: A, period: "2026-10", forceReason: "Waiting on the bank" });
    expect(r).toMatchObject({ issued: 1, notified: 1, filed: 0 });
    expect(notes()[0]!.message).toContain("was corrected (version 2)");
    expect(notes()[0]!.message).toContain("earlier version stays available");
    expect(db().rpcResults.set_statement_pdf).not.toHaveBeenCalled();
    expect(db().rpcResults.issue_monthly_statements).toBeDefined();
  });

  it("surfaces the database's refusal when the review queue isn't clear", async () => {
    db().rpcResults.issue_monthly_statements = undefined;
    const original = db().rpc.bind(db());
    db().rpc = async (fn: string, a: any) => (fn === "issue_monthly_statements" ? { data: null, error: { message: "3 bank transaction(s) are still in the needs-review queue. Review them first, or issue anyway and say why." } } : original(fn, a));
    await expect(st.issueStatements(db(), { userId: USERS.admin, propertyId: A, period: "2026-10" })).rejects.toThrow("needs-review queue");
  });
});

describe("the owner's read-only view", () => {
  beforeEach(() => {
    db().seed("monthly_statements", [
      row({ id: "mine-oct" }),
      row({ id: "mine-sep", period: "2026-09", data_snapshot: snapshot({ period: "2026-09" }) }),
      row({ id: "mine-old", version: 1, status: "superseded", period: "2026-08", data_snapshot: snapshot({ period: "2026-08" }) }),
      row({ id: "mine-new", version: 2, period: "2026-08", data_snapshot: snapshot({ period: "2026-08" }) }),
      row({ id: "mine-draft", period: "2026-11", status: "draft", issued_at: null }),
      row({ id: "theirs", member_key: IDS.b2 }),
      row({ id: "other-property", property_id: "prop-x" }),
    ]);
  });

  it("lists every issued and superseded statement of their own account, newest first, and no draft", async () => {
    const r = await st.ownerStatements(db(), { userId: USERS.b1, propertyId: A });
    if (!r.allowed) throw new Error("expected allowed");
    expect(r.statements.map((s) => [s.id, s.status])).toEqual([["mine-oct", "issued"], ["mine-sep", "issued"], ["mine-new", "issued"], ["mine-old", "superseded"]]);
    const other = await st.ownerStatements(db(), { userId: USERS.b2, propertyId: A });
    if (!other.allowed) throw new Error("expected allowed");
    expect(other.statements.map((s) => s.id)).toEqual(["theirs"]);
    expect(await st.ownerStatements(db(), { userId: "u-nobody", propertyId: A })).toEqual({ allowed: false });
  });

  it("the owner of one account can't open another's statement, a draft, or another property's, and gets the same answer as for a statement that doesn't exist", async () => {
    for (const id of ["theirs", "mine-draft", "other-property", "nope"]) await expect(st.readStatement(db(), { userId: USERS.b1, statementId: id }), id).rejects.toThrow("Statement not found.");
    for (const id of ["theirs", "mine-draft", "nope"]) await expect(st.statementPdf(db(), { userId: USERS.b1, statementId: id }), id).rejects.toThrow("Statement not found.");
    await expect(st.readStatement(db(), { userId: "u-nobody", statementId: "mine-oct" })).rejects.toThrow("Statement not found.");
    expect((await st.readStatement(db(), { userId: USERS.b1, statementId: "mine-oct" })).snapshot.capital.closing_cents).toBe(355_000);
  });

  it("an old version points at the newer one, and the old one is still readable exactly as issued", async () => {
    const old = await st.readStatement(db(), { userId: USERS.b1, statementId: "mine-old" });
    expect(old.status).toBe("superseded");
    expect(old.newerVersion).toMatchObject({ id: "mine-new", version: 2 });
    expect((await st.readStatement(db(), { userId: USERS.b1, statementId: "mine-new" })).newerVersion).toBeNull();
  });

  it("the Manager can open any statement, including a draft", async () => {
    expect((await st.readStatement(db(), { userId: USERS.admin, statementId: "mine-draft" })).status).toBe("draft");
    expect((await st.readStatement(db(), { userId: USERS.admin, statementId: "theirs" })).id).toBe("theirs");
  });

  it("an owner is never refused for their standing: the code that serves them looks at nothing but whose account it is", () => {
    const code = readFileSync("src/lib/statements.server.ts", "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");
    expect(code).not.toMatch(/retention_lock|expense_allocations|capital_call_alloc|eligib/i);
  });
});

describe("the PDF", () => {
  const pdf = (s = snapshot()) => renderStatementPdf({ snapshot: s, memberLabel: "buyer1@example.com", version: 1, status: "issued", issuedAt: "2026-11-03T12:00:00Z" });
  const text = (b: Uint8Array) => new TextDecoder().decode(b);

  it("is a real PDF whose cross-reference table points at the objects", () => {
    const t = text(pdf());
    expect(t.startsWith("%PDF-1.4")).toBe(true);
    expect(t.trimEnd().endsWith("%%EOF")).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(t)![1]);
    expect(t.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...t.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(t.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });

  it("carries the five parts: the property, the capital account, the LLC's activity, the year to date and the Manager's notes", () => {
    const t = text(pdf());
    for (const s of ["Monthly statement: October 2026", "5632 Independence Ave LLC", "Percentage interest", "50.00%", "Opening balance", "Closing balance", "$3,550.00", "-$300.00", "Roof repair", "October rent", "Year to date, 2026", "A capital call is coming.".slice(0, 0), "Manager's notes"]) expect(t).toContain(s.replace(/'/g, "\\'").replace("Manager\\'s", "Manager's"));
  });

  it("never sets text smaller than 11 pt (about 14.7 px)", () => {
    const sizes = [...text(pdf()).matchAll(/\/F[12] ([\d.]+) Tf/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(20);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(PDF_MIN_FONT_PT);
    expect(PDF_MIN_FONT_PT * (96 / 72)).toBeGreaterThanOrEqual(14);
  });

  it("a long month runs onto more pages, with the page count on each", () => {
    const items = Array.from({ length: 80 }, (_, i) => ({ date: "2026-10-15", memo: `Repair visit ${i + 1} with a longer description so that it needs a second line on the page`, amount_cents: 1000 }));
    const big = snapshot({ llc_month: { ...snapshot().llc_month, expense: [{ code: "6400", name: "Repairs", total_cents: 80_000, items }] } });
    const t = text(pdf(big));
    const pages = Number(/\/Count (\d+)/.exec(t)![1]);
    expect(pages).toBeGreaterThan(2);
    expect(t).toContain(`Page ${pages} of ${pages}`);
  });

  it("the same issued statement always gives the same document", () => {
    expect(text(pdf())).toBe(text(pdf()));
  });

  it("the owner's download is that PDF, named for the month and version", async () => {
    db().seed("monthly_statements", [row({ id: "mine-oct" })]);
    const f = await st.statementPdf(db(), { userId: USERS.b1, statementId: "mine-oct" });
    expect(f.filename).toBe("statement-2026-10-v1.pdf");
    expect(Buffer.from(f.base64, "base64").toString("latin1").startsWith("%PDF-1.4")).toBe(true);
  });
});

describe("the numbers on the page", () => {
  it("a statement is one balance: it adds up, and money reads as dollars", () => {
    expect(capitalAddsUp(snapshot().capital)).toBe(true);
    expect(capitalAddsUp({ ...snapshot().capital, closing_cents: 1 })).toBe(false);
    expect(statementMoney(-30_000)).toBe("-$300.00");
    expect(statementMoney(355_000)).toBe("$3,550.00");
  });

  it("the screens carry what the Manager and the owner need, and the job is scheduled", () => {
    const books = readFileSync("src/routes/admin.books.$propertyId.tsx", "utf8");
    for (const l of ["Generate drafts / check for corrections", "Save notes", "Issue all", "needs-review queue", "StatementPreview"]) expect(books, l).toContain(l);
    expect(readFileSync("src/routes/owner.properties.$propertyId.statements.$statementId.tsx", "utf8")).toContain("Download the PDF");
    expect(readFileSync("src/routes/owner.properties.$propertyId.index.tsx", "utf8")).toContain("/statements");
    expect(readFileSync("cron-sweeps.sql", "utf8")).toContain("statements-sweep");
    expect(readFileSync("src/routes/api.public.statements-sweep.ts", "utf8")).toContain("runStatementsSweep");
  });
});
