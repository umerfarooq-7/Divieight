/**
 * Versioned Terms on a real Postgres (PGlite): tc-versions.sql exactly as written.
 * Exactly one current version; a published version is never edited or deleted; a material revision needs a summary; notices and acceptances are records.
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

run("tc-versions.sql", () => {
  const add = (version: string, o: { current?: boolean; material?: boolean; summary?: string | null } = {}) =>
    ok("INSERT INTO tc_versions (version, effective_date, body, is_material, summary_of_changes, is_current) VALUES ($1, '2026-12-01', $2, $3, $4, $5) RETURNING id", [version, `body ${version}`, o.material ?? false, o.summary ?? null, o.current ?? false]);

  beforeAll(async () => {
    await pg!.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    `);
    const sql = readFileSync("tc-versions.sql", "utf8");
    await pg!.exec(sql);
    await pg!.exec(sql); // safe to run again
  });

  it("at most one version is current, and the flag moves to the newer one", async () => {
    const v1 = (await add("1.0", { current: true }))[0]!.id as string;
    expect(await fails("INSERT INTO tc_versions (version, effective_date, body, is_current) VALUES ('1.1', '2026-12-01', 'b', true)")).toMatch(/duplicate|unique/i);
    await ok("UPDATE tc_versions SET is_current = false WHERE id = $1", [v1]);
    await add("1.1", { current: true, material: true, summary: "What changed in plain words." });
    expect((await ok("SELECT version FROM tc_versions WHERE is_current")).map((r) => r.version)).toEqual(["1.1"]);
  });

  it("a material revision cannot be published without a summary of changes", async () => {
    expect(await fails("INSERT INTO tc_versions (version, effective_date, body, is_material) VALUES ('2.0', '2027-01-01', 'b', true)")).toMatch(/check/i);
    expect(await fails("INSERT INTO tc_versions (version, effective_date, body, is_material, summary_of_changes) VALUES ('2.0', '2027-01-01', 'b', true, 'short')")).toMatch(/check/i);
    await add("2.0", { material: true, summary: "A real summary of the change." });
    await add("2.1", { material: false });
  });

  it("a published version is never edited or deleted, and the version number is unique; only the current flag moves", async () => {
    expect(await fails("UPDATE tc_versions SET body = 'changed' WHERE version = '1.0'")).toMatch(/never edited/);
    expect(await fails("UPDATE tc_versions SET summary_of_changes = 'x' WHERE version = '2.0'")).toMatch(/never edited/);
    expect(await fails("UPDATE tc_versions SET effective_date = '2030-01-01' WHERE version = '1.0'")).toMatch(/never edited/);
    expect(await fails("DELETE FROM tc_versions WHERE version = '1.0'")).toMatch(/never deleted/);
    expect(await fails("INSERT INTO tc_versions (version, effective_date, body) VALUES ('1.0', '2026-12-01', 'again')")).toMatch(/duplicate|unique/i);
    expect((await ok("SELECT body FROM tc_versions WHERE version = '1.0'"))[0]!.body).toBe("body 1.0");
  });

  it("delivery records and acceptances are one per person (per channel), and never edited or deleted", async () => {
    const v = (await ok("SELECT id FROM tc_versions WHERE version = '1.1'"))[0]!.id as string;
    await asRole("service_role", async () => {
      await ok("INSERT INTO tc_notice_deliveries (tc_version_id, auth_user_id, channel, delivered) VALUES ($1, $2, 'portal', true) RETURNING id", [v, U(1)]);
      await ok("INSERT INTO tc_notice_deliveries (tc_version_id, auth_user_id, channel, delivered) VALUES ($1, $2, 'email', false) RETURNING id", [v, U(1)]);
      expect(await fails("INSERT INTO tc_notice_deliveries (tc_version_id, auth_user_id, channel, delivered) VALUES ($1, $2, 'portal', true)", [v, U(1)])).toMatch(/duplicate|unique/i);
      expect(await fails("INSERT INTO tc_notice_deliveries (tc_version_id, auth_user_id, channel, delivered) VALUES ($1, $2, 'sms', true)", [v, U(2)])).toMatch(/check/i);
      await ok("INSERT INTO tc_acceptances (auth_user_id, tc_version_id, version) VALUES ($1, $2, '1.1') RETURNING id", [U(1), v]);
      expect(await fails("INSERT INTO tc_acceptances (auth_user_id, tc_version_id, version) VALUES ($1, $2, '1.1')", [U(1), v])).toMatch(/duplicate|unique/i);
      expect(await fails("INSERT INTO tc_acceptances (auth_user_id, tc_version_id, version, kind) VALUES ($1, $2, '1.1', 'forced_resign')", [U(3), v])).toMatch(/check/i);
    });
    expect(await fails("UPDATE tc_notice_deliveries SET delivered = false")).toMatch(/never edited or deleted/);
    expect(await fails("DELETE FROM tc_notice_deliveries")).toMatch(/never edited or deleted/);
    expect(await fails("UPDATE tc_acceptances SET version = '9.9'")).toMatch(/never edited or deleted/);
    expect(await fails("DELETE FROM tc_acceptances")).toMatch(/never edited or deleted/);
  });

  it("members and anon have no direct access: everything goes through the server", async () => {
    for (const role of ["authenticated", "anon"]) {
      for (const t of ["tc_versions", "tc_notice_deliveries", "tc_acceptances"]) expect(await asRole(role, () => fails(`SELECT * FROM ${t}`)), `${role} ${t}`).toMatch(/permission/i);
    }
    expect(await asRole("service_role", async () => (await ok("SELECT id FROM tc_versions")).length)).toBeGreaterThan(1);
  });
});
