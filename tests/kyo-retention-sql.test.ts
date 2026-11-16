/**
 * KYO retention on a real Postgres (PGlite): kyo-retention.sql exactly as written, on stand-ins for the tables it touches, with the Audit Vault in place.
 * The ledger is never deleted; erasure happens only through retention_erase(), never for a legal hold or inside the period, and leaves no personal data in the log.
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
const FOUNDER = U(1);
const ADMIN = U(2);
const MEMBER = U(10);
const ACCOUNT = U(20);
const SELLER = U(30);

const SETUP = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
  END $$;
  GRANT service_role, authenticated, anon TO authenticator;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
  CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user', 'founder', 'compliance_officer', 'auditor');
  CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
  CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
  INSERT INTO public.user_roles (user_id, role) VALUES ('${FOUNDER}', 'founder'), ('${ADMIN}', 'admin');
  CREATE TABLE public.audit_log (id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, actor_id UUID, actor_type TEXT NOT NULL DEFAULT 'seller', action_type TEXT NOT NULL, entity_type TEXT, entity_id TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  GRANT SELECT, INSERT ON public.audit_log TO authenticated; GRANT ALL ON public.audit_log TO service_role;
  ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Authenticated can insert own audit rows" ON public.audit_log FOR INSERT TO authenticated WITH CHECK (actor_id = auth.uid());
  CREATE POLICY "Authenticated can view audit rows" ON public.audit_log FOR SELECT TO authenticated USING (true);

  CREATE TABLE public.buyer_accounts (id uuid PRIMARY KEY, onboarding_status text);
  CREATE TABLE public.sellers (id uuid PRIMARY KEY, full_name text, email text NOT NULL, phone text, address text, date_of_birth date, id_document_url text);
  CREATE TABLE public.entity_genesis (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid);
  CREATE TABLE public.account_members (id uuid PRIMARY KEY, buyer_account_id uuid, full_name text, status text, date_of_birth date, address text, id_document_number text, id_document_url text, email text, phone text);
  CREATE TABLE public.member_w9 (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_member_id uuid UNIQUE, legal_name text NOT NULL CHECK (length(btrim(legal_name)) > 0), address text NOT NULL, tin_last4 text NOT NULL CHECK (tin_last4 ~ '^[0-9]{4}$'), signed_name text NOT NULL, ip text, user_agent text);
  CREATE TABLE public.member_w9_tin_secrets (w9_id uuid PRIMARY KEY, account_member_id uuid UNIQUE, ciphertext text NOT NULL);
  CREATE TABLE public.eligibility_declarations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_member_id uuid, answers jsonb, signed_name text, attested_personally boolean NOT NULL DEFAULT false, ip text, user_agent text, status text NOT NULL,
    declaration_hash text NOT NULL DEFAULT 'sha256_x', CHECK (status = 'legacy' OR (answers IS NOT NULL AND attested_personally)));
  CREATE TABLE public.member_liveness_checks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_member_id uuid, id_document_ref text NOT NULL, selfie_url text NOT NULL, status text NOT NULL DEFAULT 'passed');
  CREATE TABLE public.kyo_correction_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_member_id uuid, requested_change text NOT NULL CHECK (length(btrim(requested_change)) > 0), ip text, user_agent text);
  -- The record-keeping triggers the real tables carry: none of these refuse an edit that the erasure is allowed to make unless they are left on.
  CREATE FUNCTION public.refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'This table is append-only.' USING ERRCODE = 'insufficient_privilege'; END $$;
  CREATE TRIGGER member_w9_append_only BEFORE UPDATE OR DELETE ON public.member_w9 FOR EACH ROW EXECUTE FUNCTION public.refuse_change();
  CREATE TRIGGER member_w9_secrets_append_only BEFORE UPDATE OR DELETE ON public.member_w9_tin_secrets FOR EACH ROW EXECUTE FUNCTION public.refuse_change();
  CREATE TRIGGER eligibility_declaration_immutable BEFORE UPDATE OR DELETE ON public.eligibility_declarations FOR EACH ROW EXECUTE FUNCTION public.refuse_change();
  CREATE TRIGGER member_liveness_immutable BEFORE UPDATE OR DELETE ON public.member_liveness_checks FOR EACH ROW EXECUTE FUNCTION public.refuse_change();
  CREATE TRIGGER kyo_correction_immutable BEFORE UPDATE OR DELETE ON public.kyo_correction_requests FOR EACH ROW EXECUTE FUNCTION public.refuse_change();
  CREATE FUNCTION public.removed_member_frozen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status = 'removed' THEN RAISE EXCEPTION 'A removed member cannot be edited.'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER account_members_guard BEFORE UPDATE ON public.account_members FOR EACH ROW EXECUTE FUNCTION public.removed_member_frozen();
  GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
`;

async function fresh(): Promise<Db> {
  const pg = new PGliteCtor!();
  await pg.exec(SETUP);
  await pg.exec(readFileSync("audit-vault.sql", "utf8"));
  const sql = readFileSync("kyo-retention.sql", "utf8");
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
async function asApp<T>(pg: Db, role: string, fn: () => Promise<T>): Promise<T> {
  await pg.exec(`SET SESSION AUTHORIZATION authenticator; SET ROLE ${role};`);
  try {
    return await fn();
  } finally {
    await pg.exec("RESET ROLE; SET SESSION AUTHORIZATION postgres;");
  }
}

/** A removed Account Member with personal data in every place the erasure reaches, archived, past its seven years. */
async function seedMember(pg: Db, o: { retainUntil?: string | null; hold?: boolean; review?: boolean } = {}) {
  await pg.query("INSERT INTO public.buyer_accounts (id, onboarding_status) VALUES ($1, 'archived')", [ACCOUNT]);
  await pg.query("INSERT INTO public.account_members (id, buyer_account_id, full_name, status, date_of_birth, address, id_document_number, id_document_url, email, phone) VALUES ($1, $2, 'Alice Example', 'removed', '1980-02-03', '1 Main St, Lusk WY', 'D1234567', 'u/license.jpg', 'alice@example.test', '307-555-0100')", [MEMBER, ACCOUNT]);
  await pg.query("INSERT INTO public.member_w9 (account_member_id, legal_name, address, tin_last4, signed_name, ip, user_agent) VALUES ($1, 'Alice Example', '1 Main St', '6789', 'Alice Example', '203.0.113.9', 'UA')", [MEMBER]);
  await pg.query("INSERT INTO public.member_w9_tin_secrets (w9_id, account_member_id, ciphertext) VALUES ($1, $2, 'SECRETCIPHERTEXT')", [U(99), MEMBER]);
  await pg.query("INSERT INTO public.eligibility_declarations (account_member_id, answers, signed_name, attested_personally, ip, status) VALUES ($1, '{\"q1\":\"yes\"}', 'Alice Example', true, '203.0.113.9', 'complete')", [MEMBER]);
  await pg.query("INSERT INTO public.member_liveness_checks (account_member_id, id_document_ref, selfie_url) VALUES ($1, 'u/license.jpg', 'u/selfie.jpg')", [MEMBER]);
  await pg.query("INSERT INTO public.kyo_correction_requests (account_member_id, requested_change, ip) VALUES ($1, 'My new address is 9 Other St', '203.0.113.9')", [MEMBER]);
  const retainUntil = o.retainUntil === undefined ? "2020-01-01" : o.retainUntil;
  const rec = (
    await ok(
      pg,
      `INSERT INTO public.kyo_retention (subject_kind, subject_id, buyer_account_id, retention_class, archive_reason, archived_at, retain_until, status, legal_hold, legal_hold_reason)
       VALUES ('account_member', $1, $2, 'archived', 'member_removed', '2013-01-01T00:00:00Z', $3, 'past_retention', $4, $5) RETURNING id`,
      [MEMBER, ACCOUNT, retainUntil, o.hold ?? false, o.hold ? "Pending litigation" : null],
    )
  )[0]!.id as string;
  const review = o.review === false ? null : ((await ok(pg, "INSERT INTO public.retention_reviews (retention_id, kind) VALUES ($1, 'past_retention') RETURNING id", [rec]))[0]!.id as string);
  return { rec, review };
}
const erase = (pg: Db, rec: string, review: string | null, who: string | null = FOUNDER, reason = "Seven years have passed and compliance has reviewed it.") =>
  asApp(pg, "service_role", () => ok(pg, "SELECT public.retention_erase($1, $2, $3, $4) AS r", [rec, who, review, reason]).then((r) => r[0]!.r as Record<string, any>));

run("kyo-retention.sql", { timeout: 90_000 } as never, () => {
  it("adds the ledger, the queue and the columns, and is safe to run again", async () => {
    const pg = await fresh();
    for (const t of ["kyo_retention", "kyo_retention_items", "retention_reviews", "kyo_deletion_requests"]) expect((await ok(pg, "SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${t}`]))[0]!.ok, t).toBe(true);
    for (const [t, c] of [["entity_genesis", "llc_dissolved_at"], ["buyer_accounts", "archived_at"], ["buyer_accounts", "archive_reason"], ["sellers", "archived_at"]]) {
      expect((await ok(pg, "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = $1 AND column_name = $2", [t, c]))[0]!.n, `${t}.${c}`).toBe(1);
    }
  });

  it("a retention record is never deleted, and the class, archive date and hold must be consistent", async () => {
    const pg = await fresh();
    const { rec } = await seedMember(pg);
    expect(await fails(pg, "DELETE FROM public.kyo_retention WHERE id = $1", [rec])).toMatch(/never deleted/);
    expect(await fails(pg, "TRUNCATE public.kyo_retention")).toBeDefined();
    expect(await fails(pg, "INSERT INTO public.kyo_retention (subject_kind, subject_id, retention_class, status) VALUES ('seller', $1, 'archived', 'retained')", [SELLER])).toMatch(/check/i);
    expect(await fails(pg, "INSERT INTO public.kyo_retention (subject_kind, subject_id, retention_class, archive_reason, archived_at, status) VALUES ('seller', $1, 'in_use', 'rejected', now(), 'in_use')", [SELLER])).toMatch(/check/i);
    expect(await fails(pg, "INSERT INTO public.kyo_retention (subject_kind, subject_id, retention_class, status, legal_hold) VALUES ('seller', $1, 'in_use', 'in_use', true)", [SELLER])).toMatch(/check/i);
    expect(await fails(pg, "INSERT INTO public.kyo_retention (subject_kind, subject_id, retention_class, status) VALUES ('seller', $1, 'in_use', 'in_use')", [SELLER])).toBe("");
    expect(await fails(pg, "INSERT INTO public.kyo_retention (subject_kind, subject_id, retention_class, status) VALUES ('seller', $1, 'in_use', 'in_use')", [SELLER])).toMatch(/duplicate|unique/i);
  });

  it("a record cannot be marked erased by hand: only retention_erase() does that", async () => {
    const pg = await fresh();
    const { rec } = await seedMember(pg);
    expect(await fails(pg, "UPDATE public.kyo_retention SET status = 'erased', erased_at = now() WHERE id = $1", [rec])).toMatch(/only through retention_erase/);
  });

  describe("retention_erase", () => {
    it("anonymizes the personal data of an archived record past its period, with a founder's approval, and logs it without the data", async () => {
      const pg = await fresh();
      const { rec, review } = await seedMember(pg);
      const r = await erase(pg, rec, review);
      expect(r).toMatchObject({ ok: true });
      expect(r.counts).toMatchObject({ w9_encrypted_values: 1, member_w9: 1, eligibility_declarations: 1, member_liveness_checks: 1, kyo_correction_requests: 1, account_members: 1 });

      const m = (await ok(pg, "SELECT * FROM public.account_members WHERE id = $1", [MEMBER]))[0]!;
      expect(m).toMatchObject({ full_name: "[erased]", date_of_birth: null, address: null, id_document_number: null, id_document_url: null, email: null, phone: null, status: "removed", buyer_account_id: ACCOUNT });
      expect((await ok(pg, "SELECT * FROM public.member_w9"))[0]).toMatchObject({ legal_name: "[erased]", address: "[erased]", signed_name: "[erased]", tin_last4: "0000", ip: null, user_agent: null });
      expect((await ok(pg, "SELECT count(*)::int AS n FROM public.member_w9_tin_secrets"))[0]!.n).toBe(0);
      expect((await ok(pg, "SELECT * FROM public.eligibility_declarations"))[0]).toMatchObject({ answers: null, signed_name: null, ip: null, status: "legacy", declaration_hash: "sha256_x" });
      expect((await ok(pg, "SELECT * FROM public.member_liveness_checks"))[0]).toMatchObject({ id_document_ref: "[erased]", selfie_url: "[erased]" });
      expect((await ok(pg, "SELECT * FROM public.kyo_correction_requests"))[0]).toMatchObject({ requested_change: "[erased]", ip: null });

      const ledger = (await ok(pg, "SELECT * FROM public.kyo_retention WHERE id = $1", [rec]))[0]!;
      expect(ledger).toMatchObject({ status: "erased", erased_by: FOUNDER, erasure_reason: "Seven years have passed and compliance has reviewed it." });
      expect(ledger.erased_at).toBeTruthy();
      expect((await ok(pg, "SELECT * FROM public.retention_reviews WHERE id = $1", [review]))[0]).toMatchObject({ status: "erased", decided_by: FOUNDER });

      // The deletion is in the Audit Vault, with counts and dates, and none of what was deleted.
      const log = (await ok(pg, "SELECT * FROM public.audit_log WHERE action_type = 'retention.erased'"))[0]!;
      expect(log).toMatchObject({ actor_id: FOUNDER, entity_type: "kyo_retention", entity_id: rec });
      expect(log.metadata).toMatchObject({ retention_class: "archived", retain_until: "2020-01-01", subject_kind: "account_member", rows_anonymized_or_removed: { account_members: 1, w9_encrypted_values: 1 } });
      const everything = JSON.stringify(await ok(pg, "SELECT * FROM public.audit_log"));
      for (const pii of ["Alice Example", "alice@example.test", "1 Main St", "D1234567", "307-555-0100", "SECRETCIPHERTEXT", "1980-02-03", "9 Other St", "6789"]) expect(everything, pii).not.toContain(pii);
      expect((await ok(pg, "SELECT * FROM public.audit_verify_chain()"))[0]).toMatchObject({ ok: true });
    });

    it("leaves the record-keeping triggers switched back on afterwards", async () => {
      const pg = await fresh();
      const { rec, review } = await seedMember(pg);
      await erase(pg, rec, review);
      expect(await fails(pg, "UPDATE public.member_w9 SET legal_name = 'tampered'")).toMatch(/append-only/);
      expect(await fails(pg, "DELETE FROM public.eligibility_declarations")).toMatch(/append-only/);
      expect(await fails(pg, "UPDATE public.account_members SET full_name = 'x' WHERE id = $1", [MEMBER])).toMatch(/removed member cannot be edited/);
      expect((await ok(pg, "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('member_w9_append_only', 'member_w9_secrets_append_only', 'eligibility_declaration_immutable', 'member_liveness_immutable', 'kyo_correction_immutable', 'account_members_guard') AND tgenabled = 'O'"))[0]!.n).toBe(6);
    });

    it("is refused for a record under a legal hold: nothing is changed, and the refusal is logged", async () => {
      const pg = await fresh();
      const { rec, review } = await seedMember(pg, { hold: true });
      expect(await erase(pg, rec, review)).toMatchObject({ ok: false, reason: "legal_hold" });
      expect((await ok(pg, "SELECT full_name FROM public.account_members WHERE id = $1", [MEMBER]))[0]!.full_name).toBe("Alice Example");
      expect((await ok(pg, "SELECT count(*)::int AS n FROM public.member_w9_tin_secrets"))[0]!.n).toBe(1);
      expect((await ok(pg, "SELECT status FROM public.kyo_retention WHERE id = $1", [rec]))[0]!.status).toBe("past_retention");
      expect((await ok(pg, "SELECT status FROM public.retention_reviews WHERE id = $1", [review]))[0]!.status).toBe("open");
      expect((await ok(pg, "SELECT * FROM public.audit_log WHERE action_type = 'retention.erasure_blocked_legal_hold'")).length).toBe(1);
      // Releasing the hold lets it proceed.
      await pg.query("UPDATE public.kyo_retention SET legal_hold = false, legal_hold_reason = NULL WHERE id = $1", [rec]);
      expect(await erase(pg, rec, review)).toMatchObject({ ok: true });
    });

    it("is refused inside the retention period, and while the period has not started (the LLC is alive)", async () => {
      const pg = await fresh();
      const future = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
      const a = await seedMember(pg, { retainUntil: future });
      expect(await erase(pg, a.rec, a.review)).toMatchObject({ ok: false, reason: "inside_retention", retain_until: future });
      await pg.query("UPDATE public.kyo_retention SET retain_until = NULL WHERE id = $1", [a.rec]);
      expect(await erase(pg, a.rec, a.review)).toMatchObject({ ok: false, reason: "inside_retention" });
      expect((await ok(pg, "SELECT full_name FROM public.account_members WHERE id = $1", [MEMBER]))[0]!.full_name).toBe("Alice Example");
      expect((await ok(pg, "SELECT count(*)::int AS n FROM public.audit_log WHERE action_type = 'retention.erasure_blocked_inside_retention'"))[0]!.n).toBe(2);
    });

    it("needs the founder, a real reason and an open review", async () => {
      const pg = await fresh();
      const { rec, review } = await seedMember(pg);
      expect(await erase(pg, rec, review, ADMIN)).toMatchObject({ ok: false, reason: "founder_only" });
      expect(await erase(pg, rec, review, null)).toMatchObject({ ok: false, reason: "founder_only" });
      expect(await erase(pg, rec, review, FOUNDER, "too short")).toMatchObject({ ok: false, reason: "reason_required" });
      expect(await erase(pg, rec, null)).toMatchObject({ ok: false, reason: "no_open_review" });
      expect(await erase(pg, rec, U(777))).toMatchObject({ ok: false, reason: "no_open_review" });
      expect(await erase(pg, U(555), review)).toMatchObject({ ok: false, reason: "not_found" });
      expect((await ok(pg, "SELECT full_name FROM public.account_members WHERE id = $1", [MEMBER]))[0]!.full_name).toBe("Alice Example");
    });

    it("running it again changes nothing", async () => {
      const pg = await fresh();
      const { rec, review } = await seedMember(pg);
      await erase(pg, rec, review);
      expect(await erase(pg, rec, review)).toMatchObject({ ok: true, already: true });
      expect((await ok(pg, "SELECT count(*)::int AS n FROM public.audit_log WHERE action_type = 'retention.erased'"))[0]!.n).toBe(1);
      expect(await fails(pg, "UPDATE public.kyo_retention SET retain_until = '2099-01-01' WHERE id = $1", [rec])).toMatch(/erased record is fixed/);
    });

    it("anonymizes a seller's record the same way", async () => {
      const pg = await fresh();
      await pg.query("INSERT INTO public.sellers (id, full_name, email, phone, address, date_of_birth, id_document_url) VALUES ($1, 'Sam Seller', 'sam@example.test', '555', '2 Elm', '1970-01-01', 'u/sam.jpg')", [SELLER]);
      const rec = (await ok(pg, "INSERT INTO public.kyo_retention (subject_kind, subject_id, retention_class, archive_reason, archived_at, retain_until, status) VALUES ('seller', $1, 'archived', 'rejected', '2013-01-01', '2020-01-01', 'past_retention') RETURNING id", [SELLER]))[0]!.id as string;
      const review = (await ok(pg, "INSERT INTO public.retention_reviews (retention_id, kind) VALUES ($1, 'past_retention') RETURNING id", [rec]))[0]!.id as string;
      expect(await erase(pg, rec, review)).toMatchObject({ ok: true });
      expect((await ok(pg, "SELECT * FROM public.sellers WHERE id = $1", [SELLER]))[0]).toMatchObject({ full_name: "[erased]", email: `erased-${SELLER}@erased.invalid`, phone: null, address: null, date_of_birth: null, id_document_url: null });
    });

    it("only the server can call it", async () => {
      const pg = await fresh();
      const { rec, review } = await seedMember(pg);
      for (const role of ["authenticated", "anon"]) expect(await asApp(pg, role, () => fails(pg, "SELECT public.retention_erase($1, $2, $3, 'a long enough reason')", [rec, FOUNDER, review])), role).toMatch(/permission denied/);
      for (const t of ["kyo_retention", "retention_reviews", "kyo_deletion_requests", "kyo_retention_items"]) expect(await asApp(pg, "authenticated", () => fails(pg, `SELECT * FROM public.${t}`)), t).toMatch(/permission denied/);
    });
  });

  describe("the queue and the requests are records", () => {
    it("one open past-retention review per record; a decided review is fixed and needs a reason", async () => {
      const pg = await fresh();
      const { rec, review } = await seedMember(pg);
      expect(await fails(pg, "INSERT INTO public.retention_reviews (retention_id, kind) VALUES ($1, 'past_retention')", [rec])).toMatch(/duplicate|unique/i);
      expect(await fails(pg, "UPDATE public.retention_reviews SET status = 'kept', decided_at = now(), decided_by = $2, decision_reason = 'no' WHERE id = $1", [review, FOUNDER])).toMatch(/check/i);
      expect(await fails(pg, "UPDATE public.retention_reviews SET status = 'kept', decided_at = now(), decided_by = $2, decision_reason = 'Needed for the audit of the LLC.' WHERE id = $1", [review, FOUNDER])).toBe("");
      expect(await fails(pg, "UPDATE public.retention_reviews SET decision_reason = 'changed my mind' WHERE id = $1", [review])).toMatch(/fixed/);
      expect(await fails(pg, "DELETE FROM public.retention_reviews")).toMatch(/never deleted/);
      // Once decided, a new review can open (the next year's).
      expect(await fails(pg, "INSERT INTO public.retention_reviews (retention_id, kind) VALUES ($1, 'past_retention')", [rec])).toBe("");
    });

    it("a deletion request: one open per member; its decision and the retention at that moment are fixed", async () => {
      const pg = await fresh();
      const { rec } = await seedMember(pg);
      const q = "INSERT INTO public.kyo_deletion_requests (retention_id, account_member_id, buyer_account_id) VALUES ($1, $2, $3) RETURNING id";
      const id = (await ok(pg, q, [rec, MEMBER, ACCOUNT]))[0]!.id as string;
      expect(await fails(pg, q, [rec, MEMBER, ACCOUNT])).toMatch(/duplicate|unique/i);
      expect(await fails(pg, "UPDATE public.kyo_deletion_requests SET status = 'declined', decided_at = now() WHERE id = $1", [id])).toMatch(/check/i);
      expect(await fails(pg, "UPDATE public.kyo_deletion_requests SET status = 'declined', decision_code = 'inside_retention', decision_reason = 'Inside the retention period until 2027-01-01.', decided_at = now(), retention_snapshot = '{\"retain_until\":\"2027-01-01\"}'::jsonb WHERE id = $1", [id])).toBe("");
      expect(await fails(pg, "UPDATE public.kyo_deletion_requests SET decision_reason = 'other' WHERE id = $1", [id])).toMatch(/fixed/);
      expect(await fails(pg, "DELETE FROM public.kyo_deletion_requests")).toMatch(/never deleted/);
      expect((await ok(pg, "SELECT retention_snapshot FROM public.kyo_deletion_requests WHERE id = $1", [id]))[0]!.retention_snapshot).toEqual({ retain_until: "2027-01-01" });
    });

    it("a request approved through erasure is closed by the erasure itself", async () => {
      const pg = await fresh();
      const { rec, review } = await seedMember(pg);
      await pg.query("INSERT INTO public.kyo_deletion_requests (retention_id, account_member_id) VALUES ($1, $2)", [rec, MEMBER]);
      await erase(pg, rec, review);
      expect((await ok(pg, "SELECT status, decision_code FROM public.kyo_deletion_requests"))[0]).toEqual({ status: "approved", decision_code: "founder_approved" });
    });
  });
});
