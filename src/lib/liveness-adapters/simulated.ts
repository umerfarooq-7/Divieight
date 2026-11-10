/**
 * Simulated liveness vendor. Passes by default, like the platform's other simulated vendors.
 *
 * QA hooks, so every outcome can be tested end to end:
 *  - a selfie whose file name contains "liveness-fail" fails, and "liveness-inconclusive" is inconclusive;
 *  - the admin test switch (platform_settings key "liveness_simulation") forces an outcome for every check.
 * The file name wins over the switch, so one test can still differ from the rest.
 */
import type { ForcedLivenessOutcome, LivenessAdapter, LivenessResult, LivenessSelfie, LivenessStatus } from "./adapter";

export type { ForcedLivenessOutcome };

export const MAGIC_FILENAMES: Record<string, Exclude<LivenessStatus, "pending">> = {
  "liveness-fail": "failed",
  "liveness-inconclusive": "inconclusive",
  "liveness-pass": "passed",
};

const REASONS: Record<Exclude<LivenessStatus, "pending">, string | null> = {
  passed: null,
  failed: "face_mismatch",
  inconclusive: "low_quality_capture",
};

export class SimulatedLivenessAdapter implements LivenessAdapter {
  readonly provider = "simulated";
  constructor(private readonly opts: { forced?: ForcedLivenessOutcome } = {}) {}

  async check(selfie: LivenessSelfie, idDocumentRef: string): Promise<LivenessResult> {
    if (!selfie.storagePath) return { status: "inconclusive", reason_code: "no_selfie" };
    if (!idDocumentRef) return { status: "inconclusive", reason_code: "no_id_document" };
    const name = selfie.fileName.toLowerCase();
    const magic = Object.entries(MAGIC_FILENAMES).find(([k]) => name.includes(k))?.[1];
    const status = magic ?? this.opts.forced ?? "passed";
    return { status, reason_code: REASONS[status] };
  }
}
