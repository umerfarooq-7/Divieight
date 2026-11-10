/**
 * Liveness (server side). A member-level step after the member's ID scan: the acting member's
 * selfie is checked against their ID document by the liveness vendor (getLivenessAdapter), and
 * every attempt is kept in member_liveness_checks.
 *
 * - passed: the member's liveness is done; once every member has their identity in and has
 *   passed, the account moves on to the persona survey.
 * - inconclusive: a Verification Request is issued (the existing flow) and the account stays pending.
 * - failed: that member is not eligible, and can't retry on their own; other members are unaffected.
 */

import { identityComplete } from "@/lib/account-members";
import { requireActingMember, type RequestContext } from "@/lib/account-members.server";
import { DEFAULT_LIVENESS_PROVIDER, getLivenessAdapter, type ForcedLivenessOutcome } from "@/lib/liveness-adapters";
import { canAttemptLiveness, latestLiveness, type LivenessRow, type LivenessStatus } from "@/lib/liveness";

type Db = { from: (t: string) => any };

const TABLE = "member_liveness_checks";
const MISSING_SCHEMA = "Database is missing liveness checks — run member-liveness.sql in Supabase.";
export const LIVENESS_TEST_SWITCH_KEY = "liveness_simulation";

async function attempts(db: Db, memberId: string): Promise<LivenessRow[]> {
  const { data, error } = await db.from(TABLE).select("id, account_member_id, status, reason_code, checked_at, created_at").eq("account_member_id", memberId);
  if (error) throw new Error(MISSING_SCHEMA);
  return (data ?? []) as LivenessRow[];
}

/** The QA test switch, set by an admin. Only the simulated vendor honours it. */
export async function readLivenessTestSwitch(db: Db): Promise<ForcedLivenessOutcome> {
  const { data } = await db.from("platform_settings").select("value").eq("key", LIVENESS_TEST_SWITCH_KEY).maybeSingle();
  const forced = (data?.value as { forced?: unknown } | null)?.forced;
  return forced === "passed" || forced === "failed" || forced === "inconclusive" ? forced : null;
}

export async function setLivenessTestSwitch(db: Db, params: { adminUserId: string; forced: ForcedLivenessOutcome }) {
  await db.from("platform_settings").upsert({ key: LIVENESS_TEST_SWITCH_KEY, value: { forced: params.forced }, updated_at: new Date().toISOString(), updated_by: params.adminUserId }, { onConflict: "key" });
  await db.from("audit_log").insert({
    actor_id: params.adminUserId,
    actor_type: "admin",
    action_type: "admin.liveness_test_switch_set",
    entity_type: "platform_settings",
    entity_id: null,
    metadata: { key: LIVENESS_TEST_SWITCH_KEY, forced: params.forced },
  });
  return { forced: params.forced };
}

export interface LivenessState {
  latest: LivenessRow | null;
  attempts: number;
  /** The member has uploaded their ID photo (the liveness check compares against it). */
  hasIdDocument: boolean;
  canAttempt: boolean;
}

export async function livenessState(db: Db, params: { userId: string; actingMemberId: string }): Promise<LivenessState> {
  const { member } = await requireActingMember(db, params.userId, params.actingMemberId);
  const rows = await attempts(db, member.id);
  const latest = latestLiveness(rows, member.id);
  return { latest, attempts: rows.length, hasIdDocument: Boolean(member.id_document_url), canAttempt: canAttemptLiveness(latest?.status) };
}

/** Who on the account still has a step before the persona survey, and which one. */
async function stillToGo(db: Db, accountId: string): Promise<Array<{ memberId: string; name: string; step: "identity" | "liveness" }>> {
  const { data: members } = await db.from("account_members").select("*").eq("buyer_account_id", accountId).eq("status", "active");
  const { data: rows } = await db.from(TABLE).select("account_member_id, status, created_at").eq("buyer_account_id", accountId);
  const all = (rows ?? []) as Array<{ account_member_id: string; status: LivenessStatus; created_at: string }>;
  const out: Array<{ memberId: string; name: string; step: "identity" | "liveness" }> = [];
  for (const m of (members ?? []) as Array<{ id: string; full_name: string | null; role: string; address: string | null; date_of_birth: string | null; id_document_url: string | null }>) {
    const name = m.full_name?.trim() || (m.role === "primary" ? "the account holder" : "the second member");
    if (!identityComplete(m) || !m.id_document_url) out.push({ memberId: m.id, name, step: "identity" });
    else if (latestLiveness(all, m.id)?.status !== "passed") out.push({ memberId: m.id, name, step: "liveness" });
  }
  return out;
}

export async function runLivenessCheck(
  db: Db,
  params: { userId: string; actingMemberId: string; selfiePath: string; selfieFileName: string; contentType: string | null; request: RequestContext },
): Promise<{ id: string; status: LivenessStatus; reason_code: string | null; waitingOn: Array<{ memberId: string; name: string; step: "identity" | "liveness" }>; advanced: boolean }> {
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);
  if (!member.id_document_url || !identityComplete(member)) throw new Error("Upload this member's ID photo in the identity step first.");
  // The selfie must be one this buyer uploaded, into their own folder.
  if (!params.selfiePath.startsWith(`${params.userId}/`) || params.selfiePath.includes("..")) throw new Error("That selfie isn't one you uploaded.");

  const previous = latestLiveness(await attempts(db, member.id), member.id);
  if (previous?.status === "passed") throw new Error("This member's liveness is already confirmed.");
  if (previous?.status === "failed") throw new Error("This member's liveness check failed. divieight needs to review it before another attempt.");

  const provider = DEFAULT_LIVENESS_PROVIDER;
  const { data: row, error } = await db
    .from(TABLE)
    .insert({
      account_member_id: member.id,
      buyer_account_id: account.id,
      id_document_ref: member.id_document_url,
      selfie_url: params.selfiePath,
      provider,
      status: "pending",
      reason_code: null,
      checked_at: null,
    })
    .select("id")
    .single();
  if (error || !row) throw new Error(MISSING_SCHEMA);
  const id = (row as { id: string }).id;

  const adapter = getLivenessAdapter(provider, { forced: await readLivenessTestSwitch(db) });
  let result: { status: LivenessStatus; reason_code: string | null };
  try {
    result = await adapter.check({ storagePath: params.selfiePath, fileName: params.selfieFileName, contentType: params.contentType }, member.id_document_url);
  } catch {
    // The vendor didn't answer: that is inconclusive, never a pass.
    result = { status: "inconclusive", reason_code: "provider_error" };
  }
  if (result.status === "pending") result = { status: "inconclusive", reason_code: result.reason_code ?? "provider_pending" };
  if (result.status === "passed") result = { status: "passed", reason_code: null };

  await db.from(TABLE).update({ status: result.status, reason_code: result.reason_code, checked_at: new Date().toISOString() }).eq("id", id).eq("status", "pending");

  const meta = { account_member_id: member.id, acted_by_member_id: member.id, liveness_check_id: id, provider: adapter.provider, status: result.status, reason_code: result.reason_code, ip_address: params.request.ip, user_agent: params.request.userAgent };
  await db.from("audit_log").insert({ actor_id: params.userId, actor_type: "buyer", action_type: "buyer.liveness_checked", entity_type: "buyer_account", entity_id: account.id, metadata: meta });

  let advanced = false;
  if (result.status === "inconclusive") {
    // The existing Verification Request: the member and the account are held for review.
    await db.from("account_members").update({ vetting_status: "verification_pending" }).eq("id", member.id);
    await db.from("buyer_accounts").update({ onboarding_status: "verification_pending", last_activity_at: new Date().toISOString(), stall_warning_sent_at: null }).eq("id", account.id);
    await db.from("audit_log").insert({
      actor_id: params.userId,
      actor_type: "buyer",
      action_type: "buyer.verification_requested",
      entity_type: "buyer_account",
      entity_id: account.id,
      metadata: { member_id: member.id, reason: "liveness_inconclusive", liveness_check_id: id, acted_by_member_id: member.id },
    });
  }

  const waitingOn = await stillToGo(db, account.id);
  if (result.status === "passed" && waitingOn.length === 0) {
    const { data: acct } = await db.from("buyer_accounts").select("onboarding_status").eq("id", account.id).maybeSingle();
    if ((acct as { onboarding_status?: string } | null)?.onboarding_status === "not_started") {
      await db.from("buyer_accounts").update({ onboarding_status: "lifestyle_survey_pending", last_activity_at: new Date().toISOString(), stall_warning_sent_at: null }).eq("id", account.id);
      advanced = true;
    }
  }
  return { id, status: result.status, reason_code: result.reason_code, waitingOn, advanced };
}

/** The latest liveness status of each member (for eligibility and the Golden Ticket). Missing table: none. */
export async function livenessByMember(db: Db, accountId: string): Promise<Record<string, LivenessStatus>> {
  const { data, error } = await db.from(TABLE).select("account_member_id, status, created_at").eq("buyer_account_id", accountId);
  if (error) return {};
  const rows = (data ?? []) as Array<{ account_member_id: string; status: LivenessStatus; created_at: string }>;
  const out: Record<string, LivenessStatus> = {};
  for (const id of new Set(rows.map((r) => r.account_member_id))) out[id] = latestLiveness(rows, id)!.status;
  return out;
}

export async function adminLiveness(db: Db, accountIds: string[]) {
  if (accountIds.length === 0) return [];
  const { data, error } = await db.from(TABLE).select("id, account_member_id, buyer_account_id, provider, status, reason_code, checked_at, created_at").in("buyer_account_id", accountIds);
  if (error) return [];
  return (data ?? []) as Array<LivenessRow & { buyer_account_id: string; provider: string }>;
}
