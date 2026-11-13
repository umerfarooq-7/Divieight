/**
 * Month 6, Prompt 13, on a real Postgres (PGlite): the real bookkeeping, capital-accounts, bank-feed, books, expenses, capital-events,
 * expense-books, monthly-statements, year-end-packet and then tax-forms.sql, as written. The broker tax-form gate (the right form for who the
 * broker is, W-8s that expire, a login that can't set its own flag), the tax vault permission, the influencer annual summary ($600 threshold,
 * W-8 payees flagged, never through a broker) and the Tax-Ready Folder's per-share ownership reconciliation. Skips when PGlite isn't installed.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
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
const FOUNDER = U(2);
const ADMIN2 = U(3);
const A1 = U(11);
const A2 = U(12);
const SELLER = U(21);
const AUTH1 = U(31);
const BROKER_USER = U(61);
const J = JSON.stringify;

const ok = async (sql: string, params?: unknown[]) => (await pg!.query(sql, params)).rows;
const fails = async (sql: string, params?: unknown[]) => {
  try {
    await pg!.query(sql, params);
    return { message: "", code: "" };
  } catch (e) {
    const err = e as { message?: string; code?: string };
    return { message: err.message ?? "", code: err.code ?? "" };
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
const svc = <T>(fn: () => Promise<T>) => asRole("service_role", null, fn);
const rpc = async (sql: string, params?: unknown[]) => (await svc(async () => ok(sql, params)))[0]!.r as any;
const tryRpc = (sql: string, params?: unknown[]) => svc(async () => fails(sql, params));
const count = async (sql: string, params?: unknown[]) => Number((await ok(sql, params))[0]!.n);

const newBroker = async () => (await ok("INSERT INTO brokers (id, auth_user_id) VALUES (gen_random_uuid(), $1) RETURNING id", [randomUUID()]))[0]!.id as string;
const secret = () => ({ ciphertext: "Y2lwaGVy", iv: "aXY=", auth_tag: "dGFn", key_version: 1 });
const form = (o: Record<string, unknown> = {}) => ({
  id: randomUUID(), form_type: "W-9", is_us_person: true, entity_kind: "entity", legal_name: "Acme Realty LLC", address: "1 Main St, Lusk, WY 82225", country: "US", tin_kind: "ein", tin_last4: "4321",
  signed_name: "Pat Broker", signed_at: "2026-03-01T00:00:00Z", expiry_date: null, ...o,
});
const submit = (broker: string, f = form(), s: unknown = secret()) => svc(async () => ok("SELECT record_broker_tax_form($1, $2::jsonb, $3::jsonb, $4, $5::jsonb) AS r", [broker, J(f), J(s), BROKER_USER, J({ ip_address: "9.9.9.9" })])).then((r) => r[0]!.r as string);
const trySubmit = (broker: string, f: Record<string, unknown>) => tryRpc("SELECT record_broker_tax_form($1, $2::jsonb, $3::jsonb, $4)", [broker, J(f), J(secret()), BROKER_USER]);
const state = async (broker: string, on: string | null = null) => (await svc(async () => ok(on ? "SELECT * FROM broker_tax_form_state($1, $2::date)" : "SELECT * FROM broker_tax_form_state($1)", on ? [broker, on] : [broker])))[0] as { state: string; form_type: string | null; expiry_date: string | null };

describe.skipIf(!pg)("tax-forms.sql", () => {
  beforeAll(async () => {
    await pg!.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role; GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
      CREATE TABLE storage.objects (bucket_id text, name text);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE TABLE properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), listing_price numeric, address text, city text, state text, zip text, deed_recorded_at timestamptz, created_at timestamptz DEFAULT now());
      CREATE TABLE entity_genesis (property_id uuid PRIMARY KEY, cap_table_locked_at timestamptz, llc_name text);
      CREATE TABLE buyer_accounts (id uuid PRIMARY KEY, auth_user_id uuid);
      CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid, actor_type text NOT NULL DEFAULT 'seller', action_type text NOT NULL, entity_type text, entity_id text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE cap_table_entries (property_id uuid, share_number int, holder_type text, buyer_account_id uuid, seller_id uuid);
      CREATE TABLE resale_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), price numeric, status text NOT NULL DEFAULT 'completed');
      CREATE TABLE cap_table_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, share_number int, from_buyer_account_id uuid, from_seller_id uuid, to_buyer_account_id uuid, to_seller_id uuid, resale_transaction_id uuid, changed_at timestamptz DEFAULT now(), from_holder_type text, to_holder_type text);
      CREATE TABLE cpa_worksheet_flags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, resale_transaction_id uuid, flag_type text NOT NULL DEFAULT 'section_754_review', note text, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE closing_funds_obligations (property_id uuid, amount numeric, status text);
      CREATE TABLE owner_capital_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, user_id uuid NOT NULL, contributed_amount numeric NOT NULL DEFAULT 0, distributions_amount numeric NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (property_id, user_id));
      CREATE TABLE owner_capital_contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, user_id uuid NOT NULL, holder_key text NOT NULL, amount numeric NOT NULL CHECK (amount > 0), contribution_type text NOT NULL CHECK (contribution_type IN ('capital_call', 'expense')), source_allocation_id uuid, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE distribution_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, total_amount numeric NOT NULL, record_date date NOT NULL, status text NOT NULL DEFAULT 'posted', lines jsonb);
      CREATE TABLE maintenance_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, title text, vendor_name text, category text, actual_cost numeric, status text, updated_at timestamptz DEFAULT now(), expense_id uuid, expense_queued_at timestamptz, expense_queued_by uuid);
      CREATE TABLE votes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, status text, result_summary jsonb);
      CREATE TABLE user_roles (user_id uuid NOT NULL, role text NOT NULL);
      CREATE TABLE owners (user_id uuid NOT NULL, property_id uuid NOT NULL);
      CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
      CREATE FUNCTION public.is_property_owner(_user uuid, _property uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.owners WHERE user_id = _user AND property_id = _property) $$;
      -- str-treatment.sql's lodging_tax_exposure, as it returns: who, never how much.
      CREATE FUNCTION public.lodging_tax_exposure(_property uuid, _actor uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_build_array(jsonb_build_object('member_key', '${A2}', 'statuses', jsonb_build_array('owed'), 'record_count', 3)) $$;
      GRANT ALL ON audit_log, owner_capital_accounts, owner_capital_contributions, distribution_events, cap_table_history, resale_transactions, cpa_worksheet_flags, cap_table_entries, maintenance_requests, votes TO service_role;
      GRANT SELECT ON properties, user_roles, owners, entity_genesis, buyer_accounts, closing_funds_obligations TO service_role; GRANT UPDATE ON properties TO service_role;
      GRANT SELECT ON buyer_accounts TO authenticated;
      GRANT EXECUTE ON FUNCTION public.has_role(uuid, text), public.is_property_owner(uuid, uuid), public.lodging_tax_exposure(uuid, uuid) TO authenticated, service_role;
      INSERT INTO user_roles VALUES ('${ADMIN}', 'admin');
      INSERT INTO buyer_accounts VALUES ('${A1}', '${AUTH1}'), ('${A2}', '${U(32)}');
    `);
    await pg!.exec(`
      CREATE TABLE brokers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auth_user_id uuid, brokerage_name text, tax_form_verified boolean NOT NULL DEFAULT false, tax_form_verified_at timestamptz);
      GRANT SELECT, UPDATE ON brokers TO authenticated, service_role;
      INSERT INTO user_roles VALUES ('${FOUNDER}', 'founder'), ('${FOUNDER}', 'admin'), ('${ADMIN2}', 'admin');
    `);
    for (const f of ["bookkeeping.sql", "capital-accounts.sql", "bank-feed.sql", "books.sql", "expenses.sql", "capital-events.sql", "expense-books.sql", "monthly-statements.sql", "year-end-packet.sql"]) await pg!.exec(readFileSync(f, "utf8"));
    const sql = readFileSync("tax-forms.sql", "utf8");
    await pg!.exec(sql);
    await pg!.exec(sql); // safe to run again
  }, 150_000);

  beforeEach(async () => {
    await pg!.exec("RESET ROLE");
  });

  describe("the Broker of Record gate", () => {
    it("a broker with no form is 'missing'; a valid W-9 clears it; the flag follows", async () => {
      const b = await newBroker();
      expect(await state(b)).toMatchObject({ state: "missing", form_type: null });
      await submit(b);
      expect(await state(b)).toMatchObject({ state: "valid", form_type: "W-9", expiry_date: null });
      expect((await ok("SELECT tax_form_verified FROM brokers WHERE id = $1", [b]))[0]!.tax_form_verified).toBe(true);
    });

    it("the form has to be the right one for who the broker is: W-9 for a US person or entity, W-8BEN for a non-US individual, W-8BEN-E for a non-US entity", async () => {
      const b = await newBroker();
      const nonUs = { is_us_person: false, country: "GB", tin_kind: "foreign_tin", tin_last4: "9876", expiry_date: "2029-12-31" };
      expect((await trySubmit(b, form({ ...nonUs, form_type: "W-9", entity_kind: "individual", expiry_date: null }))).code).toBe("23514"); // a W-9 isn't for a non-US person
      expect((await trySubmit(b, form({ form_type: "W-8BEN", entity_kind: "individual" }))).code).toBe("23514"); // a US person doesn't use a W-8
      expect((await trySubmit(b, form({ ...nonUs, form_type: "W-8BEN", entity_kind: "entity" }))).code).toBe("23514"); // an entity uses the -E
      expect((await trySubmit(b, form({ ...nonUs, form_type: "W-8BEN-E", entity_kind: "individual" }))).code).toBe("23514");
      expect((await trySubmit(b, form({ country: "GB" }))).code).toBe("23514"); // a US person with a foreign country
      expect(await count("SELECT count(*) n FROM broker_tax_forms WHERE broker_id = $1", [b])).toBe(0);
      expect(await state(b)).toMatchObject({ state: "missing" });
      await submit(b, form({ ...nonUs, form_type: "W-8BEN", entity_kind: "individual" }));
      expect(await state(b)).toMatchObject({ state: "valid", form_type: "W-8BEN" });
    });

    it("a W-8 satisfies the gate for a non-US broker (an entity on a W-8BEN-E too), and a W-9 needs a US TIN", async () => {
      const b = await newBroker();
      await submit(b, form({ form_type: "W-8BEN-E", is_us_person: false, entity_kind: "entity", country: "CA", tin_kind: "none", tin_last4: null, expiry_date: "2029-12-31" }), null);
      expect(await state(b, "2027-06-01")).toMatchObject({ state: "valid", form_type: "W-8BEN-E" });
      expect((await trySubmit(await newBroker(), form({ tin_kind: "foreign_tin" }))).code).toBe("23514");
      expect((await trySubmit(await newBroker(), form({ tin_last4: null }))).code).toBe("23514");
    });

    it("a W-8 expires (a W-9 doesn't): the end of the third calendar year after signing", async () => {
      const b = await newBroker();
      await submit(b, form({ form_type: "W-8BEN", is_us_person: false, entity_kind: "individual", country: "FR", tin_kind: "foreign_tin", tin_last4: "1234", signed_at: "2026-03-01T00:00:00Z", expiry_date: "2029-12-31" }));
      expect(await state(b, "2029-12-31")).toMatchObject({ state: "valid" });
      expect(await state(b, "2030-01-01")).toMatchObject({ state: "expired" });
      const w9 = await newBroker();
      await submit(w9);
      expect(await state(w9, "2099-01-01")).toMatchObject({ state: "valid" });
      expect((await trySubmit(await newBroker(), form({ expiry_date: "2030-12-31" }))).code).toBe("23514"); // a W-9 has none
      expect((await trySubmit(await newBroker(), form({ form_type: "W-8BEN", is_us_person: false, entity_kind: "individual", country: "FR", tin_kind: "none", tin_last4: null, expiry_date: null }))).code).toBe("23514"); // a W-8 must
    });

    it("a new form supersedes the old; only one is valid at a time; a rejected form blocks again, with the Manager's reason", async () => {
      const b = await newBroker();
      const first = await submit(b);
      const second = await submit(b, form({ legal_name: "Acme Realty II LLC" }));
      expect((await ok("SELECT id, status FROM broker_tax_forms WHERE broker_id = $1 ORDER BY created_at", [b])).map((r) => [r.id, r.status])).toEqual([[first, "superseded"], [second, "valid"]]);
      expect((await fails("INSERT INTO broker_tax_forms (broker_id, form_type, is_us_person, entity_kind, legal_name, address, country, tin_kind, tin_last4, signed_name) VALUES ($1, 'W-9', true, 'entity', 'x', 'y', 'US', 'ein', '1111', 'z')", [b])).code).toBe("23505");
      expect((await tryRpc("SELECT reject_broker_tax_form($1, ' ', $2)", [second, ADMIN])).message).toContain("Say why");
      expect((await tryRpc("SELECT reject_broker_tax_form($1, 'Name doesn''t match', $2)", [second, BROKER_USER])).message).toContain("Only the Manager");
      await svc(async () => ok("SELECT reject_broker_tax_form($1, 'Name doesn''t match', $2)", [second, ADMIN]));
      expect(await state(b)).toMatchObject({ state: "rejected" });
      expect((await ok("SELECT tax_form_verified FROM brokers WHERE id = $1", [b]))[0]!.tax_form_verified).toBe(false);
      expect((await tryRpc("SELECT reject_broker_tax_form($1, 'again', $2)", [second, ADMIN])).message).toContain("Only a valid form");
      expect((await ok("SELECT review_reason, reviewed_by FROM broker_tax_forms WHERE id = $1", [second]))[0]).toMatchObject({ review_reason: "Name doesn't match", reviewed_by: ADMIN });
    });

    it("a broker's own login can't clear the gate: setting the old flag changes nothing, and the database keeps it in step", async () => {
      const b = await newBroker();
      const user = (await ok("SELECT auth_user_id FROM brokers WHERE id = $1", [b]))[0]!.auth_user_id as string;
      await asRole("authenticated", user, () => ok("UPDATE brokers SET tax_form_verified = true, tax_form_verified_at = now() WHERE id = $1", [b]));
      expect((await ok("SELECT tax_form_verified, tax_form_verified_at FROM brokers WHERE id = $1", [b]))[0]).toMatchObject({ tax_form_verified: false, tax_form_verified_at: null });
      expect(await state(b)).toMatchObject({ state: "missing" });
      await submit(b);
      expect((await ok("SELECT tax_form_verified FROM brokers WHERE id = $1", [b]))[0]!.tax_form_verified).toBe(true);
      await asRole("authenticated", user, () => ok("UPDATE brokers SET tax_form_verified = false WHERE id = $1", [b]));
      expect((await ok("SELECT tax_form_verified FROM brokers WHERE id = $1", [b]))[0]!.tax_form_verified).toBe(true);
    });

    it("the TIN is only ever encrypted: no login reads the secrets, the audit trail has no TIN, and nobody but the broker and the Manager reads the form", async () => {
      const b = await newBroker();
      const id = await submit(b);
      expect((await ok("SELECT ciphertext FROM broker_tax_form_secrets WHERE form_id = $1", [id])).length).toBe(1);
      expect((await asRole("authenticated", ADMIN, () => fails("SELECT * FROM broker_tax_form_secrets"))).message).toMatch(/permission denied/);
      expect((await asRole("authenticated", FOUNDER, () => fails("SELECT * FROM broker_tax_form_secrets"))).message).toMatch(/permission denied/);
      const log = JSON.stringify(await ok("SELECT metadata FROM audit_log WHERE action_type = 'broker_tax_form.submitted' AND entity_id = $1", [b]));
      expect(log).not.toMatch(/4321|ciphertext|Y2lwaGVy/);
      expect(log).toContain(id);
      const own = (await ok("SELECT auth_user_id FROM brokers WHERE id = $1", [b]))[0]!.auth_user_id as string;
      expect(await asRole("authenticated", own, () => ok("SELECT id FROM broker_tax_forms WHERE broker_id = $1", [b]))).toHaveLength(1);
      expect(await asRole("authenticated", AUTH1, () => ok("SELECT id FROM broker_tax_forms WHERE broker_id = $1", [b]))).toHaveLength(0);
      expect(await asRole("authenticated", ADMIN, () => ok("SELECT id FROM broker_tax_forms WHERE broker_id = $1", [b]))).toHaveLength(1);
      expect((await asRole("authenticated", own, () => fails("INSERT INTO broker_tax_forms (broker_id) VALUES (gen_random_uuid())"))).message).toMatch(/permission denied/);
      expect((await asRole("authenticated", own, () => fails("SELECT record_broker_tax_form(gen_random_uuid(), '{}'::jsonb, NULL, gen_random_uuid())"))).message).toMatch(/permission denied/);
    });
  });

  describe("the tax vault", () => {
    it("the founder has it; a regular admin doesn't until the founder grants it, with a reason; it can be revoked", async () => {
      const has = async (u: string) => (await svc(async () => ok("SELECT has_tax_vault_access($1) AS r", [u])))[0]!.r as boolean;
      expect(await has(FOUNDER)).toBe(true);
      expect(await has(ADMIN)).toBe(false);
      expect(await has(AUTH1)).toBe(false);
      expect((await tryRpc("SELECT grant_tax_vault_access($1, 'CPA liaison', $2)", [ADMIN, ADMIN2])).message).toContain("Only the founder");
      expect((await tryRpc("SELECT grant_tax_vault_access($1, ' ', $2)", [ADMIN, FOUNDER])).message).toContain("Say why");
      expect((await tryRpc("SELECT grant_tax_vault_access($1, 'x', $2)", [AUTH1, FOUNDER])).message).toContain("Only an admin");
      await rpc("SELECT grant_tax_vault_access($1, 'CPA liaison', $2) AS r", [ADMIN, FOUNDER]);
      expect(await has(ADMIN)).toBe(true);
      await rpc("SELECT grant_tax_vault_access($1, 'again', $2) AS r", [ADMIN, FOUNDER]);
      expect(await count("SELECT count(*) n FROM tax_vault_grants WHERE user_id = $1 AND revoked_at IS NULL", [ADMIN])).toBe(1);
      await svc(async () => ok("SELECT revoke_tax_vault_access($1, $2)", [ADMIN, FOUNDER]));
      expect(await has(ADMIN)).toBe(false);
      expect((await tryRpc("SELECT revoke_tax_vault_access($1, $2)", [ADMIN, ADMIN2])).message).toContain("Only the founder");
      const actions = (await ok("SELECT action_type FROM audit_log WHERE entity_type = 'user' AND action_type LIKE 'tax_vault.%' ORDER BY created_at")).map((r) => r.action_type);
      expect(actions).toEqual(expect.arrayContaining(["tax_vault.access_granted", "tax_vault.access_revoked"]));
    });
  });

  describe("influencers: paid directly, never through a Broker of Record", () => {
    const payee = (o: Record<string, unknown> = {}) => ({ name: "Ivy Influencer", tax_form_type: "W-9", country: "US", address: "5 Elm St, Austin, TX", tin_kind: "ssn", tin_last4: "6789", form_signed_on: "2026-01-10", ...o });
    const save = (o: Record<string, unknown> = {}, id: string | null = null, s: unknown = secret()) => svc(async () => ok("SELECT save_influencer_payee($1, $2::jsonb, $3::jsonb, $4) AS r", [id, J(payee(o)), J(s), ADMIN])).then((r) => r[0]!.r as string);
    const pay = (p: string, cents: number, date: string, memo = "Campaign") => rpc("SELECT record_influencer_payment($1, $2, $3::date, $4, $5) AS r", [p, cents, date, memo, ADMIN]) as Promise<string>;
    const summary = async (year: number) => (await svc(async () => ok("SELECT * FROM influencer_annual_summary($1)", [year]))) as Array<Record<string, any>>;

    it("a payee with a form is valid and a US person (W-9) or not (W-8); without a form they are 'missing'", async () => {
      const us = await save();
      const nonUs = await save({ name: "Noor Abroad", tax_form_type: "W-8BEN", country: "AE", tin_kind: "none", tin_last4: null, form_expiry_date: "2029-12-31" }, null, null);
      const none = await save({ name: "No Form", tax_form_type: null, country: null, tin_kind: null, tin_last4: null, form_signed_on: null }, null, null);
      const rows = await ok("SELECT id, tax_form_type, tax_form_status, is_us_person FROM influencer_payees WHERE id = ANY($1)", [[us, nonUs, none]]);
      expect(rows.find((r) => r.id === us)).toMatchObject({ tax_form_type: "W-9", tax_form_status: "valid", is_us_person: true });
      expect(rows.find((r) => r.id === nonUs)).toMatchObject({ tax_form_type: "W-8BEN", tax_form_status: "valid", is_us_person: false });
      expect(rows.find((r) => r.id === none)).toMatchObject({ tax_form_type: null, tax_form_status: "missing", is_us_person: null });
      expect((await tryRpc("SELECT save_influencer_payee(NULL, $1::jsonb, NULL, $2)", [J(payee()), AUTH1])).message).toContain("Only the Manager");
      expect((await tryRpc("SELECT save_influencer_payee(NULL, $1::jsonb, NULL, $2)", [J(payee({ tax_form_type: "1099" })), ADMIN])).code).toBe("23514");
    });

    it("the annual summary lists a payee at $600.00 or more: exactly $600.00 is in, $599.99 is out", async () => {
      const at = await save({ name: "At Threshold" });
      const under = await save({ name: "Under" });
      const over = await save({ name: "Over" });
      await pay(at, 60_000, "2026-03-01");
      await pay(under, 59_999, "2026-03-01");
      await pay(over, 100_000, "2026-03-01");
      const s = await summary(2026);
      expect(s.map((r) => [r.name, Number(r.total_cents), r.treatment])).toEqual([["At Threshold", 60_000, "1099_nec"], ["Over", 100_000, "1099_nec"], ["Under", 59_999, "below_threshold"]]);
      expect(s.filter((r) => r.treatment === "1099_nec").map((r) => r.name)).toEqual(["At Threshold", "Over"]);
    });

    it("the total is for the calendar year: payments add up across the year, other years don't count, a voided payment doesn't", async () => {
      const p = await save({ name: "Multi" });
      await pay(p, 30_000, "2022-01-02");
      await pay(p, 29_999, "2022-12-31");
      await pay(p, 500_000, "2021-12-31"); // last year
      const second = await pay(p, 1, "2022-06-01");
      const multi = async (y: number) => (await summary(y)).find((r) => r.name === "Multi");
      expect(await multi(2022)).toMatchObject({ name: "Multi", payments: 3, treatment: "1099_nec" });
      expect(Number((await multi(2022))!.total_cents)).toBe(60_000);
      await svc(async () => ok("SELECT void_influencer_payment($1, 'Entered twice', $2)", [second, ADMIN]));
      expect(Number((await multi(2022))!.total_cents)).toBe(59_999);
      expect((await multi(2022))!.treatment).toBe("below_threshold");
      expect((await summary(2021)).map((r) => Number(r.total_cents))).toEqual([500_000]);
      expect(await summary(2020)).toEqual([]);
    });

    it("a non-US payee on a W-8 gets NO 1099-NEC and is flagged for the CPA; a payee with no form is a 1099-NEC payee with the form flagged missing", async () => {
      const w8 = await save({ name: "Noor Abroad", tax_form_type: "W-8BEN", country: "AE", tin_kind: "none", tin_last4: null, form_expiry_date: "2029-12-31" }, null, null);
      const w8e = await save({ name: "Abroad Media Ltd", tax_form_type: "W-8BEN-E", country: "GB", tin_kind: "foreign_tin", tin_last4: "5555", form_expiry_date: "2029-12-31" });
      const none = await save({ name: "No Form", tax_form_type: null, country: null, tin_kind: null, tin_last4: null, form_signed_on: null }, null, null);
      for (const p of [w8, w8e, none]) await pay(p, 250_000, "2024-05-05");
      const s = await summary(2024);
      expect(s.find((r) => r.name === "Noor Abroad")).toMatchObject({ treatment: "w8_flag_for_cpa", issue: expect.stringContaining("no 1099-NEC") });
      expect(s.find((r) => r.name === "Abroad Media Ltd")).toMatchObject({ treatment: "w8_flag_for_cpa", tax_form_type: "W-8BEN-E" });
      expect(s.find((r) => r.name === "No Form")).toMatchObject({ treatment: "1099_nec", form_status: "missing", issue: expect.stringContaining("collect a W-9") });
      expect(s.filter((r) => r.treatment === "1099_nec").map((r) => r.name)).toEqual(["No Form"]);
    });

    it("payments are records: never edited or deleted, only voided with a reason; the amount and date have rules", async () => {
      const p = await save();
      const id = await pay(p, 5_000, "2026-02-02");
      expect((await fails("UPDATE influencer_payments SET amount_cents = 1 WHERE id = $1", [id])).message).toContain("can't be edited");
      expect((await fails("DELETE FROM influencer_payments WHERE id = $1", [id])).message).toContain("never deleted");
      expect((await tryRpc("SELECT void_influencer_payment($1, ' ', $2)", [id, ADMIN])).message).toContain("Say why");
      await svc(async () => ok("SELECT void_influencer_payment($1, 'Wrong payee', $2)", [id, ADMIN]));
      expect((await tryRpc("SELECT void_influencer_payment($1, 'again', $2)", [id, ADMIN])).message).toContain("already voided");
      expect((await tryRpc("SELECT record_influencer_payment($1, 0, '2026-02-02', 'x', $2)", [p, ADMIN])).message).toContain("above zero");
      expect((await tryRpc("SELECT record_influencer_payment($1, 100, '2999-01-01', 'x', $2)", [p, ADMIN])).message).toContain("future");
      expect((await tryRpc("SELECT record_influencer_payment($1, 100, '2026-02-02', 'x', $2)", [p, AUTH1])).message).toContain("Only the Manager");
      expect((await tryRpc("SELECT record_influencer_payment($1, 100, '2026-02-02', 'x', $2)", [randomUUID(), ADMIN])).message).toContain("Payee not found");
    });

    it("the TIN is encrypted only, and no login reads it; the audit trail carries no TIN; the section has nothing to do with brokers", async () => {
      const p = await save();
      expect((await ok("SELECT payee_id FROM influencer_payee_secrets WHERE payee_id = $1", [p])).length).toBe(1);
      expect((await asRole("authenticated", ADMIN, () => fails("SELECT * FROM influencer_payee_secrets"))).message).toMatch(/permission denied/);
      expect(JSON.stringify(await ok("SELECT metadata FROM audit_log WHERE entity_id = $1", [p]))).not.toMatch(/6789|ciphertext|Y2lwaGVy/);
      expect((await asRole("authenticated", AUTH1, () => ok("SELECT id FROM influencer_payees"))).length).toBe(0);
      expect((await asRole("authenticated", ADMIN, () => ok("SELECT id FROM influencer_payees"))).length).toBeGreaterThan(0);
      const sql = readFileSync("tax-forms.sql", "utf8");
      const section = sql.slice(sql.indexOf("-- 3. Influencers"), sql.indexOf("-- 4. The Tax-Ready Folder")).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      expect(section).not.toMatch(/broker/i);
    });
  });

  describe("the Tax-Ready Folder", () => {
    const llc = async () => {
      const id = (await ok("INSERT INTO properties (listing_price, address) VALUES (8000, '5632 Independence Ave') RETURNING id"))[0]!.id as string;
      let n = 1;
      for (const [h, kind, shares] of [[A1, "buyer", 4], [A2, "buyer", 3], [SELLER, "seller", 1]] as const) {
        for (let i = 0; i < shares; i++) await ok("INSERT INTO cap_table_entries (property_id, share_number, holder_type, buyer_account_id, seller_id) VALUES ($1, $2, $3, $4, $5)", [id, n++, kind === "buyer" ? "buyer_account" : "retained_seller", kind === "buyer" ? h : null, kind === "seller" ? h : null]);
      }
      return id;
    };
    const sections = (p: string, year = 2025) => rpc("SELECT tax_ready_sections($1, $2) AS r", [p, year]);
    /** Share 8 was the retained seller's; on 2025-06-15 it was sold to A2 for $2,000. */
    const withResale = async (p: string) => {
      const t = (await ok("INSERT INTO resale_transactions (price, status) VALUES (2000, 'completed') RETURNING id"))[0]!.id as string;
      await ok("UPDATE cap_table_entries SET holder_type = 'buyer_account', buyer_account_id = $2, seller_id = NULL WHERE property_id = $1 AND share_number = 8", [p, A2]);
      await ok("INSERT INTO cap_table_history (property_id, share_number, from_seller_id, to_buyer_account_id, resale_transaction_id, changed_at) VALUES ($1, 8, $2, $3, $4, '2025-06-15T12:00:00Z')", [p, SELLER, A2, t]);
      return t;
    };

    it("a year with no changes: every share held all year, and it reconciles", async () => {
      const p = await llc();
      const s = await sections(p, 2025);
      expect(s.reconciliation).toMatchObject({ total_shares: 8, year_end_shares: 8, days_in_year: 365, share_days_total: 2920, share_days_expected: 2920, reconciled: true });
      expect(s.shares).toHaveLength(8);
      expect(s.shares.every((x: any) => x.days_accounted_for === 365 && x.periods.length === 1)).toBe(true);
      expect(s.members.map((m: any) => [m.member_key, m.year_end_shares, m.share_days, m.percent_of_share_days])).toEqual([[A1, 4, 1460, "50.0000"], [A2, 3, 1095, "37.5000"], [SELLER, 1, 365, "12.5000"]]);
      expect(s.sales_1099s).toEqual([]);
      expect((await sections(p, 2024)).reconciliation).toMatchObject({ days_in_year: 366, share_days_total: 2928, reconciled: true }); // a leap year
    });

    it("a share sold mid-year is split into the holder's periods, by day, and still reconciles to the cap table; the 1099-S data is the sale", async () => {
      const p = await llc();
      const t = await withResale(p);
      const s = await sections(p, 2025);
      const share8 = s.shares.find((x: any) => x.share_number === 8);
      expect(share8.periods.map((x: any) => [x.holder_key, x.from, x.to, x.days])).toEqual([[SELLER, "2025-01-01", "2025-06-14", 165], [A2, "2025-06-15", "2025-12-31", 200]]);
      expect(share8.days_accounted_for).toBe(365);
      expect(share8.year_end_holder_key).toBe(A2);
      expect(s.reconciliation).toMatchObject({ share_days_total: 2920, reconciled: true });
      expect(s.members.map((m: any) => [m.member_key, m.year_end_shares, m.share_days])).toEqual([[A1, 4, 1460], [A2, 4, 1095 + 200], [SELLER, 0, 165]]);
      expect(s.transfers).toEqual([{ share_number: 8, date: "2025-06-15", transferor_member_key: SELLER, transferee_member_key: A2, resale_transaction_id: t }]);
      expect(s.sales_1099s).toEqual([{ resale_transaction_id: t, date: "2025-06-15", share_number: 8, transferor_member_key: SELLER, transferee_member_key: A2, gross_proceeds_cents: 200_000, property_address: "5632 Independence Ave" }]);
      // the year before the sale: still the seller's all year; and the year after: A2's
      expect((await sections(p, 2024)).members.find((m: any) => m.member_key === SELLER)).toMatchObject({ year_end_shares: 1, share_days: 366 });
      expect((await sections(p, 2026)).members.find((m: any) => m.member_key === SELLER)).toBeUndefined();
      expect((await sections(p, 2026)).reconciliation.reconciled).toBe(true);
      expect((await sections(p, 2024)).sales_1099s).toEqual([]);
    });

    it("a cancelled sale is not 1099-S data", async () => {
      const p = await llc();
      const t = await withResale(p);
      await ok("UPDATE resale_transactions SET status = 'cancelled' WHERE id = $1", [t]);
      expect((await sections(p)).sales_1099s).toEqual([]);
    });

    it("the folder is recorded only with the tax-vault permission (or by the scheduled job), after the year, as an immutable version", async () => {
      const p = await llc();
      const data = { year: 2025, ...(await sections(p)) };
      const rec = (id: string, actor: string | null, year = 2025) => tryRpc("SELECT record_tax_ready_folder($1, $2, $3, $4::jsonb, $5)", [id, p, year, J(data), actor]);
      expect((await rec(randomUUID(), ADMIN2)).message).toContain("access to the tax vault");
      expect((await rec(randomUUID(), AUTH1)).message).toContain("access to the tax vault");
      expect((await rec(randomUUID(), FOUNDER, new Date().getUTCFullYear())).message).toContain("after the year has ended");
      const id = randomUUID();
      const r = await rpc("SELECT record_tax_ready_folder($1, $2, 2025, $3::jsonb, $4) AS r", [id, p, J(data), FOUNDER]);
      expect(r).toMatchObject({ id, version: 1 });
      expect(r.hash).toBe((await ok("SELECT encode(sha256(convert_to($1::jsonb::text, 'UTF8')), 'hex') h", [J(data)]))[0]!.h);
      expect((await rpc("SELECT record_tax_ready_folder($1, $2, 2025, $3::jsonb, NULL) AS r", [randomUUID(), p, J(data)])).version).toBe(2); // the scheduled job
      for (const w of ["UPDATE tax_ready_folders SET data = '{}'::jsonb WHERE id = $1", "UPDATE tax_ready_folders SET version = 9 WHERE id = $1"]) expect((await fails(w, [id])).message, w).toContain("can't be edited");
      expect((await fails("DELETE FROM tax_ready_folders WHERE id = $1", [id])).message).toContain("never deleted");
      await rpc("SELECT set_tax_ready_files($1, $2::jsonb) AS r", [id, J([{ name: "a" }])]);
      await rpc("SELECT set_tax_ready_files($1, $2::jsonb) AS r", [id, J([])]);
      expect((await ok("SELECT files FROM tax_ready_folders WHERE id = $1", [id]))[0]!.files).toEqual([{ name: "a" }]);
      expect(await count("SELECT count(*) n FROM audit_log WHERE action_type = 'tax_ready.generated' AND entity_id = $1", [id])).toBe(1);
    });

    it("a regular admin can't read the folders, an agent or an owner can't, the founder and a granted admin can; no login writes them", async () => {
      const p = await llc();
      const id = randomUUID();
      await rpc("SELECT record_tax_ready_folder($1, $2, 2025, '{\"year\":2025}'::jsonb, $3) AS r", [id, p, FOUNDER]);
      const read = (u: string) => asRole("authenticated", u, () => ok("SELECT id FROM tax_ready_folders WHERE id = $1", [id]));
      expect(await read(ADMIN2)).toHaveLength(0);
      expect(await read(AUTH1)).toHaveLength(0);
      expect(await read(FOUNDER)).toHaveLength(1);
      await rpc("SELECT grant_tax_vault_access($1, 'CPA liaison', $2) AS r", [ADMIN2, FOUNDER]);
      expect(await read(ADMIN2)).toHaveLength(1);
      await svc(async () => ok("SELECT revoke_tax_vault_access($1, $2)", [ADMIN2, FOUNDER]));
      expect(await read(ADMIN2)).toHaveLength(0);
      for (const w of ["INSERT INTO tax_ready_folders (id) VALUES (gen_random_uuid())", "UPDATE tax_ready_folders SET files = '[]'::jsonb", "DELETE FROM tax_ready_folders"]) expect((await asRole("authenticated", FOUNDER, () => fails(w))).message, w).toMatch(/permission denied/);
      expect((await ok("SELECT id, public FROM storage.buckets WHERE id = 'tax-ready'")).map((b) => [b.id, b.public])).toEqual([["tax-ready", false]]);
    });

    it("the SQL makes no tax return: no K-1, 1065 or basis figure", () => {
      const code = readFileSync("tax-forms.sql", "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      expect(code).not.toMatch(/k-1|1065|schedule k|step.?up|basis_cents/i);
    });
  });
});
