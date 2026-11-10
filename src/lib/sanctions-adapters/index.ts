/**
 * Sanctions / watchlist screening vendor (Standard Part One E: US government sanctions,
 * politically-exposed-person and law-enforcement lists). divieight performs this; it is not
 * self-reported. Callers use getSanctionsAdapter() only, so a real vendor drops in here.
 *
 * The simulated vendor returns "clear", except for QA: a member whose name contains
 * "Sanctions Test" is a possible match. A vendor never confirms a match on its own; only the
 * identity question ("are you the person the list names?"), answered against the documents
 * already held, does.
 */

export interface SanctionsSubject {
  fullName: string;
  dateOfBirth: string | null;
  idDocumentRef: string | null;
}

export interface SanctionsScreenResult {
  status: "clear" | "possible_match";
  /** The list entry it may match, when it does. */
  listName: string | null;
  matchedName: string | null;
}

export interface SanctionsAdapter {
  readonly provider: string;
  screen(subject: SanctionsSubject): Promise<SanctionsScreenResult>;
}

export class SimulatedSanctionsAdapter implements SanctionsAdapter {
  readonly provider = "simulated";
  async screen(subject: SanctionsSubject): Promise<SanctionsScreenResult> {
    if (/sanctions test/i.test(subject.fullName)) return { status: "possible_match", listName: "OFAC SDN (simulated)", matchedName: subject.fullName.toUpperCase() };
    return { status: "clear", listName: null, matchedName: null };
  }
}

const ADAPTERS: Record<string, () => SanctionsAdapter> = {
  simulated: () => new SimulatedSanctionsAdapter(),
};

export const DEFAULT_SANCTIONS_PROVIDER = "simulated";

let override: SanctionsAdapter | null = null;
export function setSanctionsAdapterForTesting(adapter: SanctionsAdapter | null) {
  override = adapter;
}

export function getSanctionsAdapter(provider: string = DEFAULT_SANCTIONS_PROVIDER): SanctionsAdapter {
  if (override) return override;
  const make = ADAPTERS[provider];
  if (!make) throw new Error(`No sanctions adapter for provider "${provider}"`);
  return make();
}
