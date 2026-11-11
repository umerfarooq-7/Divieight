/**
 * Use Calendar rules: quotas, pick order and whose turn it is.
 *
 * PLACEHOLDER pending OA language: the Operating Agreement only says occupancy
 * is equal-entitlement and that peak periods rotate (Article V). Everything here
 * — the weeks per share, how the remainder is shared, and the phases — is the
 * current working rule, in one file so it is easy to change.
 *
 * Decided: holiday-week turns are proportional to shares (a holder with N shares gets N holiday turns in each
 * round-set), and the guaranteed weeks per share and the turn length are governance settings
 * (src/lib/governance-config.ts), not numbers written here.
 */
import { GOVERNANCE_DEFAULTS } from "@/lib/governance-config";

export const WEEKS_IN_YEAR = 52;
export const TOTAL_SHARES = 8;
/** Every share is guaranteed this many weeks: 8 × 6 = 48, leaving 4 to share by rotation. */
export const GUARANTEED_WEEKS_PER_SHARE = GOVERNANCE_DEFAULTS.guaranteedWeeksPerShare;
export const DEFAULT_TURN_HOURS = GOVERNANCE_DEFAULTS.useCalendarTurnHours;

/**
 * TEMPORARY: a retained seller has no priority rank, so they pick last
 * (slot 9, after up to eight buyers). Pending Mark's decision. Change here only.
 */
export const RETAINED_SELLER_RANK = 9;
export const RETAINED_SELLER_NOTE = "Pending Mark decision: seller use-calendar position";

export interface CalendarHolder {
  holderKey: string;
  shares: number;
}

/** Holder order shifted by the year's rotation, wrapping around. */
export function rotateOrder<T>(order: T[], rotationOffset: number): T[] {
  if (order.length === 0) return [];
  const shift = ((rotationOffset % order.length) + order.length) % order.length;
  return [...order.slice(shift), ...order.slice(0, shift)];
}

/**
 * Weeks per holder. Each share gets its guaranteed 6. The 4 leftover weeks of a
 * full pod (fewer if shares are unissued) go one at a time around the rotated
 * order, so they move between holders year to year. A holder is capped at half a
 * week per share (rounded up), keeping entitlement near 6.5 weeks a share.
 */
export function computeQuotas(holdersInRankOrder: CalendarHolder[], rotationOffset: number, guaranteedWeeksPerShare: number = GUARANTEED_WEEKS_PER_SHARE): Record<string, number> {
  const quotas: Record<string, number> = {};
  const extra: Record<string, number> = {};
  let issued = 0;
  for (const h of holdersInRankOrder) {
    quotas[h.holderKey] = h.shares * guaranteedWeeksPerShare;
    extra[h.holderKey] = 0;
    issued += h.shares;
  }
  const leftoverForFullPod = WEEKS_IN_YEAR - TOTAL_SHARES * guaranteedWeeksPerShare;
  let remaining = Math.floor((leftoverForFullPod * issued) / TOTAL_SHARES);
  const rotated = rotateOrder(holdersInRankOrder, rotationOffset);
  while (remaining > 0) {
    let gaveOne = false;
    for (const h of rotated) {
      if (remaining === 0) break;
      if (extra[h.holderKey]! >= Math.ceil(h.shares / 2)) continue;
      extra[h.holderKey]! += 1;
      quotas[h.holderKey]! += 1;
      remaining -= 1;
      gaveOne = true;
    }
    if (!gaveOne) break;
  }
  return quotas;
}

export type TurnPhase = "holiday" | "normal";

export interface Turn {
  holderKey: string;
  phase: TurnPhase;
  round: number;
}

export interface TurnContext {
  /** Holder keys in plain priority order (rank 1 first). */
  order: string[];
  rotationOffset: number;
  quotas: Record<string, number>;
  picks: Record<string, number>;
  openHolidayWeeks: number;
  openNormalWeeks: number;
  /**
   * Shares held, per holder. Holiday turns are proportional to it. Without it every holder counts as one share,
   * which is the old one-turn-each behaviour.
   */
  shares?: Record<string, number>;
}

/** Holiday turns a holder takes in each round-set: one per share. */
export const holidayTurnsPerRoundSet = (shares: number): number => Math.max(1, Math.floor(shares));

/**
 * One round-set of holiday turns is as many rounds as the biggest holder has shares. In round r, the holders who have
 * at least r shares pick once, in the rotated order, so a 3-share holder picks in all three rounds, a 2-share holder in
 * the first two and a 1-share holder in the first only. Everyone gets exactly their share count per round-set.
 */
const holidaySubRound = (round: number, maxShares: number) => ((round - 1) % maxShares) + 1;

const remainingFor = (ctx: TurnContext, holderKey: string) => (ctx.quotas[holderKey] ?? 0) - (ctx.picks[holderKey] ?? 0);

/**
 * Whose turn comes next, or null when selection is finished. Holiday weeks go
 * first, in the rotated order; then the other weeks in plain priority order.
 * Each turn is one week; holders whose quota is full are passed over.
 */
export function nextTurn(ctx: TurnContext, current: Turn | null): Turn | null {
  if (!ctx.order.some((h) => remainingFor(ctx, h) > 0)) return null;

  let phase: TurnPhase = current?.phase ?? (ctx.openHolidayWeeks > 0 ? "holiday" : "normal");
  let round = current?.round ?? 1;
  let from = current ? -2 : -1; // -2: find the current holder below
  if (phase === "holiday" && ctx.openHolidayWeeks === 0) {
    if (current) round += 1;
    phase = "normal";
    from = -1;
  }
  if (phase === "normal" && ctx.openNormalWeeks === 0) return null;

  const order = phase === "holiday" ? rotateOrder(ctx.order, ctx.rotationOffset) : ctx.order;
  if (from === -2) from = order.indexOf(current!.holderKey);
  const sharesOf = (holderKey: string) => holidayTurnsPerRoundSet(ctx.shares?.[holderKey] ?? 1);
  const maxShares = phase === "holiday" ? Math.max(1, ...order.map(sharesOf)) : 1;
  for (let step = 1; step <= order.length * maxShares; step += 1) {
    const index = from + step;
    const holderKey = order[index % order.length]!;
    const turnRound = round + Math.floor(index / order.length);
    // In a holiday round only the holders with enough shares for that round take a turn.
    if (phase === "holiday" && sharesOf(holderKey) < holidaySubRound(turnRound, maxShares)) continue;
    if (remainingFor(ctx, holderKey) > 0) {
      return { holderKey, phase, round: turnRound };
    }
  }
  return null;
}

/** Week N of a year: seven days from January 1, as calendar dates. */
export function weekDates(year: number, weekNumber: number): { startDate: string; endDate: string } {
  const day = 86_400_000;
  const start = Date.UTC(year, 0, 1) + (weekNumber - 1) * 7 * day;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(start + 6 * day) };
}
