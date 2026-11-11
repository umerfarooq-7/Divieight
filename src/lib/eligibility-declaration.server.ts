/**
 * Block 4 — Eligibility Declaration and Authorization (server side).
 *
 * One record per submission, per Account Member. A correction is a new record that names the
 * one it replaces (supersedes_id); the earlier record is marked 'superseded' and never changed
 * or deleted otherwise. No consumer report is requested here: only the consent text and its hash.
 */

import { getLiveStandard } from "@/lib/standard-version.server";
import { requireActingMember, type RequestContext } from "@/lib/account-members.server";
import { identityComplete } from "@/lib/account-members";
import { sha256 } from "@/lib/entity-genesis-stage2.server";
import {
  AUTHORIZATION_QUESTION,
  NAME_MISMATCH_MESSAGE,
  declarationStatusFor,
  declarationText,
  legalNamesMatch,
  type DeclarationAnswers,
  type DeclarationStatus,
} from "@/lib/eligibility-declaration";

type Db = { from: (t: string) => any };

const MISSING_SCHEMA = "Database is missing eligibility declarations — run eligibility-declarations.sql in Supabase.";
const TABLE = "eligibility_declarations";

export interface DeclarationRecord {
  id: string;
  account_member_id: string;
  buyer_account_id: string;
  standard_version: string;
  answers: DeclarationAnswers | null;
  rendered_text_snapshot: string;
  declaration_hash: string;
  declared_at: string;
  signed_name: string | null;
  attested_personally: boolean;
  supersedes_id: string | null;
  status: DeclarationStatus;
}

/** The same answers under the same Standard always give the same hash. */
export function declarationHash(answers: DeclarationAnswers, standardVersion: string): string {
  return sha256(declarationText(answers, standardVersion));
}

async function memberRecords(db: Db, memberId: string): Promise<DeclarationRecord[]> {
  const { data, error } = await db.from(TABLE).select("*").eq("account_member_id", memberId).order("declared_at", { ascending: true });
  if (error) throw new Error(MISSING_SCHEMA);
  return (data ?? []) as DeclarationRecord[];
}

const current = (rows: DeclarationRecord[]) => rows.filter((r) => r.status === "complete" || r.status === "incomplete").at(-1) ?? null;

export interface DeclarationState {
  current: DeclarationRecord | null;
  history: number;
  /** The name verified from this member's ID, which the typed signature must match. */
  verifiedName: string | null;
  vettingStatus: string | null;
  /** Active members on the account whose declaration isn't complete yet (names only). */
  waitingOn: string[];
  /** The Standard that is live now: what a declaration made today is made under. */
  standardVersion: string;
}

export async function declarationState(db: Db, params: { userId: string; actingMemberId: string }): Promise<DeclarationState> {
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);
  const rows = await memberRecords(db, member.id);
  return {
    current: current(rows),
    history: rows.filter((r) => r.status !== "legacy").length,
    verifiedName: verifiedNameOf(member),
    vettingStatus: member.vetting_status,
    waitingOn: await waitingOn(db, account.id),
    standardVersion: (await getLiveStandard(db)).version,
  };
}

/** The identity step records the member's legal name with their ID document; that is the verified name. */
function verifiedNameOf(m: { full_name: string | null; date_of_birth: string | null; address: string | null; id_document_url?: string | null }) {
  if (!identityComplete(m) || !m.id_document_url) return null;
  return (m.full_name ?? "").trim() || null;
}

async function waitingOn(db: Db, accountId: string): Promise<string[]> {
  const { data: members } = await db.from("account_members").select("id, full_name, role").eq("buyer_account_id", accountId).eq("status", "active");
  const { data: rows } = await db.from(TABLE).select("account_member_id, status").eq("buyer_account_id", accountId).eq("status", "complete");
  const done = new Set(((rows ?? []) as Array<{ account_member_id: string }>).map((r) => r.account_member_id));
  return ((members ?? []) as Array<{ id: string; full_name: string | null; role: string }>)
    .filter((m) => !done.has(m.id))
    .map((m) => m.full_name?.trim() || (m.role === "primary" ? "the account holder" : "the second member"));
}

export async function submitDeclaration(
  db: Db,
  params: {
    userId: string;
    actingMemberId: string;
    answers: DeclarationAnswers;
    attestedPersonally: boolean;
    signedName: string;
    /** The record this one corrects; must be the member's current record, if they have one. */
    supersedesId: string | null;
    /** A correction of fact (E2) or a ten-day change notice (Q6). Both are new versions. */
    kind?: "correction" | "change_report";
    request: RequestContext;
  },
): Promise<{ id: string; status: "incomplete" | "complete"; declarationHash: string; vettingStatus: string | null; result: string | null; reasonCodes: string[]; waitingOn: string[] }> {
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);
  // The questions and rules must be the ones the live Standard version was published with.
  await (await import("@/lib/standard-rules-check.server")).assertStandardRules(db);

  if (params.attestedPersonally !== true) throw new Error("Confirm that you are personally making this declaration.");
  const verified = verifiedNameOf(member);
  if (!verified) throw new Error("Finish the identity step for this member first, so the signature can be checked against their ID.");
  const signedName = params.signedName.trim();
  if (!legalNamesMatch(signedName, verified)) throw new Error(NAME_MISMATCH_MESSAGE);

  const rows = await memberRecords(db, member.id);
  const now = current(rows);
  if ((now?.id ?? null) !== (params.supersedesId ?? null)) {
    throw new Error(now ? "This declaration was already corrected. Reload the page to see the latest one." : "There is no earlier declaration to correct.");
  }

  // The Standard that is live now. A declaration is made under it, and stays tied to it: a version published
  // later never re-measures it.
  const standardVersion = (await getLiveStandard(db)).version;
  const status = declarationStatusFor(params.answers);
  const text = declarationText(params.answers, standardVersion);
  const hash = sha256(text);
  const declaredAt = new Date().toISOString();

  const { data: inserted, error } = await db
    .from(TABLE)
    .insert({
      account_member_id: member.id,
      buyer_account_id: account.id,
      standard_version: standardVersion,
      answers: params.answers,
      rendered_text_snapshot: text,
      declaration_hash: hash,
      declared_at: declaredAt,
      signed_name: signedName,
      attested_personally: true,
      ip: params.request.ip,
      user_agent: params.request.userAgent,
      supersedes_id: now?.id ?? null,
      status,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") throw new Error("This declaration was already corrected. Reload the page to see the latest one.");
    throw new Error(error.message?.includes(TABLE) ? MISSING_SCHEMA : error.message || MISSING_SCHEMA);
  }
  // The database trigger marks the earlier record superseded as part of the insert; this is a no-op there.
  if (now) await db.from(TABLE).update({ status: "superseded" }).eq("id", now.id).in("status", ["incomplete", "complete"]);

  // The Question 5 authorization is the member's consent record. The legacy fcra_consent_at column follows it: set when
  // they say Yes, cleared if they later withdraw it. (background_check_result is no longer written by anything.)
  await db.from("account_members").update({ fcra_consent_at: params.answers[AUTHORIZATION_QUESTION] === "yes" ? declaredAt : null }).eq("id", member.id);

  // Vetting outcome from the declaration alone. Q5 = No is incomplete: the member's status is left as it was,
  // and nothing is ever recorded as failed. A "No" to a statement is held for review, and stays held even if a
  // later correction answers Yes: a correction of fact is reviewed, not taken on its own.
  // The result is the engine's, from these answers and the member's screening facts. Recomputed on
  // every submission: a correction of fact or a reported change gives a new result.
  const { recomputeEligibility } = await import("@/lib/eligibility-engine.server");
  const engine = await recomputeEligibility(db, { memberId: member.id, actorId: params.userId, trigger: params.kind === "change_report" ? "change_reported" : now ? "declaration_corrected" : "declaration_made" });
  const { data: after } = await db.from("account_members").select("vetting_status").eq("id", member.id).maybeSingle();
  const vettingStatus = (after as { vetting_status: string | null } | null)?.vetting_status ?? member.vetting_status;

  await db.from("audit_log").insert({
    actor_id: params.userId,
    actor_type: "buyer",
    action_type: status === "complete" ? "buyer.eligibility_declaration_made" : "buyer.eligibility_declaration_incomplete",
    entity_type: "buyer_account",
    entity_id: account.id,
    metadata: {
      record: "eligibility_declaration",
      declaration_id: (inserted as { id: string }).id,
      account_member_id: member.id,
      acted_by_member_id: member.id,
      standard_version: standardVersion,
      declaration_hash: hash,
      status,
      supersedes_id: now?.id ?? null,
      kind: params.kind ?? (now ? "correction" : "first"),
      vetting_status: vettingStatus,
      eligibility_result: engine.result,
      ip_address: params.request.ip,
      user_agent: params.request.userAgent,
    },
  });

  return { id: (inserted as { id: string }).id, status, declarationHash: hash, vettingStatus, result: engine.result, reasonCodes: engine.reason_codes, waitingOn: await waitingOn(db, account.id) };
}

/** For the admin's buyer view: every member's current declaration (and the count of earlier ones). */
export async function adminDeclarations(db: Db, accountIds: string[]) {
  if (accountIds.length === 0) return [];
  const { data, error } = await db
    .from(TABLE)
    .select("id, account_member_id, buyer_account_id, standard_version, status, declared_at, declaration_hash, answers")
    .in("buyer_account_id", accountIds);
  if (error) return [];
  return (data ?? []) as Array<Pick<DeclarationRecord, "id" | "account_member_id" | "buyer_account_id" | "standard_version" | "status" | "declared_at" | "declaration_hash" | "answers">>;
}
