/**
 * The eligibility result engine (server side): gathers each member's facts, runs the pure
 * evaluateEligibility(), and appends a result row. Every recompute that yields a result inserts a
 * new row; the latest row on the member's current declaration is their current result.
 *
 * Admins record FACTS only: how a disclosed charge ended, whether a possible sanctions match is the
 * member, or that a declaration was untrue. There is no way to set or override a result.
 */

import { identityComplete } from "@/lib/account-members";
import { latestLiveness } from "@/lib/liveness";
import { getSanctionsAdapter } from "@/lib/sanctions-adapters";
import {
  OFFENSES,
  VETTING_STATUS_FOR,
  currentResultOf,
  evaluateEligibility,
  type Disposition,
  type DispositionOutcome,
  type EligibilityResult,
  type Evaluation,
  type SanctionsStatus,
  type Screening,
} from "@/lib/eligibility-engine";
import type { DeclarationAnswers } from "@/lib/eligibility-declaration";

type Db = { from: (t: string) => any };

const MISSING_SCHEMA = "Database is missing the eligibility engine tables — run eligibility-results.sql in Supabase.";

interface MemberRow {
  id: string;
  buyer_account_id: string;
  full_name: string | null;
  role: string;
  status: string;
  address: string | null;
  date_of_birth: string | null;
  id_document_url: string | null;
  vetting_status: string | null;
}

interface DeclRow {
  id: string;
  account_member_id: string;
  status: string;
  answers: DeclarationAnswers | null;
  declared_at: string;
  standard_version: string;
}

const byTime = <T extends { created_at: string }>(rows: T[]) => [...rows].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

async function member(db: Db, memberId: string): Promise<MemberRow> {
  const { data } = await db.from("account_members").select("*").eq("id", memberId).maybeSingle();
  if (!data) throw new Error("Member not found");
  return data as MemberRow;
}

async function currentDeclaration(db: Db, memberId: string): Promise<DeclRow | null> {
  const { data } = await db.from("eligibility_declarations").select("id, account_member_id, status, answers, declared_at, standard_version").eq("account_member_id", memberId);
  return ((data ?? []) as DeclRow[]).find((d) => d.status === "complete" || d.status === "incomplete") ?? null;
}

async function latestSanctions(db: Db, memberId: string) {
  const { data, error } = await db.from("member_sanctions_screenings").select("*").eq("account_member_id", memberId);
  if (error) throw new Error(MISSING_SCHEMA);
  return byTime((data ?? []) as Array<{ id: string; status: SanctionsStatus; created_at: string; list_name: string | null; matched_name: string | null }>).at(-1) ?? null;
}

/** Screens the member once their identity is in; a possible match issues a Verification Request. */
async function ensureScreened(db: Db, m: MemberRow) {
  const existing = await latestSanctions(db, m.id);
  if (existing || !identityComplete(m)) return existing;
  const adapter = getSanctionsAdapter();
  let r: { status: SanctionsStatus; listName: string | null; matchedName: string | null };
  try {
    r = await adapter.screen({ fullName: m.full_name ?? "", dateOfBirth: m.date_of_birth, idDocumentRef: m.id_document_url });
  } catch {
    r = { status: "pending", listName: null, matchedName: null };
  }
  const row = { account_member_id: m.id, buyer_account_id: m.buyer_account_id, provider: adapter.provider, status: r.status, list_name: r.listName, matched_name: r.matchedName };
  const { data } = await db.from("member_sanctions_screenings").insert(row).select("*").single();
  await db.from("audit_log").insert({ actor_id: null, actor_type: "system", action_type: "eligibility.sanctions_screened", entity_type: "buyer_account", entity_id: m.buyer_account_id, metadata: { account_member_id: m.id, status: r.status, provider: adapter.provider } });
  if (r.status === "possible_match") {
    // The existing Verification Request: the account stays pending.
    await db.from("account_members").update({ vetting_status: "verification_pending" }).eq("id", m.id);
    await db.from("buyer_accounts").update({ onboarding_status: "verification_pending" }).eq("id", m.buyer_account_id);
    await db.from("audit_log").insert({ actor_id: null, actor_type: "system", action_type: "buyer.verification_requested", entity_type: "buyer_account", entity_id: m.buyer_account_id, metadata: { member_id: m.id, reason: "sanctions_possible_match", question: "Are you the person the list names?" } });
  }
  return (data as { id: string; status: SanctionsStatus; created_at: string }) ?? { ...row, id: "", created_at: new Date().toISOString() };
}

async function screeningFor(db: Db, m: MemberRow, decl: DeclRow | null): Promise<Screening> {
  const { data: live } = await db.from("member_liveness_checks").select("account_member_id, status, created_at").eq("account_member_id", m.id);
  const sanctions = await ensureScreened(db, m);
  const { data: untrue } = await db.from("declaration_untrue_findings").select("id").eq("account_member_id", m.id);
  const { data: disp } = await db.from("charge_dispositions").select("*").eq("account_member_id", m.id);
  const d = byTime((disp ?? []) as Array<{ outcome: DispositionOutcome; offense_key: string | null; disposition_date: string; created_at: string }>).at(-1);
  return {
    identityComplete: identityComplete(m) && Boolean(m.id_document_url),
    liveness: (latestLiveness((live ?? []) as Array<{ account_member_id: string; status: Screening["liveness"]; created_at: string }>, m.id)?.status ?? null) as Screening["liveness"],
    sanctions: sanctions?.status ?? null,
    declarationFoundUntrue: ((untrue ?? []) as unknown[]).length > 0,
    disposition: d ? { outcome: d.outcome, offenseKey: d.offense_key, dispositionDate: d.disposition_date } : null,
    appliedAt: decl?.declared_at ?? new Date().toISOString(),
  };
}

export interface RecomputeOutcome extends Evaluation {
  resultId: string | null;
}

/** Recomputes one member's result from their facts. Writes a row only when there is a result. */
export async function recomputeEligibility(db: Db, params: { memberId: string; actorId: string | null; trigger: string }): Promise<RecomputeOutcome> {
  const m = await member(db, params.memberId);
  const decl = await currentDeclaration(db, m.id);
  const answers = decl?.answers ?? null;
  const screening = await screeningFor(db, m, decl);
  const evaluation = evaluateEligibility(answers, screening);

  let resultId: string | null = null;
  if (evaluation.result && decl) {
    const { data, error } = await db
      .from("eligibility_results")
      .insert({
        account_member_id: m.id,
        buyer_account_id: m.buyer_account_id,
        // The version of the declaration this result is determined on, not whichever is live now: publishing a
        // new Standard never re-measures an existing participant.
        standard_version: decl.standard_version,
        result: evaluation.result,
        reason_codes: evaluation.reason_codes,
        determined_at: new Date().toISOString(),
        declaration_id: decl.id,
        screening_snapshot: { ...screening, trigger: params.trigger },
      })
      .select("id")
      .single();
    if (error) throw new Error(MISSING_SCHEMA);
    resultId = (data as { id: string }).id;
    await db.from("account_members").update({ vetting_status: VETTING_STATUS_FOR[evaluation.result] }).eq("id", m.id);
  } else if (["cleared", "held", "not_eligible", "held_for_review"].includes(m.vetting_status ?? "")) {
    // No result now (e.g. a correction left it incomplete): the old label no longer applies.
    await db.from("account_members").update({ vetting_status: "in_progress" }).eq("id", m.id);
  }

  await db.from("audit_log").insert({
    actor_id: params.actorId,
    actor_type: params.actorId ? "buyer" : "system",
    action_type: "eligibility.recomputed",
    entity_type: "buyer_account",
    entity_id: m.buyer_account_id,
    metadata: { account_member_id: m.id, trigger: params.trigger, result: evaluation.result, reason_codes: evaluation.reason_codes, result_id: resultId, declaration_id: decl?.id ?? null },
  });
  return { ...evaluation, resultId };
}

/** Each active member's current result on the account (null = no result yet). */
export async function currentResults(db: Db, accountId: string): Promise<Record<string, { result: EligibilityResult; reason_codes: string[] } | null>> {
  const { data: members } = await db.from("account_members").select("id").eq("buyer_account_id", accountId).eq("status", "active");
  const { data: decls } = await db.from("eligibility_declarations").select("id, account_member_id, status").eq("buyer_account_id", accountId).eq("status", "complete");
  const { data: rows, error } = await db.from("eligibility_results").select("*").eq("buyer_account_id", accountId);
  const out: Record<string, { result: EligibilityResult; reason_codes: string[] } | null> = {};
  for (const { id } of (members ?? []) as Array<{ id: string }>) {
    const decl = ((decls ?? []) as Array<{ id: string; account_member_id: string }>).find((d) => d.account_member_id === id) ?? null;
    const cur = error ? null : currentResultOf((rows ?? []) as Array<{ account_member_id: string; declaration_id: string; determined_at: string; result: EligibilityResult; reason_codes: string[] }>, id, decl?.id ?? null);
    out[id] = cur ? { result: cur.result, reason_codes: cur.reason_codes } : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Admin: facts only
// ---------------------------------------------------------------------------

async function adminAudit(db: Db, adminId: string, action: string, accountId: string, metadata: Record<string, unknown>) {
  await db.from("audit_log").insert({ actor_id: adminId, actor_type: "admin", action_type: action, entity_type: "buyer_account", entity_id: accountId, metadata });
}

/** Members whose current result is held, with what they disclosed and when. */
export async function listHeld(db: Db) {
  const { data: rows, error } = await db.from("eligibility_results").select("*").eq("result", "held");
  if (error) throw new Error(MISSING_SCHEMA);
  const out: Array<{ memberId: string; accountId: string; fullName: string; declarationId: string; heldSince: string; reasonCodes: string[] }> = [];
  const seen = new Set<string>();
  for (const r of (rows ?? []) as Array<{ account_member_id: string; buyer_account_id: string; declaration_id: string; determined_at: string; reason_codes: string[] }>) {
    if (seen.has(r.account_member_id)) continue;
    seen.add(r.account_member_id);
    const current = (await currentResults(db, r.buyer_account_id))[r.account_member_id];
    if (current?.result !== "held") continue;
    const m = await member(db, r.account_member_id);
    out.push({ memberId: m.id, accountId: m.buyer_account_id, fullName: m.full_name ?? "", declarationId: r.declaration_id, heldSince: r.determined_at, reasonCodes: current.reason_codes });
  }
  return out;
}

/** Records how a disclosed charge ended. The engine, not the admin, decides what it means. */
export async function recordDisposition(db: Db, params: { adminId: string; memberId: string; outcome: DispositionOutcome; offenseKey: string | null; dispositionDate: string }) {
  const m = await member(db, params.memberId);
  const decl = await currentDeclaration(db, m.id);
  if (!decl || decl.status !== "complete" || decl.answers?.q3 !== "no") throw new Error("This member hasn't disclosed a pending charge on their current declaration.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.dispositionDate) || Number.isNaN(Date.parse(params.dispositionDate))) throw new Error("Enter the date of the disposition.");
  if (params.dispositionDate > new Date().toISOString().slice(0, 10)) throw new Error("The disposition date can't be in the future.");
  const offenseKey = params.outcome === "convicted" ? params.offenseKey : null;
  if (params.outcome === "convicted" && !OFFENSES.some((o) => o.key === offenseKey)) throw new Error("For a conviction, choose the offense it was for.");
  const { error } = await db.from("charge_dispositions").insert({
    account_member_id: m.id,
    buyer_account_id: m.buyer_account_id,
    declaration_id: decl.id,
    outcome: params.outcome,
    offense_key: offenseKey,
    disposition_date: params.dispositionDate,
    recorded_by: params.adminId,
  });
  if (error) throw new Error(MISSING_SCHEMA);
  await adminAudit(db, params.adminId, "eligibility.disposition_recorded", m.buyer_account_id, { account_member_id: m.id, declaration_id: decl.id, outcome: params.outcome, offense_key: offenseKey, disposition_date: params.dispositionDate });
  return recomputeEligibility(db, { memberId: m.id, actorId: null, trigger: "disposition_recorded" });
}

/** Members with an unresolved possible sanctions match. */
export async function listPossibleMatches(db: Db) {
  const { data, error } = await db.from("member_sanctions_screenings").select("*");
  if (error) throw new Error(MISSING_SCHEMA);
  const rows = (data ?? []) as Array<{ id: string; account_member_id: string; buyer_account_id: string; status: SanctionsStatus; list_name: string | null; matched_name: string | null; created_at: string }>;
  const out: Array<{ screeningId: string; memberId: string; accountId: string; fullName: string; listName: string | null; matchedName: string | null; since: string }> = [];
  for (const id of new Set(rows.map((r) => r.account_member_id))) {
    const last = byTime(rows.filter((r) => r.account_member_id === id)).at(-1)!;
    if (last.status !== "possible_match") continue;
    const m = await member(db, id);
    out.push({ screeningId: last.id, memberId: id, accountId: last.buyer_account_id, fullName: m.full_name ?? "", listName: last.list_name, matchedName: last.matched_name, since: last.created_at });
  }
  return out;
}

/** The only question: is the member the person the list names? Answered against the documents already held. */
export async function resolvePossibleMatch(db: Db, params: { adminId: string; memberId: string; screeningId: string; samePerson: boolean }) {
  const m = await member(db, params.memberId);
  const last = await latestSanctions(db, m.id);
  if (!last || last.id !== params.screeningId || last.status !== "possible_match") throw new Error("This possible match was already resolved. Reload the page.");
  const status: SanctionsStatus = params.samePerson ? "confirmed_match" : "clear";
  await db.from("member_sanctions_screenings").insert({
    account_member_id: m.id,
    buyer_account_id: m.buyer_account_id,
    provider: "identity_resolution",
    status,
    list_name: last.list_name,
    matched_name: last.matched_name,
    resolves_id: last.id,
    resolved_by: params.adminId,
  });
  await adminAudit(db, params.adminId, "eligibility.sanctions_identity_resolved", m.buyer_account_id, { account_member_id: m.id, screening_id: last.id, same_person: params.samePerson });
  return recomputeEligibility(db, { memberId: m.id, actorId: null, trigger: "sanctions_identity_resolved" });
}

async function accountHasClosed(db: Db, accountId: string): Promise<boolean> {
  const { data: res } = await db.from("pod_reservations").select("property_id, status").eq("buyer_account_id", accountId);
  const ids = [...new Set(((res ?? []) as Array<{ property_id: string; status: string }>).filter((r) => r.status !== "cancelled").map((r) => r.property_id))];
  if (ids.length === 0) return false;
  const { data: props } = await db.from("properties").select("id, deed_recorded_at").in("id", ids);
  return ((props ?? []) as Array<{ deed_recorded_at: string | null }>).some((p) => Boolean(p.deed_recorded_at));
}

/** Part F. Sets the member to not eligible (through the engine), audits it, and after closing flags the account for legal review. */
export async function markDeclarationUntrue(db: Db, params: { adminId: string; memberId: string; finding: string }) {
  const finding = params.finding.trim();
  if (!finding) throw new Error("Describe what was found untrue.");
  const m = await member(db, params.memberId);
  const { data: decls } = await db.from("eligibility_declarations").select("id, account_member_id, status, answers, declared_at").eq("account_member_id", m.id);
  const list = (decls ?? []) as DeclRow[];
  const decl = list.find((d) => d.status === "complete") ?? list.find((d) => d.status === "incomplete") ?? null;
  if (!decl) throw new Error("This member has no declaration to find untrue.");
  const afterClosing = await accountHasClosed(db, m.buyer_account_id);
  const { error } = await db.from("declaration_untrue_findings").insert({ account_member_id: m.id, buyer_account_id: m.buyer_account_id, declaration_id: decl.id, finding: finding.slice(0, 2000), after_closing: afterClosing, recorded_by: params.adminId });
  if (error) throw new Error(MISSING_SCHEMA);
  if (afterClosing) {
    await db.from("buyer_accounts").update({ legal_review_flagged_at: new Date().toISOString(), legal_review_reason: "declaration_found_untrue_after_closing" }).eq("id", m.buyer_account_id);
  }
  await adminAudit(db, params.adminId, "eligibility.declaration_marked_untrue", m.buyer_account_id, { account_member_id: m.id, declaration_id: decl.id, after_closing: afterClosing, legal_review_flagged: afterClosing });
  const outcome = await recomputeEligibility(db, { memberId: m.id, actorId: null, trigger: "declaration_marked_untrue" });
  return { ...outcome, legalReviewFlagged: afterClosing };
}

/** Admin view: every member's current result and the facts behind it. */
export async function adminEligibility(db: Db, accountIds: string[]) {
  const out: Record<string, { result: EligibilityResult; reason_codes: string[] } | null> = {};
  for (const id of accountIds) Object.assign(out, await currentResults(db, id));
  return out;
}

export { type Disposition };
