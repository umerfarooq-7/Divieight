/**
 * Retention Lock enforcement and its exceptions (server side). Only reads the
 * lock dates on cap_table_entries; the closing saga decides when a lock starts.
 * Retained-seller shares follow the same rules as buyer shares. Unanimous-consent
 * requests run on the normal owner votes. Every step goes to the audit log.
 */

import { adminRecipients, deliver } from "@/lib/authorization.notify.server";
import { formatDate } from "@/lib/format-date";
import {
  isOwnRetentionDocPath,
  lockDaysRemaining,
  RETENTION_EXCEPTION_LABELS,
  retentionVoteTitle,
  type RetentionExceptionStatus,
  type RetentionExceptionType,
} from "@/lib/retention";
import { cancelVote, closeVote, createVote, holderFor, openVote, type VoteRow } from "@/lib/votes.server";
import { DEFAULT_VOTE_OPTIONS } from "@/lib/votes";
import { loadGovernanceConfig } from "@/lib/governance-config.server";

type Db = { from: (t: string) => any };

export interface RetentionExceptionRow {
  id: string;
  property_id: string;
  share_number: number;
  requested_by_user_id: string;
  exception_type: RetentionExceptionType;
  reason: string;
  supporting_doc_url: string | null;
  status: RetentionExceptionStatus;
  vote_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

interface CapShare {
  holder_type: string;
  buyer_account_id: string | null;
  seller_id: string | null;
  retention_lock_started_at: string | null;
  retention_lock_expires_at: string;
}

export type ShareLock =
  | { issued: false }
  | { issued: true; locked: boolean; startedAt: string | null; expiresAt: string; exceptionApproved: boolean };

async function holderUserId(db: Db, share: CapShare): Promise<string | null> {
  if (share.holder_type === "retained_seller") return share.seller_id;
  if (!share.buyer_account_id) return null;
  const { data } = await db.from("buyer_accounts").select("auth_user_id").eq("id", share.buyer_account_id).maybeSingle();
  return (data?.auth_user_id as string | undefined) ?? null;
}

/**
 * Same rule as is_share_locked in retention-lock.sql: locked until the expiry date
 * unless the current holder has an approved exception. If exceptions can't be
 * read the share stays locked.
 */
export async function shareLock(db: Db, propertyId: string, shareNumber: number): Promise<ShareLock> {
  const { data } = await db
    .from("cap_table_entries")
    .select("holder_type, buyer_account_id, seller_id, retention_lock_started_at, retention_lock_expires_at")
    .eq("property_id", propertyId)
    .eq("share_number", shareNumber)
    .maybeSingle();
  const share = data as CapShare | null;
  if (!share) return { issued: false };
  const userId = await holderUserId(db, share);
  const { data: approved } = userId
    ? await db
        .from("retention_exceptions")
        .select("id")
        .eq("property_id", propertyId)
        .eq("share_number", shareNumber)
        .eq("status", "approved")
        .eq("requested_by_user_id", userId)
        .limit(1)
    : { data: [] };
  const exceptionApproved = (approved ?? []).length > 0;
  return {
    issued: true,
    locked: Date.now() < new Date(share.retention_lock_expires_at).getTime() && !exceptionApproved,
    startedAt: share.retention_lock_started_at ?? null,
    expiresAt: share.retention_lock_expires_at,
    exceptionApproved,
  };
}

/**
 * Call this from the Resale Shop before creating a listing. Throws unless this
 * user holds the share and its Retention Lock no longer applies.
 */
export async function assertShareListable(db: Db, params: { userId: string; propertyId: string; shareNumber: number }): Promise<void> {
  const holder = await holderFor(db, params.userId, params.propertyId);
  if (!holder?.shareNumbers.includes(params.shareNumber)) throw new Error("You don't hold that share.");
  await settleVoteExceptions(db, params.propertyId);
  const lock = await shareLock(db, params.propertyId, params.shareNumber);
  if (!lock.issued) throw new Error("You don't hold that share.");
  if (lock.locked) {
    await db.from("audit_log").insert({
      actor_id: params.userId,
      actor_type: holder.type,
      action_type: "retention_lock.listing_blocked",
      entity_type: "cap_table_entry",
      entity_id: params.propertyId,
      metadata: { property_id: params.propertyId, share_number: params.shareNumber, unlocks_at: lock.expiresAt },
    });
    throw new Error(`Share #${params.shareNumber} is under the 12-month Retention Lock until ${formatDate(lock.expiresAt)}.`);
  }
}

async function audit(
  db: Db,
  params: { actorId: string | null; actorType: string; action: string; row: Pick<RetentionExceptionRow, "id" | "property_id" | "share_number" | "exception_type">; extra?: Record<string, unknown> },
) {
  await db.from("audit_log").insert({
    actor_id: params.actorId,
    actor_type: params.actorType,
    action_type: params.action,
    entity_type: "retention_exception",
    entity_id: params.row.id,
    metadata: {
      property_id: params.row.property_id,
      share_number: params.row.share_number,
      exception_type: params.row.exception_type,
      at: new Date().toISOString(),
      ...params.extra,
    },
  });
}

/** Tell the requester and every admin. */
async function notifyBoth(db: Db, row: RetentionExceptionRow, subject: string, message: string) {
  const { data: buyer } = await db.from("buyer_accounts").select("email").eq("auth_user_id", row.requested_by_user_id).maybeSingle();
  await deliver(db as never, { authUserId: row.requested_by_user_id, email: (buyer?.email as string | null) ?? null }, {
    subject,
    message,
    link: `/owner/properties/${row.property_id}/retention`,
    type: "retention_exception_update",
    propertyId: row.property_id,
    dedupeKey: `retention:${row.id}:${subject}`,
  });
  for (const admin of await adminRecipients(db as never)) {
    await deliver(db as never, admin, { subject, message, link: "/admin/retention-exceptions", type: "retention", propertyId: row.property_id });
  }
}

/** Decide a pending request exactly once: false if something else already decided it. */
async function settle(
  db: Db,
  row: Pick<RetentionExceptionRow, "id">,
  patch: { status: RetentionExceptionStatus; decided_by: string | null; decision_note: string | null },
): Promise<RetentionExceptionRow | null> {
  const { data } = await db
    .from("retention_exceptions")
    .update({ ...patch, decided_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  return (data as RetentionExceptionRow) ?? null;
}

/**
 * Apply a finished vote to the request it was opened for: passed approves,
 * anything else rejects. Votes with no linked pending request are left alone.
 */
export async function applyVoteOutcome(db: Db, vote: Pick<VoteRow, "id" | "status" | "result_summary">): Promise<void> {
  const closed = vote.status === "closed" && vote.result_summary;
  if (!closed && vote.status !== "cancelled") return;
  const { data } = await db.from("retention_exceptions").select("id").eq("vote_id", vote.id).eq("status", "pending").maybeSingle();
  if (!data) return;
  const passed = Boolean(closed && vote.result_summary!.passed);
  const note = passed ? "The unanimous vote passed." : vote.status === "cancelled" ? "The vote was cancelled." : "The unanimous vote did not pass.";
  const row = await settle(db, data as { id: string }, { status: passed ? "approved" : "rejected", decided_by: null, decision_note: note });
  if (!row) return;
  await audit(db, { actorId: null, actorType: "system", action: passed ? "retention_exception.approved" : "retention_exception.rejected", row, extra: { vote_id: vote.id } });
  await notifyBoth(
    db,
    row,
    passed ? "Retention Lock released" : "Retention Lock release not approved",
    passed
      ? `The vote passed: share #${row.share_number} is released from the Retention Lock.`
      : `Share #${row.share_number} stays under the Retention Lock. ${note}`,
  );
}

/** Close overdue release votes and decide their requests. Safe to repeat. */
export async function settleVoteExceptions(db: Db, propertyId?: string): Promise<number> {
  let query = db.from("retention_exceptions").select("id, vote_id").eq("status", "pending").eq("exception_type", "unanimous_consent");
  if (propertyId) query = query.eq("property_id", propertyId);
  const { data, error } = await query;
  if (error) return 0; // before retention-lock.sql is run
  let settled = 0;
  for (const row of (data ?? []) as Array<{ id: string; vote_id: string | null }>) {
    if (!row.vote_id) continue;
    const { data: found } = await db.from("votes").select("*").eq("id", row.vote_id).maybeSingle();
    const vote = found as VoteRow | null;
    if (!vote) continue;
    const overdue = vote.status === "open" && Date.now() >= new Date(vote.closes_at).getTime();
    const interrupted = vote.status === "closed" && !vote.result_summary;
    if (overdue || interrupted) await closeVote(db, vote.id, { id: null, type: "system" });
    else await applyVoteOutcome(db, vote);
    const { data: after } = await db.from("retention_exceptions").select("status").eq("id", row.id).maybeSingle();
    if (after?.status !== "pending") settled += 1;
  }
  return settled;
}

export interface OwnerRetentionShare {
  shareNumber: number;
  locked: boolean;
  /** False until closing starts the lock; the date is provisional until then. */
  started: boolean;
  expiresAt: string;
  daysRemaining: number;
  exceptionApproved: boolean;
  canRequest: boolean;
  requests: Array<{
    id: string;
    exceptionType: RetentionExceptionType;
    reason: string;
    status: RetentionExceptionStatus;
    voteId: string | null;
    hasDocument: boolean;
    decisionNote: string | null;
    decidedAt: string | null;
    createdAt: string;
  }>;
}

export async function ownerRetention(db: Db, userId: string, propertyId: string): Promise<{ allowed: boolean; shares: OwnerRetentionShare[]; voteDays?: number }> {
  const holder = await holderFor(db, userId, propertyId);
  if (!holder) return { allowed: false, shares: [] };
  const voteDays = (await loadGovernanceConfig(db)).retentionReleaseVoteDays;
  await settleVoteExceptions(db, propertyId);
  const { data } = await db
    .from("retention_exceptions")
    .select("*")
    .eq("property_id", propertyId)
    .eq("requested_by_user_id", userId)
    .order("created_at", { ascending: false });
  const mine = (data ?? []) as RetentionExceptionRow[];
  const shares: OwnerRetentionShare[] = [];
  for (const shareNumber of holder.shareNumbers) {
    const lock = await shareLock(db, propertyId, shareNumber);
    if (!lock.issued) continue;
    const requests = mine.filter((r) => r.share_number === shareNumber);
    shares.push({
      shareNumber,
      locked: lock.locked,
      started: Boolean(lock.startedAt),
      expiresAt: lock.expiresAt,
      daysRemaining: lock.locked ? lockDaysRemaining(lock.expiresAt) : 0,
      exceptionApproved: lock.exceptionApproved,
      canRequest: lock.locked && !requests.some((r) => r.status === "pending"),
      requests: requests.map((r) => ({
        id: r.id,
        exceptionType: r.exception_type,
        reason: r.reason,
        status: r.status,
        voteId: r.vote_id,
        hasDocument: Boolean(r.supporting_doc_url),
        decisionNote: r.decision_note,
        decidedAt: r.decided_at,
        createdAt: r.created_at,
      })),
    });
  }
  return { allowed: true, shares, voteDays };
}

export async function requestException(
  db: Db,
  params: { userId: string; propertyId: string; shareNumber: number; exceptionType: RetentionExceptionType; reason: string; supportingDocUrl: string | null },
): Promise<{ error?: string; id?: string; voteId?: string }> {
  const holder = await holderFor(db, params.userId, params.propertyId);
  if (!holder) return { error: "You don't have ownership in that property." };
  if (!holder.shareNumbers.includes(params.shareNumber)) return { error: "You don't hold that share." };
  const lock = await shareLock(db, params.propertyId, params.shareNumber);
  if (!lock.issued || !lock.locked) return { error: "This share isn't under the Retention Lock." };
  if (params.supportingDocUrl && !isOwnRetentionDocPath(params.supportingDocUrl, params.userId, params.propertyId))
    return { error: "That document couldn't be attached. Upload it again." };

  const pendingMessage = "This share already has a request in progress.";
  const { data: pending } = await db
    .from("retention_exceptions")
    .select("id")
    .eq("property_id", params.propertyId)
    .eq("share_number", params.shareNumber)
    .eq("status", "pending")
    .maybeSingle();
  if (pending) return { error: pendingMessage };

  const { data, error } = await db
    .from("retention_exceptions")
    .insert({
      property_id: params.propertyId,
      share_number: params.shareNumber,
      requested_by_user_id: params.userId,
      exception_type: params.exceptionType,
      reason: params.reason,
      supporting_doc_url: params.supportingDocUrl,
      status: "pending",
    })
    .select("*")
    .maybeSingle();
  if (error?.code === "23505") return { error: pendingMessage };
  if (error || !data) return { error: "Requests aren't available yet. Please try again later." };
  const row = data as RetentionExceptionRow;
  await audit(db, { actorId: params.userId, actorType: holder.type, action: "retention_exception.requested", row, extra: { has_document: Boolean(params.supportingDocUrl) } });

  let voteId: string | undefined;
  if (params.exceptionType === "unanimous_consent") {
    try {
      const now = Date.now();
      const vote = await createVote(db, {
        actorId: params.userId,
        actorType: holder.type,
        propertyId: params.propertyId,
        title: retentionVoteTitle(params.shareNumber),
        description: params.reason,
        voteType: "unanimous",
        options: DEFAULT_VOTE_OPTIONS,
        opensAt: new Date(now).toISOString(),
        closesAt: new Date(now + (await loadGovernanceConfig(db)).retentionReleaseVoteDays * 86_400_000).toISOString(),
      });
      voteId = vote.id;
      await db.from("retention_exceptions").update({ vote_id: vote.id }).eq("id", row.id);
      await openVote(db, params.userId, vote.id, holder.type);
    } catch {
      await settle(db, row, { status: "withdrawn", decided_by: null, decision_note: "The vote could not be opened." });
      await audit(db, { actorId: null, actorType: "system", action: "retention_exception.withdrawn", row, extra: { reason: "vote_not_opened" } });
      return { error: "The vote couldn't be opened. Please try again." };
    }
    await audit(db, { actorId: params.userId, actorType: holder.type, action: "retention_exception.vote_opened", row, extra: { vote_id: voteId } });
  }

  await notifyBoth(
    db,
    row,
    "Retention Lock exception requested",
    `${RETENTION_EXCEPTION_LABELS[params.exceptionType]} request received for share #${params.shareNumber}.${
      voteId ? " Every issued share must vote Yes, including yours." : " The divieight Manager will review it."
    }`,
  );
  return { id: row.id, voteId };
}

export async function withdrawException(db: Db, userId: string, exceptionId: string): Promise<{ error?: string }> {
  const { data } = await db.from("retention_exceptions").select("*").eq("id", exceptionId).maybeSingle();
  const found = data as RetentionExceptionRow | null;
  if (!found || found.requested_by_user_id !== userId) return { error: "This request isn't available." };
  await settleVoteExceptions(db, found.property_id); // a vote that already ended decides it
  const row = await settle(db, found, { status: "withdrawn", decided_by: userId, decision_note: null });
  if (!row) return { error: "This request has already been decided." };
  if (row.vote_id) {
    await cancelVote(db, userId, row.vote_id, "owner").catch(() => undefined); // it may have closed just now
  }
  await audit(db, { actorId: userId, actorType: "owner", action: "retention_exception.withdrawn", row });
  await notifyBoth(db, row, "Retention Lock request withdrawn", `The request for share #${row.share_number} was withdrawn.`);
  return {};
}

// ---------------------------------------------------------------------------
// Admin (divieight as Manager)
// ---------------------------------------------------------------------------

export interface AdminRetentionException {
  id: string;
  propertyId: string;
  propertyLabel: string;
  shareNumber: number;
  requester: string;
  exceptionType: RetentionExceptionType;
  reason: string;
  status: RetentionExceptionStatus;
  documentUrl: string | null;
  voteId: string | null;
  lockExpiresAt: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export async function adminRetentionExceptions(db: Db): Promise<{ rows: AdminRetentionException[] }> {
  await settleVoteExceptions(db);
  const { data, error } = await db.from("retention_exceptions").select("*").order("created_at", { ascending: false });
  if (error) throw new Error("Database is missing retention_exceptions — run retention-lock.sql in Supabase.");
  const rows = (data ?? []) as RetentionExceptionRow[];
  const bucket = (db as any).storage?.from("property-documents");
  const out: AdminRetentionException[] = [];
  for (const r of rows) {
    const { data: p } = await db.from("properties").select("address, city, state").eq("id", r.property_id).maybeSingle();
    const { data: buyer } = await db.from("buyer_accounts").select("email").eq("auth_user_id", r.requested_by_user_id).maybeSingle();
    const lock = await shareLock(db, r.property_id, r.share_number);
    const signed = r.supporting_doc_url ? await bucket?.createSignedUrl(r.supporting_doc_url, 3600) : null;
    out.push({
      id: r.id,
      propertyId: r.property_id,
      propertyLabel: p ? [p.address, p.city, p.state].filter(Boolean).join(", ") : "Property",
      shareNumber: r.share_number,
      requester: (buyer?.email as string | undefined) ?? "Retained seller",
      exceptionType: r.exception_type,
      reason: r.reason,
      status: r.status,
      documentUrl: signed?.data?.signedUrl ?? null,
      voteId: r.vote_id,
      lockExpiresAt: lock.issued ? lock.expiresAt : null,
      decisionNote: r.decision_note,
      decidedAt: r.decided_at,
      createdAt: r.created_at,
    });
  }
  out.sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
  return { rows: out };
}

/** Hardship only: a unanimous-consent request is decided by its vote. */
export async function decideHardship(db: Db, params: { adminId: string; exceptionId: string; decision: "approved" | "rejected"; note: string }) {
  const { data } = await db.from("retention_exceptions").select("*").eq("id", params.exceptionId).maybeSingle();
  const found = data as RetentionExceptionRow | null;
  if (!found) throw new Error("Request not found");
  if (found.exception_type !== "hardship") throw new Error("A unanimous-consent request is decided by its vote.");
  const row = await settle(db, found, { status: params.decision, decided_by: params.adminId, decision_note: params.note });
  if (!row) throw new Error("This request has already been decided.");
  await audit(db, { actorId: params.adminId, actorType: "admin", action: `retention_exception.${params.decision}`, row, extra: { decision_note: params.note } });
  await notifyBoth(
    db,
    row,
    params.decision === "approved" ? "Retention Lock released" : "Retention Lock exception rejected",
    params.decision === "approved"
      ? `The hardship request was approved: share #${row.share_number} is released from the Retention Lock. Note: ${params.note}`
      : `The hardship request for share #${row.share_number} was rejected. Note: ${params.note}`,
  );
}
