/** Month 6, Prompt 6, the app side: an owner sees only their own capital account, read-only, past and present; the Manager acts. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, USERS, IDS } from "./fixtures";
import * as cap from "@/lib/capital.server";

const db = () => harness.db as any;
const A = IDS.property;
const FAR = new Date(Date.now() + 5000 * 3_600_000).toISOString();

/** What capital_roll_forward returns for the fixture: B1 and B2, 2025 then 2026 (2026 begins where 2025 ended). */
const rf = (year: number) => {
  const base: Record<number, Array<Record<string, any>>> = {
    2025: [
      { member_key: IDS.b1, beginning_cents: 0, opening_cents: 100_000, contributions_cents: 5_000, income_cents: 2_000, expense_cents: -3_000, depreciation_cents: -1_000, distributions_cents: -500, transfer_in_cents: 0, transfer_out_cents: 0, ending_cents: 102_500 },
      { member_key: IDS.b2, beginning_cents: 0, opening_cents: 200_000, contributions_cents: 0, income_cents: 4_000, expense_cents: -6_000, depreciation_cents: -2_000, distributions_cents: -1_000, transfer_in_cents: 0, transfer_out_cents: 0, ending_cents: 195_000 },
    ],
    2026: [
      { member_key: IDS.b1, beginning_cents: 102_500, opening_cents: 0, contributions_cents: 0, income_cents: 1_000, expense_cents: 0, depreciation_cents: 0, distributions_cents: 0, transfer_in_cents: 0, transfer_out_cents: -25_000, ending_cents: 78_500 },
      { member_key: IDS.b2, beginning_cents: 195_000, opening_cents: 0, contributions_cents: 0, income_cents: 2_000, expense_cents: 0, depreciation_cents: 0, distributions_cents: 0, transfer_in_cents: 25_000, transfer_out_cents: 0, ending_cents: 222_000 },
    ],
  };
  return base[year] ?? [];
};

beforeEach(() => {
  seedPod(db());
  db().seed("cap_table_entries", [
    { property_id: A, share_number: 1, holder_type: "buyer_account", buyer_account_id: IDS.b1, acquisition_date: FAR, retention_lock_expires_at: FAR },
    { property_id: A, share_number: 2, holder_type: "buyer_account", buyer_account_id: IDS.b2, acquisition_date: FAR, retention_lock_expires_at: FAR },
  ]);
  db().seed("capital_account_ledger", [
    { property_id: A, member_key: IDS.b1, effective_date: "2025-03-01", amount_cents: 100_000 },
    { property_id: A, member_key: IDS.b2, effective_date: "2025-03-01", amount_cents: 200_000 },
  ]);
  db().rpcResults.capital_roll_forward = (a: any) => rf(a._year);
  db().rpcResults.allocate_income = { status: "posted", total_cents: 1_234 };
  db().rpcResults.post_depreciation = { status: "posted", entry_id: "e-dep" };
  db().rpcResults.sync_month5_events = { expenses: 2, distributions: 1, transfers: 0, problems: [{ error: "closed" }] };
});

const today = new Date("2026-11-12T00:00:00Z");

describe("an owner's capital account", () => {
  it("shows their own row for the current year and every past year, newest first, each beginning where the last ended", async () => {
    const r = await cap.ownerCapitalAccount(db(), { userId: USERS.b1, propertyId: A, today });
    expect(r.allowed).toBe(true);
    expect(r.years.map((y) => y.year)).toEqual([2026, 2025]);
    const [y26, y25] = r.years;
    expect(y25).toMatchObject({ beginningCents: 0, openingCents: 100_000, contributionsCents: 5_000, incomeCents: 2_000, expenseCents: -3_000, depreciationCents: -1_000, distributionsCents: -500, endingCents: 102_500 });
    expect(y26!.beginningCents).toBe(y25!.endingCents);
    expect(y26).toMatchObject({ transferOutCents: -25_000, endingCents: 78_500 });
    // Every line adds up to the ending.
    for (const y of r.years) expect(y.beginningCents + y.openingCents + y.contributionsCents + y.incomeCents + y.expenseCents + y.depreciationCents + y.distributionsCents + y.transferInCents + y.transferOutCents).toBe(y.endingCents);
  });

  it("never shows another member's figures, and nothing at all to someone who isn't an owner of this property", async () => {
    const mine = JSON.stringify(await cap.ownerCapitalAccount(db(), { userId: USERS.b1, propertyId: A, today }));
    for (const theirs of ["200000", "195000", "222000", IDS.b2]) expect(mine).not.toContain(theirs);
    const b2 = await cap.ownerCapitalAccount(db(), { userId: USERS.b2, propertyId: A, today });
    expect(b2.years[1]!.endingCents).toBe(195_000);
    for (const u of [USERS.b3, USERS.ra, USERS.hla, USERS.broker, USERS.admin, "u-nobody"]) expect(await cap.ownerCapitalAccount(db(), { userId: u, propertyId: A, today }), u).toEqual({ allowed: false, years: [] });
  });

  it("a year with no activity carries the balance forward, and a new owner with nothing yet sees an empty list", async () => {
    db().rpcResults.capital_roll_forward = (a: any) => (a._year === 2025 ? rf(2025) : []);
    const r = await cap.ownerCapitalAccount(db(), { userId: USERS.b1, propertyId: A, today });
    expect(r.years[0]).toMatchObject({ year: 2026, beginningCents: 102_500, endingCents: 102_500, contributionsCents: 0 });
    db().table("capital_account_ledger").length = 0;
    expect(await cap.ownerCapitalAccount(db(), { userId: USERS.b1, propertyId: A, today })).toEqual({ allowed: true, years: [] });
  });

  it("is read-only: the page and the server offer no way to change anything", () => {
    const page = readFileSync("src/routes/owner.properties.$propertyId.capital.tsx", "utf8");
    expect(page).not.toMatch(/useMutation|<input|<textarea|<form|<select/);
    expect(page.match(/useServerFn\(/g)).toHaveLength(1); // only the read
    const fnSrc = readFileSync("src/lib/capital.server.ts", "utf8");
    const owner = fnSrc.slice(fnSrc.indexOf("export async function ownerCapitalAccount"), fnSrc.indexOf("export interface AdminRollForward"));
    expect(owner).not.toMatch(/\.insert\(|\.update\(|\.delete\(|rpc\("(post_|allocate_|sync_)/);
  });
});

describe("the Manager", () => {
  it("reads every member's roll-forward with totals that add up", async () => {
    const r = await cap.adminRollForward(db(), { userId: USERS.admin, propertyId: A, year: 2025 });
    expect(r.members.map((m) => [m.member, m.endingCents])).toEqual([["b1@test.local", 102_500], ["b2@test.local", 195_000]]);
    expect(r.totals).toMatchObject({ beginningCents: 0, openingCents: 300_000, contributionsCents: 5_000, endingCents: 297_500 });
    expect(r.totals.beginningCents + r.totals.openingCents + r.totals.contributionsCents + r.totals.incomeCents + r.totals.expenseCents + r.totals.depreciationCents + r.totals.distributionsCents + r.totals.transferInCents + r.totals.transferOutCents).toBe(r.totals.endingCents);
    const y26 = await cap.adminRollForward(db(), { userId: USERS.admin, propertyId: A, year: 2026 });
    expect(y26.totals.beginningCents).toBe(r.totals.endingCents); // beginning(N+1) = ending(N), in total too
    expect(y26.totals.endingCents).toBe(300_500);
  });

  it("only the Manager allocates income, enters depreciation, posts Month 5 events and reads everyone's figures", async () => {
    expect(await cap.allocateIncome(db(), { actorId: USERS.admin, propertyId: A, asOf: "2026-06-30" })).toEqual({ status: "posted", totalCents: 1_234 });
    expect(await cap.enterDepreciation(db(), { actorId: USERS.admin, propertyId: A, year: 2025, amountCents: 40_000, scheduleRef: "CPA 2025" })).toEqual({ entryId: "e-dep" });
    expect(await cap.syncMonth5Events(db(), { actorId: USERS.admin, propertyId: A })).toEqual({ expenses: 2, distributions: 1, transfers: 0, problems: ["closed"] });
    for (const u of [USERS.b1, USERS.hla, USERS.ra, USERS.broker, "u-nobody"]) {
      await expect(cap.allocateIncome(db(), { actorId: u, propertyId: A, asOf: "2026-06-30" })).rejects.toThrow("Only the Manager");
      await expect(cap.enterDepreciation(db(), { actorId: u, propertyId: A, year: 2025, amountCents: 1, scheduleRef: "x" })).rejects.toThrow("Only the Manager");
      await expect(cap.syncMonth5Events(db(), { actorId: u, propertyId: A })).rejects.toThrow("Only the Manager");
      await expect(cap.adminRollForward(db(), { userId: u, propertyId: A, year: 2025 })).rejects.toThrow("Only the Manager");
    }
  });

  it("depreciation needs the CPA's figure and schedule before the database is asked; the platform has no formula", async () => {
    const spy = vi.fn(() => ({ status: "posted", entry_id: "x" }));
    db().rpcResults.post_depreciation = spy;
    await expect(cap.enterDepreciation(db(), { actorId: USERS.admin, propertyId: A, year: 2025, amountCents: 0, scheduleRef: "S" })).rejects.toThrow("whole number of cents above zero");
    await expect(cap.enterDepreciation(db(), { actorId: USERS.admin, propertyId: A, year: 2025, amountCents: 1.5, scheduleRef: "S" })).rejects.toThrow("whole number of cents above zero");
    await expect(cap.enterDepreciation(db(), { actorId: USERS.admin, propertyId: A, year: 2025, amountCents: 100, scheduleRef: "  " })).rejects.toThrow("Name the CPA's schedule");
    expect(spy).not.toHaveBeenCalled();
    for (const f of ["src/lib/capital.server.ts", "src/lib/capital.functions.ts", "capital-events.sql"]) expect(readFileSync(f, "utf8")).not.toMatch(/MACRS|useful life|straight.line|declining balance|recovery period/i);
  });

  it("the page and the schedule are wired", () => {
    const books = readFileSync("src/routes/admin.books.$propertyId.tsx", "utf8");
    for (const label of ["Capital", "Allocate income", "Enter depreciation (from the CPA's schedule)", "Post Month 5 events the ledger hasn't seen"]) expect(books).toContain(label);
    expect(readFileSync("src/routes/owner.properties.$propertyId.index.tsx", "utf8")).toContain("Capital account");
    expect(readFileSync("src/routeTree.gen.ts", "utf8")).toContain("/owner/properties/$propertyId/capital");
  });
});
