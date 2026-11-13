/**
 * Prompt 14 on a real Postgres (PGlite): acknowledgment-posture.sql exactly as written, on a minimal stand-in for the tables it depends on.
 * Re-triggers and posture records are immutable; the Manager alone reads them; the server (service role) can write them.
 * Skips when PGlite is not installed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

type Db = { exec: (sql: string) => Promise<unknown>; query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, any>> }> };
let pg: Db | null = null;
try {
  const specifier = "@electric-sql/pglite";
  const { PGlite } = (await import(/* @vite-ignore */ specifier)) as { PGlite: new () => Db };
  pg = new PGlite();
} catch {
  pg = null;
}

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = U(1);
const MEMBER = U(2);
const ok = async (sql: string, params?: unknown[]) => (await pg!.query(sql, params)).rows;
const fails = async (sql: string, params?: unknown[]) => {
  try {
    await pg!.query(sql, params);
    return "";
  } catch (e) {
    return (e as { message?: string }).message ?? "failed";
  }
};
const asRole = async <T>(role: string, uid: string | null, fn: () => Promise<T>) => {
  await pg!.exec(`SELECT set_config('test.uid', '${uid ?? ""}', false); SET ROLE ${role};`);
  try {
    return await fn();
  } finally {
    await pg!.exec("RESET ROLE");
  }
};

const run = pg ? describe : describe.skip;

run("acknowledgment-posture.sql", () => {
  let property = "";
  beforeAll(async () => {
    await pg!.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
      END $$;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
      CREATE OR REPLACE FUNCTION public.has_role(u uuid, r text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT u = '${ADMIN}'::uuid AND r = 'admin' $$;
      CREATE TABLE IF NOT EXISTS public.properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
      GRANT SELECT ON public.properties TO authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION public.has_role(uuid, text) TO anon, authenticated, service_role;
    `);
    const sql = readFileSync("acknowledgment-posture.sql", "utf8");
    await pg!.exec(sql);
    await pg!.exec(sql); // safe to run again
    property = (await ok("INSERT INTO properties DEFAULT VALUES RETURNING id"))[0]!.id as string;
  });

  const retrigger = (doc: string, kind = "new_required_document") =>
    ok("INSERT INTO diligence_retriggers (property_id, document_id, kind, document_title, content_hash) VALUES ($1, $2, $3, 'Roof Report', 'h') RETURNING id", [property, doc, kind]);

  it("the server records a re-trigger, once per document, and it can never be edited or deleted", async () => {
    await asRole("service_role", null, async () => {
      await retrigger(U(100));
      expect(await fails("INSERT INTO diligence_retriggers (property_id, document_id, kind, document_title, content_hash) VALUES ($1, $2, 'new_version', 'x', 'h')", [property, U(100)])).toMatch(/duplicate|unique/i);
      expect(await fails("INSERT INTO diligence_retriggers (property_id, document_id, kind, document_title, content_hash) VALUES ($1, $2, 'bogus', 'x', 'h')", [property, U(101)])).toMatch(/check/i);
    });
    expect(await fails("UPDATE diligence_retriggers SET document_title = 'changed'")).toMatch(/never edited or deleted|permission/i);
    expect(await fails("DELETE FROM diligence_retriggers")).toMatch(/never edited or deleted|permission/i);
  });

  it("a posture record is hashed, versioned, and immutable; only its vault link is set, once", async () => {
    const id = await asRole("service_role", null, async () => {
      const r = await ok("INSERT INTO acknowledgment_posture_records (property_id, version, content_hash, data, hash) VALUES ($1, 1, 'c1', '{\"a\":1}'::jsonb, 'h1') RETURNING id", [property]);
      expect(await fails("INSERT INTO acknowledgment_posture_records (property_id, version, content_hash, data, hash) VALUES ($1, 1, 'c2', '{}'::jsonb, 'h2')", [property])).toMatch(/duplicate|unique/i);
      return r[0]!.id as string;
    });
    // The superuser (the table owner) is bound by the guard too.
    expect(await fails("UPDATE acknowledgment_posture_records SET data = '{\"a\":2}'::jsonb WHERE id = $1", [id])).toMatch(/immutable/i);
    expect(await fails("UPDATE acknowledgment_posture_records SET hash = 'other' WHERE id = $1", [id])).toMatch(/immutable/i);
    expect(await fails("DELETE FROM acknowledgment_posture_records WHERE id = $1", [id])).toMatch(/never deleted/i);
    expect(await fails("UPDATE acknowledgment_posture_records SET vault_document_id = $2 WHERE id = $1", [id, U(500)])).toBe("");
    expect(await fails("UPDATE acknowledgment_posture_records SET vault_document_id = $2 WHERE id = $1", [id, U(501)])).toMatch(/fixed once/i);
  });

  it("only the Manager reads them; a member and anon see nothing", async () => {
    expect(await asRole("authenticated", ADMIN, async () => (await ok("SELECT id FROM acknowledgment_posture_records")).length)).toBe(1);
    expect(await asRole("authenticated", ADMIN, async () => (await ok("SELECT id FROM diligence_retriggers")).length)).toBe(1);
    expect(await asRole("authenticated", MEMBER, async () => (await ok("SELECT id FROM acknowledgment_posture_records")).length)).toBe(0);
    expect(await asRole("authenticated", MEMBER, async () => (await ok("SELECT id FROM diligence_retriggers")).length)).toBe(0);
    expect(await asRole("authenticated", MEMBER, async () => fails("INSERT INTO diligence_retriggers (property_id, document_id, kind, document_title, content_hash) VALUES ($1, $2, 'new_version', 'x', 'h')", [property, U(300)]))).toMatch(/permission|policy/i);
    expect(await asRole("anon", null, async () => fails("SELECT id FROM acknowledgment_posture_records"))).toMatch(/permission/i);
  });
});
