/**
 * Retention Lock exceptions: shared labels and small rules.
 *
 * How long a release vote stays open is a governance setting (governance-config.ts).
 */

import { GOVERNANCE_DEFAULTS } from "@/lib/governance-config";

export const RETENTION_EXCEPTION_TYPES = ["hardship", "unanimous_consent"] as const;
export type RetentionExceptionType = (typeof RETENTION_EXCEPTION_TYPES)[number];
export type RetentionExceptionStatus = "pending" | "approved" | "rejected" | "withdrawn";

export const RETENTION_EXCEPTION_LABELS: Record<RetentionExceptionType, string> = {
  hardship: "Hardship",
  unanimous_consent: "Unanimous consent",
};

/** The default; the live value is the governance config's retentionReleaseVoteDays. */
export const RETENTION_VOTE_DAYS = GOVERNANCE_DEFAULTS.retentionReleaseVoteDays;

export const retentionVoteTitle = (shareNumber: number) => `Retention Lock release: share #${shareNumber}`;

/** Whole days left, rounded up: any part of a day still counts as locked. */
export function lockDaysRemaining(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 86_400_000));
}

/** A supporting document must sit in the requester's own folder for this property. */
export function isOwnRetentionDocPath(path: string, userId: string, propertyId: string): boolean {
  const prefix = `${userId}/${propertyId}/retention-`;
  return path.startsWith(prefix) && path.length > prefix.length && !path.slice(prefix.length).includes("/");
}
