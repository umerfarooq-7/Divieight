/**
 * Shared amenity tag set. Used by both the Seller Module property listing form
 * and the Buyer lifestyle survey so buyer "non-negotiables" can be matched
 * against seller property amenities later.
 */
export const DEFAULT_AMENITIES = [
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
] as const;

/**
 * Only the shared amenities, for display. Records saved when free-text amenities
 * were allowed keep those values in the database; they are simply not shown.
 */
export function knownAmenities(stored: readonly string[]): string[] {
  return stored.filter((a) => (DEFAULT_AMENITIES as readonly string[]).includes(a));
}
