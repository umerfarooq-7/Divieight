/** Liveness (shared, no server imports): one member-level step, stored per account_member_id. */

import type { LivenessStatus } from "@/lib/liveness-adapters/adapter";

export type { LivenessStatus };

export interface LivenessRow {
  id: string;
  account_member_id: string;
  status: LivenessStatus;
  reason_code: string | null;
  checked_at: string | null;
  created_at: string;
}

/** Every attempt is kept; the latest one is the member's liveness result. */
export function latestLiveness<T extends { account_member_id: string; created_at: string }>(rows: T[], memberId: string): T | null {
  return rows
    .filter((r) => r.account_member_id === memberId)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    .at(-1) ?? null;
}

/** A member may take another selfie unless they passed (done) or failed (blocked until divieight reviews). */
export function canAttemptLiveness(latest: LivenessStatus | null | undefined): boolean {
  return latest !== "passed" && latest !== "failed";
}

export const LIVENESS_STATE_COPY: Record<LivenessStatus, { title: string; body: string }> = {
  passed: { title: "Liveness confirmed", body: "A real person is present, and the ID document is theirs." },
  failed: {
    title: "We couldn't confirm it was you",
    body: "The selfie didn't match the ID document on file. This member can't continue until divieight reviews it. Contact support@divieight.com.",
  },
  inconclusive: {
    title: "We couldn't complete the check",
    body: "The result was inconclusive. We've opened a Verification Request, and your account stays pending while divieight reviews it.",
  },
  pending: { title: "Checking…", body: "Comparing your selfie with your ID document." },
};
