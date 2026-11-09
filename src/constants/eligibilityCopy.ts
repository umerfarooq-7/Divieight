// VERBATIM copy from "Eligibility Decision Page Content Specification v1.0" (4 Nov 2026)
// and Participant Eligibility Standard v1.1. Do NOT edit, rephrase, shorten, reorder or add to any string.
// A change here is a change to the client's document. Layout and styling are free; words are not.

export const STANDARD_VERSION = "1.1";
export const DECISION_PAGE_SPEC_VERSION = "1.0";

export const decisionPageCopy = {
  wordmark: "divieight",
  eyebrow: `Participant Eligibility Standard · Version ${STANDARD_VERSION}`,
  heading: "Read this before you pay anything.",
  definition:
    "Vetting, on the divieight platform, means: confirmation of identity against a government-issued document; a liveness confirmation that a real person is present and that the document is theirs; screening against United States government sanctions, politically-exposed-person and law-enforcement watchlists; verification of financial capacity; and a declaration made under penalty of perjury that the participant meets this Standard.",
  doesAndDoesNot: {
    heading: "What divieight does and does not do",
    p1: "Your financial capacity (liquidity) to make a cash purchase and to own real estate is indeed checked for verification. However, divieight does not obtain a credit report and it does not look at your credit history, your score, your debts or any bankruptcy.",
    p2: "What you say about your own background, you say under penalty of perjury, and divieight does not check it against an outside source, except as explained below. Your future co-owners are told this in the same words, in the document every buyer signs. Except as explained below, it is not intended that divieight will run a criminal records search or search court records.",
  },
  partOne: {
    label: "Part One",
    heading: "The standard itself",
    intro: "The following is what always disqualifies, what disqualifies for ten years, and what does not count at all.",
    A: {
      title: "A. Always disqualifying",
      lead: "A conviction for any of these disqualifies you, regardless of how long ago it happened. Each one bears on the physical safety of people who will share a house.",
      items: [
        "Any homicide offense.",
        "Any offense requiring registration as a sex offender in any jurisdiction, for as long as that requirement lasts or would have lasted.",
        "Arson.",
        "Kidnapping or unlawful imprisonment.",
      ],
    },
    B: {
      title: "B. Disqualifying within ten years",
      lead: "A conviction for any of these within the ten years before you apply disqualifies you. Each one bears on holding property and money jointly with seven other people.",
      items: [
        "Fraud, forgery, or false pretenses.",
        "Embezzlement, criminal breach of trust, or criminal breach of fiduciary duty.",
        "Money laundering, or structuring to evade reporting requirements.",
        "Identity theft.",
        "Theft constituting a felony.",
        "Any felony offense against a person, including domestic violence, not already listed in A.",
      ],
      tail: "The ten years run from the date of conviction — not from the end of a sentence, probation or supervision.",
    },
    C: {
      title: "C. What does not count at all",
      lead: "None of the following affects your eligibility, and you are not asked about any of it. This list is here because silence invites guessing.",
      items: [
        "An arrest, charge, accusation or indictment that did not result in a conviction.",
        "A charge dismissed, withdrawn, acquitted, or resolved by nolle prosequi.",
        "A record expunged, sealed, vacated, set aside, or pardoned.",
        "A juvenile adjudication.",
        "An infraction, a traffic offense, or any misdemeanor not listed in A or B.",
        "A drug offense involving possession or personal use.",
        "Any conviction older than the ten-year window in B.",
        "Credit history, credit score, debts, liens, civil judgments, bankruptcy, or any other financial history. divieight does not collect these and does not consider them. Whether you hold the funds (the financial capacity to purchase and own real estate) is verified separately, and that is a question of what you have now, not of what happened before.",
      ],
    },
    D: {
      title: "D. If a charge is pending",
      body: "If you have a criminal charge pending that would disqualify you on conviction, you are neither admitted nor refused. Your application is held, and decided when that charge is resolved. A pending criminal charge that would not disqualify you does not affect anything and is not asked about.",
    },
    E: {
      title: "E. Sanctions and watchlists",
      body: "There is a legal obligation that divieight has to screen every participant against United States government sanctions, politically-exposed-persons and law-enforcement lists. This one is not self-reported — divieight performs it. A confirmed match disqualifies. Where a possible match is not confirmed, the only question asked is whether you are the person the list names, answered against the identity documents already held.",
    },
    F: {
      title: "F. Telling the truth",
      body: "A declaration that is untrue in any respect disqualifies you, whether or not the underlying matter would have. That applies before admission, after admission, and after closing. Further, applying on behalf of someone whose identity you have not disclosed to divieight also disqualifies you.",
    },
    G: {
      title: "G. Nobody at divieight decides",
      body: "Your answers are compared against this Standard and return one of three results: eligible, held, or not eligible. No person at divieight weighs anything, and two people who answer the same way always get the same result. If you think you answered a question wrongly, you can correct it and resubmit it because that would be a correction of fact, not an appeal.",
    },
  },
  partTwo: {
    label: "Part Two",
    heading: "Your declaration",
    body: "At the time of your enrollment, you will answer six questions that pertain directly to items A through G above. Under penalty of perjury, you will answer with a simple yes or no. There is no box to write in.",
  },
  importantNote: {
    heading: "Important note",
    p1: "Your answer to one of the six questions will authorize divieight to obtain a report about you, limited to criminal history, from a consumer reporting agency, but only if such were needed to confirm any of your declarations. It is authorization given by you but only in case a question arises about the truth of your declarations.",
    p2: "Otherwise, divieight does not obtain such reports in the ordinary course on your onboarding or divieight’s administration of the platform.",
  },
  acknowledgement:
    "I understand that at the time of enrollment I will be asked the six questions described above, and that I will answer them under penalty of perjury.",
  continueLabel: "Continue",
  footer: [
    "divieight, LLC — PO Box 688, Lehi, UT 84043-4080.",
    "Questions or for a review of the Standard: support@divieight.com",
  ],
} as const;

// Block 4 (Amendment Sheet 4 Nov 2026, Section B / Standard Part Two). One question at a time, yes/no only.
export const block4Questions = [
  "I have never been convicted of a homicide offense, of arson, of kidnapping or unlawful imprisonment, or of any offense requiring registration as a sex offender in any jurisdiction.",
  "Within the last ten years I have not been convicted of fraud, forgery or false pretenses; embezzlement or criminal breach of trust; money laundering or structuring; identity theft; theft constituting a felony; or any felony offense against a person, including domestic violence.",
  "There is no criminal charge pending against me that would fall within question 1 or question 2 if it resulted in a conviction. If there is, I am disclosing it now, and I understand my application will be held rather than refused until that charge is resolved.",
  "I am applying for myself. I am not applying on behalf of, or at the direction of, any person whose identity I have not disclosed to divieight.",
  "I authorize divieight, LLC to obtain a consumer report about me, limited to criminal history, from a consumer reporting agency, for the sole purpose of confirming the statements above. I give this authorization as my written instruction. I understand that divieight does not obtain such reports in the ordinary course, that it may never obtain one about me, and that it retains this authorization in case a question arises about the truth of what I have stated here.",
  "I will notify divieight within ten days if any statement above stops being true. I understand that an untrue statement ends my participation, whenever it is discovered, including after closing.",
] as const;

export const block4DeclarationLine =
  "I declare under penalty of perjury under the laws of the State of Utah and of the United States that the foregoing is true and correct.";

// Part Three: paragraph that appears in what every buyer signs (Hold Harmless / buyer-signed document).
export const partThreeCoOwnerNotice =
  "divieight confirms your co-owners’ identities against government-issued documents and a liveness check, screens every participant against United States government sanctions and watchlists, and verifies financial capacity. Each participant declares under penalty of perjury that they meet divieight’s published eligibility standard, which is set out before anyone joins. divieight does not obtain criminal history reports and does not check any participant’s statements against court records. What your co-owners have said about their own backgrounds is their sworn statement, and it has not been independently verified.";

// Hold Harmless recital (Amendment Sheet Section A, replaces "the platform vets all members").
export const holdHarmlessRecital =
  "The user signs the Hold Harmless agreement, acknowledging that the platform’s vetting is as defined in the Participant Eligibility Standard — identity, liveness, sanctions screening, financial capacity, and a sworn declaration — that it does not include a criminal history search, and that the user remains responsible for their final property decisions. Each Account Member signs the Hold Harmless individually.";
