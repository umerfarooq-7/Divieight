/**
 * PII encryption (server only). AES-256-GCM with the key in W9_TIN_ENCRYPTION_KEY (32 bytes,
 * base64). There is no plaintext fallback: without a valid key, nothing is encrypted or saved.
 *
 * The key is never logged and plaintext never leaves the function that needs it.
 * key_version lets the key be rotated later: new rows use currentKeyVersion(), and decryption
 * picks the key for the row's version.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { noteDecrypt } from "@/lib/pii-access.server";

/**
 * The key version new values are sealed with. Rotation needs no deploy of code: add W9_TIN_ENCRYPTION_KEY_V2 and set PII_KEY_VERSION=2. Values sealed under an earlier
 * version keep decrypting with that version's key until scripts/rotate-pii-keys.mjs re-seals them.
 */
export function currentKeyVersion(): number {
  const v = Number(process.env.PII_KEY_VERSION ?? 1);
  return Number.isInteger(v) && v >= 1 ? v : 1;
}

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super("W-9 can't be saved: the TIN encryption key isn't configured on the server (W9_TIN_ENCRYPTION_KEY).");
    this.name = "MissingEncryptionKeyError";
  }
}

function keyFor(version: number): Buffer {
  // Rotation: W9_TIN_ENCRYPTION_KEY_V2, _V3… can be added; version 1 is the base variable.
  const raw = version === 1 ? process.env.W9_TIN_ENCRYPTION_KEY : process.env[`W9_TIN_ENCRYPTION_KEY_V${version}`];
  if (!raw) throw new MissingEncryptionKeyError();
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new MissingEncryptionKeyError();
  return key;
}

/** Throws MissingEncryptionKeyError when the key is absent or not 32 bytes. */
export function assertEncryptionKey(): void {
  keyFor(currentKeyVersion());
}

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  auth_tag: string;
  key_version: number;
}

export function encryptPii(plaintext: string, aad: string): EncryptedValue {
  const key = keyFor(currentKeyVersion());
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // The row's identity is bound in as associated data: a ciphertext moved to another row won't decrypt.
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), auth_tag: cipher.getAuthTag().toString("base64"), key_version: currentKeyVersion() };
}

/** Throws when the ciphertext, iv, tag or associated data were altered. */
export function decryptPii(value: EncryptedValue, aad: string): string {
  // A TIN decrypted outside a declared, audited rule raises a Suspicious Activity Alert (pii-access.server.ts).
  noteDecrypt(aad);
  const decipher = createDecipheriv("aes-256-gcm", keyFor(value.key_version), Buffer.from(value.iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(value.auth_tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

/**
 * The one decryption for an LLC's bank-feed item reference (llc_plaid_consents.plaid_item_ref). Bound to its property: a
 * reference moved to another property won't decrypt. Used only by the bank feed job.
 */
export function decryptBankItemRef(value: EncryptedValue, propertyId: string): string {
  return decryptPii(value, `llc_plaid:${propertyId}`);
}
