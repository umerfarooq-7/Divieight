/**
 * Hybrid Exit sellers' eligibility declaration (Module 1A): a seller who retains shares goes through
 * the same Block 4 flow every buyer does (same six questions, same typed-name signature, same
 * versioned and hashed record). Full Exit sellers have no eligibility check.
 *
 * The engine's rules are applied to the seller's answers. A seller's liveness and sanctions screening
 * aren't built yet, so a seller whose answers raise nothing has no result yet (pending), never "eligible".
 */
import { getLiveStandard } from "@/lib/standard-version.server";
import { type RequestContext } from "@/lib/account-members.server";
import { declarationStatusFor, declarationText, legalNamesMatch, NAME_MISMATCH_MESSAGE, type DeclarationAnswers } from "@/lib/eligibility-declaration";
import { SELLER_DECLARATION_MISSING_MESSAGE, SELLER_NOT_ELIGIBLE_MESSAGE } from "@/constants/eligibilityCheckCopy";
import { evaluateEligibility, HELD_BUYER_TEXT, type Evaluation } from "@/lib/eligibility-engine";
import { loadGovernanceConfig } from "@/lib/governance-config.server";
import { sha256 } from "@/lib/entity-genesis-stage2.server";

type Db = { from: (t: string) => any };

const TABLE = "seller_eligibility_declarations";
const MISSING_SCHEMA = "Database is missing seller eligibility declarations — run eligibility-wording.sql in Supabase.";
export const FULL_EXIT_NO_CHECK = "Full Exit sellers have no eligibility check.";

interface SellerRow {
  id: string;
  full_name: string | null;
  address: string | null;
  date_of_birth: string | null;
  exit_type: string | null;
}

export interface SellerDeclarationRecord {
  id: string;
  seller_id: string;
  status: "incomplete" | "complete" | "superseded";
  answers: DeclarationAnswers;
  declared_at: string;
  signed_name: string;
  standard_version: string;
  declaration_hash: string;
}

async function seller(db: Db, userId: string): Promise<SellerRow> {
  const { data } = await db.from("sellers").select("id, full_name, address, date_of_birth, exit_type").eq("id", userId).maybeSingle();
  if (!data) throw new Error("No seller account");
  return data as SellerRow;
}

/** Only a seller who retains shares goes through the eligibility check. */
export const requiresEligibilityCheck = (s: { exit_type: string | null }) => s.exit_type === "hybrid_exit";

const identityOn = (s: SellerRow) => Boolean(s.full_name?.trim() && s.address?.trim() && s.date_of_birth);

function evaluate(s: SellerRow, answers: DeclarationAnswers | null, declaredAt: string): Evaluation {
  return evaluateEligibility(answers, {
    identityComplete: identityOn(s),
    liveness: null,
    sanctions: null,
    declarationFoundUntrue: false,
    disposition: null,
    appliedAt: declaredAt,
  });
}


/**
 * Whether the seller's eligibility result stops their listing being published. Only when the setting is on
 * (gateListingOnSellerEligibility, off by default), only for a seller who retains shares, and only when their result
 * isn't 'eligible'. A held seller is told it is held, in the same words a held buyer reads.
 */
export async function sellerListingGate(db: Db, sellerId: string): Promise<{ blocked: boolean; held: boolean; message: string | null }> {
  const open = { blocked: false, held: false, message: null };
  if ((await loadGovernanceConfig(db)).gateListingOnSellerEligibility !== 1) return open;
  let state: Awaited<ReturnType<typeof sellerEligibilityState>>;
  try {
    state = await sellerEligibilityState(db, sellerId);
  } catch {
    return open; // no seller record to judge: the setting never blocks on a missing table
  }
  if (!state.required || state.result === "eligible") return open;
  if (state.result === "held") return { blocked: true, held: true, message: HELD_BUYER_TEXT };
  if (state.result === "not_eligible") return { blocked: true, held: false, message: SELLER_NOT_ELIGIBLE_MESSAGE };
  // No result yet. A seller has no liveness or sanctions step, so those pending items don't count against them: only a
  // declaration that hasn't been made (or isn't complete) does.
  const undeclared = state.reasonCodes.some((c) => ["declaration_missing", "q5_authorization_not_given", "q6_undertaking_not_given"].includes(c));
  return undeclared ? { blocked: true, held: false, message: SELLER_DECLARATION_MISSING_MESSAGE } : open;
}

export async function sellerEligibilityState(db: Db, userId: string) {
  const s = await seller(db, userId);
  const gatesListing = (await loadGovernanceConfig(db)).gateListingOnSellerEligibility === 1;
  if (!requiresEligibilityCheck(s)) return { gatesListing, required: false as const, standardVersion: null, current: null, history: 0, verifiedName: null, result: null, reasonCodes: [] as string[], message: FULL_EXIT_NO_CHECK };
  const { data, error } = await db.from(TABLE).select("*").eq("seller_id", s.id);
  if (error) throw new Error(MISSING_SCHEMA);
  const rows = (data ?? []) as SellerDeclarationRecord[];
  const current = rows.find((r) => r.status === "complete" || r.status === "incomplete") ?? null;
  const e = current ? evaluate(s, current.answers, current.declared_at) : { result: null, reason_codes: ["declaration_missing"] };
  const standardVersion = (await getLiveStandard(db)).version;
  return { gatesListing, required: true as const, standardVersion, current, history: rows.length, verifiedName: identityOn(s) ? (s.full_name ?? "").trim() : null, result: e.result, reasonCodes: e.reason_codes, message: null };
}

export async function submitSellerDeclaration(
  db: Db,
  params: { userId: string; answers: DeclarationAnswers; attestedPersonally: boolean; signedName: string; supersedesId: string | null; request: RequestContext },
) {
  const s = await seller(db, params.userId);
  if (!requiresEligibilityCheck(s)) throw new Error(FULL_EXIT_NO_CHECK);
  await (await import("@/lib/standard-rules-check.server")).assertStandardRules(db);
  if (params.attestedPersonally !== true) throw new Error("Confirm that you are personally making this declaration.");
  if (!identityOn(s)) throw new Error("Finish the identity step first, so the signature can be checked against your ID.");
  const signedName = params.signedName.trim();
  if (!legalNamesMatch(signedName, s.full_name ?? "")) throw new Error(NAME_MISMATCH_MESSAGE);

  const { data: existing, error: readError } = await db.from(TABLE).select("id, status").eq("seller_id", s.id);
  if (readError) throw new Error(MISSING_SCHEMA);
  const now = ((existing ?? []) as Array<{ id: string; status: string }>).find((r) => r.status === "complete" || r.status === "incomplete") ?? null;
  if ((now?.id ?? null) !== (params.supersedesId ?? null)) throw new Error(now ? "This declaration was already corrected. Reload the page to see the latest one." : "There is no earlier declaration to correct.");

  const standardVersion = (await getLiveStandard(db)).version;
  const status = declarationStatusFor(params.answers);
  const text = declarationText(params.answers, standardVersion);
  const hash = sha256(text);
  const declaredAt = new Date().toISOString();
  const { data, error } = await db
    .from(TABLE)
    .insert({
      seller_id: s.id,
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
  if (error || !data) throw new Error(error?.code === "23505" ? "This declaration was already corrected. Reload the page to see the latest one." : MISSING_SCHEMA);
  if (now) await db.from(TABLE).update({ status: "superseded" }).eq("id", now.id).in("status", ["incomplete", "complete"]);

  const e = evaluate(s, params.answers, declaredAt);
  await db.from("audit_log").insert({
    actor_id: params.userId,
    actor_type: "seller",
    action_type: status === "complete" ? "seller.eligibility_declaration_made" : "seller.eligibility_declaration_incomplete",
    entity_type: "seller",
    entity_id: s.id,
    metadata: { declaration_id: (data as { id: string }).id, standard_version: standardVersion, declaration_hash: hash, status, supersedes_id: now?.id ?? null, result: e.result, reason_codes: e.reason_codes, ip_address: params.request.ip, user_agent: params.request.userAgent },
  });
  return { id: (data as { id: string }).id, status, declarationHash: hash, result: e.result, reasonCodes: e.reason_codes };
}
