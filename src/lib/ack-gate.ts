/**
 * The acknowledgment gate, in detail (shared and pure): which Required document, which version, who still owes it. The gate itself is the one in
 * due-diligence.ts and authorization.functions.ts; this names what is missing, so a locked screen can say so, and the Final Acknowledgment Posture Record
 * can list everything. Nothing here changes who has to acknowledge what.
 */
export interface GateDoc {
  id: string;
  document_title: string;
  category: string;
  content_hash: string;
  placed_at: string;
  required: boolean;
  superseded_by: string | null;
}

/** The version of a document: 1 for the first, and one more for each time a newer one superseded it. */
export function versionOf(docs: Array<Pick<GateDoc, "id" | "superseded_by">>, id: string): number {
  let v = 1;
  let cur = id;
  const seen = new Set<string>();
  for (;;) {
    const prior = docs.find((d) => d.superseded_by === cur && !seen.has(d.id));
    if (!prior) return v;
    seen.add(prior.id);
    v += 1;
    cur = prior.id;
  }
}

/** The older versions a document replaced, nearest first. */
export function priorVersions<T extends Pick<GateDoc, "id" | "superseded_by">>(docs: T[], id: string): T[] {
  const out: T[] = [];
  let cur = id;
  const seen = new Set<string>();
  for (;;) {
    const prior = docs.find((d) => d.superseded_by === cur && !seen.has(d.id));
    if (!prior) return out;
    seen.add(prior.id);
    out.push(prior);
    cur = prior.id;
  }
}

export interface Missing {
  documentId: string;
  title: string;
  version: number;
  who: "member" | "agent" | "account";
  memberId?: string | null;
  agentId?: string | null;
  name: string;
  /** A Required document that is a report with flagged findings. */
  materialFlags: number;
}

/** What the person (or the screen) is told. Lists every document and who still owes it. */
export function lockMessage(missing: Missing[], what = "Wire instructions and closing-funds confirmation"): string {
  if (missing.length === 0) return "";
  const byDoc = new Map<string, Missing[]>();
  for (const m of missing) byDoc.set(m.documentId, [...(byDoc.get(m.documentId) ?? []), m]);
  const parts = [...byDoc.values()].map((list) => {
    const first = list[0]!;
    const tag = `v${first.version}${first.materialFlags > 0 ? `, material report: ${first.materialFlags} flagged finding${first.materialFlags === 1 ? "" : "s"}` : ""}`;
    return `${first.title} (${tag}): ${list.map((m) => (m.who === "agent" ? `Resident Agent ${m.name}` : m.name)).join(", ")}`;
  });
  return `${what} stay locked until every member of the account and the Resident Agent have acknowledged every Required document and every material report item. Still needed: ${parts.join("; ")}.`;
}

export const POSTURE_SCHEMA = "acknowledgment-posture.v1";
export const POSTURE_DOCUMENT_TYPE = "acknowledgment_posture";

export interface PostureAck {
  document_id: string;
  title: string;
  version: number;
  content_hash: string;
  acknowledged_at: string;
  ip_address: string | null;
  device_fingerprint: string | null;
  user_agent: string | null;
  /** typed_signature, or authority when a member acknowledged under another member's documented authority. */
  method: "typed_signature" | "authority";
  secondary_verification: string | null;
  signed_name: string | null;
  acted_by_member_id: string | null;
  authority_grant_id: string | null;
  current: boolean;
}
