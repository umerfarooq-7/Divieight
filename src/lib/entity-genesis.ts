// Entity Genesis — Stage 1 (Digital Genesis) shared types and templates.
//
// Every property is a STANDALONE Delaware LLC. There is deliberately no
// "Master LLC with internal Series cells" structure (explicitly rejected).
// divieight, LLC is always the Manager — a fixed clause, never configurable.

export const RETENTION_LOCK_MONTHS = 12;

export interface CapTableRow {
  shareNumber: number;
  holderType: "buyer_account" | "retained_seller";
  buyerAccountId: string | null;
  sellerId: string | null;
  memberNames: string[];
  acquisitionDate: string;
  retentionLockExpiresAt: string;
}

export interface EntityGenesisRecord {
  id: string;
  propertyId: string;
  stage: "digital_genesis" | "state_filed";
  llcName: string;
  ein: string | null;
  draftOperatingAgreementUrl: string | null;
  capTableGeneratedAt: string | null;
  createdAt: string;
}

export interface EntityGenesisView extends EntityGenesisRecord {
  address: string;
  city: string;
  state: string;
  zip: string;
  capTable: CapTableRow[];
}

/** acquisition_date + 12 months. */
export function retentionLockExpiry(acquisitionDate: string): string {
  const d = new Date(acquisitionDate);
  d.setMonth(d.getMonth() + RETENTION_LOCK_MONTHS);
  return d.toISOString();
}

/**
 * Placeholder LLC name used until the Delaware filing (Stage 2) confirms the
 * reserved name. Pattern: `D8 <street slug> <zip>, LLC (name reservation pending)`.
 */
export function placeholderLlcName(property: {
  address: string;
  city: string;
  state: string;
  zip: string;
}): string {
  const slug = property.address
    .replace(/[^A-Za-z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join(" ")
    .toUpperCase();
  return `D8 ${slug} ${property.zip}, LLC (name reservation pending)`;
}

/**
 * Draft Operating Agreement. Placeholders stay unresolved on purpose: the
 * member roster is only final at Closing-Ready, and the LLC name/EIN arrive
 * with the state filing in Stage 2.
 */
export function draftOperatingAgreement(input: {
  llcName: string;
  property: { address: string; city: string; state: string; zip: string };
  capTable: CapTableRow[];
  generatedAt: string;
}): string {
  const { llcName, property, capTable, generatedAt } = input;
  const roster =
    capTable.length === 0
      ? "  [MEMBER ROSTER PENDING — no shares recorded at generation time]"
      : capTable
          .map((r) => {
            const who =
              r.holderType === "retained_seller"
                ? "Retained Seller Share (Hybrid Exit election)"
                : r.memberNames.length > 0
                  ? r.memberNames.join(" & ")
                  : "[MEMBER NAME PENDING]";
            return `  Unit ${r.shareNumber} of 8 — ${who} — acquired ${r.acquisitionDate.slice(0, 10)} — Retention Lock through ${r.retentionLockExpiresAt.slice(0, 10)}`;
          })
          .join("\n");

  return `DRAFT LIMITED LIABILITY COMPANY OPERATING AGREEMENT
${llcName}
A Delaware limited liability company

STATUS: DRAFT — generated at Hard-Lock (${generatedAt}). This draft is
finalized once the full cap table is known at Closing-Ready. Each divieight
property is held by its own standalone Delaware limited liability company;
this Company is not a series, cell, or division of any other entity.

ARTICLE I — THE COMPANY AND THE PROPERTY
1.1 The Company is formed to acquire, hold and administer the real property
    commonly known as:
      ${property.address}, ${property.city}, ${property.state} ${property.zip}
    (the "Subject Property").
1.2 Membership interests are divided into eight (8) equal units, each
    representing an undivided one-eighth (1/8th) interest.
1.3 The Company name shown above is a placeholder pending Delaware name
    reservation and filing. [LLC NAME — PENDING STATE FILING]
1.4 Employer Identification Number: [EIN — PENDING STAGE 2]

ARTICLE II — MEMBERS AND UNITS (MEMBER ROSTER — DRAFT)
${roster}
    Any unit not listed above remains unissued pending reservation.

ARTICLE III — MANAGER
3.1 The Company is manager-managed. divieight, LLC is the Manager of the
    Company. This clause is a fixed term of the divieight standard form and
    is not variable by property or by member election.
3.2 The Manager administers the Use Calendar, maintenance reserves, vendor
    engagement, insurance, tax filings and books and records, and may execute
    ordinary-course instruments on behalf of the Company.
3.3 Matters outside the ordinary course — sale of the Subject Property,
    encumbrance of title, capital calls beyond the reserve schedule, and
    amendment of this Agreement — require member approval as provided herein.

ARTICLE IV — RETENTION LOCK
4.1 Each member's unit is subject to a Retention Lock for twelve (12) months
    from that member's acquisition date, running per unit and not per company.
4.2 During the Retention Lock a member may not sell, assign, pledge or
    otherwise transfer the unit, except through a platform-administered
    substitution or as required by law.
4.3 Retention Lock expiry dates are recorded per unit in Article II and are
    maintained on the Company cap table.

ARTICLE V — USE CALENDAR
5.1 Occupancy is allocated among the eight units through the divieight Use
    Calendar, administered by the Manager on an equal-entitlement basis.
5.2 Peak, holiday and high-demand periods rotate so that no unit obtains a
    persistent advantage across successive years.
5.3 Unused allocations do not accrue beyond the limits published in the Use
    Calendar rules, and exchanges between members are recorded by the Manager.

ARTICLE VI — TRANSFERS AND SUBSTITUTION
6.1 After the Retention Lock, transfers proceed only through the platform's
    substitution process, with the Manager confirming the transferee meets
    the Company's member requirements.

ARTICLE VII — DRAFT PLACEHOLDERS
    [MEMBER ROSTER — FINALIZED AT CLOSING-READY]
    [CAPITAL CONTRIBUTION SCHEDULE — FINALIZED AT CLOSING]
    [SIGNATURE PAGES — ONE PER MEMBER]
`;
}

// ---------------------------------------------------------------------------
// Stage 2 — State Filing + EIN, final Operating Agreement
// ---------------------------------------------------------------------------

export type StateFilingStatus = "pending" | "filed" | "confirmed";
export type EinStatus = "pending" | "issued" | "verified";
export type TinMatchResult = "match" | "not_found" | "name_mismatch";
export type AtlasStatus = "not_requested" | "requested" | "completed";
export type FinalOaStatus = "not_started" | "awaiting_signatures" | "executed";

export const ATLAS_FEE_USD = 500;

export const TIN_MATCH_LABELS: Record<TinMatchResult, string> = {
  match: "Match — name and EIN confirmed",
  not_found: "Not found — IRS has no record of this EIN",
  name_mismatch: "Name mismatch — EIN exists under a different name",
};

export interface Stage2Signer {
  buyerAccountId: string;
  accountMemberId: string;
  name: string;
}

/**
 * The final Operating Agreement: the draft's fixed terms, with the member
 * roster locked from the Closing-Ready cap table and the Delaware filing
 * details filled in. One signature line per Account Member.
 */
export function finalOperatingAgreement(input: {
  llcName: string;
  delawareFileNumber: string | null;
  ein: string | null;
  property: { address: string; city: string; state: string; zip: string };
  capTable: CapTableRow[];
  signers: Stage2Signer[];
  lockedAt: string;
}): string {
  const draft = draftOperatingAgreement({
    llcName: input.llcName,
    property: input.property,
    capTable: input.capTable,
    generatedAt: input.lockedAt,
  });
  const body = draft
    .replace("DRAFT LIMITED LIABILITY COMPANY OPERATING AGREEMENT", "LIMITED LIABILITY COMPANY OPERATING AGREEMENT")
    .replace(
      /STATUS: DRAFT[\s\S]*?this Company is not a series, cell, or division of any other entity\./,
      `STATUS: FINAL — member roster locked at Closing-Ready (${input.lockedAt}).
Each divieight property is held by its own standalone Delaware limited
liability company; this Company is not a series, cell, or division of any
other entity.`,
    )
    .replace(
      /1\.3 The Company name shown above is a placeholder[\s\S]*?\[LLC NAME — PENDING STATE FILING\]/,
      `1.3 The Company was formed by filing a Certificate of Formation with the
    Delaware Secretary of State${input.delawareFileNumber ? ` (file no. ${input.delawareFileNumber})` : ""}.`,
    )
    .replace("1.4 Employer Identification Number: [EIN — PENDING STAGE 2]", `1.4 Employer Identification Number: ${input.ein ?? "as assigned by the IRS"}`)
    .replace("ARTICLE II — MEMBERS AND UNITS (MEMBER ROSTER — DRAFT)", "ARTICLE II — MEMBERS AND UNITS (MEMBER ROSTER — FINAL)")
    .replace("    Any unit not listed above remains unissued pending reservation.\n", "")
    .replace(/ARTICLE VII — DRAFT PLACEHOLDERS[\s\S]*$/, "");

  const lines = input.signers
    .map(
      (s) => `  ____________________________________
  ${s.name} (Buyer Account member)
  Signed electronically: [SIGNATURE PENDING]`,
    )
    .join("\n\n");
  return `${body.trimEnd()}

ARTICLE VII — EXECUTION
7.1 This Agreement is executed electronically through the divieight
    Platform-Native Signing Interface. Members sign in parallel and in no
    required order; it becomes effective when every member below has signed.
7.2 Signature pages:

${lines}
`;
}

/** The executed copy: the final text with each signature line completed. */
export function executedOperatingAgreement(
  finalText: string,
  signatures: Array<{ name: string; signedAt: string; hash: string }>,
): string {
  let text = finalText;
  for (const s of signatures) {
    text = text.replace(
      `  ${s.name} (Buyer Account member)\n  Signed electronically: [SIGNATURE PENDING]`,
      `  /s/ ${s.name} (Buyer Account member)\n  Signed electronically: ${s.signedAt}`,
    );
  }
  return `${text}
EXECUTION RECORD
  Every signature above was applied to the document with SHA-256 hash
  ${signatures[0]?.hash ?? "—"}.
`;
}
