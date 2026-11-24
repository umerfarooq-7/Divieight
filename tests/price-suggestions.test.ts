import { describe, expect, it } from "vitest";
import { parseMoney, priceSuggestions } from "@/lib/price-suggestions.server";

function db(tables: Record<string, any[]>) {
  return {
    from: (t: string) => {
      const q: any = { select: () => q, in: (col: string, ids: string[]) => Promise.resolve({ data: (tables[t] ?? []).filter((r) => ids.includes(r[col])) }) };
      return q;
    },
  };
}

describe("price suggestions for the admin screens", () => {
  it("reads money however it was typed", () => {
    expect(parseMoney("$1,250,000.00")).toBe(1250000);
    expect(parseMoney("1.25m")).toBe(1250000);
    expect(parseMoney("500k")).toBe(500000);
    expect(parseMoney(800000)).toBe(800000);
    expect(parseMoney("to be agreed")).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });

  it("with no offer, uses the listing price and suggests 1% earnest money", async () => {
    const s = await priceSuggestions(db({ properties: [{ id: "p1", listing_price: 800000 }] }), ["p1"]);
    expect(s.get("p1")).toEqual({ listingPrice: 800000, purchasePrice: 800000, purchasePriceSource: "listing", earnestMoney: 8000, earnestMoneySource: "one_percent" });
  });

  it("prefers the latest live offer's own terms", async () => {
    const s = await priceSuggestions(
      db({
        properties: [{ id: "p1", listing_price: 800000 }],
        authorization_requests: [
          { property_id: "p1", status: "authorized", created_at: "2026-01-01", terms: { "Purchase price": "$700,000" } },
          { property_id: "p1", status: "pending", created_at: "2026-02-01", terms: { "Purchase price": "$760,000", "Earnest money": "$20,000" } },
          { property_id: "p1", status: "declined", created_at: "2026-03-01", terms: { "Purchase price": "$1" } },
        ],
      }),
      ["p1"],
    );
    expect(s.get("p1")).toMatchObject({ purchasePrice: 760000, purchasePriceSource: "offer", earnestMoney: 20000, earnestMoneySource: "offer" });
  });

  it("suggests nothing when no price is known", async () => {
    const s = await priceSuggestions(db({ properties: [{ id: "p1", listing_price: null }] }), ["p1"]);
    expect(s.get("p1")).toMatchObject({ purchasePrice: null, earnestMoney: null, earnestMoneySource: null });
  });
});
