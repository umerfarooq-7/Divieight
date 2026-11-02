/** The shared amenity list; free-text amenities can no longer be added. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_AMENITIES, knownAmenities } from "@/lib/amenities";

describe("amenities", () => {
  it("keeps the same options, in the same order, with no Other", () => {
    expect(DEFAULT_AMENITIES).toEqual([
      "Pool",
      "Home Office",
      "Pet-Friendly",
      "Waterfront",
      "Mountain View",
      "Gated Community",
      "Hot Tub",
      "Garage",
      "Fireplace",
      "Air Conditioning",
    ]);
  });

  it("hides old stored values from display without changing the stored array", () => {
    const stored = ["Pool", "other", "Other", "Sauna", "Garage"];
    expect(knownAmenities(stored)).toEqual(["Pool", "Garage"]);
    expect(stored).toHaveLength(5);
    expect(knownAmenities([])).toEqual([]);
  });

  it.each(["src/routes/onboarding.listing.tsx", "src/routes/buyer.onboarding.lifestyle.tsx"])(
    "%s uses the shared list and has no free-text amenity input",
    (file) => {
      const source = readFileSync(file, "utf8");
      expect(source).toContain('from "@/lib/amenities"');
      expect(source).not.toMatch(/customAmenity|Add a custom amenity|Add your own/);
      expect(source).not.toMatch(/const DEFAULT_AMENITIES/);
      // The form renders the shared list, so an old value can't produce a stray chip.
      expect(source).toContain("{DEFAULT_AMENITIES.map((tag) => {");
    },
  );
});
