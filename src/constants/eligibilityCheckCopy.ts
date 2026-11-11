// The Eligibility Check: the client's wording for the screen and for the seller path.
// (eligibilityCopy.ts is the client's locked document and is not edited; this file holds the screen text.)

export const eligibilityCheckScreen = {
  eyebrow: "Step 5 · The Eligibility Check",
  heading: "The Eligibility Check",
  body:
    "The platform confirms identity and liveness for each Account Member individually, screens each Account Member against United States government sanctions, politically-exposed-person and law-enforcement watchlists, and records each Account Member's declaration made under penalty of perjury that they meet the Participant Eligibility Standard. The platform does not obtain a consumer report and does not conduct a criminal history search. The platform returns one of three results: eligible, held, or not eligible. No person at divieight exercises discretion, and identical declarations always receive the same result.",
} as const;

/** Hybrid Exit sellers (Module 1A): what a seller who retains shares goes through. */
export const hybridSellerEligibilityCheck =
  "eligibility check (identity, liveness, sanctions screening, and the eligibility declaration at Block 4)";

export const hybridSellerNotice = `A seller who retains shares goes through the ${hybridSellerEligibilityCheck}, the same Block 4 flow every buyer completes.`;
export const fullExitSellerNotice = "Full Exit sellers have no eligibility check.";

/** Verification Requests. A possible sanctions match is a question of identity, not merit. */
export const verificationRequestCopy = {
  sanctionsHeading: "We need to confirm who you are",
  sanctionsBody:
    "Our screening found a name on a United States government list that is similar to yours. The only question we ask is whether you are the person that list names. It is a question of identity, not merit: we answer it against the identity documents we already hold, and you can add a second government-issued ID below to help.",
  generalHeading: "We need a little more to complete your Eligibility Check",
  generalBody:
    "This is not a decision on your account. We simply need something more to complete your Eligibility Check. Helpful documents include a government-issued ID, proof of address, or a written explanation of anything you believe is inaccurate.",
  reviewHeading: "Your account is under review",
  dashboardBody: "We need a little more to complete your Eligibility Check. You can add more documents at any time.",
} as const;
