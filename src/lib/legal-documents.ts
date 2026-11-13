/**
 * The platform-generated documents, built in ONE place so the Pre-Signing Review, the signing screen and the executed copy are the same text, and so the hash
 * the signing screen shows is the hash that is stored. A template change is a new version (the PRA_VERSION / LISTING_VERSION below): it applies only to
 * documents made after it. An executed document is never rebuilt from a template; it is read back from executed_document_texts.
 *
 * The Effective Date is the template's own (fixed per version), not "today": the same member, market and intent always give the same text and the same hash.
 */

/** v1 was dated by the day it was shown; executed v1 copies are untouched. v2 carries the template's own fixed effective date. */
export const PRA_VERSION = "v2";
export const PRA_EFFECTIVE = "November 13, 2026";
export const LISTING_VERSION = "v2";
export const LISTING_EFFECTIVE = "November 13, 2026";

export type PraBuyer = { intent: string | null; primary_target_market: string | null };
export type ListingSeller = { full_name: string | null; exit_type: string | null; retained_shares: number | null };
export type ListingProperty = { address: string; city: string; state: string; zip: string };

// Simple deterministic hash placeholder (djb2). Replace with real digest later.
export function hashDocument(text: string) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) & 0xffffffff;
  }
  return `djb2_${(hash >>> 0).toString(16)}_${text.length}`;
}

export function buildPRA(name: string, buyer: PraBuyer | null) {
  const market = buyer?.primary_target_market?.trim() || "your declared target market";
  const intent =
    buyer?.intent === "short_term_rental"
      ? "Short-Term Rental (income-focused) use"
      : "Personal Use (long-term ownership)";

  return `PRIORITY RESERVATION AGREEMENT (PRA)
Document Version: ${PRA_VERSION}
Effective Date: ${PRA_EFFECTIVE}

BETWEEN: ${name || "Buyer"} ("Buyer")
AND: divieight, LLC ("divieight", the "Platform", the "Manager")
RE: Priority reservation of undivided 1/8th fractional ownership shares

1. PURPOSE AND NATURE OF THIS AGREEMENT
This Priority Reservation Agreement establishes the Buyer's place in the divieight priority queue for fractional 1/8th ownership shares in properties matching the Buyer's declared preferences, including ${market} and ${intent}. This Agreement is not a contract for the purchase of real property and conveys no title, deed, equitable interest, or possessory right in any specific property. It reserves process priority only.

2. PLATFORM PROTOCOLS
The Buyer agrees to conduct all reservation, offer, matching, document exchange, and communication activity through the divieight platform. The Buyer agrees to (a) maintain accurate identity, financial, and preference information, (b) respond to reservation offers within the stated response window, and (c) refrain from soliciting sellers, co-owners, or other buyers outside the Platform for transactions originating on the Platform. Repeated non-response to matched reservations may result in re-ranking or suspension of queue position.

3. PRIORITY RANK AND SENIORITY
Buyer seniority is determined by the timestamp, recorded to millisecond precision, at which the Buyer's Platform Enrollment Fee is confirmed as successfully paid. Priority rank is personal to the Buyer Account, is non-transferable and non-assignable, and may not be sold, pledged, or shared. Priority rank governs the order in which matched share opportunities are presented; it does not guarantee that any specific property, share, or price will become available.

4. USE-CALENDAR RULES
Upon closing on one or more 1/8th shares, the Buyer's occupancy rights are governed by the divieight Use-Calendar Protocol. Each 1/8th share entitles the holder to a proportionate allocation of annual use nights, allocated by rotating selection rounds so that peak, shoulder, and off-peak periods rotate equitably among co-owners across years. Unused nights do not accrue beyond the limits stated in the Protocol. Holiday and high-demand periods are allocated by rotation, not by seniority or priority rank. Guest use, pet policies, quiet hours, maximum occupancy, and any short-term rental activity are subject to the property-level rules and applicable local ordinances. Unauthorized occupancy beyond an allocated period is subject to overstay fees and, on repetition, to suspension of use rights.

5. CO-OWNERSHIP OBLIGATIONS
Upon closing, the Buyer becomes a co-owner subject to the divieight Co-Ownership Operating Agreement, which the Buyer agrees to execute as a condition of closing. Co-ownership obligations include: (a) proportionate payment of property taxes, insurance, utilities, maintenance, management fees, and reserve contributions, assessed monthly per share held; (b) participation in approved capital improvement assessments; (c) compliance with the property care standard and post-stay condition rules; (d) adherence to the Right of First Refusal and transfer-approval provisions on any resale of a share; and (e) good-faith participation in the dispute-resolution process before pursuing external remedies. Delinquency in cost-sharing obligations may result in suspension of use rights and, if unremedied, forced-sale remedies as set out in the Operating Agreement.

6. AUTHORIZATION OF divieight LLC AS MANAGER AND LEAD BUYER
The Buyer irrevocably authorizes and appoints divieight, LLC to act as (i) Manager of the property-holding entity or co-ownership arrangement into which the Buyer's share is placed, with authority to administer the use calendar, collect and disburse shared expenses, procure insurance, engage vendors, maintain records, and enforce co-ownership rules; and (ii) Lead Buyer in the acquisition process, with authority to negotiate on behalf of the assembled buyer pool, submit and coordinate offers, execute purchase documents in the assembling entity's name, order and coordinate inspections, appraisals, and title work, open and administer escrow, and take such further acts as are reasonably necessary to complete the acquisition. This authorization is limited to transactions the Buyer expressly opts into and does not authorize divieight to obligate the Buyer beyond amounts and terms the Buyer has confirmed in writing on the Platform. divieight acts as a coordinator and fiduciary of process; it does not provide legal, tax, brokerage, or investment advice, and the Buyer is advised to obtain independent counsel.

7. PLATFORM ENROLLMENT FEE — NON-REFUNDABLE
The Buyer shall pay a one-time Platform Enrollment Fee of $2,570 (USD). THIS FEE IS FULLY EARNED UPON PAYMENT AND EXECUTION OF THIS AGREEMENT, REGARDLESS OF TRANSACTION OUTCOME. The fee is non-refundable in whole or in part, including where no matching property becomes available, where the Buyer withdraws, where vetting is not completed or is not approved, or where any prospective transaction fails to close for any reason.

8. VETTING
Placement in the priority queue is conditional on completion of divieight's buyer vetting, which may include identity confirmation, funds verification, and screening. divieight may decline or discontinue vetting at its discretion. Declination does not entitle the Buyer to a refund of the Platform Enrollment Fee.

9. LIMITATION OF LIABILITY
To the fullest extent permitted by law, divieight's aggregate liability arising out of or relating to this Agreement shall not exceed the amount of the Platform Enrollment Fee actually paid by the Buyer.

10. GOVERNING LAW AND DISPUTE RESOLUTION
This Agreement is governed by the laws of the State of Delaware, without regard to conflicts of law principles. Any dispute arising hereunder shall be resolved by binding arbitration administered by the American Arbitration Association under its Commercial Arbitration Rules.

11. ELECTRONIC SIGNATURE
The Buyer consents to transacting electronically and agrees that their typed full legal name, together with a timestamp, IP address, and cryptographic document record, constitutes a legally binding electronic signature under the E-SIGN Act and applicable state UETA statutes. See also Section 11 of the divieight Terms and Conditions.

12. ENTIRE AGREEMENT
This Agreement is the entire understanding of the parties as to its subject matter and supersedes all prior agreements, written or oral.

BY SIGNING BELOW, THE BUYER ACKNOWLEDGES THAT THEY HAVE READ, UNDERSTOOD, AND AGREED TO THE TERMS OF THIS PRIORITY RESERVATION AGREEMENT.`;
}

export function buildListingAgreement(seller: ListingSeller | null, property: ListingProperty | null) {
  const name = seller?.full_name?.trim() || "Seller";
  const exit = seller?.exit_type;
  const retained = seller?.retained_shares ?? 0;
  const soldShares = exit === "hybrid_exit" ? 8 - retained : 8;
  const propertyLine = property
    ? `${property.address}, ${property.city}, ${property.state} ${property.zip}`
    : "the property described in your listing";

  const exitParagraph =
    exit === "hybrid_exit"
      ? `As a Hybrid Exit Seller, you have elected to sell ${soldShares} of 8 fractional shares (${soldShares}/8ths) of the Property and to retain ${retained} of 8 fractional shares (${retained}/8ths) as a continuing co-owner. Retained shares are subject to the divieight Co-Ownership Rules, including scheduled-use allocation, cost-sharing obligations, and the Right of First Refusal on any subsequent share transfer. Retained shares may not be re-listed on the marketplace for a period of ninety (90) days from the Effective Date without written consent of the Platform.`
      : `As a Full Exit Seller, you have elected to sell all 8 of 8 fractional shares (8/8ths) of the Property and to exit ownership in its entirety upon closing of the final share sale.`;

  return `LISTING AGREEMENT
Document Version: ${LISTING_VERSION}
Effective Date: ${LISTING_EFFECTIVE}

BETWEEN: ${name} ("Seller")
AND: divieight, Inc. ("Platform")
RE: ${propertyLine} ("Property")

1. ENGAGEMENT AND ROLE OF THE PLATFORM
The Seller hereby engages divieight, Inc. as the exclusive marketplace administrator for the fractional listing and sale of undivided 1/8th ownership shares in the Property. The Platform acts as a technology-enabled marketplace and transaction coordinator. The Platform is not a licensed real estate broker in every jurisdiction and does not provide legal, tax, or investment advice. The Seller acknowledges that the Platform's role is limited to marketing, buyer matching, document coordination, and post-sale co-ownership administration.

2. EXIT ELECTION
${exitParagraph}

3. LISTING PRICE AND SHARE PRICING
The Property shall be listed at the Seller-selected total valuation. The per-share list price shall be computed as the total listing price divided by eight (8) and rounded to the nearest whole dollar. The Seller may adjust the listing price with seventy-two (72) hours' written notice, subject to any active offers.

4. TIMELINE AND EXCLUSIVITY
This Agreement grants divieight an exclusive listing period of one hundred eighty (180) days from the Effective Date. The Seller may not list the same Property, in whole or by fractional share, on any competing marketplace during the exclusivity period. Either party may terminate this Agreement with thirty (30) days' written notice after the initial ninety (90) day marketing window.

5. FEES AND DISBURSEMENT
The Platform shall charge a marketplace facilitation fee equal to a percentage of the gross proceeds from each share sold, as disclosed in the Seller Fee Schedule. Fees are deducted at closing of each share transaction and net proceeds are disbursed to the Seller within five (5) business days of settlement.

6. REPRESENTATIONS AND WARRANTIES
The Seller represents and warrants that (a) they are the record owner of the Property or the duly authorized agent thereof, (b) they have disclosed all known liens, easements, encumbrances, and covenants affecting the Property, and (c) all information provided to the Platform, including identity, ownership, and property details, is true and accurate to the best of their knowledge.

7. CO-OWNERSHIP GOVERNANCE
Upon closing of one or more fractional share sales, the Property shall be governed by the divieight Co-Ownership Operating Agreement, which shall be executed by all co-owners of record. This includes rules on scheduled use, shared expenses, capital improvements, dispute resolution, and voluntary or involuntary share transfers.

8. COMPLIANCE AND FAIR HOUSING
The Seller agrees to comply with all applicable federal, state, and local laws, including the Fair Housing Act. The Platform reserves the right to remove any listing that violates its Content and Compliance Policies.

9. LIMITATION OF LIABILITY
To the fullest extent permitted by law, the Platform's aggregate liability under this Agreement shall not exceed the total fees actually paid by the Seller to the Platform in the twelve (12) months preceding the event giving rise to the claim.

10. GOVERNING LAW AND DISPUTE RESOLUTION
This Agreement shall be governed by the laws of the State of Delaware, without regard to conflicts of law principles. Any dispute arising hereunder shall be resolved by binding arbitration administered by the American Arbitration Association in accordance with its Commercial Arbitration Rules.

11. ELECTRONIC SIGNATURE
The Seller consents to conducting this transaction by electronic means and agrees that their typed full legal name, together with a timestamp and cryptographic record, constitutes a legally binding electronic signature under the E-SIGN Act and applicable state UETA statutes.

12. ENTIRE AGREEMENT
This Agreement constitutes the entire understanding of the parties with respect to the subject matter hereof and supersedes all prior agreements, whether written or oral.

BY SIGNING BELOW, THE SELLER ACKNOWLEDGES THAT THEY HAVE READ, UNDERSTOOD, AND AGREED TO THE TERMS OF THIS LISTING AGREEMENT.`;
}
