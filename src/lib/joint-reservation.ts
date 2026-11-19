/**
 * Joint reservations: two linked co-buyers taking ONE share together. The buyer who starts it reserves the share as usual and pays
 * for it; the other buyer is asked first and, on accepting, becomes the second holder of the same share.
 */

export type JointRequestStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";

/** How long the other buyer has to answer. The share stays reserved for the initiator meanwhile. */
export const JOINT_REQUEST_HOURS = 72;

export const JOINT_MESSAGES = {
  noLink: "You don't have an active co-buyer to share this with.",
  notReady: "Your co-buyer is still finishing onboarding. You can reserve this share alone now, or wait until they are ready.",
  partnerHolds: "Your co-buyer already holds a share in this home.",
  notYours: "That request isn't addressed to you.",
  notFound: "That request can't be found, or it has already been answered.",
  expired: "That request has expired. The share stays with the buyer who reserved it.",
  gone: "That share is no longer reserved.",
  linkEnded: "You are no longer linked as co-buyers, so this share can't be shared.",
  locked: "The cap table is already locked for closing, so a co-holder can no longer be added to this share.",
  openJoint: "You share a reservation with your co-buyer. Withdraw it first, or wait until your co-buyer answers, then end the link.",
} as const;

/** What the reserve screen needs to offer the choice. Null when you have no active co-buyer. */
export interface CoBuyerOption {
  partnerName: string;
  /** Whether they can take a share together right now, and if not, why in plain words. */
  available: boolean;
  unavailableReason: string | null;
}

export interface JointInfo {
  /** Which side you are on for this share. */
  role: "initiator" | "partner";
  partnerName: string;
  status: "pending" | "active" | "declined" | "expired" | "cancelled";
  requestId: string | null;
}

export interface IncomingJointRequest {
  id: string;
  initiatorName: string;
  propertyId: string;
  address: string;
  city: string;
  state: string;
  createdAt: string;
  expiresAt: string;
}
