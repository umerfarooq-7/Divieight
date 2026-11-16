/**
 * The Audit Vault on a real Postgres (PGlite): audit-vault.sql exactly as written, on top of the original audit_log table.
 * Append-only for every role, redaction, the hash chain and tamper detection, the row-level safety net, Suspicious Activity Alerts, logged read-only access.
 * Skips when PGlite is not installed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

type Db = { exec: (sql: string) => Promise<unknown>; query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, any>> }> };
const specifier = "@electric-sql/pglite";
let PGliteCtor: (new () => Db) | null = null;
try {
  PGliteCtor = ((await import(/* @vite-ignore */ specifier)) as { PGlite: new () => Db }).PGlite;
} catch {
  PGliteCtor = null;
}

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = U(1);
const AUDITOR = U(2);
const OFFICER = U(3);
const MEMBER = U(4);

/** The original table, exactly as the first migration made it, with a few old rows (some carrying values that must never have been logged). */
const LEGACY = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
  END $$;
  GRANT service_role, authenticated, anon TO authenticator;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE SCHEMA IF NOT EXISTS auth;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
  CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user', 'compliance_officer', 'auditor');
  CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
  CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
  GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO anon, authenticated, service_role;
  INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}', 'admin'), ('${AUDITOR}', 'auditor'), ('${OFFICER}', 'compliance_officer');

  CREATE TABLE public.audit_log (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, actor_id UUID, actor_type TEXT NOT NULL DEFAULT 'seller', action_type TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
  );
  GRANT SELECT, INSERT ON public.audit_log TO authenticated;
  GRANT ALL ON public.audit_log TO service_role;
  ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Authenticated can insert own audit rows" ON public.audit_log FOR INSERT TO authenticated WITH CHECK (actor_id = auth.uid());
  CREATE POLICY "Authenticated can view audit rows" ON public.audit_log FOR SELECT TO authenticated USING (true);

  INSERT INTO public.audit_log (actor_id, actor_type, action_type, metadata, created_at) VALUES
    (NULL, 'buyer', 'old.one', '{"w9_id":"a","tin":"123-45-6789","tin_last4":"6789","note":"kept"}', '2026-01-01T00:00:00Z'),
    (NULL, 'buyer', 'old.two', '{"ip_address":"198.51.100.7","user_agent":"UA-old","acted_by_member_id":"${U(77)}"}', '2026-01-02T00:00:00Z'),
    (NULL, 'admin', 'old.three', '{"answers":{"q1":"yes"}}', '2026-01-03T00:00:00Z');

  CREATE TABLE public.cap_table_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, share_number int, holder_type text, buyer_account_id uuid, updated_at timestamptz);
  CREATE TABLE public.buyer_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), onboarding_status text, last_activity_at timestamptz, golden_ticket_issued boolean DEFAULT false);
  CREATE TABLE public.eligibility_declarations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, answers jsonb, account_member_id uuid);
  GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
`;

async function fresh(): Promise<Db> {
  const pg = new PGliteCtor!();
  await pg.exec(LEGACY);
  const sql = readFileSync("audit-vault.sql", "utf8");
  await pg.exec(sql);
  await pg.exec(sql); // safe to run again
  return pg;
}

const run = PGliteCtor ? describe : describe.skip;

const ok = (pg: Db, sql: string, params?: unknown[]) => pg.query(sql, params).then((r) => r.rows);
const fails = async (pg: Db, sql: string, params?: unknown[]) => {
  try {
    await pg.query(sql, params);
    return "";
  } catch (e) {
    return (e as { message?: string }).message ?? "failed";
  }
};
/** Run as the application does: through the API (the authenticator), as the service role. */
async function asApp<T>(pg: Db, fn: () => Promise<T>, role = "service_role", claims = ""): Promise<T> {
  await pg.exec(`SET SESSION AUTHORIZATION authenticator; SET ROLE ${role};`);
  if (claims) await pg.exec(`SELECT set_config('request.jwt.claims', '${claims}', false);`);
  try {
    return await fn();
  } finally {
    await pg.exec("RESET ROLE; SET SESSION AUTHORIZATION postgres; SELECT set_config('request.jwt.claims', '', false);");
  }
}
async function asUser<T>(pg: Db, uid: string, fn: () => Promise<T>): Promise<T> {
  await pg.exec(`SELECT set_config('test.uid', '${uid}', false);`);
  return asApp(pg, fn, "authenticated", JSON.stringify({ role: "authenticated", sub: uid }));
}
const log = (pg: Db, action: string, metadata: Record<string, unknown> = {}, actor: string | null = null) =>
  pg.query("INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata) VALUES ($1, 'admin', $2, 'thing', 'e1', $3::jsonb) RETURNING *", [actor, action, JSON.stringify(metadata)]).then((r) => r.rows[0]!);
const verify = async (pg: Db) => (await ok(pg, "SELECT * FROM public.audit_verify_chain()"))[0]!;

run("audit-vault.sql", { timeout: 90_000 } as never, () => {
  it("chains the rows that were already there, in the order they were written, and cleans what should never have been logged", async () => {
    const pg = await fresh();
    const rows = await ok(pg, "SELECT * FROM public.audit_log ORDER BY seq");
    expect(rows.map((r) => r.action_type)).toEqual(["old.one", "old.two", "old.three"]);
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3]);
    expect(rows[0]!.prev_hash).toBe("GENESIS");
    expect(rows[1]!.prev_hash).toBe(rows[0]!.row_hash);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.row_hash);
    expect(rows[0]!.source).toBe("legacy");
    // The old TIN and the old declaration answers are redacted; the last four digits stay.
    expect(rows[0]!.metadata).toEqual({ w9_id: "a", tin: "[redacted]", tin_last4: "6789", note: "kept" });
    expect(rows[2]!.metadata).toEqual({ answers: "[redacted]" });
    // Where was lifted out of the payload into columns.
    expect(rows[1]).toMatchObject({ ip_address: "198.51.100.7", user_agent: "UA-old", acting_member_id: U(77) });
    expect(await verify(pg)).toMatchObject({ ok: true, rows_checked: 3 });
  });

  it("a new row records who, what, when (UTC, to the millisecond) and where, and is chained", async () => {
    const pg = await fresh();
    const row = await asApp(pg, () => log(pg, "buyer.pra_signed", { acted_by_member_id: U(9), ip_address: "203.0.113.9", user_agent: "UA-new", route: "/buyer/onboarding/payment", before: { status: "a" }, after: { status: "b" } }, ADMIN));
    expect(row).toMatchObject({ actor_id: ADMIN, acting_member_id: U(9), ip_address: "203.0.113.9", user_agent: "UA-new", route: "/buyer/onboarding/payment", source: "app", seq: 4 });
    expect(new Date(row.created_at).getTime() % 1).toBe(0);
    const ms = (await ok(pg, "SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS t FROM public.audit_log WHERE seq = 4"))[0]!.t as string;
    expect(ms).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row.prev_hash).toBe((await ok(pg, "SELECT row_hash FROM public.audit_log WHERE seq = 3"))[0]!.row_hash);
    expect(row.metadata).toMatchObject({ before: { status: "a" }, after: { status: "b" } });
  });

  it("a caller cannot back-date a row", async () => {
    const pg = await fresh();
    await pg.query("INSERT INTO public.audit_log (action_type, created_at) VALUES ('x', '2001-01-01T00:00:00Z')");
    const at = (await ok(pg, "SELECT created_at FROM public.audit_log ORDER BY seq DESC LIMIT 1"))[0]!.created_at as string;
    expect(new Date(at).getFullYear()).toBeGreaterThan(2020);
  });

  it("never stores a TIN, a bank number, an answer or a secret in plain text, wherever it sits in the payload", async () => {
    const pg = await fresh();
    const row = await log(pg, "x.y", {
      tin: "987-65-4321", ssn: "111-22-3333", ein: "12-3456789", tin_last4: "4321", tin_kind: "ssn",
      account_number: "000123456789", routing_number: "021000021", declaration_answers: { q1: "no" }, answers: [1, 2],
      nested: { password: "hunter2", deep: { api_token: "abc", ciphertext: "zzz", iv: "1", auth_tag: "2", fine: "ok" } },
      list: [{ secret: "s" }, "plain", "123-45-6789"], note: "an ordinary note", amount_cents: 500, token_id: "t-1",
    });
    expect(row.metadata).toEqual({
      tin: "[redacted]", ssn: "[redacted]", ein: "[redacted]", tin_last4: "4321", tin_kind: "ssn",
      account_number: "[redacted]", routing_number: "[redacted]", declaration_answers: "[redacted]", answers: "[redacted]",
      nested: { password: "[redacted]", deep: { api_token: "[redacted]", ciphertext: "[redacted]", iv: "[redacted]", auth_tag: "[redacted]", fine: "ok" } },
      list: [{ secret: "[redacted]" }, "plain", "[redacted]"], note: "an ordinary note", amount_cents: 500, token_id: "t-1",
    });
    expect(JSON.stringify(row.metadata)).not.toMatch(/987-65|111-22|12-3456789|000123456789|hunter2/);
  });

  it("update, delete and truncate fail for every role, including admin-level and the service role the app uses", async () => {
    const pg = await fresh();
    await log(pg, "keep.me");
    const attempts = ["UPDATE public.audit_log SET action_type = 'changed'", "DELETE FROM public.audit_log", "TRUNCATE public.audit_log", "UPDATE public.audit_log SET metadata = '{}'::jsonb WHERE seq = 1"];
    for (const sql of attempts) {
      expect(await fails(pg, sql), `superuser: ${sql}`).toMatch(/append-only/);
      expect(await asApp(pg, () => fails(pg, sql)), `service role: ${sql}`).toMatch(/permission denied|append-only/);
      expect(await asUser(pg, ADMIN, () => fails(pg, sql)), `admin user: ${sql}`).toMatch(/permission denied|append-only/);
    }
    // Even a session that sets the one-time chaining switch cannot touch a row that has a number.
    await pg.exec("SELECT set_config('audit.backfill', 'on', false)");
    expect(await fails(pg, "UPDATE public.audit_log SET action_type = 'changed' WHERE seq = 1")).toMatch(/append-only/);
    expect(await fails(pg, "DELETE FROM public.audit_log WHERE seq = 1")).toMatch(/append-only/);
    expect((await ok(pg, "SELECT count(*)::int AS n FROM public.audit_log"))[0]!.n).toBe(4);
    expect(await verify(pg)).toMatchObject({ ok: true });
  });

  it("no member or visitor can read the table directly; the old read-everything policy is gone", async () => {
    const pg = await fresh();
    for (const role of ["authenticated", "anon"]) expect(await asApp(pg, () => fails(pg, "SELECT * FROM public.audit_log"), role), role).toMatch(/permission denied/);
    expect((await ok(pg, "SELECT polname FROM pg_policy WHERE polrelid = 'public.audit_log'::regclass")).map((p) => p.polname)).toEqual(["Authenticated can insert own audit rows"]);
    // A signed-in person can still log their own action (the browser does), and it is chained.
    await asUser(pg, MEMBER, () => pg.query("INSERT INTO public.audit_log (actor_id, actor_type, action_type) VALUES ($1, 'buyer', 'buyer.wishlist_removed')", [MEMBER]));
    const mine = (await ok(pg, "SELECT * FROM public.audit_log WHERE action_type = 'buyer.wishlist_removed'"))[0]!;
    expect(mine).toMatchObject({ seq: 4, source: "app", actor_id: MEMBER });
    expect(await asUser(pg, MEMBER, () => fails(pg, "INSERT INTO public.audit_log (actor_id, actor_type, action_type) VALUES ($1, 'buyer', 'forged')", [U(99)]))).toMatch(/row-level security/);
  });

  describe("the hash chain detects tampering", () => {
    const tamper = async (pg: Db, sql: string) => {
      await pg.exec("ALTER TABLE public.audit_log DISABLE TRIGGER audit_log_no_change");
      await pg.exec(sql);
      await pg.exec("ALTER TABLE public.audit_log ENABLE TRIGGER audit_log_no_change");
    };
    const build = async () => {
      const pg = await fresh();
      for (let i = 0; i < 4; i++) await log(pg, `event.${i}`, { n: i });
      expect(await verify(pg)).toMatchObject({ ok: true, rows_checked: 7 });
      return pg;
    };

    it("a row whose content was edited", async () => {
      const pg = await build();
      await tamper(pg, "UPDATE public.audit_log SET metadata = '{\"n\": 999}'::jsonb WHERE action_type = 'event.1'");
      expect(await verify(pg)).toMatchObject({ ok: false, first_bad_seq: 5, reason: expect.stringMatching(/changed after it was written/) });
    });
    it("a row whose actor, time or action was edited", async () => {
      const pg = await build();
      await tamper(pg, "UPDATE public.audit_log SET actor_id = '" + U(55) + "' WHERE action_type = 'event.2'");
      expect(await verify(pg)).toMatchObject({ ok: false, first_bad_seq: 6 });
      await tamper(pg, "UPDATE public.audit_log SET actor_id = NULL WHERE action_type = 'event.2'");
      expect((await verify(pg)).ok).toBe(true);
      await tamper(pg, "UPDATE public.audit_log SET created_at = created_at + interval '1 second' WHERE action_type = 'event.0'");
      expect(await verify(pg)).toMatchObject({ ok: false, first_bad_seq: 4 });
    });
    it("a row that was removed from the middle", async () => {
      const pg = await build();
      await tamper(pg, "DELETE FROM public.audit_log WHERE action_type = 'event.1'");
      expect(await verify(pg)).toMatchObject({ ok: false, first_bad_seq: 6, reason: expect.stringMatching(/missing/) });
    });
    it("a row that was edited and re-hashed to look right: the next row's link breaks", async () => {
      const pg = await build();
      await tamper(pg, "UPDATE public.audit_log SET metadata = '{\"n\": 5}'::jsonb WHERE action_type = 'event.1'");
      await tamper(pg, "UPDATE public.audit_log a SET row_hash = public.audit_row_hash(a) WHERE action_type = 'event.1'");
      expect(await verify(pg)).toMatchObject({ ok: false, first_bad_seq: 6, reason: expect.stringMatching(/link to the previous row/) });
    });
    it("rows cut from the end of the log: the last good check is the witness", async () => {
      const pg = await build();
      const cp = (await ok(pg, "SELECT * FROM public.record_audit_checkpoint('nightly')"))[0]!;
      expect(cp).toMatchObject({ ok: true, rows_checked: 7, last_seq: 7 });
      await tamper(pg, "DELETE FROM public.audit_log WHERE seq > 5");
      expect(await verify(pg)).toMatchObject({ ok: false, reason: expect.stringMatching(/removed from the end/) });
    });
    it("checkpoints are records: never edited or deleted", async () => {
      const pg = await build();
      await ok(pg, "SELECT * FROM public.record_audit_checkpoint('nightly')");
      expect(await fails(pg, "UPDATE public.audit_vault_checkpoints SET ok = false")).toMatch(/never edited or deleted/);
      expect(await fails(pg, "DELETE FROM public.audit_vault_checkpoints")).toMatch(/never edited or deleted/);
    });
  });

  describe("the safety net on the critical tables", () => {
    it("a change made through the application is recorded with its source, and raises no alert", async () => {
      const pg = await fresh();
      await asApp(pg, async () => {
        await pg.query("INSERT INTO public.cap_table_entries (id, property_id, share_number, holder_type, buyer_account_id) VALUES ($1, $2, 1, 'buyer_account', $3)", [U(500), U(600), U(700)]);
      }, "service_role", JSON.stringify({ role: "service_role" }));
      const row = (await ok(pg, "SELECT * FROM public.audit_log WHERE action_type = 'db.row_changed'"))[0]!;
      expect(row).toMatchObject({ entity_type: "cap_table_entries", entity_id: U(500), source: "trigger", actor_type: "service_role" });
      expect(row.metadata).toMatchObject({ table: "cap_table_entries", operation: "INSERT", protected: true, direct_database_change: false, property_id: U(600), after: { share_number: 1, holder_type: "buyer_account" } });
      expect((await ok(pg, "SELECT count(*)::int AS n FROM public.suspicious_activity_alerts"))[0]!.n).toBe(0);
    });

    it("a change made directly in the database to a PROTECTED table raises a Suspicious Activity Alert", async () => {
      const pg = await fresh();
      await pg.query("INSERT INTO public.cap_table_entries (id, property_id, share_number, holder_type) VALUES ($1, $2, 1, 'buyer_account')", [U(500), U(600)]);
      await pg.query("UPDATE public.cap_table_entries SET share_number = 2 WHERE id = $1", [U(500)]);
      await pg.query("DELETE FROM public.cap_table_entries WHERE id = $1", [U(500)]);
      const alerts = await ok(pg, "SELECT * FROM public.suspicious_activity_alerts ORDER BY detected_at");
      expect(alerts).toHaveLength(3);
      expect(alerts[0]).toMatchObject({ kind: "out_of_band_change", severity: "critical", subject_table: "cap_table_entries", subject_pk: U(500), notified_at: null });
      expect(alerts[0]!.detail).toMatchObject({ db_role: "postgres", why: expect.stringMatching(/directly in the database/) });
      expect(alerts.map((a) => a.detail.operation).sort()).toEqual(["DELETE", "INSERT", "UPDATE"]);
      const audit = await ok(pg, "SELECT metadata, actor_type FROM public.audit_log WHERE action_type = 'db.row_changed' AND entity_type = 'cap_table_entries' ORDER BY seq");
      expect(audit.every((a) => a.actor_type === "database" && a.metadata.direct_database_change === true)).toBe(true);
      expect(audit[1]!.metadata).toMatchObject({ operation: "UPDATE", changed_columns: ["share_number"], before: { share_number: 1 }, after: { share_number: 2 } });
      expect(audit[1]!.metadata.before_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(audit[1]!.metadata.before_hash).not.toBe(audit[1]!.metadata.after_hash);
      expect(await verify(pg)).toMatchObject({ ok: true });
    });

    it("a direct change to a table that is audited but not protected is recorded, with no alert", async () => {
      const pg = await fresh();
      await pg.query("INSERT INTO public.buyer_accounts (id, onboarding_status) VALUES ($1, 'payment_pending')", [U(800)]);
      await pg.query("UPDATE public.buyer_accounts SET onboarding_status = 'vetting_pending', golden_ticket_issued = true WHERE id = $1", [U(800)]);
      const rows = await ok(pg, "SELECT metadata FROM public.audit_log WHERE entity_type = 'buyer_accounts' ORDER BY seq");
      expect(rows).toHaveLength(2);
      expect(rows[1]!.metadata).toMatchObject({ changed_columns: ["golden_ticket_issued", "onboarding_status"], before: { onboarding_status: "payment_pending" }, after: { onboarding_status: "vetting_pending", golden_ticket_issued: true } });
      expect((await ok(pg, "SELECT count(*)::int AS n FROM public.suspicious_activity_alerts"))[0]!.n).toBe(0);
    });

    it("bookkeeping-only changes are not recorded, and sensitive columns never enter a record", async () => {
      const pg = await fresh();
      await pg.query("INSERT INTO public.buyer_accounts (id, onboarding_status) VALUES ($1, 'x')", [U(801)]);
      const before = (await ok(pg, "SELECT count(*)::int AS n FROM public.audit_log"))[0]!.n;
      await pg.query("UPDATE public.buyer_accounts SET last_activity_at = now() WHERE id = $1", [U(801)]);
      expect((await ok(pg, "SELECT count(*)::int AS n FROM public.audit_log"))[0]!.n).toBe(before);
      await pg.query("INSERT INTO public.eligibility_declarations (id, status, answers) VALUES ($1, 'draft', '{\"q1\":\"yes\"}')", [U(802)]);
      const mark = (await ok(pg, "SELECT count(*)::int AS n FROM public.audit_log"))[0]!.n;
      await pg.query("UPDATE public.eligibility_declarations SET answers = '{\"q1\":\"no\"}' WHERE id = $1", [U(802)]);
      expect((await ok(pg, "SELECT count(*)::int AS n FROM public.audit_log"))[0]!.n).toBe(mark); // only the answers changed: nothing about them is logged
      await pg.query("UPDATE public.eligibility_declarations SET status = 'complete' WHERE id = $1", [U(802)]);
      const row = (await ok(pg, "SELECT metadata FROM public.audit_log WHERE entity_type = 'eligibility_declarations' ORDER BY seq DESC LIMIT 1"))[0]!;
      expect(row.metadata.changed_columns).toEqual(["status"]);
      expect(JSON.stringify(row.metadata)).not.toMatch(/yes|"no"/);
    });

    it("a fault in the safety net never blocks the business write", async () => {
      const pg = await fresh();
      await pg.exec("ALTER TABLE public.audit_log DISABLE TRIGGER audit_log_chain_insert"); // seq stays null, the insert is refused by NOT NULL
      await pg.query("INSERT INTO public.buyer_accounts (id, onboarding_status) VALUES ($1, 'x')", [U(803)]);
      expect((await ok(pg, "SELECT count(*)::int AS n FROM public.buyer_accounts WHERE id = $1", [U(803)]))[0]!.n).toBe(1);
    });
  });

  describe("Suspicious Activity Alerts are records", () => {
    it("only the notification and the acknowledgement can be set, once; nothing else is edited or deleted", async () => {
      const pg = await fresh();
      await pg.query("INSERT INTO public.cap_table_entries (id, property_id, share_number) VALUES ($1, $2, 1)", [U(500), U(600)]);
      const id = (await ok(pg, "SELECT id FROM public.suspicious_activity_alerts"))[0]!.id as string;
      expect(await fails(pg, "UPDATE public.suspicious_activity_alerts SET detail = '{}'::jsonb WHERE id = $1", [id])).toMatch(/never edited/);
      expect(await fails(pg, "UPDATE public.suspicious_activity_alerts SET kind = 'chain_break' WHERE id = $1", [id])).toMatch(/never edited/);
      expect(await fails(pg, "DELETE FROM public.suspicious_activity_alerts")).toMatch(/never deleted/);
      expect(await fails(pg, "UPDATE public.suspicious_activity_alerts SET notified_at = now() WHERE id = $1", [id])).toBe("");
      expect(await fails(pg, "UPDATE public.suspicious_activity_alerts SET notified_at = now() + interval '1 day' WHERE id = $1", [id])).toMatch(/fixed/);
      expect(await fails(pg, "UPDATE public.suspicious_activity_alerts SET acknowledged_at = now(), acknowledged_by = $2, acknowledgement_note = 'ok' WHERE id = $1", [id, ADMIN])).toBe("");
      expect(await fails(pg, "UPDATE public.suspicious_activity_alerts SET acknowledgement_note = 'rewritten' WHERE id = $1", [id])).toMatch(/fixed/);
    });
  });

  describe("reading the Audit Vault is read-only and logged", () => {
    it("the Manager, the Compliance Officer and an auditor can read; every read is a log row; anyone else is refused", async () => {
      const pg = await fresh();
      for (const [who, type] of [[ADMIN, "admin"], [OFFICER, "compliance_officer"], [AUDITOR, "auditor"]] as const) {
        const rows = await asUser(pg, who, () => ok(pg, "SELECT * FROM public.read_audit_vault(50)"));
        expect(rows.length).toBeGreaterThan(3);
        const access = (await ok(pg, "SELECT * FROM public.audit_log WHERE action_type = 'audit.vault_accessed' AND actor_id = $1", [who]))[0]!;
        expect(access).toMatchObject({ actor_type: type, entity_type: "audit_log" });
        expect(access.metadata).toMatchObject({ via: "read_audit_vault", limit: 50 });
      }
      expect(await asUser(pg, MEMBER, () => fails(pg, "SELECT * FROM public.read_audit_vault(10)"))).toMatch(/Only the Manager/);
      expect(await asApp(pg, () => fails(pg, "SELECT * FROM public.read_audit_vault(10)"), "anon")).toMatch(/permission denied/);
      expect((await ok(pg, "SELECT count(*)::int AS n FROM public.audit_log WHERE action_type = 'audit.vault_accessed' AND actor_id = $1", [MEMBER]))[0]!.n).toBe(0);
    });

    it("the filters are recorded with the access, and the reader cannot write through it", async () => {
      const pg = await fresh();
      await log(pg, "x.special");
      const rows = await asUser(pg, AUDITOR, () => ok(pg, "SELECT * FROM public.read_audit_vault(10, NULL, 'x.special')"));
      expect(rows.map((r) => r.action_type)).toEqual(["x.special"]);
      const access = (await ok(pg, "SELECT metadata FROM public.audit_log WHERE action_type = 'audit.vault_accessed' ORDER BY seq DESC LIMIT 1"))[0]!;
      expect(access.metadata.filters).toEqual({ action: "x.special" });
      expect(await asUser(pg, AUDITOR, () => fails(pg, "UPDATE public.audit_log SET action_type = 'x'"))).toMatch(/permission denied/);
      expect(await asUser(pg, AUDITOR, () => fails(pg, "SELECT * FROM public.audit_log"))).toMatch(/permission denied/);
    });
  });
});
