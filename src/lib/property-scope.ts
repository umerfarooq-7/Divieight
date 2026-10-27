/**
 * Optional "?property=<id>" scope for the buyer's cross-property list pages.
 * Shared by the server fns (input) and the routes (search param).
 */
export interface PropertyScopeInput {
  propertyId?: string | null;
}

export function parsePropertyScope(input: PropertyScopeInput | undefined): { propertyId: string | null } {
  const raw = input?.propertyId;
  return { propertyId: typeof raw === "string" && raw.trim() ? raw.trim() : null };
}

export function propertySearch(search: Record<string, unknown>): { property?: string } {
  return typeof search.property === "string" && search.property ? { property: search.property } : {};
}

/** Keep only ids in scope (all of them when there is no scope). */
export function scopeIds(ids: string[], propertyId: string | null): string[] {
  return propertyId ? ids.filter((id) => id === propertyId) : ids;
}
