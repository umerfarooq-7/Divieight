/** Buyer W-9 (shared, no server imports). One W-9 per Account Member. */

export const TAX_CLASSIFICATIONS = [
  { value: "individual", label: "Individual / sole proprietor or single-member LLC" },
  { value: "c_corporation", label: "C corporation" },
  { value: "s_corporation", label: "S corporation" },
  { value: "partnership", label: "Partnership" },
  { value: "trust_estate", label: "Trust / estate" },
  { value: "llc", label: "Limited liability company (taxed as C, S or partnership)" },
] as const;

export type TaxClassification = (typeof TAX_CLASSIFICATIONS)[number]["value"];

export type TinKind = "ssn" | "ein";

/**
 * Validates and normalises a TIN: 9 digits, as an SSN (123-45-6789) or an EIN (12-3456789).
 * Returns only digits. Never echoes the TIN back in an error.
 */
export function normalizeTin(input: string, kind: TinKind): string {
  const digits = String(input ?? "").replace(/[\s-]/g, "");
  if (!/^\d{9}$/.test(digits)) throw new Error(kind === "ssn" ? "Enter a 9-digit Social Security number." : "Enter a 9-digit Employer Identification Number.");
  if (kind === "ssn") {
    // Never-issued SSN ranges: area 000, 666 or 900–999; group 00; serial 0000.
    const area = Number(digits.slice(0, 3));
    if (area === 0 || area === 666 || area >= 900 || digits.slice(3, 5) === "00" || digits.slice(5) === "0000") throw new Error("That isn't a valid Social Security number.");
  } else if (digits.startsWith("00")) {
    throw new Error("That isn't a valid Employer Identification Number.");
  }
  return digits;
}

export const tinLast4 = (digits: string) => digits.slice(-4);

/** How a stored TIN is shown, ever: last four only. */
export const maskedTin = (last4: string | null, kind: TinKind | null) => (last4 ? (kind === "ein" ? `••-•••${last4}` : `•••-••-${last4}`) : "—");
