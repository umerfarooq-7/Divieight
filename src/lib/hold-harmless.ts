import { holdHarmlessRecital, partThreeCoOwnerNotice } from "@/constants/eligibilityCopy";

/**
 * The Hold Harmless ("Common Sense" Legal Wall). The text is the client's recital, then the Part Three
 * co-owner paragraph, verbatim, because every buyer-signed document that carries the Hold Harmless
 * carries that paragraph. Each Account Member signs it individually.
 *
 * Version 2 replaces the old one-sentence acknowledgment. Signatures already made on version 1
 * stay on record as they were signed.
 */
export const HOLD_HARMLESS_VERSION = "hh-v2";

export const holdHarmlessDocumentText = `${holdHarmlessRecital}\n\n${partThreeCoOwnerNotice}`;
