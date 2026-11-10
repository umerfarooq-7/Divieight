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
 * The one place a TIN is decrypted: tax exports (Month 6), for admin/finance only (checked by the
 * caller). Every call is audited with who, when and why — but never with the TIN.
 */
export async function decryptTinForTaxExport(db: Db, params: { actorId: string; w9Id: string; reason: string }): Promise<string> {
  const reason = params.reason.trim();
  if (!reason) throw new Error("Give the reason for decrypting this TIN.");
  const { data, error } = await db.from("member_w9_tin_secrets").select("w9_id, ciphertext, iv, auth_tag, key_version").eq("w9_id", params.w9Id).maybeSingle();
  if (error || !data) throw new Error("No TIN on file for that W-9.");
  await db.from("audit_log").insert({
    actor_id: params.actorId,
    actor_type: "admin",
    action_type: "admin.w9_tin_decrypted",
    entity_type: "member_w9",
    entity_id: params.w9Id,
    metadata: { w9_id: params.w9Id, reason: reason.slice(0, 500), at: new Date().toISOString() },
  });
  return decryptPii(data as { ciphertext: string; iv: string; auth_tag: string; key_version: number }, `member_w9:${params.w9Id}`);
}
