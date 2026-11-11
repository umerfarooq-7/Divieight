/**
 * Use Calendar (server side). A holder is a Buyer Account (any member picks for
 * it) or a retained seller. Owners can always see their property's calendar: no
 * Digital Key or status check applies (Rev 48 floor).
 */

import { deliver } from "@/lib/authorization.notify.server";
import { loadOwnerProperty } from "@/lib/owner.functions";
import {
  computeQuotas,
  nextTurn,
  RETAINED_SELLER_NOTE,
  RETAINED_SELLER_RANK,
  WEEKS_IN_YEAR,
  weekDates,
  type Turn,
  type TurnContext,
  type TurnPhase,
} from "@/lib/use-calendar";
import { holderFor } from "@/lib/votes.server";
import { loadGovernanceConfig } from "@/lib/governance-config.server";

type Db = { from: (t: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => any };

const MISSING_SCHEMA = "Database is missing the Use Calendar — run use-calendar.sql in Supabase.";
const FORMER_HOLDER = "Former holder";

export interface YearRow {
  id: string;
  property_id: string;
  year: number;
  status: "draft" | "selection_open" | "locked";
  holiday_weeks: number[];
  rotation_offset: number;
  quotas: Record<string, number>;
  turn_hours: number;
  turn_holder_key: string | null;
  turn_phase: TurnPhase | null;
  turn_round: number | null;
  turn_deadline_at: string | null;
  turn_seq: number;
}

interface WeekRow {
  week_number: number;
  start_date: string;
  end_date: string;
  is_holiday: boolean;
  holder_key: string | null;
}

export interface RankedHolder {
  holderKey: string;
  name: string;
  shares: number;
  rank: number;
  isRetainedSeller: boolean;
}

/** Holders in pick order: buyers by rank, then earliest priority timestamp; the retained seller last. */
export async function rankedHolders(db: Db, propertyId: string): Promise<RankedHolder[]> {
  const { data } = await db
    .from("cap_table_entries")
    .select("holder_type, buyer_account_id, seller_id, account_member_names")
    .eq("property_id", propertyId);
  const rows = (data ?? []) as Array<{ holder_type: string; buyer_account_id: string | null; seller_id: string | null; account_member_names: string[] | null }>;

  const buyers = new Map<string, { shares: number; name: string }>();
  const sellers = new Map<string, number>();
  for (const r of rows) {
    if (r.holder_type === "retained_seller" && r.seller_id) sellers.set(r.seller_id, (sellers.get(r.seller_id) ?? 0) + 1);
    else if (r.buyer_account_id) {
      const b = buyers.get(r.buyer_account_id) ?? { shares: 0, name: (r.account_member_names ?? []).filter(Boolean).join(" & ") };
      b.shares += 1;
      buyers.set(r.buyer_account_id, b);
    }
  }

  const { data: accounts } = buyers.size
    ? await db.from("buyer_accounts").select("id, priority_rank, priority_rank_timestamp").in("id", [...buyers.keys()])
    : { data: [] };
  const sorted = ((accounts ?? []) as Array<{ id: string; priority_rank: number | null; priority_rank_timestamp: string | null }>).sort((a, b) => {
    const rank = (a.priority_rank ?? Infinity) - (b.priority_rank ?? Infinity);
    if (rank && Number.isFinite(rank)) return rank;
    if (a.priority_rank != null && b.priority_rank == null) return -1;
    if (a.priority_rank == null && b.priority_rank != null) return 1;
    const time = (s: string | null) => (s ? new Date(s).getTime() : Infinity);
    const diff = time(a.priority_rank_timestamp) - time(b.priority_rank_timestamp);
    return (Number.isNaN(diff) ? 0 : diff) || a.id.localeCompare(b.id);
  });

  const out: RankedHolder[] = sorted.map((a, i) => ({
    holderKey: a.id,
    name: buyers.get(a.id)!.name || "Co-owner",
    shares: buyers.get(a.id)!.shares,
    rank: i + 1,
    isRetainedSeller: false,
  }));
  let sellerSlot = 0;
  for (const [sellerId, shares] of sellers) {
    const { data: s } = await db.from("sellers").select("full_name").eq("id", sellerId).maybeSingle();
    out.push({
      holderKey: `seller:${sellerId}`,
      name: (s?.full_name as string | null) || "Seller",
      shares,
      rank: RETAINED_SELLER_RANK + sellerSlot,
      isRetainedSeller: true,
    });
    sellerSlot += 1;
  }
  return out;
}

async function audit(db: Db, actor: { id: string | null; type: string }, action: string, year: Pick<YearRow, "id" | "property_id" | "year">, extra: Record<string, unknown> = {}) {
  await db.from("audit_log").insert({
    actor_id: actor.id,
    actor_type: actor.type,
    action_type: action,
    entity_type: "use_calendar",
    entity_id: year.id,
    metadata: { property_id: year.property_id, year: year.year, ...extra },
  });
}

async function notifyHolder(db: Db, holderKey: string, propertyId: string, subject: string, message: string, dedupeKey?: string) {
  let recipient: { authUserId: string; email: string | null } | null = null;
  if (holderKey.startsWith("seller:")) recipient = { authUserId: holderKey.slice("seller:".length), email: null };
  else {
    const { data } = await db.from("buyer_accounts").select("auth_user_id, email").eq("id", holderKey).maybeSingle();
    if (data) recipient = { authUserId: data.auth_user_id, email: data.email ?? null };
  }
  if (recipient)
    await deliver(db as never, recipient, { subject, message, link: `/owner/properties/${propertyId}/calendar`, type: "calendar_turn", propertyId, dedupeKey });
}

/** turnSeq is the turn this starts: each one is told once, however it came about. */
const notifyTurn = (db: Db, year: YearRow, holderKey: string, turnSeq = year.turn_seq + 1) =>
  notifyHolder(db, holderKey, year.property_id, "It's your turn to pick a week", `It's your turn to pick a ${year.year} Use Calendar week.`, `calendar_turn:${year.id}:${turnSeq}`);

async function yearWeeks(db: Db, year: Pick<YearRow, "property_id" | "year">): Promise<WeekRow[]> {
  const { data } = await db
    .from("use_calendar_weeks")
    .select("week_number, start_date, end_date, is_holiday, holder_key")
    .eq("property_id", year.property_id)
    .eq("year", year.year)
    .order("week_number", { ascending: true });
  return (data ?? []) as WeekRow[];
}

async function turnContext(db: Db, year: YearRow, weeks: WeekRow[]): Promise<TurnContext> {
  const { data } = await db.from("use_calendar_priority").select("holder_key, priority_rank").eq("property_id", year.property_id);
  // Someone who sold all their shares takes no more turns, but keeps what they picked.
  const { data: cap } = await db.from("cap_table_entries").select("holder_type, buyer_account_id, seller_id").eq("property_id", year.property_id);
  const current = new Set(((cap ?? []) as Array<{ holder_type: string; buyer_account_id: string | null; seller_id: string | null }>).map((c) => (c.holder_type === "retained_seller" ? `seller:${c.seller_id}` : String(c.buyer_account_id))));
  const order = ((data ?? []) as Array<{ holder_key: string; priority_rank: number }>)
    .sort((a, b) => a.priority_rank - b.priority_rank)
    .map((p) => p.holder_key)
    .filter((key) => key in year.quotas && current.has(key));
  const picks: Record<string, number> = {};
  for (const w of weeks) if (w.holder_key) picks[w.holder_key] = (picks[w.holder_key] ?? 0) + 1;
  // Holiday turns are proportional to the shares each holder has.
  const shares: Record<string, number> = {};
  for (const c of (cap ?? []) as Array<{ holder_type: string; buyer_account_id: string | null; seller_id: string | null }>) {
    const key = c.holder_type === "retained_seller" ? `seller:${c.seller_id}` : String(c.buyer_account_id);
    shares[key] = (shares[key] ?? 0) + 1;
  }
  return {
    shares,
    order,
    rotationOffset: year.rotation_offset,
    quotas: year.quotas,
    picks,
    openHolidayWeeks: weeks.filter((w) => !w.holder_key && w.is_holiday).length,
    openNormalWeeks: weeks.filter((w) => !w.holder_key && !w.is_holiday).length,
  };
}

const currentTurn = (year: YearRow): Turn | null =>
  year.turn_holder_key && year.turn_phase ? { holderKey: year.turn_holder_key, phase: year.turn_phase, round: year.turn_round ?? 1 } : null;

const deadlineFrom = (hours: number, turn: Turn | null) => (turn ? new Date(Date.now() + hours * 3_600_000).toISOString() : null);

async function moveTurn(db: Db, year: YearRow, next: Turn | null): Promise<boolean> {
  const { data, error } = await db.rpc!("advance_use_calendar_turn", {
    p_year_id: year.id,
    p_expected_seq: year.turn_seq,
    p_next_holder_key: next?.holderKey ?? null,
    p_next_phase: next?.phase ?? null,
    p_next_round: next?.round ?? null,
    p_next_deadline: deadlineFrom(year.turn_hours, next),
  });
  return !error && data === true;
}

/** A missed deadline skips that one turn; the holder keeps their quota for a later round. */
async function skipExpiredTurn(db: Db, year: YearRow): Promise<YearRow> {
  const current = currentTurn(year);
  if (year.status !== "selection_open" || !current || !year.turn_deadline_at) return year;
  if (Date.now() < new Date(year.turn_deadline_at).getTime()) return year;
  const ctx = await turnContext(db, year, await yearWeeks(db, year));
  const next = nextTurn(ctx, current);
  if (!(await moveTurn(db, year, next))) return (await loadYear(db, year.id)) ?? year;
  await audit(db, { id: null, type: "system" }, "use_calendar.turn_skipped", year, { holder_key: current.holderKey, round: current.round });
  await notifyHolder(db, current.holderKey, year.property_id, "Your Use Calendar turn was skipped", `Your ${year.year} Use Calendar turn passed without a pick, so it moved on. You'll get another turn in a later round.`);
  if (next) await notifyTurn(db, year, next.holderKey);
  return (await loadYear(db, year.id)) ?? year;
}

async function loadYear(db: Db, id: string): Promise<YearRow | null> {
  const { data } = await db.from("use_calendar_years").select("*").eq("id", id).maybeSingle();
  return (data as YearRow) ?? null;
}

export async function runUseCalendarSweep(db: Db): Promise<{ skipped: number }> {
  const { data, error } = await db
    .from("use_calendar_years")
    .select("*")
    .eq("status", "selection_open")
    .lt("turn_deadline_at", new Date().toISOString());
  if (error) return { skipped: 0 };
  let skipped = 0;
  for (const year of (data ?? []) as YearRow[]) {
    const after = await skipExpiredTurn(db, year);
    if (after.turn_seq !== year.turn_seq) skipped += 1;
  }
  return { skipped };
}

export interface OwnerCalendarWeek {
  weekNumber: number;
  startDate: string;
  endDate: string;
  isHoliday: boolean;
  state: "mine" | "other" | "open";
  holderName: string | null;
  selectable: boolean;
}

export interface OwnerCalendar {
  allowed: boolean;
  years: number[];
  year: {
    year: number;
    status: YearRow["status"];
    isMyTurn: boolean;
    turnHolderName: string | null;
    phase: TurnPhase | null;
    round: number | null;
    deadlineAt: string | null;
    myQuota: number;
    myPicked: number;
    myHolidayTurns: number;
  } | null;
  weeks: OwnerCalendarWeek[];
}

export async function ownerCalendar(db: Db, userId: string, propertyId: string, requestedYear: number | null): Promise<OwnerCalendar> {
  const holder = await holderFor(db, userId, propertyId);
  if (!holder) return { allowed: false, years: [], year: null, weeks: [] };

  const { data, error } = await db
    .from("use_calendar_years")
    .select("*")
    .eq("property_id", propertyId)
    .neq("status", "draft")
    .order("year", { ascending: false });
  const years = error ? [] : ((data ?? []) as YearRow[]);
  if (years.length === 0) return { allowed: true, years: [], year: null, weeks: [] };

  const thisYear = new Date().getUTCFullYear();
  const chosen =
    years.find((y) => y.year === requestedYear) ??
    years.find((y) => y.status === "selection_open") ??
    years.find((y) => y.year === thisYear) ??
    years[0]!;
  const year = await skipExpiredTurn(db, chosen);
  const weeks = await yearWeeks(db, year);

  // Other owners are named only once ownership is active, as on the roster.
  const access = await loadOwnerProperty(db as never, userId, propertyId);
  const names = access.access === "active" ? new Map((await rankedHolders(db, propertyId)).map((h) => [h.holderKey, h.name])) : new Map<string, string>();
  const isMyTurn = year.status === "selection_open" && year.turn_holder_key === holder.holderKey;
  const myPicked = weeks.filter((w) => w.holder_key === holder.holderKey).length;

  return {
    allowed: true,
    years: years.map((y) => y.year),
    year: {
      year: year.year,
      status: year.status,
      isMyTurn,
      turnHolderName: !isMyTurn && year.turn_holder_key ? (names.get(year.turn_holder_key) ?? "Another owner") : null,
      phase: year.status === "selection_open" ? year.turn_phase : null,
      round: year.status === "selection_open" ? year.turn_round : null,
      deadlineAt: year.status === "selection_open" ? year.turn_deadline_at : null,
      myQuota: year.quotas[holder.holderKey] ?? 0,
      myPicked,
      /** Holiday turns are proportional to shares: this many in each round-set. */
      myHolidayTurns: holder.shareNumbers.length,
    },
    weeks: weeks.map((w) => {
      const mine = w.holder_key === holder.holderKey;
      return {
        weekNumber: w.week_number,
        startDate: w.start_date,
        endDate: w.end_date,
        isHoliday: w.is_holiday,
        state: mine ? "mine" : w.holder_key ? "other" : "open",
        holderName: mine ? "You" : w.holder_key ? (names.get(w.holder_key) ?? "Another owner") : null,
        selectable: isMyTurn && !w.holder_key && (year.turn_phase === "holiday") === w.is_holiday,
      };
    }),
  };
}

/** select_week: only the holder whose turn it is, one week, with the row lock in the database. */
export async function selectWeek(
  db: Db,
  params: { userId: string; propertyId: string; year: number; weekNumber: number },
): Promise<{ error?: string }> {
  const holder = await holderFor(db, params.userId, params.propertyId);
  if (!holder) return { error: "This calendar isn't available." };
  const { data } = await db
    .from("use_calendar_years")
    .select("*")
    .eq("property_id", params.propertyId)
    .eq("year", params.year)
    .neq("status", "draft")
    .maybeSingle();
  if (!data) return { error: "This calendar isn't available." };
  const year = await skipExpiredTurn(db, data as YearRow);
  if (year.status !== "selection_open") return { error: "Selection isn't open for this year." };
  if (year.turn_holder_key !== holder.holderKey) return { error: "It isn't your turn." };

  const weeks = await yearWeeks(db, year);
  const week = weeks.find((w) => w.week_number === params.weekNumber);
  if (!week) return { error: "That week doesn't exist." };
  if (week.holder_key) return { error: "That week has already been picked." };
  if ((year.turn_phase === "holiday") !== week.is_holiday)
    return { error: year.turn_phase === "holiday" ? "Holiday weeks are picked first." : "All holiday weeks have been settled for this round." };

  const after = weeks.map((w) => (w.week_number === week.week_number ? { ...w, holder_key: holder.holderKey } : w));
  const next = nextTurn(await turnContext(db, year, after), currentTurn(year));
  const { data: result, error } = await db.rpc!("select_use_calendar_week", {
    p_year_id: year.id,
    p_week_number: week.week_number,
    p_holder_key: holder.holderKey,
    p_user_id: params.userId,
    p_expected_seq: year.turn_seq,
    p_next_holder_key: next?.holderKey ?? null,
    p_next_phase: next?.phase ?? null,
    p_next_round: next?.round ?? null,
    p_next_deadline: deadlineFrom(year.turn_hours, next),
  });
  if (error) return { error: /select_use_calendar_week/.test(error.message) ? MISSING_SCHEMA : error.message };
  if (result !== "ok") {
    const messages: Record<string, string> = {
      taken: "That week has already been picked.",
      not_open: "Selection isn't open for this year.",
      wrong_phase: "That week can't be picked in this phase.",
      no_week: "That week doesn't exist.",
    };
    return { error: messages[String(result)] ?? "It isn't your turn." };
  }

  await audit(db, { id: params.userId, type: holder.type }, "use_calendar.week_selected", year, {
    holder_key: holder.holderKey,
    week_number: week.week_number,
    round: year.turn_round,
  });
  if (next) await notifyTurn(db, year, next.holderKey);
  return {};
}

/** Dashboard snapshot: this holder's next stays. */
export async function nextStays(db: Db, propertyId: string, holderKey: string, limit = 3) {
  const { data, error } = await db
    .from("use_calendar_weeks")
    .select("year, week_number, start_date, end_date")
    .eq("property_id", propertyId)
    .eq("holder_key", holderKey)
    .gte("end_date", new Date().toISOString().slice(0, 10))
    .order("start_date", { ascending: true })
    .limit(limit);
  if (error) return [];
  return ((data ?? []) as Array<{ year: number; week_number: number; start_date: string; end_date: string }>).map((w) => ({
    weekNumber: w.week_number,
    startDate: w.start_date,
    endDate: w.end_date,
  }));
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export async function adminCalendar(db: Db, propertyId: string) {
  const { data: p } = await db.from("properties").select("address, city, state").eq("id", propertyId).maybeSingle();
  if (!p) throw new Error("Property not found");
  const { data, error } = await db.from("use_calendar_years").select("*").eq("property_id", propertyId).order("year", { ascending: false });
  if (error) throw new Error(MISSING_SCHEMA);
  const holders = await rankedHolders(db, propertyId);
  const nameOf = new Map(holders.map((h) => [h.holderKey, h.name]));
  const years = [];
  for (const row of (data ?? []) as YearRow[]) {
    const year = await skipExpiredTurn(db, row);
    const weeks = await yearWeeks(db, year);
    years.push({
      id: year.id,
      year: year.year,
      status: year.status,
      rotationOffset: year.rotation_offset,
      turnHours: year.turn_hours,
      turnHolderName: year.turn_holder_key ? (nameOf.get(year.turn_holder_key) ?? FORMER_HOLDER) : null,
      turnPhase: year.turn_phase,
      turnRound: year.turn_round,
      deadlineAt: year.turn_deadline_at,
      holidayWeeks: weeks.filter((w) => w.is_holiday).map((w) => w.week_number),
      quotas: year.quotas,
      picks: Object.fromEntries(holders.map((h) => [h.holderKey, weeks.filter((w) => w.holder_key === h.holderKey).length])),
      weeks: weeks.map((w) => ({
        weekNumber: w.week_number,
        startDate: w.start_date,
        endDate: w.end_date,
        isHoliday: w.is_holiday,
        holderKey: w.holder_key,
        holderName: w.holder_key ? (nameOf.get(w.holder_key) ?? FORMER_HOLDER) : null,
      })),
      weekHolders: [...new Set(weeks.map((w) => w.holder_key).filter(Boolean))].map((key) => ({ holderKey: key as string, name: nameOf.get(key as string) ?? FORMER_HOLDER })),
    });
  }
  return {
    label: [p.address, p.city, p.state].filter(Boolean).join(", "),
    holders: holders.map((h) => ({ ...h, note: h.isRetainedSeller ? RETAINED_SELLER_NOTE : null })),
    years,
  };
}

async function refreshPriority(db: Db, propertyId: string, holders: RankedHolder[]) {
  await db.from("use_calendar_priority").delete().eq("property_id", propertyId);
  if (holders.length) {
    const { error } = await db
      .from("use_calendar_priority")
      .insert(holders.map((h) => ({ property_id: propertyId, holder_key: h.holderKey, priority_rank: h.rank })));
    if (error) throw new Error(MISSING_SCHEMA);
  }
}

/** Create a year with its 52 weeks. rotation_offset moves on by one per year. */
export async function createCalendarYear(db: Db, actorId: string, propertyId: string, year: number, turnHours: number | null) {
  const { data: property } = await db.from("properties").select("id").eq("id", propertyId).maybeSingle();
  if (!property) throw new Error("Property not found");
  const { data: earlier, error: readError } = await db.from("use_calendar_years").select("year, rotation_offset").eq("property_id", propertyId);
  if (readError) throw new Error(MISSING_SCHEMA);
  const rows = (earlier ?? []) as Array<{ year: number; rotation_offset: number }>;
  if (rows.some((r) => r.year === year)) throw new Error(`${year} already exists.`);
  const previous = rows.filter((r) => r.year < year).sort((a, b) => b.year - a.year)[0];

  const { data: created, error } = await db
    .from("use_calendar_years")
    .insert({
      property_id: propertyId,
      year,
      status: "draft",
      holiday_weeks: [],
      rotation_offset: previous ? previous.rotation_offset + (year - previous.year) : 0,
      turn_hours: turnHours ?? (await loadGovernanceConfig(db)).useCalendarTurnHours,
      quotas: {},
      turn_seq: 0,
    })
    .select("*")
    .maybeSingle();
  if (error || !created) throw new Error(error?.message ?? MISSING_SCHEMA);

  const weeks = Array.from({ length: WEEKS_IN_YEAR }, (_, i) => {
    const { startDate, endDate } = weekDates(year, i + 1);
    return { property_id: propertyId, year, week_number: i + 1, start_date: startDate, end_date: endDate, is_holiday: false };
  });
  const { error: weeksError } = await db.from("use_calendar_weeks").insert(weeks);
  if (weeksError) throw new Error(weeksError.message);
  await audit(db, { id: actorId, type: "admin" }, "use_calendar.year_created", created as YearRow, { rotation_offset: created.rotation_offset });
  return created as YearRow;
}

export async function setHolidayWeeks(db: Db, actorId: string, yearId: string, holidayWeeks: number[]) {
  const year = await loadYear(db, yearId);
  if (!year) throw new Error("Year not found");
  if (year.status !== "draft") throw new Error("Holiday weeks can only change before selection opens.");
  const unique = [...new Set(holidayWeeks)].sort((a, b) => a - b);
  if (unique.some((w) => !Number.isInteger(w) || w < 1 || w > WEEKS_IN_YEAR)) throw new Error("Weeks must be between 1 and 52.");
  await db.from("use_calendar_years").update({ holiday_weeks: unique }).eq("id", year.id);
  for (const w of await yearWeeks(db, year)) {
    const flagged = unique.includes(w.week_number);
    if (flagged !== w.is_holiday)
      await db.from("use_calendar_weeks").update({ is_holiday: flagged }).eq("property_id", year.property_id).eq("year", year.year).eq("week_number", w.week_number);
  }
  await audit(db, { id: actorId, type: "admin" }, "use_calendar.holidays_set", year, { holiday_weeks: unique });
}

export async function setTurnHours(db: Db, actorId: string, yearId: string, hours: number) {
  const year = await loadYear(db, yearId);
  if (!year) throw new Error("Year not found");
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new Error("Hours per turn must be between 1 and 720.");
  await db.from("use_calendar_years").update({ turn_hours: hours }).eq("id", year.id);
  await audit(db, { id: actorId, type: "admin" }, "use_calendar.turn_hours_set", year, { turn_hours: hours });
}

/** Open selection: ranks and quotas are fixed from the cap table now. */
export async function openSelection(db: Db, actorId: string, yearId: string) {
  const year = await loadYear(db, yearId);
  if (!year) throw new Error("Year not found");
  if (year.status !== "draft") throw new Error("Only a draft year can be opened.");
  const holders = await rankedHolders(db, year.property_id);
  if (holders.length === 0) throw new Error("This property has no holders on its cap table.");
  await refreshPriority(db, year.property_id, holders);

  const quotas = computeQuotas(holders, year.rotation_offset, (await loadGovernanceConfig(db)).guaranteedWeeksPerShare);
  const weeks = await yearWeeks(db, year);
  const opened = { ...year, quotas };
  const first = nextTurn(await turnContext(db, opened, weeks), null);
  await db
    .from("use_calendar_years")
    .update({
      status: "selection_open",
      quotas,
      turn_holder_key: first?.holderKey ?? null,
      turn_phase: first?.phase ?? null,
      turn_round: first?.round ?? null,
      turn_deadline_at: deadlineFrom(year.turn_hours, first),
    })
    .eq("id", year.id)
    .eq("status", "draft");
  await audit(db, { id: actorId, type: "admin" }, "use_calendar.selection_opened", year, { quotas, first_holder: first?.holderKey ?? null });
  if (first) await notifyTurn(db, year, first.holderKey, year.turn_seq);
}

/** Force-assign or clear a week. The reason is required and logged; quotas don't bind an override. */
export async function overrideWeek(
  db: Db,
  params: { actorId: string; yearId: string; weekNumber: number; holderKey: string | null; reason: string },
) {
  const year = await loadYear(db, params.yearId);
  if (!year) throw new Error("Year not found");
  if (year.status === "draft") throw new Error("Open selection before assigning weeks.");
  const reason = params.reason.trim();
  if (!reason) throw new Error("A reason is required.");
  const weeks = await yearWeeks(db, year);
  const week = weeks.find((w) => w.week_number === params.weekNumber);
  if (!week) throw new Error("Week not found");
  if (params.holderKey && !(await rankedHolders(db, year.property_id)).some((h) => h.holderKey === params.holderKey))
    throw new Error("That holder isn't on this property's cap table.");

  await db
    .from("use_calendar_weeks")
    .update({ holder_key: params.holderKey, selected_by_user_id: params.actorId, selected_at: new Date().toISOString(), selection_round: null })
    .eq("property_id", year.property_id)
    .eq("year", year.year)
    .eq("week_number", week.week_number);
  await audit(db, { id: params.actorId, type: "admin" }, "use_calendar.week_overridden", year, {
    week_number: week.week_number,
    previous_holder: week.holder_key,
    holder_key: params.holderKey,
    reason,
  });

  // Keep the turn consistent with the new picture.
  if (year.status !== "selection_open") return;
  const after = weeks.map((w) => (w.week_number === week.week_number ? { ...w, holder_key: params.holderKey } : w));
  const ctx = await turnContext(db, year, after);
  const current = currentTurn(year);
  const currentStillValid =
    current &&
    (ctx.quotas[current.holderKey] ?? 0) - (ctx.picks[current.holderKey] ?? 0) > 0 &&
    (current.phase === "holiday" ? ctx.openHolidayWeeks : ctx.openNormalWeeks) > 0;
  if (currentStillValid) return;
  const next = nextTurn(ctx, current);
  if (next?.holderKey === current?.holderKey && next?.phase === current?.phase && next?.round === current?.round) return;
  if ((await moveTurn(db, year, next)) && next) await notifyTurn(db, year, next.holderKey);
}

/**
 * After a resale the old holder keeps their picked weeks until the year ends.
 * This moves their upcoming weeks, and the quota for them, to a current holder.
 */
export async function transferUpcomingWeeks(
  db: Db,
  params: { actorId: string; yearId: string; fromHolderKey: string; toHolderKey: string; reason: string },
): Promise<{ moved: number }> {
  const year = await loadYear(db, params.yearId);
  if (!year) throw new Error("Year not found");
  if (year.status === "draft") throw new Error("Open selection before transferring weeks.");
  if (params.fromHolderKey === params.toHolderKey) throw new Error("Choose two different holders.");
  if (!(await rankedHolders(db, year.property_id)).some((h) => h.holderKey === params.toHolderKey)) throw new Error("That holder isn't on this property's cap table.");
  const today = new Date().toISOString().slice(0, 10);
  const moving = (await yearWeeks(db, year)).filter((w) => w.holder_key === params.fromHolderKey && w.end_date >= today);
  if (moving.length === 0) throw new Error("That holder has no upcoming weeks in this year.");
  for (const w of moving) {
    await db
      .from("use_calendar_weeks")
      .update({ holder_key: params.toHolderKey, selected_by_user_id: params.actorId, selected_at: new Date().toISOString(), selection_round: null })
      .eq("property_id", year.property_id)
      .eq("year", year.year)
      .eq("week_number", w.week_number)
      .eq("holder_key", params.fromHolderKey);
  }
  const quotas = { ...year.quotas };
  if (params.fromHolderKey in quotas) quotas[params.fromHolderKey] = Math.max(0, (quotas[params.fromHolderKey] ?? 0) - moving.length);
  quotas[params.toHolderKey] = (quotas[params.toHolderKey] ?? 0) + moving.length;
  await db.from("use_calendar_years").update({ quotas }).eq("id", year.id);
  await audit(db, { id: params.actorId, type: "admin" }, "use_calendar.weeks_transferred", year, {
    from_holder_key: params.fromHolderKey,
    to_holder_key: params.toHolderKey,
    weeks: moving.map((w) => w.week_number),
    reason: params.reason,
  });
  const text = `${moving.length} ${year.year} Use Calendar week${moving.length === 1 ? "" : "s"} moved by divieight. Reason: ${params.reason}`;
  await notifyHolder(db, params.fromHolderKey, year.property_id, "Use Calendar weeks moved", text);
  await notifyHolder(db, params.toHolderKey, year.property_id, "Use Calendar weeks moved", text);
  return { moved: moving.length };
}

export async function lockYear(db: Db, actorId: string, yearId: string) {
  const year = await loadYear(db, yearId);
  if (!year) throw new Error("Year not found");
  if (year.status === "locked") return;
  await db
    .from("use_calendar_years")
    .update({ status: "locked", turn_holder_key: null, turn_phase: null, turn_round: null, turn_deadline_at: null, turn_seq: year.turn_seq + 1 })
    .eq("id", year.id);
  await audit(db, { id: actorId, type: "admin" }, "use_calendar.year_locked", year);
}
