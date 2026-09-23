/**
 * Entity Genesis — Stage 2: State Filing + EIN (Prompt 9).
 *
 * Runs only once the pod is Closing-Ready: retained seller shares + reserved
 * shares = 8/8 (the corrected pod arithmetic — never "8 buyers"). The Delaware
 * filing and EIN come through Stripe Atlas as a manual admin workflow; the
 * direct Delaware SOS + IRS EIN APIs are the later "at scale" path.
 *
 * Every Stage 2 event is written to audit_log under `entity.`.
 */
import { createHash } from "node:crypto";
import { deliver } from "@/lib/authorization.notify.server";
import {
  ATLAS_FEE_USD,
  executedOperatingAgreement,
  finalOperatingAgreement,
  type CapTableRow,
  type Stage2Signer,
  type TinMatchResult,
} from "@/lib/entity-genesis";

type Db = { from: (t: string) => any; storage?: any };

const BUCKET = "property-documents";

async function audit(db: Db, actorId: string | null, actionType: string, propertyId: string, metadata: Record<string, unknown> = {}) {
  await db.from("audit_log").insert({
    actor_id: actorId,
    actor_type: actorId ? "admin" : "system",
    action_type: `entity.${actionType}`,
    entity_type: "entity_genesis",
    entity_id: propertyId,
    metadata,
  });
}

export function sha256(text: string) {
  return `sha256_${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

async function genesis(db: Db, propertyId: string) {
  const { data } = await db.from("entity_genesis").select("*").eq("property_id", propertyId).maybeSingle();
  if (!data) throw new Error("Stage 1 (Digital Genesis) hasn't opened for this property yet.");
  return data as Record<string, any>;
}

async function update(db: Db, propertyId: string, patch: Record<string, unknown>) {
  const { error } = await db
    .from("entity_genesis")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("property_id", propertyId);
  if (error) throw new Error(error.message);
}

async function vault(
  db: Db,
  actorId: string | null,
  row: { propertyId: string; genesisId: string; documentType: string; title: string; fileUrl: string; contentHash?: string | null },
) {
  const { data, error } = await db
    .from("property_records_vault")
    .insert({
      property_id: row.propertyId,
      entity_genesis_id: row.genesisId,
      document_type: row.documentType,
      title: row.title,
      file_url: row.fileUrl,
      content_hash: row.contentHash ?? null,
      stored_by: actorId,
    })
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  await audit(db, actorId, "vault_document_stored", row.propertyId, {
    vault_id: data?.id ?? null,
    document_type: row.documentType,
    file_url: row.fileUrl,
  });
}

// ---------------------------------------------------------------------------
// Closing-Ready
// ---------------------------------------------------------------------------

/** Corrected pod arithmetic: retained (Hybrid Exit) + reserved shares. */
export async function podArithmetic(db: Db, propertyId: string) {
  const { data: property } = await db
    .from("properties")
    .select("id, exit_type, retained_shares, listing_status")
    .eq("id", propertyId)
    .maybeSingle();
  if (!property) throw new Error("Property not found");
  const retained = property.exit_type === "hybrid_exit" ? Math.max(0, Math.min(8, property.retained_shares ?? 0)) : 0;
  const { data: res } = await db
    .from("pod_reservations")
    .select("shares_reserved")
    .eq("property_id", propertyId)
    .eq("status", "reserved");
  const reserved = ((res ?? []) as Array<{ shares_reserved: number | null }>).reduce((s, r) => s + (r.shares_reserved ?? 0), 0);
  return { retained, reserved, total: retained + reserved, full: retained + reserved === 8, listingStatus: property.listing_status as string };
}

export async function markClosingReady(db: Db, actorId: string, propertyId: string) {
  const g = await genesis(db, propertyId);
  if (g.cap_table_locked_at) throw new Error("Already Closing-Ready — cap table is locked.");
  const pod = await podArithmetic(db, propertyId);
  if (!pod.full)
    throw new Error(
      `Not Closing-Ready: ${pod.retained} retained + ${pod.reserved} reserved = ${pod.total}/8 shares.`,
    );

  const { syncCapTable } = await import("@/lib/entity-genesis.server");
  await syncCapTable(db as never, { propertyId, actorId, reason: "closing_ready" });
  const now = new Date().toISOString();
  await update(db, propertyId, { closing_ready_at: now, cap_table_locked_at: now });
  await db.from("properties").update({ listing_status: "closing_ready" }).eq("id", propertyId);
  await audit(db, actorId, "closing_ready", propertyId, { retained: pod.retained, reserved: pod.reserved });
  await audit(db, actorId, "cap_table_locked", propertyId, { locked_at: now });
}

/**
 * Called by syncCapTable when holders change after the lock (e.g. a funding
 * Default before closing): Closing-Ready is revoked and the final OA must be
 * regenerated and re-signed. Prior signatures stay on file, pinned to the old
 * document hash, but no longer count.
 */
export async function unlockAfterCapTableChange(db: Db, propertyId: string, reason: string) {
  const { data: g } = await db
    .from("entity_genesis")
    .select("cap_table_locked_at, final_oa_status, final_oa_hash")
    .eq("property_id", propertyId)
    .maybeSingle();
  if (!g?.cap_table_locked_at) return false;
  await update(db, propertyId, {
    closing_ready_at: null,
    cap_table_locked_at: null,
    final_oa_status: "not_started",
    final_oa_text: null,
    final_oa_hash: null,
    final_oa_generated_at: null,
  });
  await db
    .from("properties")
    .update({ listing_status: "forming" })
    .eq("id", propertyId)
    .eq("listing_status", "closing_ready");
  await audit(db, null, "cap_table_unlocked", propertyId, {
    reason,
    previous_final_oa_status: g.final_oa_status,
    superseded_oa_hash: g.final_oa_hash ?? null,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Stripe Atlas → Delaware filing → EIN → IRS TIN Matching
// ---------------------------------------------------------------------------

function requireClosingReady(g: Record<string, any>) {
  if (!g.cap_table_locked_at) throw new Error("Stage 2 opens only at Closing-Ready (8/8 shares, cap table locked).");
}

export async function requestAtlas(db: Db, actorId: string, propertyId: string, reference: string | null) {
  const g = await genesis(db, propertyId);
  requireClosingReady(g);
  if (g.atlas_request_status !== "not_requested") throw new Error("Stripe Atlas was already requested for this LLC.");
  await update(db, propertyId, {
    atlas_request_status: "requested",
    atlas_requested_at: new Date().toISOString(),
    atlas_reference: reference,
    atlas_fee: ATLAS_FEE_USD,
  });
  await audit(db, actorId, "atlas_requested", propertyId, {
    vendor: "stripe_atlas",
    fee_usd: ATLAS_FEE_USD,
    includes: ["delaware_filing", "ein"],
    reference,
  });
}

export async function markStateFiled(db: Db, actorId: string, propertyId: string) {
  const g = await genesis(db, propertyId);
  if (g.atlas_request_status === "not_requested") throw new Error("Request the filing through Stripe Atlas first.");
  if (g.state_filing_status !== "pending") throw new Error("The Delaware filing is already marked filed.");
  const now = new Date().toISOString();
  await update(db, propertyId, { state_filing_status: "filed", filed_at: now });
  await audit(db, actorId, "state_filed", propertyId, { filed_at: now, via: "stripe_atlas" });
}

async function maybeCompleteAtlas(db: Db, actorId: string, propertyId: string) {
  const g = await genesis(db, propertyId);
  if (g.state_filing_status === "confirmed" && g.ein_status !== "pending" && g.atlas_request_status === "requested") {
    await update(db, propertyId, { atlas_request_status: "completed", atlas_completed_at: new Date().toISOString() });
    await audit(db, actorId, "atlas_completed", propertyId, {});
  }
}

export async function confirmStateFiling(
  db: Db,
  actorId: string,
  propertyId: string,
  input: { llcName: string; delawareFileNumber: string; certificateFileUrl: string; certificateHash?: string | null },
) {
  const g = await genesis(db, propertyId);
  if (g.state_filing_status !== "filed") throw new Error("Mark the filing as filed before confirming it.");
  const now = new Date().toISOString();
  await update(db, propertyId, {
    state_filing_status: "confirmed",
    state_confirmed_at: now,
    stage: "state_filed",
    llc_name: input.llcName,
    delaware_file_number: input.delawareFileNumber,
  });
  await vault(db, actorId, {
    propertyId,
    genesisId: g.id,
    documentType: "certificate_of_formation",
    title: `Certificate of Formation — ${input.llcName}`,
    fileUrl: input.certificateFileUrl,
    contentHash: input.certificateHash,
  });
  await audit(db, actorId, "state_filing_confirmed", propertyId, {
    llc_name: input.llcName,
    previous_llc_name: g.llc_name,
    delaware_file_number: input.delawareFileNumber,
  });
  await maybeCompleteAtlas(db, actorId, propertyId);
}

export const EIN_PATTERN = /^\d{2}-\d{7}$/;

export async function recordEin(
  db: Db,
  actorId: string,
  propertyId: string,
  input: { ein: string; confirmationFileUrl: string; confirmationHash?: string | null },
) {
  const g = await genesis(db, propertyId);
  requireClosingReady(g);
  if (!EIN_PATTERN.test(input.ein)) throw new Error("EIN must look like 12-3456789.");
  if (g.ein_status !== "pending") throw new Error("An EIN is already recorded for this LLC.");
  const now = new Date().toISOString();
  await update(db, propertyId, { ein: input.ein, ein_status: "issued", ein_issued_at: now });
  await vault(db, actorId, {
    propertyId,
    genesisId: g.id,
    documentType: "ein_confirmation",
    title: `IRS EIN confirmation (${input.ein})`,
    fileUrl: input.confirmationFileUrl,
    contentHash: input.confirmationHash,
  });
  await audit(db, actorId, "ein_issued", propertyId, { ein_last4: input.ein.slice(-4) });
  await maybeCompleteAtlas(db, actorId, propertyId);
}

/**
 * IRS TIN Matching result, entered manually for now.
 * TODO(irs-tin-matching): replace the manual entry with the IRS TIN Matching
 * API once the e-Services account is approved (5–10 business days). Until a
 * 'match' is recorded, every LLC financial transaction stays blocked.
 */
export async function recordTinMatch(db: Db, actorId: string, propertyId: string, result: TinMatchResult) {
  const g = await genesis(db, propertyId);
  if (g.ein_status === "pending") throw new Error("Record the EIN before TIN matching.");
  const now = new Date().toISOString();
  await update(db, propertyId, {
    tin_match_result: result,
    tin_checked_at: now,
    ...(result === "match" ? { ein_status: "verified", tin_verified_at: now } : { ein_status: "issued", tin_verified_at: null }),
  });
  await audit(db, actorId, "tin_match_recorded", propertyId, {
    result,
    source: "manual_entry_pending_irs_api",
    llc_financials_unblocked: result === "match",
  });
}

// ---------------------------------------------------------------------------
// Final Operating Agreement — Platform-Native Signing, all members in parallel
// ---------------------------------------------------------------------------

async function lockedCapTable(db: Db, propertyId: string): Promise<CapTableRow[]> {
  const { data } = await db
    .from("cap_table_entries")
    .select("share_number, holder_type, buyer_account_id, seller_id, account_member_names, acquisition_date, retention_lock_expires_at")
    .eq("property_id", propertyId)
    .order("share_number", { ascending: true });
  return ((data ?? []) as any[]).map((r) => ({
    shareNumber: r.share_number,
    holderType: r.holder_type,
    buyerAccountId: r.buyer_account_id,
    sellerId: r.seller_id,
    memberNames: r.account_member_names ?? [],
    acquisitionDate: new Date(r.acquisition_date).toISOString(),
    retentionLockExpiresAt: new Date(r.retention_lock_expires_at).toISOString(),
  }));
}

/** Every Account Member of every Buyer Account on the locked cap table. */
export async function oaSigners(db: Db, propertyId: string): Promise<Stage2Signer[]> {
  const cap = await lockedCapTable(db, propertyId);
  const accounts = [...new Set(cap.map((c) => c.buyerAccountId).filter(Boolean))] as string[];
  if (accounts.length === 0) return [];
  const { data } = await db
    .from("account_members")
    .select("id, buyer_account_id, full_name")
    .in("buyer_account_id", accounts);
  return ((data ?? []) as Array<{ id: string; buyer_account_id: string; full_name: string | null }>)
    .map((m) => ({ buyerAccountId: m.buyer_account_id, accountMemberId: m.id, name: (m.full_name ?? "").trim() || "Account Member" }))
    .sort((a, b) => accounts.indexOf(a.buyerAccountId) - accounts.indexOf(b.buyerAccountId));
}

export async function generateFinalOa(db: Db, actorId: string, propertyId: string) {
  const g = await genesis(db, propertyId);
  requireClosingReady(g);
  if (g.state_filing_status !== "confirmed")
    throw new Error("Confirm the Delaware filing first, so the executed agreement carries the filed LLC name.");
  if (g.final_oa_status === "executed") throw new Error("The Operating Agreement is already executed.");

  const { data: property } = await db.from("properties").select("address, city, state, zip").eq("id", propertyId).maybeSingle();
  const signers = await oaSigners(db, propertyId);
  if (signers.length === 0) throw new Error("No Buyer Account members on the locked cap table.");
  const text = finalOperatingAgreement({
    llcName: g.llc_name,
    delawareFileNumber: g.delaware_file_number ?? null,
    ein: g.ein ?? null,
    property,
    capTable: await lockedCapTable(db, propertyId),
    signers,
    lockedAt: g.cap_table_locked_at,
  });
  const hash = sha256(text);
  await update(db, propertyId, {
    final_oa_status: "awaiting_signatures",
    final_oa_text: text,
    final_oa_hash: hash,
    final_oa_generated_at: new Date().toISOString(),
  });
  await audit(db, actorId, "final_oa_generated", propertyId, { document_hash: hash, signers_required: signers.length });

  const accountIds = [...new Set(signers.map((s) => s.buyerAccountId))];
  const { data: buyers } = await db.from("buyer_accounts").select("id, auth_user_id, email").in("id", accountIds);
  for (const b of (buyers ?? []) as Array<{ auth_user_id: string; email: string | null }>)
    await deliver(
      db,
      { authUserId: b.auth_user_id, email: b.email },
      {
        subject: "Sign your LLC Operating Agreement",
        message: `The Operating Agreement for ${g.llc_name} is final and ready for signature. Each member of your Buyer Account signs; all Buyer Accounts sign in parallel, in no particular order.`,
        link: "/buyer/operating-agreement",
        type: "entity",
      },
    );
  return { hash, signers: signers.length };
}

export interface SignOaInput {
  propertyId: string;
  accountMemberId: string;
  signedName: string;
  documentHash: string;
  secondaryVerificationMethod: string;
  ipAddress: string | null;
  deviceFingerprint: string | null;
}

export async function signOperatingAgreement(db: Db, authUserId: string, buyerAccountId: string, input: SignOaInput) {
  const g = await genesis(db, input.propertyId);
  if (g.final_oa_status !== "awaiting_signatures") throw new Error("This Operating Agreement is not open for signature.");
  if (input.documentHash !== g.final_oa_hash)
    throw new Error("The agreement changed since you opened it — reload and review the current version.");

  const signers = await oaSigners(db, input.propertyId);
  const me = signers.find((s) => s.accountMemberId === input.accountMemberId && s.buyerAccountId === buyerAccountId);
  if (!me) throw new Error("This member is not a signer on this Operating Agreement.");
  if (input.signedName.trim().toLowerCase() !== me.name.toLowerCase())
    throw new Error(`Type the member's full legal name exactly: ${me.name}`);

  const { error } = await db.from("operating_agreement_signatures").insert({
    entity_genesis_id: g.id,
    property_id: input.propertyId,
    buyer_account_id: buyerAccountId,
    account_member_id: me.accountMemberId,
    signed_name: input.signedName.trim(),
    document_hash: g.final_oa_hash,
    secondary_verification_method: input.secondaryVerificationMethod,
    ip_address: input.ipAddress,
    device_fingerprint: input.deviceFingerprint,
    signed_at: new Date().toISOString(),
  });
  if (error) throw new Error(/duplicate/i.test(error.message) ? "This member has already signed." : error.message);
  await db.from("audit_log").insert({
    actor_id: authUserId,
    actor_type: "buyer",
    action_type: "entity.oa_signed",
    entity_type: "entity_genesis",
    entity_id: input.propertyId,
    metadata: {
      buyer_account_id: buyerAccountId,
      account_member_id: me.accountMemberId,
      document_hash: g.final_oa_hash,
      ip_address: input.ipAddress,
      secondary_verification_method: input.secondaryVerificationMethod,
    },
  });

  const { data: sigs } = await db
    .from("operating_agreement_signatures")
    .select("account_member_id, signed_name, signed_at")
    .eq("entity_genesis_id", g.id)
    .eq("document_hash", g.final_oa_hash);
  const signed = (sigs ?? []) as Array<{ account_member_id: string; signed_name: string; signed_at: string }>;
  const outstanding = signers.filter((s) => !signed.some((x) => x.account_member_id === s.accountMemberId));
  if (outstanding.length > 0) return { executed: false, outstanding: outstanding.length };

  await executeOa(db, g, signers, signed);
  return { executed: true, outstanding: 0 };
}

async function executeOa(
  db: Db,
  g: Record<string, any>,
  signers: Stage2Signer[],
  signed: Array<{ account_member_id: string; signed_at: string }>,
) {
  const executed = executedOperatingAgreement(
    g.final_oa_text,
    signers.map((s) => ({
      name: s.name,
      signedAt: signed.find((x) => x.account_member_id === s.accountMemberId)!.signed_at,
      hash: g.final_oa_hash,
    })),
  );
  const path = `entity-genesis/${g.property_id}/executed-operating-agreement-${String(g.final_oa_hash).slice(7, 19)}.md`;
  try {
    await db.storage?.from(BUCKET).upload(path, new Blob([executed], { type: "text/markdown" }), {
      upsert: true,
      contentType: "text/markdown",
    });
  } catch {
    // The vault row still records the executed hash; the file can be regenerated.
  }
  const now = new Date().toISOString();
  await update(db, g.property_id, { final_oa_status: "executed", executed_oa_url: path, oa_executed_at: now });
  await vault(db, null, {
    propertyId: g.property_id,
    genesisId: g.id,
    documentType: "executed_operating_agreement",
    title: `Executed Operating Agreement — ${g.llc_name}`,
    fileUrl: path,
    contentHash: sha256(executed),
  });
  await audit(db, null, "oa_executed", g.property_id, { signers: signers.length, signed_document_hash: g.final_oa_hash });

  const accountIds = [...new Set(signers.map((s) => s.buyerAccountId))];
  const { data: buyers } = await db.from("buyer_accounts").select("auth_user_id, email").in("id", accountIds);
  for (const b of (buyers ?? []) as Array<{ auth_user_id: string; email: string | null }>)
    await deliver(
      db,
      { authUserId: b.auth_user_id, email: b.email },
      {
        subject: "Operating Agreement executed",
        message: `Every member has signed. The Operating Agreement for ${g.llc_name} is executed and stored in the Property Records Vault.`,
        link: "/buyer/operating-agreement",
        type: "entity",
      },
    );
}

// ---------------------------------------------------------------------------
// LLC financial gate
// ---------------------------------------------------------------------------

/** No financial transaction involving the LLC until IRS TIN Matching says 'match'. */
export async function llcTinGate(db: Db, propertyId: string) {
  const { data: g } = await db
    .from("entity_genesis")
    .select("ein, ein_status, tin_match_result")
    .eq("property_id", propertyId)
    .maybeSingle();
  if (g?.tin_match_result === "match") return { ok: true, message: "LLC EIN verified by IRS TIN Matching." };
  const why = !g?.ein
    ? "the LLC has no EIN yet"
    : g.tin_match_result
      ? `IRS TIN Matching returned "${g.tin_match_result}"`
      : "IRS TIN Matching hasn't confirmed the EIN yet";
  return { ok: false, message: `LLC financial transactions are blocked: ${why}.` };
}

export async function assertLlcFinancialsAllowed(db: Db, propertyId: string, action: string) {
  const gate = await llcTinGate(db, propertyId);
  if (!gate.ok) {
    await audit(db, null, "llc_financial_blocked", propertyId, { action, reason: gate.message });
    throw new Error(gate.message);
  }
}
