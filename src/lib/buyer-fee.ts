/**
 * The Buyer Platform Enrollment Fee is charged per account member: $2,570 for one person, double for two.
 * It is worked out when the account pays. Members are added before payment (adding a second member after the fee is paid is refused),
 * and a fee that has been paid is not refunded if a member is removed later.
 */
export const BUYER_ENROLLMENT_CENTS_PER_MEMBER = 257000;

export function enrollmentFeeCents(memberCount: number): number {
  const n = Number.isFinite(memberCount) ? Math.max(1, Math.floor(memberCount)) : 1;
  return BUYER_ENROLLMENT_CENTS_PER_MEMBER * n;
}

export const FEE_AFTER_PAYMENT_MESSAGE =
  "The enrollment fee is charged per member. Add the second member before the fee is paid; after payment, contact divieight support to add a member.";
