/**
 * Document access on a real Postgres (PGlite): document-access.sql exactly as written.
 * One acknowledgment per member per document version; acknowledgments and executed texts are never edited or deleted; members and anon cannot touch them.
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
const ok = async (sql: string, params?: unknown[]) => (await pg!.query(sql, params)).rows;
const fails = async (sql: string, params?: unknown[]) => {
  try {
    await pg!.query(sql, params);
    return "";
  } catch (e) {
    return (e as { message?: string }).message ?? "failed";
  }
};
const asRole = async <T>(role: string, fn: () => Promise<T>) => {
  await pg!.exec(`SET ROLE ${role};`);
  try {
    return await fn();
  } finally {
    await pg!.exec("RESET ROLE");
  }
};

const run = pg ? describe : describe.skip;

run("document-access.sql", () => {
  beforeAll(async () => {
    await pg!.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    `);
    const sql = readFileSync("document-access.sql", "utf8");
    await pg!.exec(sql);
    await pg!.exec(sql); // safe to run again
  });

  const ack = (member: string, version = "v2", doc = "PRA") =>
    ok("INSERT INTO document_review_acknowledgments (account_member_id, buyer_account_id, document_type, document_version, document_hash) VALUES ($1, $2, $3, $4, 'h') RETURNING id", [member, U(900), doc, version]);

  it("one acknowledgment per member per document version; each member has their own", async () => {
    await asRole("service_role", async () => {
      await ack(U(1));
      await ack(U(2));
      expect(await fails("INSERT INTO document_review_acknowledgments (account_member_id, buyer_account_id, document_type, document_version, document_hash) VALUES ($1, $2, 'PRA', 'v2', 'h')", [U(1), U(900)])).toMatch(/duplicate|unique/i);
      await ack(U(1), "v3");
    });
  });

  it("an acknowledgment must record that the bottom was reached, and is never edited or deleted", async () => {
    expect(await fails("INSERT INTO document_review_acknowledgments (account_member_id, buyer_account_id, document_type, document_version, document_hash, reached_end) VALUES ($1, $2, 'PRA', 'v9', 'h', false)", [U(3), U(900)])).toMatch(/check/i);
    expect(await fails("UPDATE document_review_acknowledgments SET document_hash = 'x'")).toMatch(/never edited or deleted/);
    expect(await fails("DELETE FROM document_review_acknowledgments")).toMatch(/never edited or deleted/);
  });

  it("an executed text is written once per document hash, and never changed or removed", async () => {
    await asRole("service_role", async () => {
      await ok("INSERT INTO executed_document_texts (document_hash, document_type, document_version, body, body_sha256) VALUES ('hash-1', 'PRA', 'v2', 'THE TEXT', 'sha') RETURNING id");
      expect(await fails("INSERT INTO executed_document_texts (document_hash, document_type, document_version, body, body_sha256) VALUES ('hash-1', 'PRA', 'v2', 'ANOTHER TEXT', 'sha2')")).toMatch(/duplicate|unique/i);
    });
    expect(await fails("UPDATE executed_document_texts SET body = 'changed'")).toMatch(/never edited or deleted/);
    expect(await fails("DELETE FROM executed_document_texts")).toMatch(/never edited or deleted/);
    expect((await ok("SELECT body FROM executed_document_texts WHERE document_hash = 'hash-1'"))[0]!.body).toBe("THE TEXT");
  });

  it("members and anon have no direct access to either table; only the server does", async () => {
    for (const role of ["authenticated", "anon"]) {
      expect(await asRole(role, () => fails("SELECT * FROM document_review_acknowledgments"))).toMatch(/permission/i);
      expect(await asRole(role, () => fails("SELECT * FROM executed_document_texts"))).toMatch(/permission/i);
      expect(await asRole(role, () => fails("INSERT INTO executed_document_texts (document_hash, document_type, document_version, body, body_sha256) VALUES ('x', 'PRA', 'v', 'b', 's')"))).toMatch(/permission/i);
    }
    expect(await asRole("service_role", async () => (await ok("SELECT id FROM executed_document_texts")).length)).toBe(1);
  });
});
