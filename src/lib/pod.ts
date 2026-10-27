export interface PodComposition {
  propertyId: string;
  totalShares: number;
  retainedShares: number;
  reservedShares: number;
  availableShares: number;
  hardLocked: boolean;
  listingStatus: string;
  /** Ordered slot map, 8 entries: seller-retained first, then reserved, then available. */
  slots: ("retained" | "reserved" | "available")[];
}

export interface ReservationEligibility {
  ok: boolean;
  reason:
    | "ok"
    | "no_buyer_account"
    | "not_liquidity_verified"
    | "not_tethered"
    | "not_found"
    | "sold_out"
    | "already_reserved";
  liquidityStatus: string | null;
  targetBudget: number | null;
  existingShares: number;
  composition: PodComposition | null;
}

export interface ReservationResult {
  ok: boolean;
  reason:
    | ReservationEligibility["reason"]
    | "error"
    // The buyer's agent holds this property's listing — choose another agent.
    | "dual_agency_conflict"
    | "invalid_replacement_agent"
    | "no_replacement_agent";
  reservationId: string | null;
  composition: PodComposition | null;
  systemLocked: boolean;
  /** Present with reason "dual_agency_conflict". */
  conflict?: {
    code: "DUAL_AGENCY_CONFLICT";
    conflicting_agent_id: string;
    conflicting_agent_name: string | null;
    referring_agent_id_same: boolean;
  } | null;
  /** Explanation for invalid_replacement_agent / no_replacement_agent. */
  message?: string | null;
  /** Present when the reservation finalized with a per-property agent. */
  agentChange?: { newAgentId: string; newAgentName: string | null; referralPreserved: boolean } | null;
}

export interface MyReservation {
  id: string;
  property_id: string;
  shares_reserved: number;
  status: string;
  reserved_at: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  listing_price: number | null;
  listing_status: string;
}

export const RESERVATION_BLOCK_COPY: Record<
  Exclude<ReservationEligibility["reason"], "ok">,
  { title: string; body: string }
> = {
  no_buyer_account: {
    title: "Buyer account required",
    body: "Reservations are limited to enrolled divieight buyers. Create a buyer account to continue.",
  },
  not_liquidity_verified: {
    title: "Liquidity verification required",
    body: "Your funds haven't cleared the Liquidity Gate yet. Verified liquidity of at least 1.2× your target budget is required before you can hold a share.",
  },
  not_tethered: {
    title: "Agent tethering required",
    body: "You can keep browsing every listing, but committing to a home waits until you're tethered to a Resident Agent. Name your agent or accept a platform assignment from your dashboard.",
  },
  not_found: {
    title: "Listing unavailable",
    body: "This home isn't accepting reservations right now.",
  },
  sold_out: {
    title: "All eight shares are accounted for",
    body: "This pod is full and has moved into System Lock. Browse other homes to secure a rank.",
  },
  already_reserved: {
    title: "You already hold a share here",
    body: "Your reservation on this property is active — see it under My Reservations on your dashboard.",
  },
};

/** Buyer-facing pod detail view. Other members stay de-identified. */
export interface BuyerPodDetails {
  propertyId: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  listingPrice: number | null;
  propertyType: string | null;
  photoUrl: string | null;
  composition: PodComposition;
  myShares: number;
  myStatus: string;
  myReservedAt: string | null;
  priorityRank: number | null;
  priorityRankTimestamp: string | null;
  members: { label: string; shares: number; reservedAt: string | null; isMine: boolean }[];
  tetheredAgentName: string | null;
  heavyLiftingAgentName: string | null;
  hlaStatus: string | null;
  /** Broker Closing Hold state, visible to everyone involved in the pod. */
  closingHold: import("@/lib/closing-hold").ClosingHoldState;
}
