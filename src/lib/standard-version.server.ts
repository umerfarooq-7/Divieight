/**
 * The Participant Eligibility Standard as a versioned document (server side).
 *
 * One source for the live version: the live row of standard_versions. If the table doesn't exist yet, the
 * version bundled with this build (STANDARD_VERSION in eligibilityCopy.ts) stands in, so nothing breaks
 * before standard-versions.sql is run.
 *
 * Publishing a new version never re-measures anyone: existing declarations and results keep the version
 * they were made under, and a new version applies only to declarations made after it takes effect.
 */
import { STANDARD_VERSION } from "@/constants/eligibilityCopy";
import {
  PUBLISH_WARNING,
  compareStandardVersions,
  fileMatchesVersion,
  isStandardVersion,
  standardDocumentName,
  type StandardVersionRow,
} from "@/lib/standard-version";

type Db = { from: (t: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => any };

export interface LiveStandard {
  version: string;
  effectiveFrom: string | null;
  fileUrl: string | null;
  /** 'table' = the live row; 'bundled' = the version built into this release (the table isn't there yet). */
  source: "table" | "bundled";
}

const MISSING_SCHEMA = "Database is missing the Standard versions — run standard-versions.sql in Supabase.";

export async function getLiveStandard(db: Db): Promise<LiveStandard> {
  const { data, error } = await db.from("standard_versions").select("version, effective_from, file_url").eq("is_live", true).maybeSingle();
  const row = data as { version: string; effective_from: string; file_url: string } | null;
  if (error || !row) return { version: STANDARD_VERSION, effectiveFrom: null, fileUrl: null, source: "bundled" };
  return { version: row.version, effectiveFrom: row.effective_from, fileUrl: row.file_url, source: "table" };
}

export async function listStandardVersions(db: Db): Promise<StandardVersionRow[]> {
  const { data, error } = await db.from("standard_versions").select("*");
  if (error) throw new Error(MISSING_SCHEMA);
  return ((data ?? []) as StandardVersionRow[]).sort((a, b) => compareStandardVersions(b.version, a.version));
}

/**
 * Admin only (the caller checks the role). Makes `version` the live one. The admin must confirm they have
 * read the warning: the Decision Page copy and the Standard are separate documents.
 */
export async function publishStandardVersion(
  db: Db,
  params: { adminId: string; version: string; fileUrl: string; acknowledgedWarning: boolean },
): Promise<{ version: string; previousVersion: string | null; effectiveFrom: string; warning: string }> {
  if (params.acknowledgedWarning !== true) throw new Error("Confirm that you have read the warning before publishing.");
  const version = params.version.trim();
  const fileUrl = params.fileUrl.trim();
  if (!isStandardVersion(version)) throw new Error("A version looks like 1.2.");
  if (!fileUrl) throw new Error(`Give the document's location. It is named like ${standardDocumentName(version)}.pdf`);
  if (!fileMatchesVersion(fileUrl, version)) throw new Error(`The document must be named ${standardDocumentName(version)} (for example ${standardDocumentName(version)}.pdf).`);
  const live = await getLiveStandard(db);
  if (compareStandardVersions(version, live.version) <= 0) throw new Error(`The new version must be newer than the live version (${live.version}).`);
  const existing = await listStandardVersions(db);
  if (existing.some((v) => v.version === version)) throw new Error(`Version ${version} already exists.`);

  // One transaction in the database: the new version goes live and the old one stops, together.
  const { currentRulesHash } = await import("@/lib/standard-rules-hash");
  const publish = (args: Record<string, unknown>) => (db.rpc as NonNullable<Db["rpc"]>)("publish_standard_version", args);
  let { data, error } = await publish({ _version: version, _file_url: fileUrl, _published_by: params.adminId, _rules_hash: currentRulesHash() });
  // Before rules-and-held-decisions.sql is run the function has no hash argument: publish the old way.
  if (error && /_rules_hash|schema cache|Could not find the function/i.test(error.message ?? "")) ({ data, error } = await publish({ _version: version, _file_url: fileUrl, _published_by: params.adminId }));
  if (error) throw new Error(error.message?.includes("publish_standard_version") ? MISSING_SCHEMA : error.message || MISSING_SCHEMA);
  const effectiveFrom = (data as string | null) ?? new Date().toISOString();
  // The new version was published with this build's questions-and-rules hash, in the same insert.
  await db.from("audit_log").insert({
    actor_id: params.adminId,
    actor_type: "admin",
    action_type: "standard.version_published",
    entity_type: "standard_versions",
    entity_id: null,
    metadata: { version, previous_version: live.source === "table" ? live.version : null, file_url: fileUrl, effective_from: effectiveFrom, existing_results_remeasured: false, warning_acknowledged: true },
  });
  return { version, previousVersion: live.source === "table" ? live.version : null, effectiveFrom, warning: PUBLISH_WARNING };
}
