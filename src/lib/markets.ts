/**
 * Market helpers.
 *
 * An agent is not stored as "Resident" or "Non-Resident" anywhere. Those are
 * derived per transaction: an agent is Resident on a property/referral when
 * that property's market is one of the markets they are licensed and active
 * in (`agents.markets`), and Non-Resident when it is not.
 */

export type Residency = "resident" | "non_resident";

// USPS 3-digit zip prefix ranges → state. Buyers declare markets as zip codes
// while agents register state codes/names, so a zip must resolve to its state.
const ZIP_PREFIX_STATES: Array<[number, number, string]> = [
  [5, 5, "NY"], [6, 7, "PR"], [8, 8, "VI"], [9, 9, "PR"],
  [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"], [50, 54, "VT"], [55, 55, "MA"],
  [56, 59, "VT"], [60, 69, "CT"], [70, 89, "NJ"], [100, 149, "NY"], [150, 196, "PA"], [197, 199, "DE"],
  [200, 200, "DC"], [201, 201, "VA"], [202, 205, "DC"], [206, 219, "MD"], [220, 246, "VA"],
  [247, 268, "WV"], [270, 289, "NC"], [290, 299, "SC"], [300, 319, "GA"], [320, 349, "FL"],
  [350, 369, "AL"], [370, 385, "TN"], [386, 397, "MS"], [398, 399, "GA"], [400, 427, "KY"],
  [430, 459, "OH"], [460, 479, "IN"], [480, 499, "MI"], [500, 528, "IA"], [530, 549, "WI"],
  [550, 567, "MN"], [569, 569, "DC"], [570, 577, "SD"], [580, 588, "ND"], [590, 599, "MT"],
  [600, 629, "IL"], [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"], [700, 714, "LA"],
  [716, 729, "AR"], [730, 731, "OK"], [733, 733, "TX"], [734, 749, "OK"], [750, 799, "TX"],
  [800, 816, "CO"], [820, 831, "WY"], [832, 838, "ID"], [840, 847, "UT"], [850, 865, "AZ"],
  [870, 884, "NM"], [885, 885, "TX"], [889, 898, "NV"], [900, 961, "CA"], [967, 968, "HI"],
  [969, 969, "GU"], [970, 979, "OR"], [980, 994, "WA"], [995, 999, "AK"],
];

const STATE_NAMES: Record<string, string> = {
  AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado",
  CT: "connecticut", DE: "delaware", DC: "district of columbia", FL: "florida", GA: "georgia",
  HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky",
  LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts", MI: "michigan", MN: "minnesota",
  MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire",
  NJ: "new jersey", NM: "new mexico", NY: "new york", NC: "north carolina", ND: "north dakota",
  OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhode island",
  SC: "south carolina", SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont",
  VA: "virginia", WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming",
  PR: "puerto rico", VI: "virgin islands", GU: "guam",
};

/** The two-letter state a 5-digit US zip code belongs to, if known. */
export function stateForZip(zip: string): string | null {
  const m = /^(\d{3})\d{2}(?:-\d{4})?$/.exec((zip ?? "").trim());
  if (!m) return null;
  const prefix = Number(m[1]);
  return ZIP_PREFIX_STATES.find(([lo, hi]) => prefix >= lo && prefix <= hi)?.[2] ?? null;
}

/** A zip matches a market that names its state, by code ("CA") or name ("California"). */
function zipInMarket(zip: string, market: string): boolean {
  const state = stateForZip(zip);
  if (!state) return false;
  const m = market.trim().toLowerCase().replace(/\./g, "");
  return m === state.toLowerCase() || m === STATE_NAMES[state];
}

/**
 * Loose market match: exact, or either string containing the other. This is
 * the rule tethering and residency use — deliberately text-only, so a buyer's
 * zip does not auto-tether them to a state-level agent (they choose instead).
 */
export function marketMatches(market: string, other: string) {
  const a = (market ?? "").trim().toLowerCase();
  const b = (other ?? "").trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Wider match for the aggregate Market pools view only: also places a zip
 * code in the state (code or name) it lies in.
 */
export function marketCoversArea(market: string, other: string) {
  const a = (market ?? "").trim().toLowerCase();
  const b = (other ?? "").trim().toLowerCase();
  if (!a || !b) return false;
  return marketMatches(a, b) || zipInMarket(a, b) || zipInMarket(b, a);
}

/** Normalise whatever the database/form hands us into a clean string array. */
export function parseMarkets(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

/** True when the agent covers the given market. */
export function isResidentInMarket(markets: unknown, market: string): boolean {
  const list = parseMarkets(markets);
  if (!market.trim()) return false;
  return list.some((m) => marketMatches(m, market));
}

/** Derived residency for one specific property/referral market. */
export function residencyFor(markets: unknown, market: string): Residency {
  return isResidentInMarket(markets, market) ? "resident" : "non_resident";
}

export function residencyLabel(residency: Residency): string {
  return residency === "resident" ? "Resident on this transaction" : "Non-Resident on this transaction";
}

export function formatMarkets(markets: unknown): string {
  const list = parseMarkets(markets);
  return list.length > 0 ? list.join(" · ") : "—";
}
