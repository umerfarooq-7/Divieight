/** Use Calendar: quotas, turns, rotation, concurrency, scoping and the admin tools. */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS, hoursFromNow } from "./fixtures";
import {
  createCalendarYearAsAdmin,
  getAdminCalendar,
  getOwnerCalendar,
  lockCalendarYear,
  openCalendarSelection,
  overrideCalendarWeek,
  selectCalendarWeek,
  setCalendarHolidays,
  setCalendarTurnHours,
} from "@/lib/use-calendar.functions";
import { runUseCalendarSweep, selectWeek } from "@/lib/use-calendar.server";
import { getOwnerProperty } from "@/lib/owner.functions";
import { computeQuotas, nextTurn, RETAINED_SELLER_NOTE, RETAINED_SELLER_RANK, rotateOrder, weekDates } from "@/lib/use-calendar";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const A = IDS.property;
const B = "prop-2";
const SELLER_KEY = `seller:${IDS.seller}`;

/** Mirrors the row-locked functions in use-calendar.sql (no await: one runs at a time, like the lock). */
function installRpcs() {
  db().rpcResults.select_use_calendar_week = (a: any) => {
    const y = db().table("use_calendar_years").find((r) => r.id === a.p_year_id);
    if (!y || y.status !== "selection_open") return "not_open";
    if (y.turn_holder_key !== a.p_holder_key) return "not_your_turn";
    if (y.turn_seq !== a.p_expected_seq) return "stale";
    const w = db().table("use_calendar_weeks").find((r) => r.property_id === y.property_id && r.year === y.year && r.week_number === a.p_week_number);
    if (!w) return "no_week";
    if (w.holder_key) return "taken";
    if ((y.turn_phase === "holiday") !== w.is_holiday) return "wrong_phase";
    Object.assign(w, { holder_key: a.p_holder_key, selected_by_user_id: a.p_user_id, selected_at: new Date().toISOString(), selection_round: y.turn_round });
    Object.assign(y, { turn_holder_key: a.p_next_holder_key, turn_phase: a.p_next_phase, turn_round: a.p_next_round, turn_deadline_at: a.p_next_deadline, turn_seq: y.turn_seq + 1 });
    return "ok";
  };
  db().rpcResults.advance_use_calendar_turn = (a: any) => {
    const y = db().table("use_calendar_years").find((r) => r.id === a.p_year_id);
    if (!y || y.status !== "selection_open" || y.turn_seq !== a.p_expected_seq) return false;
    Object.assign(y, { turn_holder_key: a.p_next_holder_key, turn_phase: a.p_next_phase, turn_round: a.p_next_round, turn_deadline_at: a.p_next_deadline, turn_seq: y.turn_seq + 1 });
    return true;
  };
}

/** A: B1 (2 shares, earliest), B2 (3 shares), retained seller (3 shares). B: B3. */
function seed() {
  seedPod(db());
  installRpcs();
  db().seed("properties", [{ id: B, address: "77 Second St", city: "Casper", state: "WY", zip: "82601", seller_id: "seller-2" }]);
  db().seed("sellers", [{ id: IDS.seller, email: "seller@test.local", full_name: "Sam Seller" }]);
  Object.assign(db().table("buyer_accounts").find((b) => b.id === IDS.b1)!, { priority_rank: null, priority_rank_timestamp: "2026-01-01T00:00:00.000Z" });
  Object.assign(db().table("buyer_accounts").find((b) => b.id === IDS.b2)!, { priority_rank: null, priority_rank_timestamp: "2026-02-01T00:00:00.000Z" });
  const cap = (property_id: string, share_number: number, holder: Record<string, unknown>) =>
    db().seed("cap_table_entries", [{ property_id, share_number, buyer_account_id: null, seller_id: null, account_member_names: [], ...holder }]);
  for (const n of [1, 2]) cap(A, n, { holder_type: "buyer_account", buyer_account_id: IDS.b1, account_member_names: ["Alice One", "Bob One"] });
  for (const n of [3, 4, 5]) cap(A, n, { holder_type: "buyer_account", buyer_account_id: IDS.b2, account_member_names: ["Carol Two"] });
  for (const n of [6, 7, 8]) cap(A, n, { holder_type: "retained_seller", seller_id: IDS.seller });
  cap(B, 1, { holder_type: "buyer_account", buyer_account_id: IDS.b3, account_member_names: ["Dan Three"] });
}

async function newYear(year = 2027, holidays: number[] = [], open = true, propertyId = A) {
  as(USERS.admin);
  const { id } = await createCalendarYearAsAdmin({ data: { propertyId, year } });
  if (holidays.length) await setCalendarHolidays({ data: { yearId: id, holidayWeeks: holidays } });
  if (open) await openCalendarSelection({ data: { yearId: id } });
  return id;
}
const pick = (user: string, weekNumber: number, year = 2027, propertyId = A) => {
  as(user);
  return selectCalendarWeek({ data: { propertyId, year, weekNumber } });
};
const yearRow = (id: string) => db().table("use_calendar_years").find((y) => y.id === id)!;
const week = (n: number, year = 2027) => db().table("use_calendar_weeks").find((w) => w.year === year && w.week_number === n && w.property_id === A)!;

describe("quota math", () => {
  const holders = [
    { holderKey: "b1", shares: 2 },
    { holderKey: "b2", shares: 3 },
    { holderKey: "s", shares: 3 },
  ];

  it("guarantees 6 weeks a share and shares out the 4 left over, totalling 52", () => {
    const q = computeQuotas(holders, 0);
    expect(q.b1! >= 12 && q.b2! >= 18 && q.s! >= 18).toBe(true);
    expect(q.b1! + q.b2! + q.s!).toBe(52);
    expect(q).toEqual({ b1: 13, b2: 20, s: 19 });
  });

  it("moves the leftover weeks with the rotation, and keeps the cap", () => {
    expect(computeQuotas(holders, 2)).toEqual({ b1: 13, b2: 19, s: 20 });
    const eight = Array.from({ length: 8 }, (_, i) => ({ holderKey: `h${i}`, shares: 1 }));
    const q = computeQuotas(eight, 0);
    expect(Object.values(q).reduce((a, b) => a + b, 0)).toBe(52);
    expect(Math.max(...Object.values(q))).toBe(7);
    expect(Math.min(...Object.values(q))).toBe(6);
  });

  it("leaves unissued shares' weeks open", () => {
    const total = Object.values(computeQuotas([{ holderKey: "a", shares: 2 }], 0)).reduce((x, y) => x + y, 0);
    expect(total).toBe(13);
  });

  it("rotation wraps around", () => {
    expect(rotateOrder(["a", "b", "c"], 1)).toEqual(["b", "c", "a"]);
    expect(rotateOrder(["a", "b", "c"], 4)).toEqual(["b", "c", "a"]);
  });

  it("weeks run seven days from January 1, without overlap", () => {
    expect(weekDates(2027, 1)).toEqual({ startDate: "2027-01-01", endDate: "2027-01-07" });
    expect(weekDates(2027, 2).startDate).toBe("2027-01-08");
    expect(weekDates(2027, 52).endDate).toBe("2027-12-30");
    expect(weekDates(2028, 10).startDate).toBe("2028-03-04"); // leap year
  });
});

describe("turns", () => {
  it("rank 1 picks first; earliest priority timestamp wins when ranks are empty", async () => {
    seed();
    const id = await newYear();
    expect(yearRow(id).turn_holder_key).toBe(IDS.b1);
    as(USERS.b1);
    expect((await getOwnerCalendar({ data: { propertyId: A } })).year).toMatchObject({ isMyTurn: true, myPicked: 0, myQuota: 13 });
    expect(db().notificationsFor(USERS.b1).at(-1)!.message).toContain("your turn");
  });

  it("an explicit priority rank outranks the timestamp", async () => {
    seed();
    db().table("buyer_accounts").find((b) => b.id === IDS.b2)!.priority_rank = 3;
    const id = await newYear();
    expect(yearRow(id).turn_holder_key).toBe(IDS.b2);
  });

  it("rejects an out-of-turn pick, and goes round one week at a time", async () => {
    seed();
    await newYear();
    expect((await pick(USERS.b2, 1)).error).toBe("It isn't your turn.");
    expect((await pick(IDS.seller, 1)).error).toBe("It isn't your turn.");
    expect(week(1).holder_key ?? null).toBeNull();

    expect(await pick(USERS.b1, 1)).toEqual({});
    expect((await pick(USERS.b1, 2)).error).toBe("It isn't your turn.");
    expect(await pick(USERS.b2, 2)).toEqual({});
    expect(await pick(IDS.seller, 3)).toEqual({});
    expect(await pick(USERS.b1, 4)).toEqual({});
    expect(week(1)).toMatchObject({ holder_key: IDS.b1, selection_round: 1, selected_by_user_id: USERS.b1 });
    expect(week(3)).toMatchObject({ holder_key: SELLER_KEY, selection_round: 1 });
    expect(week(4).selection_round).toBe(2);
  });

  it("two simultaneous picks of one week: one wins, the other is refused", async () => {
    seed();
    await newYear();
    as(USERS.b1);
    const results = await Promise.all([
      selectWeek(db() as never, { userId: USERS.b1, propertyId: A, year: 2027, weekNumber: 5 }),
      selectWeek(db() as never, { userId: USERS.b1, propertyId: A, year: 2027, weekNumber: 5 }),
    ]);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect(results.filter((r) => r.error)).toHaveLength(1);
    expect(db().audits("use_calendar.week_selected")).toHaveLength(1);
  });

  it("a double submit can't take two weeks in one turn", async () => {
    seed();
    const id = await newYear();
    as(USERS.b1);
    const results = await Promise.all([
      selectWeek(db() as never, { userId: USERS.b1, propertyId: A, year: 2027, weekNumber: 5 }),
      selectWeek(db() as never, { userId: USERS.b1, propertyId: A, year: 2027, weekNumber: 6 }),
    ]);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect(db().table("use_calendar_weeks").filter((w) => w.holder_key === IDS.b1)).toHaveLength(1);
    expect(yearRow(id).turn_seq).toBe(1);
  });

  it("a taken week is refused", async () => {
    seed();
    await newYear();
    await pick(USERS.b1, 5);
    expect((await pick(USERS.b2, 5)).error).toBe("That week has already been picked.");
  });

  it("fills every quota and finishes, with exactly 52 weeks used", async () => {
    seed();
    const id = await newYear();
    const userOf: Record<string, string> = { [IDS.b1]: USERS.b1, [IDS.b2]: USERS.b2, [SELLER_KEY]: IDS.seller };
    for (let n = 1; n <= 52; n += 1) {
      const turn = yearRow(id).turn_holder_key as string;
      expect(await pick(userOf[turn]!, n)).toEqual({});
    }
    expect(yearRow(id).turn_holder_key).toBeNull();
    expect(yearRow(id).turn_deadline_at).toBeNull();
    const counts = (key: string) => db().table("use_calendar_weeks").filter((w) => w.holder_key === key).length;
    expect([counts(IDS.b1), counts(IDS.b2), counts(SELLER_KEY)]).toEqual([13, 20, 19]);
  });

  it("any member of a multi-member account picks once for the account", async () => {
    seed();
    await newYear();
    expect(await pick(USERS.b1, 1)).toEqual({});
    expect(week(1)).toMatchObject({ holder_key: IDS.b1, selected_by_user_id: USERS.b1 });
  });
});

describe("holiday rotation", () => {
  const ctx = (rotationOffset: number, openHolidayWeeks: number) => ({
    order: ["a", "b", "c"],
    rotationOffset,
    quotas: { a: 13, b: 20, c: 19 },
    picks: {},
    openHolidayWeeks,
    openNormalWeeks: 40,
  });

  it("holiday weeks go first in rotated order; normal weeks in plain order", () => {
    expect(nextTurn(ctx(1, 2), null)).toEqual({ holderKey: "b", phase: "holiday", round: 1 });
    expect(nextTurn(ctx(1, 2), { holderKey: "c", phase: "holiday", round: 1 })).toEqual({ holderKey: "a", phase: "holiday", round: 1 });
    expect(nextTurn(ctx(1, 2), { holderKey: "a", phase: "holiday", round: 1 })).toEqual({ holderKey: "b", phase: "holiday", round: 2 });
    expect(nextTurn(ctx(1, 0), { holderKey: "b", phase: "holiday", round: 1 })).toEqual({ holderKey: "a", phase: "normal", round: 2 });
    expect(nextTurn(ctx(1, 0), null)).toEqual({ holderKey: "a", phase: "normal", round: 1 });
  });

  it("next year's first holiday pick moves down one, and wraps", async () => {
    seed();
    const first = await newYear(2027, [51, 52]);
    const second = await newYear(2028, [51, 52]);
    const third = await newYear(2029, [51, 52]);
    const fourth = await newYear(2030, [51, 52]);
    expect([first, second, third, fourth].map((id) => yearRow(id).rotation_offset)).toEqual([0, 1, 2, 3]);
    expect([first, second, third, fourth].map((id) => yearRow(id).turn_holder_key)).toEqual([IDS.b1, IDS.b2, SELLER_KEY, IDS.b1]);
  });

  it("a skipped year still moves the rotation by the gap", async () => {
    seed();
    await newYear(2027, [], false);
    const id = await newYear(2029, [], false);
    expect(yearRow(id).rotation_offset).toBe(2);
  });

  it("holiday weeks must be settled first, then normal weeks use plain order", async () => {
    seed();
    const id = await newYear(2028, [], false);
    as(USERS.admin);
    await createCalendarYearAsAdmin({ data: { propertyId: A, year: 2027 } });
    await setCalendarHolidays({ data: { yearId: id, holidayWeeks: [51] } });
    await openCalendarSelection({ data: { yearId: id } });
    expect(yearRow(id)).toMatchObject({ turn_phase: "holiday", turn_holder_key: IDS.b1 });
    expect((await pick(USERS.b1, 1, 2028)).error).toBe("Holiday weeks are picked first.");
    expect(await pick(USERS.b1, 51, 2028)).toEqual({});
    expect(yearRow(id)).toMatchObject({ turn_phase: "normal", turn_holder_key: IDS.b1, turn_round: 2 });
  });
});

describe("retained seller", () => {
  it("appears last at rank 9, with the admin note", async () => {
    seed();
    await newYear();
    as(USERS.admin);
    const { holders } = await getAdminCalendar({ data: { propertyId: A } });
    expect(holders.map((h) => [h.name, h.rank])).toEqual([
      ["Alice One & Bob One", 1],
      ["Carol Two", 2],
      ["Sam Seller", RETAINED_SELLER_RANK],
    ]);
    expect(holders[2]!.note).toBe(RETAINED_SELLER_NOTE);
    expect(holders[0]!.note).toBeNull();
    expect(db().table("use_calendar_priority").find((p) => p.holder_key === SELLER_KEY)!.priority_rank).toBe(9);
  });

  it("the note isn't shown to owners", async () => {
    seed();
    await newYear();
    as(USERS.b1);
    expect(JSON.stringify(await getOwnerCalendar({ data: { propertyId: A } }))).not.toContain("Pending Mark");
  });

  it("can pick on their turn", async () => {
    seed();
    await newYear();
    await pick(USERS.b1, 1);
    await pick(USERS.b2, 2);
    expect(await pick(IDS.seller, 3)).toEqual({});
  });
});

describe("deadlines", () => {
  it("a missed turn is skipped with a notice, and the holder picks again later", async () => {
    seed();
    const id = await newYear();
    yearRow(id).turn_deadline_at = hoursFromNow(-1);
    expect(await runUseCalendarSweep(db())).toEqual({ skipped: 1 });
    expect(yearRow(id).turn_holder_key).toBe(IDS.b2);
    expect(db().notificationsFor(USERS.b1).at(-1)!.message).toContain("passed without a pick");
    expect(db().notificationsFor(USERS.b2).at(-1)!.message).toContain("your turn");
    expect(db().audits("use_calendar.turn_skipped")[0]!.metadata.holder_key).toBe(IDS.b1);

    await pick(USERS.b2, 1);
    await pick(IDS.seller, 2);
    expect(await pick(USERS.b1, 3)).toEqual({});
    expect(week(3).selection_round).toBe(2);
  });

  it("the sweep leaves live turns alone", async () => {
    seed();
    const id = await newYear();
    expect(await runUseCalendarSweep(db())).toEqual({ skipped: 0 });
    expect(yearRow(id).turn_holder_key).toBe(IDS.b1);
  });

  it("a pick after the deadline is refused even if the sweep hasn't run", async () => {
    seed();
    const id = await newYear();
    yearRow(id).turn_deadline_at = hoursFromNow(-1);
    expect((await pick(USERS.b1, 1)).error).toBe("It isn't your turn.");
    expect(yearRow(id).turn_holder_key).toBe(IDS.b2);
  });

  it("hours per turn are configurable and used for the next deadline", async () => {
    seed();
    const id = await newYear();
    as(USERS.admin);
    await setCalendarTurnHours({ data: { yearId: id, hours: 2 } });
    await pick(USERS.b1, 1);
    const left = new Date(yearRow(id).turn_deadline_at).getTime() - Date.now();
    expect(left).toBeLessThanOrEqual(2 * 3_600_000);
    expect(left).toBeGreaterThan(3_600_000);
  });
});

describe("scoping and the Rev 48 floor", () => {
  it("an owner of A can't see or pick in B's calendar", async () => {
    seed();
    await newYear(2027, [], true, B);
    as(USERS.b1);
    expect(await getOwnerCalendar({ data: { propertyId: B } })).toEqual({ allowed: false, years: [], year: null, weeks: [] });
    expect((await pick(USERS.b1, 1, 2027, B)).error).toBe("This calendar isn't available.");
    as("u-nobody");
    expect((await getOwnerCalendar({ data: { propertyId: A } })).allowed).toBe(false);
  });

  it("stays visible with a revoked key, and masks other owners until ownership is active", async () => {
    seed();
    await newYear();
    await pick(USERS.b1, 1);
    db().seed("co_owner_digital_keys", [{ property_id: A, holder_type: "buyer_account", buyer_account_id: IDS.b2, shares: 3, status: "revoked" }]);
    as(USERS.b2);
    const view = await getOwnerCalendar({ data: { propertyId: A } });
    expect(view.allowed).toBe(true);
    expect(view.weeks).toHaveLength(52);
    expect(view.weeks[0]).toMatchObject({ state: "other", holderName: "Another owner" });
    expect(JSON.stringify(view)).not.toContain("Alice");
  });

  it("names other owners once active, and never returns holder keys or user ids", async () => {
    seed();
    db().seed("entity_genesis", [{ property_id: A, oa_executed_at: "2026-10-05T00:00:00.000Z" }]);
    db().seed("co_owner_digital_keys", [{ property_id: A, holder_type: "buyer_account", buyer_account_id: IDS.b2, shares: 3, status: "active" }]);
    await newYear();
    await pick(USERS.b1, 1);
    as(USERS.b2);
    const view = await getOwnerCalendar({ data: { propertyId: A } });
    expect(view.weeks[0]).toMatchObject({ state: "other", holderName: "Alice One & Bob One" });
    expect(view.weeks[1]).toMatchObject({ state: "open", holderName: null, selectable: true });
    const text = JSON.stringify(view);
    for (const secret of [IDS.b1, USERS.b1, IDS.seller]) expect(text).not.toContain(secret);
  });

  it("drafts stay hidden from owners", async () => {
    seed();
    await newYear(2027, [], false);
    as(USERS.b1);
    expect((await getOwnerCalendar({ data: { propertyId: A } })).year).toBeNull();
    expect((await pick(USERS.b1, 1)).error).toBe("This calendar isn't available.");
  });
});

describe("admin", () => {
  it("override needs a reason, is logged, and keeps the turn valid", async () => {
    seed();
    const id = await newYear();
    as(USERS.admin);
    await expect(overrideCalendarWeek({ data: { yearId: id, weekNumber: 1, holderKey: IDS.b2, reason: "  " } })).rejects.toThrow("Missing reason");
    await overrideCalendarWeek({ data: { yearId: id, weekNumber: 1, holderKey: IDS.b2, reason: "Agreed swap" } });
    expect(week(1).holder_key).toBe(IDS.b2);
    expect(db().audits("use_calendar.week_overridden")[0]!.metadata).toMatchObject({ reason: "Agreed swap", holder_key: IDS.b2, week_number: 1 });
    expect(yearRow(id).turn_holder_key).toBe(IDS.b1);
    await overrideCalendarWeek({ data: { yearId: id, weekNumber: 1, holderKey: null, reason: "Undo" } });
    expect(week(1).holder_key).toBeNull();
    await expect(overrideCalendarWeek({ data: { yearId: id, weekNumber: 1, holderKey: IDS.b3, reason: "x" } })).rejects.toThrow("cap table");
  });

  it("an override that fills the holder's quota moves the turn on", async () => {
    seed();
    const id = await newYear();
    yearRow(id).quotas[IDS.b1] = 1;
    as(USERS.admin);
    await overrideCalendarWeek({ data: { yearId: id, weekNumber: 9, holderKey: IDS.b1, reason: "Fill" } });
    expect(yearRow(id).turn_holder_key).toBe(IDS.b2);
  });

  it("locking ends selection; the calendar stays visible", async () => {
    seed();
    const id = await newYear();
    await pick(USERS.b1, 1);
    as(USERS.admin);
    await lockCalendarYear({ data: { yearId: id } });
    expect(yearRow(id).status).toBe("locked");
    expect((await pick(USERS.b2, 2)).error).toBe("Selection isn't open for this year.");
    as(USERS.b1);
    const view = await getOwnerCalendar({ data: { propertyId: A } });
    expect(view.year).toMatchObject({ status: "locked", isMyTurn: false, myPicked: 1 });
    expect(view.weeks.every((w) => !w.selectable)).toBe(true);
  });

  it("holidays change only before selection opens; a year can't repeat", async () => {
    seed();
    const id = await newYear(2027, [51]);
    expect(week(51).is_holiday).toBe(true);
    as(USERS.admin);
    await expect(setCalendarHolidays({ data: { yearId: id, holidayWeeks: [1] } })).rejects.toThrow("before selection");
    await expect(createCalendarYearAsAdmin({ data: { propertyId: A, year: 2027 } })).rejects.toThrow("already exists");
    expect(db().table("use_calendar_weeks").filter((w) => w.year === 2027)).toHaveLength(52);
  });

  it("is admin only", async () => {
    seed();
    const id = await newYear(2027, [], false);
    as(USERS.b1);
    await expect(getAdminCalendar({ data: { propertyId: A } })).rejects.toThrow("Not authorized");
    await expect(createCalendarYearAsAdmin({ data: { propertyId: A, year: 2030 } })).rejects.toThrow("Not authorized");
    await expect(openCalendarSelection({ data: { yearId: id } })).rejects.toThrow("Not authorized");
    await expect(setCalendarHolidays({ data: { yearId: id, holidayWeeks: [] } })).rejects.toThrow("Not authorized");
    await expect(setCalendarTurnHours({ data: { yearId: id, hours: 2 } })).rejects.toThrow("Not authorized");
    await expect(overrideCalendarWeek({ data: { yearId: id, weekNumber: 1, holderKey: null, reason: "x" } })).rejects.toThrow("Not authorized");
    await expect(lockCalendarYear({ data: { yearId: id } })).rejects.toThrow("Not authorized");
  });
});

describe("dashboard snapshot", () => {
  it("shows this holder's next 3 stays only", async () => {
    seed();
    db().seed("entity_genesis", [{ property_id: A, oa_executed_at: "2026-10-05T00:00:00.000Z" }]);
    db().seed("co_owner_digital_keys", [{ property_id: A, holder_type: "buyer_account", buyer_account_id: IDS.b1, shares: 2, status: "active" }]);
    const year = new Date().getUTCFullYear() + 1;
    await newYear(year);
    for (const [user, n] of [[USERS.b1, 3], [USERS.b2, 4], [IDS.seller, 5], [USERS.b1, 1], [USERS.b2, 6], [IDS.seller, 7], [USERS.b1, 8], [USERS.b2, 9], [IDS.seller, 10], [USERS.b1, 11]] as const) {
      expect(await pick(user, n, year)).toEqual({});
    }
    as(USERS.b1);
    const r = await getOwnerProperty({ data: { propertyId: A } });
    if (r.access !== "active") throw new Error("expected active");
    expect(r.property.upcomingStays.map((s) => s.weekNumber)).toEqual([1, 3, 8]);
  });

  it("is empty with no weeks", async () => {
    seed();
    db().seed("entity_genesis", [{ property_id: A, oa_executed_at: "2026-10-05T00:00:00.000Z" }]);
    db().seed("co_owner_digital_keys", [{ property_id: A, holder_type: "buyer_account", buyer_account_id: IDS.b1, shares: 2, status: "active" }]);
    as(USERS.b1);
    const r = await getOwnerProperty({ data: { propertyId: A } });
    if (r.access !== "active") throw new Error("expected active");
    expect(r.property.upcomingStays).toEqual([]);
  });
});
