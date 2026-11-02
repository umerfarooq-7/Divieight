/**
 * Owner voting: thresholds and the tally. One vote per 1/8th share.
 *
 * PLACEHOLDER thresholds pending Operating Agreement review. The approving
 * option is the first one listed (normally "Yes"); Abstain counts toward
 * participation but not approval.
 */

export const VOTE_TYPES = ["ordinary", "major", "unanimous"] as const;
export type VoteType = (typeof VOTE_TYPES)[number];
export type VoteStatus = "draft" | "open" | "closed" | "cancelled";

export const DEFAULT_VOTE_OPTIONS = ["Yes", "No", "Abstain"];
export const TOTAL_SHARES = 8;

export const VOTE_THRESHOLDS: Record<VoteType, { label: string; requiredShares: (issued: number) => number }> = {
  ordinary: { label: "50% + 1 of all issued shares", requiredShares: (issued) => Math.floor(issued * 0.5) + 1 },
  major: { label: "75% of all issued shares", requiredShares: (issued) => Math.ceil(issued * 0.75) },
  unanimous: { label: "100% of all issued shares", requiredShares: (issued) => issued },
};
export const VOTE_THRESHOLDS_ARE_PLACEHOLDER = true;

export const VOTE_TYPE_LABELS: Record<VoteType, string> = {
  ordinary: "Ordinary",
  major: "Major",
  unanimous: "Unanimous",
};

export interface VoteResultSummary {
  tally: Array<{ choice: string; shares: number }>;
  votedShares: number;
  totalShares: number;
  issuedShares: number;
  approvingOption: string;
  requiredShares: number;
  thresholdLabel: string;
  thresholdsArePlaceholder: boolean;
  passed: boolean;
  computedAt: string;
}

export function tallyVote(params: {
  voteType: VoteType;
  options: string[];
  issuedShares: number;
  ballots: Array<{ choice: string; weight: number }>;
  now?: Date;
}): VoteResultSummary {
  const tally = params.options.map((choice) => ({
    choice,
    shares: params.ballots.filter((b) => b.choice === choice).reduce((sum, b) => sum + b.weight, 0),
  }));
  const threshold = VOTE_THRESHOLDS[params.voteType];
  const requiredShares = threshold.requiredShares(params.issuedShares);
  const approvingOption = params.options[0]!;
  const approving = tally[0]?.shares ?? 0;
  return {
    tally,
    votedShares: tally.reduce((sum, t) => sum + t.shares, 0),
    totalShares: TOTAL_SHARES,
    issuedShares: params.issuedShares,
    approvingOption,
    requiredShares,
    thresholdLabel: threshold.label,
    thresholdsArePlaceholder: VOTE_THRESHOLDS_ARE_PLACEHOLDER,
    passed: params.issuedShares > 0 && approving >= requiredShares,
    computedAt: (params.now ?? new Date()).toISOString(),
  };
}

export interface MemberPosition {
  memberId: string;
  name: string;
  position: string | null;
}

export type ConsensusState = "not_required" | "pending" | "disagree" | "agreed";

/** Only when every member records the same position can the account cast. */
export function consensusState(members: MemberPosition[]): { state: ConsensusState; choice: string | null } {
  if (members.length <= 1) return { state: "not_required", choice: null };
  const recorded = members.map((m) => m.position).filter(Boolean) as string[];
  if (new Set(recorded).size > 1) return { state: "disagree", choice: null };
  if (recorded.length < members.length) return { state: "pending", choice: null };
  return { state: "agreed", choice: recorded[0]! };
}

/** "Alice One" → "AO", "Jane" → "JA": the same rule as SecondaryVerification. */
export function nameInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return parts.map((part) => part[0]).join("").slice(0, 4).toUpperCase();
}
