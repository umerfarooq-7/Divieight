/**
 * Governance numbers, in one place. The constants below are the defaults; an admin-editable settings table
 * (governance_settings) can override each of them, and only the founder role may change it. Every reader of
 * these numbers goes through resolveConfig(), so there is no second copy of any of them anywhere else.
 *
 * Not the commission math, not the saga: those are untouched.
 */

export const GOVERNANCE_KEYS = [
  "ordinaryVotePercent",
  "majorVotePercent",
  "unanimousVotePercent",
  "capitalCallVoteThresholdUsd",
  "retentionReleaseVoteDays",
  "rofrWindowHours",
  "rofrNextOfferHours",
  "openMarketExpiryDays",
  "useCalendarTurnHours",
  "guaranteedWeeksPerShare",
] as const;
export type GovernanceKey = (typeof GOVERNANCE_KEYS)[number];
export type GovernanceConfig = Record<GovernanceKey, number>;

/** The decided answers. These are the values in force until the founder changes one. */
export const GOVERNANCE_DEFAULTS: GovernanceConfig = {
  /** Ordinary: this percent of all issued shares, plus one share. */
  ordinaryVotePercent: 50,
  /** Major: at least this percent of all issued shares. */
  majorVotePercent: 75,
  /** Unanimous: at least this percent of all issued shares (100 means every share). */
  unanimousVotePercent: 100,
  /** A capital call strictly above this amount needs a passed Major vote. */
  capitalCallVoteThresholdUsd: 10_000,
  /** How long a Retention Lock release (unanimous consent) vote stays open. */
  retentionReleaseVoteDays: 14,
  /** The co-owners' right of first refusal. */
  rofrWindowHours: 240,
  /** The fresh, shorter window given to the next co-owner when a ROFR sale is cancelled. */
  rofrNextOfferHours: 48,
  /** How long an open-market listing stays up before it expires. */
  openMarketExpiryDays: 180,
  /** How long a Use Calendar turn lasts. */
  useCalendarTurnHours: 48,
  /** Weeks every share is guaranteed in the Use Calendar. */
  guaranteedWeeksPerShare: 6,
};

export interface GovernanceSetting {
  key: GovernanceKey;
  label: string;
  unit: string;
  help: string;
  min: number;
  max: number;
  integer: boolean;
}

export const GOVERNANCE_SETTINGS: GovernanceSetting[] = [
  { key: "ordinaryVotePercent", label: "Ordinary vote", unit: "% of issued shares, plus one share", help: "An Ordinary vote passes with more than this share of all issued shares.", min: 1, max: 99, integer: true },
  { key: "majorVotePercent", label: "Major vote", unit: "% of issued shares", help: "A Major vote passes with at least this share of all issued shares.", min: 1, max: 100, integer: true },
  { key: "unanimousVotePercent", label: "Unanimous vote", unit: "% of issued shares", help: "100 means every issued share.", min: 1, max: 100, integer: true },
  { key: "capitalCallVoteThresholdUsd", label: "Capital-call vote threshold", unit: "USD", help: "A capital call strictly above this amount needs a passed Major vote. Exactly this amount does not.", min: 0, max: 100_000_000, integer: false },
  { key: "retentionReleaseVoteDays", label: "Retention Lock release vote", unit: "days", help: "How long a unanimous-consent release vote stays open.", min: 1, max: 90, integer: true },
  { key: "rofrWindowHours", label: "Right of first refusal window", unit: "hours", help: "240 hours is 10 days. Applies to listings made after the change.", min: 1, max: 2160, integer: true },
  { key: "rofrNextOfferHours", label: "Next co-owner window after a cancelled sale", unit: "hours", help: "The fresh window given to the next co-owner who elected.", min: 1, max: 720, integer: true },
  { key: "openMarketExpiryDays", label: "Open-market listing expiry", unit: "days", help: "A listing on the open market expires after this many days. Applies to listings that reach the open market after the change.", min: 1, max: 730, integer: true },
  { key: "useCalendarTurnHours", label: "Use Calendar turn length", unit: "hours", help: "The default for a new calendar year. An admin can still change one year.", min: 1, max: 720, integer: true },
  { key: "guaranteedWeeksPerShare", label: "Guaranteed weeks per share", unit: "weeks", help: "Eight shares at 6 weeks leaves 4 weeks to share by rotation. More than 6 does not fit in 52 weeks.", min: 1, max: 6, integer: true },
];

const SETTING_BY_KEY = Object.fromEntries(GOVERNANCE_SETTINGS.map((s) => [s.key, s])) as Record<GovernanceKey, GovernanceSetting>;

/** Why a value is refused, or null when it is fine. */
export function governanceValueProblem(key: GovernanceKey, value: unknown): string | null {
  const s = SETTING_BY_KEY[key];
  if (!s) return "Unknown setting.";
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return `${s.label}: enter a number.`;
  if (s.integer && !Number.isInteger(n)) return `${s.label}: enter a whole number.`;
  if (n < s.min || n > s.max) return `${s.label}: must be between ${s.min} and ${s.max}.`;
  return null;
}

/** The defaults with any stored overrides on top. A bad stored value is ignored, never trusted. */
export function resolveConfig(overrides: Partial<Record<string, unknown>> | null | undefined = {}): GovernanceConfig {
  const out = { ...GOVERNANCE_DEFAULTS };
  for (const key of GOVERNANCE_KEYS) {
    const raw = overrides?.[key];
    const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
    if (typeof n === "number" && governanceValueProblem(key, n) === null) out[key] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vote thresholds, from the config
// ---------------------------------------------------------------------------

export type ThresholdVoteType = "ordinary" | "major" | "unanimous";

/** What a vote started with. Stored on the vote when it opens, so a later change never reaches it. */
export interface VoteThresholds {
  ordinaryVotePercent: number;
  majorVotePercent: number;
  unanimousVotePercent: number;
  capitalCallVoteThresholdUsd: number;
}

export const voteThresholdsOf = (config: GovernanceConfig = GOVERNANCE_DEFAULTS): VoteThresholds => ({
  ordinaryVotePercent: config.ordinaryVotePercent,
  majorVotePercent: config.majorVotePercent,
  unanimousVotePercent: config.unanimousVotePercent,
  capitalCallVoteThresholdUsd: config.capitalCallVoteThresholdUsd,
});

/** Reads a stored snapshot; anything missing falls back to the defaults (a vote from before snapshots). */
export const readVoteThresholds = (stored: unknown): VoteThresholds => {
  const base = voteThresholdsOf(GOVERNANCE_DEFAULTS);
  if (!stored || typeof stored !== "object") return base;
  const s = stored as Record<string, unknown>;
  const pick = (k: keyof VoteThresholds) => (typeof s[k] === "number" && Number.isFinite(s[k] as number) ? (s[k] as number) : base[k]);
  return { ordinaryVotePercent: pick("ordinaryVotePercent"), majorVotePercent: pick("majorVotePercent"), unanimousVotePercent: pick("unanimousVotePercent"), capitalCallVoteThresholdUsd: pick("capitalCallVoteThresholdUsd") };
};

/** Shares needed to pass. Integer arithmetic, so 75% of 8 is exactly 6 and 50% + 1 of 8 is exactly 5. */
export function requiredSharesFor(type: ThresholdVoteType, issued: number, t: VoteThresholds = voteThresholdsOf()): number {
  if (type === "ordinary") return Math.floor((issued * t.ordinaryVotePercent) / 100) + 1;
  const percent = type === "major" ? t.majorVotePercent : t.unanimousVotePercent;
  return Math.min(issued, Math.ceil((issued * percent) / 100));
}

export function thresholdLabelFor(type: ThresholdVoteType, t: VoteThresholds = voteThresholdsOf()): string {
  if (type === "ordinary") return `${t.ordinaryVotePercent}% + 1 of all issued shares`;
  return `${type === "major" ? t.majorVotePercent : t.unanimousVotePercent}% of all issued shares`;
}

/** A capital call strictly above the threshold needs a passed Major vote. */
export const capitalCallNeedsVoteAt = (totalAmount: number, thresholdUsd: number): boolean => Math.round(totalAmount * 100) > Math.round(thresholdUsd * 100);

/** "240 hours" as "10 days" when it is a whole number of days. */
export const hoursAsText = (hours: number): string => (hours % 24 === 0 ? `${hours / 24} day${hours / 24 === 1 ? "" : "s"}` : `${hours} hours`);
