/**
 * Know Your Owner (KYO) record (server side).
 *
 * Admin view: per Account Member, the eligibility result and the Participant Eligibility Standard
 * version it was determined against (from eligibility_results), and the declaration's hash, Standard
 * version and date. Member view: each member sees only their own KYO data (through the switcher) and
 * can request a correction. Nothing here changes the KYO retention periods, the PII Sub-Vault or the
 * Audit Vault; the PII itself is not copied into the record.
 *
 * Rev 49 counsel items D2(a)/D2(b): nothing here is, or may be, shown to a tethered agent. The agent-facing
 * Binary Vetting Result and KYO Access Controls wording is deliberately untouched and lives elsewhere.
 */
import { requireActingMember, type RequestContext } from "@/lib/account-members.server";
import { currentResultOf, type EligibilityResult } from "@/lib/eligibility-engine";
import { latestLiveness } from "@/lib/liveness";
import { isCorrectionField, type KyoDeclaration, type KyoEligibility, type MemberKyo } from "@/lib/kyo";

type Db = { from: (t: string) => any };

const MISSING_SCHEMA = "Database is missing the KYO correction table — run kyo-corrections.sql in Supabase.";

interface MemberRow {
  id: string;
  full_name: string | null;
  role: string;
  status: string;
  buyer_account_id: string;
  date_of_birth?: string | null;
  address?: string | null;
  id_document_number?: string | null;
  id_document_url?: string | null;
  email?: string | null;
  phone?: string | null;
}

const nameOf = (m: { full_name: string | null; role: string }) => m.full_name?.trim() || (m.role === "primary" ? "The account holder" : "The second member");

/** Builds one member's KYO from the declarations and the engine's result rows. */
async function buildKyo(db: Db, m: MemberRow): Promise<MemberKyo & { reasonCodes: string[] }> {
  const { data: decls } = await db.from("eligibility_declarations").select("id, status, standard_version, declared_at, declaration_hash").eq("account_member_id", m.id);
  const rows = ((decls ?? []) as Array<{ id: string; status: string; standard_version: string; declared_at: string; declaration_hash: string }>).filter((d) => d.status !== "legacy");
  const current = rows.find((d) => d.status === "complete") ?? rows.find((d) => d.status === "incomplete") ?? null;
  const { data: results } = await db.from("eligibility_results").select("account_member_id, declaration_id, determined_at, result, standard_version, reason_codes").eq("account_member_id", m.id);
  const cur = current?.status === "complete" ? currentResultOf((results ?? []) as Array<{ account_member_id: string; declaration_id: string; determined_at: string; result: EligibilityResult; standard_version: string; reason_codes: string[] }>, m.id, current.id) : null;
  const eligibility: KyoEligibility | null = cur ? { result: cur.result, standardVersion: cur.standard_version, determinedAt: cur.determined_at } : null;
  const declaration: KyoDeclaration | null = current
    ? { id: current.id, status: current.status as "incomplete" | "complete", standardVersion: current.standard_version, declaredAt: current.declared_at, declarationHash: current.declaration_hash, versions: rows.length }
    : null;
  return { memberId: m.id, name: nameOf(m), role: m.role, eligibility, declaration, reasonCodes: cur?.reason_codes ?? [] };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** Admin only (the caller checks the role). Reading it is logged. */
export async function adminKyo(db: Db, params: { adminId: string; accountId: string }) {
  const { data: members } = await db.from("account_members").select("id, full_name, role, status, buyer_account_id").eq("buyer_account_id", params.accountId);
  const active = ((members ?? []) as MemberRow[]).filter((m) => m.status === "active");
  const out = [];
  for (const m of active) out.push(await buildKyo(db, m));
  await db.from("audit_log").insert({ actor_id: params.adminId, actor_type: "admin", action_type: "kyo.viewed", entity_type: "buyer_account", entity_id: params.accountId, metadata: { members: active.map((m) => m.id) } });
  return out;
}

export async function listOpenCorrections(db: Db) {
  const { data, error } = await db.from("kyo_correction_requests").select("*").eq("status", "open");
  if (error) throw new Error(MISSING_SCHEMA);
  return ((data ?? []) as Array<{ id: string; account_member_id: string; buyer_account_id: string; field: string; requested_change: string; created_at: string }>).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

export async function resolveCorrection(db: Db, params: { adminId: string; requestId: string; note: string }) {
  const note = params.note.trim();
  if (!note) throw new Error("Say how it was handled.");
  const { data: r } = await db.from("kyo_correction_requests").select("id, status, account_member_id, buyer_account_id, field").eq("id", params.requestId).maybeSingle();
  const row = r as { id: string; status: string; account_member_id: string; buyer_account_id: string; field: string } | null;
  if (!row) throw new Error("Request not found");
  if (row.status !== "open") throw new Error("This request was already resolved.");
  const at = new Date().toISOString();
  const { error } = await db.from("kyo_correction_requests").update({ status: "resolved", resolution_note: note.slice(0, 2000), resolved_by: params.adminId, resolved_at: at }).eq("id", row.id).eq("status", "open");
  if (error) throw new Error(MISSING_SCHEMA);
  await db.from("audit_log").insert({ actor_id: params.adminId, actor_type: "admin", action_type: "kyo.correction_resolved", entity_type: "buyer_account", entity_id: row.buyer_account_id, metadata: { request_id: row.id, account_member_id: row.account_member_id, field: row.field } });
  return { resolvedAt: at };
}

// ---------------------------------------------------------------------------
// The member's own data and corrections
// ---------------------------------------------------------------------------

const last = (v: string | null | undefined, n: number) => (v ? `•••${v.slice(-n)}` : null);

/** Only the acting member's own KYO data. The other member's is never returned. */
export async function myKyo(db: Db, params: { userId: string; actingMemberId: string }) {
  const { member } = await requireActingMember(db, params.userId, params.actingMemberId);
  const m = member as MemberRow;
  const kyo = await buildKyo(db, m);
  const { data: live } = await db.from("member_liveness_checks").select("account_member_id, status, created_at").eq("account_member_id", m.id);
  const liveness = latestLiveness((live ?? []) as Array<{ account_member_id: string; status: string; created_at: string }>, m.id)?.status ?? null;
  const { data: w9 } = await db.from("member_w9").select("tin_kind, tin_last4, signed_at").eq("account_member_id", m.id).maybeSingle();
  const { data: reqs, error } = await db.from("kyo_correction_requests").select("id, field, requested_change, status, resolution_note, created_at, resolved_at").eq("account_member_id", m.id);
  return {
    memberId: m.id,
    name: kyo.name,
    // The result and the version of the Standard, the declaration's hash and date: the member's own record.
    eligibility: kyo.eligibility,
    declaration: kyo.declaration,
    held: kyo.eligibility?.result === "held",
    onFile: {
      fullName: m.full_name ?? null,
      dateOfBirth: m.date_of_birth ? "on file" : null,
      address: m.address ? "on file" : null,
      idDocumentNumber: last(m.id_document_number, 2),
      idImage: m.id_document_url ? "on file" : null,
      email: m.email ?? null,
      phone: m.phone ?? null,
      liveness,
      w9: w9 ? { kind: (w9 as { tin_kind: string }).tin_kind, last4: (w9 as { tin_last4: string }).tin_last4 } : null,
    },
    corrections: error ? [] : ((reqs ?? []) as Array<{ id: string; field: string; requested_change: string; status: string; resolution_note: string | null; created_at: string; resolved_at: string | null }>).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
  };
}

export async function requestCorrection(db: Db, params: { userId: string; actingMemberId: string; field: string; requestedChange: string; request: RequestContext }) {
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);
  if (!isCorrectionField(params.field)) throw new Error("Choose what you want corrected.");
  const change = params.requestedChange.trim();
  if (!change) throw new Error("Say what should be corrected.");
  const { data, error } = await db
    .from("kyo_correction_requests")
    .insert({ account_member_id: member.id, buyer_account_id: account.id, field: params.field, requested_change: change.slice(0, 2000), status: "open", ip: params.request.ip, user_agent: params.request.userAgent })
    .select("id")
    .single();
  if (error || !data) throw new Error(MISSING_SCHEMA);
  await db.from("audit_log").insert({
    actor_id: params.userId,
    actor_type: "buyer",
    action_type: "kyo.correction_requested",
    entity_type: "buyer_account",
    entity_id: account.id,
    // The requested change itself is not copied into the audit log: it may be the very PII being corrected.
    metadata: { request_id: (data as { id: string }).id, account_member_id: member.id, acted_by_member_id: member.id, field: params.field, ip_address: params.request.ip, user_agent: params.request.userAgent },
  });
  return { id: (data as { id: string }).id };
}
