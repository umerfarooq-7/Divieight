/**
 * Market matching (buyers declare zip codes, agents register states) and the
 * seller listing lock once a pod is full.
 */
import { describe, it, expect } from "vitest";
import { marketCoversArea, marketMatches, residencyFor, stateForZip } from "@/lib/markets";
import { isListingLocked } from "@/lib/listing-lock";

describe("markets — a zip resolves to its state", () => {
  it("maps zip prefixes to states", () => {
    expect(stateForZip("94103")).toBe("CA");
    expect(stateForZip("10001")).toBe("NY");
    expect(stateForZip("33101")).toBe("FL");
    expect(stateForZip("82801")).toBe("WY");
    expect(stateForZip("12364")).toBe("NY");
    expect(stateForZip("CA")).toBeNull();
  });

  it("Market pools place a buyer's zip in an agent market given as state code or name", () => {
    expect(marketCoversArea("CA", "94103")).toBe(true);
    expect(marketCoversArea("94103", "Ca")).toBe(true);
    expect(marketCoversArea("florida", "33101")).toBe(true);
    expect(marketCoversArea("NY", "94103")).toBe(false);
    expect(marketCoversArea("CA", "33101")).toBe(false);
  });

  it("tethering/residency stay text-only, so a zip never auto-tethers to a state agent", () => {
    expect(marketMatches("CA", "94103")).toBe(false);
    expect(residencyFor(["NY", "FL", "CA"], "94011")).toBe("non_resident");
  });

  it("keeps the existing text matching", () => {
    expect(marketMatches("San Francisco", "san francisco, CA")).toBe(true);
    expect(marketMatches("94103", "94103")).toBe(true);
    expect(marketMatches("", "94103")).toBe(false);
  });
});

describe("listing lock", () => {
  it("locks from System Lock onward, never while forming", () => {
    expect(isListingLocked("forming")).toBe(false);
    expect(isListingLocked(null)).toBe(false);
    expect(isListingLocked("system_lock")).toBe(true);
    expect(isListingLocked("closing_ready")).toBe(true);
    expect(isListingLocked("active")).toBe(true);
  });
});
