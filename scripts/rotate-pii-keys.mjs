#!/usr/bin/env node
/**
 * Re-seal every encrypted value under the current key version (key rotation).
 *
 *   1. Generate a new key:        node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *   2. Set, in the environment:   W9_TIN_ENCRYPTION_KEY_V2=<the new key>   (keep W9_TIN_ENCRYPTION_KEY, the old one, for now)
 *                                 PII_KEY_VERSION=2                        (new values are sealed with version 2 from the next deploy)
 *   3. Dry run:                   node scripts/rotate-pii-keys.mjs
 *      Re-seal:                   node scripts/rotate-pii-keys.mjs --apply
 *   4. When it reports 0 values left on an old version, remove the old key from the environment.
 *
 * Needs SUPABASE_URL (or VITE_SUPABASE_URL) and the service-role key in SUPABASE_SERVICE_ROLE_KEY (or DB_SERVICE_ROLE_KEY). Never prints a key or a value.
 * Each value is bound to its row (the associated data), so one moved to another row would not decrypt: the script re-seals in place, row by row, and verifies each
 * result decrypts before it writes.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SECRET_TABLES = [
  { table: "member_w9_tin_secrets", key: "w9_id", aad: (id) => `member_w9:${id}` },
  { table: "broker_tax_form_secrets", key: "form_id", aad: (id) => `broker_tax_form:${id}` },
  { table: "influencer_payee_secrets", key: "payee_id", aad: (id) => `influencer_payee:${id}` },
];

export function keyFor(version, env = process.env) {
  const raw = version === 1 ? env.W9_TIN_ENCRYPTION_KEY : env[`W9_TIN_ENCRYPTION_KEY_V${version}`];
  if (!raw) throw new Error(`No key for version ${version}: set ${version === 1 ? "W9_TIN_ENCRYPTION_KEY" : `W9_TIN_ENCRYPTION_KEY_V${version}`}.`);
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new Error(`The key for version ${version} is not 32 bytes (base64).`);
  return key;
}

export function open(value, aad, env = process.env) {
  const d = createDecipheriv("aes-256-gcm", keyFor(value.key_version, env), Buffer.from(value.iv, "base64"));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(Buffer.from(value.auth_tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(value.ciphertext, "base64")), d.final()]).toString("utf8");
}

export function seal(plaintext, aad, version, env = process.env) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFor(version, env), iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), auth_tag: c.getAuthTag().toString("base64"), key_version: version };
}

/** One value to the target version. Returns null when it is already there. The new value is opened again before it is returned. */
export function reseal(value, aad, target, env = process.env) {
  if (value.key_version === target) return null;
  const plaintext = open(value, aad, env);
  const next = seal(plaintext, aad, target, env);
  if (open(next, aad, env) !== plaintext) throw new Error("A re-sealed value did not decrypt to the same text: nothing was written.");
  return next;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const target = Number(process.env.PII_KEY_VERSION ?? 1);
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.DB_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  keyFor(target); // fails early if the target key is missing
  const db = createClient(url, key, { auth: { persistSession: false } });
  let left = 0;
  let done = 0;
  for (const t of SECRET_TABLES) {
    const { data, error } = await db.from(t.table).select(`${t.key}, ciphertext, iv, auth_tag, key_version`);
    if (error) {
      console.log(`${t.table}: skipped (${error.message})`);
      continue;
    }
    for (const row of data ?? []) {
      const next = reseal(row, t.aad(row[t.key]), target);
      if (!next) continue;
      left += 1;
      if (!apply) continue;
      const { error: e } = await db.from(t.table).update(next).eq(t.key, row[t.key]);
      if (e) throw new Error(`${t.table} ${String(row[t.key]).slice(0, 8)}: ${e.message}`);
      done += 1;
    }
    console.log(`${t.table}: ${data?.length ?? 0} values`);
  }
  console.log(apply ? `Re-sealed ${done} value(s) under version ${target}.` : `${left} value(s) are on an older key. Run with --apply to re-seal them under version ${target}.`);
}

if (process.argv[1] && process.argv[1].endsWith("rotate-pii-keys.mjs")) main().catch((e) => (console.error(e.message), process.exit(1)));
