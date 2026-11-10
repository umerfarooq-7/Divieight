/**
 * Liveness provider adapter.
 *
 * Liveness confirms that a real person is present and that the ID document is theirs.
 * Every liveness vendor implements this interface; callers only ever use getLivenessAdapter()
 * and these shapes, so a real vendor replaces the simulated one without touching them.
 */

export type LivenessStatus = "passed" | "failed" | "inconclusive" | "pending";

/** The selfie the member took or uploaded, as stored by the platform. */
export interface LivenessSelfie {
  /** Storage path of the selfie (bucket liveness-selfies). */
  storagePath: string;
  /** The file's original name, as the member's browser gave it. */
  fileName: string;
  contentType: string | null;
}

export interface LivenessResult {
  status: LivenessStatus;
  /** Why it didn't pass, in the provider's normalized vocabulary. Null when it passed. */
  reason_code: string | null;
}

export interface LivenessAdapter {
  readonly provider: string;
  /** Compare the selfie with the member's ID document and say whether a real, matching person is present. */
  check(selfie: LivenessSelfie, idDocumentRef: string): Promise<LivenessResult>;
}

/** A QA test switch outcome (null = no override). Vendors other than the simulated one ignore it. */
export type ForcedLivenessOutcome = Exclude<LivenessStatus, "pending"> | null;
