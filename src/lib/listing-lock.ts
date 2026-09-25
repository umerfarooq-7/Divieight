/**
 * Once a pod is full the listing is frozen for the seller: System Lock,
 * Closing-Ready and (after closing) Active. listing-lock.sql enforces the
 * same rule in the database; this mirrors it for the UI.
 */
export const LOCKED_LISTING_STATUSES = ["system_lock", "closing_ready", "active"] as const;

export function isListingLocked(listingStatus: string | null | undefined): boolean {
  return (LOCKED_LISTING_STATUSES as readonly string[]).includes(listingStatus ?? "");
}

export const LISTING_LOCKED_MESSAGE =
  "All 8 shares are committed, so this listing is locked — it can no longer be edited or deleted. Contact divieight support if something needs correcting.";
