/**
 * Buyer W-9 (server side). Each Account Member completes their own, through the picker, and
 * signs with their typed full legal name, checked here against their account_members.full_name.
 *
 * The TIN is encrypted (AES-256-GCM, pii-crypto.server) into member_w9_tin_secrets, a table no
 * client role can read. Only the last four digits are ever returned. The TIN is never logged,
 * never put in an error message, and never written to the audit log.
 * A TIN match against the IRS is out of scope here (it exists for the LLC in Entity Genesis).
 */
import { randomUUID } from "node:crypto";
import { requireActingMember, type RequestContext } from "@/lib/account-members.server";
import { legalNamesMatch } from "@/lib/eligibility-declaration";
import { assertEncryptionKey, decryptPii, encryptPii } from "@/lib/pii-crypto.server";
import { TAX_CLASSIFICATIONS, normalizeTin, tinLast4, type TaxClassification, type TinKind } from "@/lib/w9";

type Db = { from: (t: string) => any };

const MISSING_SCHEMA = "Database is missing the W-9 tables — run member-steps.sql in Supabase.";
export const SIGNATURE_MISMATCH = "The signature must be this member's full legal name, exactly as it is on their account.";

export interface W9View {
  id: string;
  legal_name: string;
  tax_classification: TaxClassification;
  address: string;
  tin_kind: TinKind;
  tin_last4: string;
  signed_name: string;
  signed_at: string;
}

const PUBLIC_COLUMNS = "id, account_member_id, legal_name, tax_classification, address, tin_kind, tin_last4, signed_name, signed_at";

export async function myW9(db: Db, params: { userId: string; actingMemberId: string }): Promise<{ w9: W9View | null; memberName: string }> {
  const { member } = await requireActingMember(db, params.userId, params.actingMemberId);
  const { data, error } = await db.from("member_w9").select(PUBLIC_COLUMNS).eq("account_member_id", member.id).maybeSingle();
  if (error) throw new Error(MISSING_SCHEMA);
  return { w9: (data as W9View | null) ?? null, memberName: member.full_name ?? "" };
}

export async function submitW9(
  db: Db,
  params: {
    userId: string;
    actingMemberId: string;
    legalName: string;
    taxClassification: string;
    address: string;
    tinKind: TinKind;
    tin: string;
    signedName: string;
    request: RequestContext;
  },
): Promise<{ w9: W9View }> {
  // No key, no save: checked before anything is read or written.
  assertEncryptionKey();
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);

  const { data: existing, error: readError } = await db.from("member_w9").select("id").eq("account_member_id", member.id).maybeSingle();
  if (readError) throw new Error(MISSING_SCHEMA);
  if (existing) throw new Error("This member's W-9 is already on file.");

  const legalName = params.legalName.trim();
  const address = params.address.trim();
  if (!legalName) throw new Error("Enter the name shown on your tax return.");
  if (!address) throw new Error("Enter your address.");
  if (!TAX_CLASSIFICATIONS.some((c) => c.value === params.taxClassification)) throw new Error("Choose a federal tax classification.");
  if (params.tinKind !== "ssn" && params.tinKind !== "ein") throw new Error("Choose SSN or EIN.");
  const tin = normalizeTin(params.tin, params.tinKind);
  const signedName = params.signedName.trim();
  if (!legalNamesMatch(signedName, member.full_name ?? "")) throw new Error(SIGNATURE_MISMATCH);

  const id = randomUUID();
  const sealed = encryptPii(tin, `member_w9:${id}`);
  // The secret first: if the W-9 row then fails, an orphan ciphertext reveals nothing and blocks nothing.
  const { error: secretError } = await db.from("member_w9_tin_secrets").insert({ w9_id: id, account_member_id: member.id, ...sealed });
  if (secretError) throw new Error(MISSING_SCHEMA);
  const signedAt = new Date().toISOString();
  const { error } = await db.from("member_w9").insert({
    id,
    account_member_id: member.id,
    buyer_account_id: account.id,
    legal_name: legalName.slice(0, 200),
    tax_classification: params.taxClassification,
    address: address.slice(0, 500),
    tin_kind: params.tinKind,
    tin_last4: tinLast4(tin),
    signed_name: signedName,
    signed_at: signedAt,
    ip: params.request.ip,
    user_agent: params.request.userAgent,
  });
  if (error) throw new Error(error.code === "23505" ? "This member's W-9 is already on file." : MISSING_SCHEMA);

  await db.from("audit_log").insert({
    actor_id: params.userId,
    actor_type: "buyer",
    action_type: "buyer.w9_submitted",
    entity_type: "buyer_account",
    entity_id: account.id,
    // No TIN, not even its last four, in the audit trail.
    metadata: { w9_id: id, account_member_id: member.id, acted_by_member_id: member.id, tax_classification: params.taxClassification, tin_kind: params.tinKind, ip_address: params.request.ip, user_agent: params.request.userAgent },
  });
  return {
    w9: { id, legal_name: legalName, tax_classification: params.taxClassification as TaxClassification, address, tin_kind: params.tinKind, tin_last4: tinLast4(tin), signed_name: signedName, signed_at: signedAt },
  };
}

/**
 * The one place a TIN is decrypted: tax exports (Month 6), for admin/finance only (checked by the caller), and the designated CPA for
 * the LLC they are designated to (viewTinAsCpa below checks that). Every call is audited with who, when, why and, for a CPA, which
 * property: never with the TIN. The audit row is written first; if it can't be written nothing is decrypted.
 */
export async function decryptTinForTaxExport(db: Db, params: { actorId: string; w9Id: string; reason: string; actorType?: "admin" | "cpa"; propertyId?: string }): Promise<string> {
  const reason = params.reason.trim();
  if (!reason) throw new Error("Give the reason for decrypting this TIN.");
  const { data, error } = await db.from("member_w9_tin_secrets").select("w9_id, ciphertext, iv, auth_tag, key_version").eq("w9_id", params.w9Id).maybeSingle();
  if (error || !data) throw new Error("No TIN on file for that W-9.");
  const cpa = params.actorType === "cpa";
  const { error: auditError } = await db.from("audit_log").insert({
    actor_id: params.actorId,
    actor_type: cpa ? "cpa" : "admin",
    action_type: cpa ? "cpa.w9_tin_viewed" : "admin.w9_tin_decrypted",
    entity_type: "member_w9",
    entity_id: params.w9Id,
    metadata: { w9_id: params.w9Id, reason: reason.slice(0, 500), at: new Date().toISOString(), ...(params.propertyId ? { property_id: params.propertyId } : {}) },
  });
  if (auditError) throw new Error("The TIN can't be shown: the audit log could not be written.");
  return decryptPii(data as { ciphertext: string; iv: string; auth_tag: string; key_version: number }, `member_w9:${params.w9Id}`);
}

/** The permissible purpose for a CPA's TIN view. */
export const CPA_TIN_PURPOSE = "K-1 preparation (CPA permissible purpose)";

/** 123-45-6789 for an SSN, 12-3456789 for an EIN. */
export function formatTin(tin: string, kind: string): string {
  const d = tin.replace(/\D/g, "");
  if (d.length !== 9) return d;
  return kind === "ein" ? `${d.slice(0, 2)}-${d.slice(2)}` : `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

/**
 * The designated CPA views a member's TIN, for K-1 preparation. Allowed only for the property they are designated to and only a W-9 of a member
 * whose account holds shares in it (the database says so); every view is logged by the one decryption above, with the property. Whatever goes wrong,
 * the message never carries the TIN or anything about the ciphertext.
 */
export async function viewTinAsCpa(db: Db & { rpc: (fn: string, args: Record<string, unknown>) => any }, params: { userId: string; propertyId: string; w9Id: string; note?: string | null }): Promise<{ tin: string; legalName: string; tinKind: string }> {
  const { data: allowed } = await db.rpc("cpa_can_view_tin", { _user: params.userId, _property: params.propertyId, _w9: params.w9Id });
  if (allowed !== true) throw new Error("Not authorized");
  const { data: w9 } = await db.from("member_w9").select("legal_name, tin_kind").eq("id", params.w9Id).maybeSingle();
  if (!w9) throw new Error("Not authorized");
  try {
    const reason = params.note?.trim() ? `${CPA_TIN_PURPOSE}: ${params.note.trim().slice(0, 300)}` : CPA_TIN_PURPOSE;
    const tin = await decryptTinForTaxExport(db, { actorId: params.userId, w9Id: params.w9Id, reason, actorType: "cpa", propertyId: params.propertyId });
    return { tin: formatTin(tin, w9.tin_kind as string), legalName: w9.legal_name as string, tinKind: w9.tin_kind as string };
  } catch {
    throw new Error("The TIN could not be shown.");
  }
}
