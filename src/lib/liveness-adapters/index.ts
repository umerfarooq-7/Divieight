/**
 * The liveness vendor registry. Callers ask for an adapter here and never construct one,
 * so adding a real vendor is one entry below and a change of DEFAULT_LIVENESS_PROVIDER.
 */
import type { LivenessAdapter } from "./adapter";
import type { ForcedLivenessOutcome } from "./adapter";
import { SimulatedLivenessAdapter } from "./simulated";

export interface LivenessAdapterOptions {
  /** QA test switch; only the simulated vendor honours it. */
  forced?: ForcedLivenessOutcome;
}

const ADAPTERS: Record<string, (opts: LivenessAdapterOptions) => LivenessAdapter> = {
  simulated: (opts) => new SimulatedLivenessAdapter({ forced: opts.forced ?? null }),
  // persona: () => new PersonaLivenessAdapter(),
};

export const DEFAULT_LIVENESS_PROVIDER = "simulated";

/** Tests may swap the vendor without touching callers. */
let override: LivenessAdapter | null = null;
export function setLivenessAdapterForTesting(adapter: LivenessAdapter | null) {
  override = adapter;
}

export function getLivenessAdapter(provider: string = DEFAULT_LIVENESS_PROVIDER, opts: LivenessAdapterOptions = {}): LivenessAdapter {
  if (override) return override;
  const make = ADAPTERS[provider];
  if (!make) throw new Error(`No liveness adapter for provider "${provider}"`);
  return make(opts);
}

export type { ForcedLivenessOutcome, LivenessAdapter, LivenessResult, LivenessSelfie, LivenessStatus } from "./adapter";
