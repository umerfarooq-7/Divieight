/**
 * The Participant Eligibility Standard as a versioned document (shared, no server imports).
 *
 * The live version comes from one place: the live row of standard_versions (see standard-version.server.ts).
 * The version constant in eligibilityCopy.ts is only the version bundled with this build, used as the fallback
 * before the table exists. Nothing else reads it to decide which version is live.
 */

export const STANDARD_DOCUMENT_NAME = "Participant_Eligibility_Standard";

/** "Participant_Eligibility_Standard_v1.1" */
export const standardDocumentName = (version: string) => `${STANDARD_DOCUMENT_NAME}_v${version}`;

export const isStandardVersion = (v: unknown): v is string => typeof v === "string" && /^[0-9]+\.[0-9]+$/.test(v);

const parts = (v: string) => v.split(".").map(Number) as [number, number];

/** 1.2 > 1.1 > 1.0; 1.10 > 1.9 (numeric, not text). */
export function compareStandardVersions(a: string, b: string): number {
  const [a1, a2] = parts(a);
  const [b1, b2] = parts(b);
  return a1 - b1 || a2 - b2;
}

/** The document must be named for its version, with any folder and extension: …/Participant_Eligibility_Standard_v1.2.pdf */
export const fileMatchesVersion = (fileUrl: string, version: string) => fileUrl.includes(standardDocumentName(version));

/** Shown, word for word, before anyone publishes a new version. */
export const PUBLISH_WARNING =
  "The Decision Page copy must be read against the Standard in the same pass. They are separate documents and do not stay in sync on their own.";

/** The footer's "Standard on request" is only this text: no form. */
export const STANDARD_ON_REQUEST = { label: "Standard on request", text: "support@divieight.com" } as const;

export interface StandardVersionRow {
  version: string;
  effective_from: string;
  is_live: boolean;
  file_url: string;
  published_by?: string | null;
  created_at?: string;
}

/** The Decision Page's eyebrow for a version. Same words as the client's, with the version in it. */
export const eyebrowFor = (version: string) => `Participant Eligibility Standard · Version ${version}`;
