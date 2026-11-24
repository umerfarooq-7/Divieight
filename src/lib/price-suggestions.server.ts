/**
 * Figures the admin screens pre-fill when a property is picked, so nobody retypes a price the platform already knows.
 * The purchase price is the one on the latest offer the buyers were asked to authorize (its "Purchase price" term), or the
 * listing price when there is no offer yet. Earnest money is the offer's own "Earnest money" term when it has one; otherwise
 * a 1% starting figure the admin is expected to check against the accepted offer. Every field stays editable.
 */

type Db = { from: (t: string) => any };

export interface PriceSuggestion {
  listingPrice: number | null;
  /** From the latest offer's "Purchase price" term, else the listing price. */
  purchasePrice: number | null;
  purchasePriceSource: "offer" | "listing" | null;
  earnestMoney: number | null;
  earnestMoneySource: "offer" | "one_percent" | null;
}

export const EARNEST_DEFAULT_RATE = 0.01;

/** "$1,250,000.00" or "1.25m" style text to a number of dollars; null when there is no usable figure. */
export function parseMoney(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  const m = String(value ?? "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([kKmM])?/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? (m[2].toLowerCase() === "m" ? 1_000_000 : 1_000) : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function term(terms: Record<string, unknown> | null | undefined, pattern: RegExp): number | null {
  for (const [label, value] of Object.entries(terms ?? {})) if (pattern.test(label)) return parseMoney(value);
  return null;
}

export async function priceSuggestions(db: Db, propertyIds: string[]): Promise<Map<string, PriceSuggestion>> {
  const out = new Map<string, PriceSuggestion>();
  if (propertyIds.length === 0) return out;
  const { data: props } = await db.from("properties").select("id, listing_price").in("id", propertyIds);
  const listing = new Map(((props ?? []) as Array<{ id: string; listing_price: number | null }>).map((p) => [p.id, parseMoney(p.listing_price)]));
  const { data: reqs } = await db.from("authorization_requests").select("property_id, terms, status, created_at").in("property_id", propertyIds);
  const rows = ((reqs ?? []) as Array<{ property_id: string; terms: Record<string, unknown> | null; status: string; created_at?: string | null }>)
    .filter((r) => r.status !== "declined" && r.status !== "cancelled")
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));

  for (const id of propertyIds) {
    const mine = rows.filter((r) => r.property_id === id);
    const offerPrice = mine.map((r) => term(r.terms, /purchase\s*price|offer\s*price|^price$/i)).find((n) => n != null) ?? null;
    const offerEarnest = mine.map((r) => term(r.terms, /earnest/i)).find((n) => n != null) ?? null;
    const listingPrice = listing.get(id) ?? null;
    const purchasePrice = offerPrice ?? listingPrice;
    out.set(id, {
      listingPrice,
      purchasePrice,
      purchasePriceSource: offerPrice != null ? "offer" : listingPrice != null ? "listing" : null,
      earnestMoney: offerEarnest ?? (purchasePrice != null ? Math.round(purchasePrice * EARNEST_DEFAULT_RATE) : null),
      earnestMoneySource: offerEarnest != null ? "offer" : purchasePrice != null ? "one_percent" : null,
    });
  }
  return out;
}
