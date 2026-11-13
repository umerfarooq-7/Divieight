/**
 * Month 6, Prompt 12, on a real Postgres (PGlite): the real bookkeeping, capital-accounts, bank-feed, books, expenses, capital-events,
 * expense-books, monthly-statements and then cpa-credential.sql, as written. One active CPA per LLC, the CPA's login reads and writes
 * nothing directly, rescinding ends access in the same instant, and a TIN is in scope only for the CPA's own property. Skips when PGlite
 * isn't installed.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
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
const A1 = U(11);
const A2 = U(12);
const SELLER = U(21);
const AUTH1 = U(31);
let CPA1 = U(51);
let CPA2 = U(52);
let seq = 200;

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

async function llc() {
  const id = (await ok("INSERT INTO properties (listing_price, address) VALUES (8000, '5632 Independence Ave') RETURNING id"))[0]!.id as string;
  let n = 1;
  for (const [h, kind, shares] of [[A1, "buyer", 4], [A2, "buyer", 3], [SELLER, "seller", 1]] as const) {
    for (let i = 0; i < shares; i++) await ok("INSERT INTO cap_table_entries (property_id, share_number, holder_type, buyer_account_id, seller_id) VALUES ($1, $2, $3, $4, $5)", [id, n++, kind === "buyer" ? "buyer_account" : "retained_seller", kind === "buyer" ? h : null, kind === "seller" ? h : null]);
  }
  await ok("INSERT INTO entity_genesis (property_id, cap_table_locked_at, llc_name) VALUES ($1, now(), 'LLC')", [id]);
  await pg!.exec("ALTER TABLE properties DISABLE TRIGGER properties_open_ledger");
  await svc(async () => ok("UPDATE properties SET deed_recorded_at = '2025-03-01T00:00:00Z' WHERE id = $1", [id]));
  await pg!.exec("ALTER TABLE properties ENABLE TRIGGER properties_open_ledger");
  expect((await rpc("SELECT open_property_ledger($1, $2) AS r", [id, ADMIN])).status).toBe("opened");
  return id;
}
const designate = (p: string, o: { name?: string; firm?: string; email?: string; license?: string | null; actor?: string } = {}) =>
  rpc("SELECT designate_cpa($1, $2, $3, $4, $5, $6) AS r", [p, o.name ?? "Pat Accountant", o.firm ?? "Accountant & Co", o.email ?? "pat@accountant.example", o.license ?? null, o.actor ?? ADMIN]) as Promise<string>;
const tryDesignate = (p: string, o: { email?: string; actor?: string } = {}) => tryRpc("SELECT designate_cpa($1, 'Pat', 'Firm', $2, NULL, $3)", [p, o.email ?? "pat@accountant.example", o.actor ?? ADMIN]);
const activate = async (id: string, user: string) => {
  await rpc("SELECT attach_cpa_login($1, $2) AS r", [id, user]);
  return (await svc(async () => ok("SELECT * FROM activate_cpa_designations($1)", [user]))) as Array<Record<string, any>>;
};
const isCpa = async (user: string, p: string) => (await svc(async () => ok("SELECT is_property_cpa($1, $2) AS r", [user, p])))[0]!.r as boolean;
const status = async (id: string) => (await ok("SELECT status FROM cpa_designations WHERE id = $1", [id]))[0]!.status as string;

describe.skipIf(!pg)("cpa-credential.sql", () => {
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
      CREATE TABLE resale_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), price numeric);
      CREATE TABLE cap_table_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, share_number int, from_buyer_account_id uuid, from_seller_id uuid, to_buyer_account_id uuid, to_seller_id uuid, resale_transaction_id uuid, changed_at timestamptz DEFAULT now());
      CREATE TABLE cpa_worksheet_flags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, resale_transaction_id uuid, flag_type text NOT NULL DEFAULT 'section_754_review', note text);
      CREATE TABLE closing_funds_obligations (property_id uuid, amount numeric, status text);
      CREATE TABLE owner_capital_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, user_id uuid NOT NULL, contributed_amount numeric NOT NULL DEFAULT 0, distributions_amount numeric NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (property_id, user_id));
      CREATE TABLE owner_capital_contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, user_id uuid NOT NULL, holder_key text NOT NULL, amount numeric NOT NULL CHECK (amount > 0), contribution_type text NOT NULL CHECK (contribution_type IN ('capital_call', 'expense')), source_allocation_id uuid, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE distribution_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, total_amount numeric NOT NULL, record_date date NOT NULL, status text NOT NULL DEFAULT 'posted', lines jsonb);
      CREATE TABLE maintenance_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, title text, vendor_name text, category text, actual_cost numeric, status text, updated_at timestamptz DEFAULT now(), expense_id uuid, expense_queued_at timestamptz, expense_queued_by uuid);
      CREATE TABLE votes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, status text, result_summary jsonb);
      CREATE TABLE member_w9 (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), buyer_account_id uuid NOT NULL, legal_name text, tin_kind text, tin_last4 text);
      CREATE TABLE user_roles (user_id uuid NOT NULL, role text NOT NULL);
      CREATE TABLE owners (user_id uuid NOT NULL, property_id uuid NOT NULL);
      CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
      CREATE FUNCTION public.is_property_owner(_user uuid, _property uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.owners WHERE user_id = _user AND property_id = _property) $$;
      GRANT ALL ON audit_log, owner_capital_accounts, owner_capital_contributions, distribution_events, cap_table_history, resale_transactions, cpa_worksheet_flags, cap_table_entries, maintenance_requests, votes TO service_role;
      GRANT SELECT ON properties, user_roles, owners, entity_genesis, buyer_accounts, closing_funds_obligations, member_w9 TO service_role; GRANT UPDATE ON properties TO service_role;
      GRANT SELECT ON buyer_accounts TO authenticated;
      GRANT EXECUTE ON FUNCTION public.has_role(uuid, text), public.is_property_owner(uuid, uuid) TO authenticated, service_role;
      INSERT INTO user_roles VALUES ('${ADMIN}', 'admin');
      INSERT INTO buyer_accounts VALUES ('${A1}', '${AUTH1}'), ('${A2}', '${U(32)}');
    `);
    for (const f of ["bookkeeping.sql", "capital-accounts.sql", "bank-feed.sql", "books.sql", "expenses.sql", "capital-events.sql", "expense-books.sql", "monthly-statements.sql"]) await pg!.exec(readFileSync(f, "utf8"));
    const sql = readFileSync("cpa-credential.sql", "utf8");
    await pg!.exec(sql);
    await pg!.exec(sql); // safe to run again
  }, 120_000);

  beforeEach(() => {
    // Every test has its own two CPA logins.
    CPA1 = U(seq++);
    CPA2 = U(seq++);
  });

  describe("designating: one active CPA per LLC", () => {
    it("the Manager designates a CPA with name, firm, email and an optional license number; the CPA starts invited", async () => {
      const p = await llc();
      const id = await designate(p, { license: "CPA-12345" });
      expect((await ok("SELECT cpa_name, firm, email, license_no, status, designated_by, auth_user_id FROM cpa_designations WHERE id = $1", [id]))[0]).toMatchObject({ cpa_name: "Pat Accountant", firm: "Accountant & Co", email: "pat@accountant.example", license_no: "CPA-12345", status: "invited", designated_by: ADMIN, auth_user_id: null });
      const q = await designate(await llc());
      expect((await ok("SELECT license_no FROM cpa_designations WHERE id = $1", [q]))[0]!.license_no).toBeNull();
      expect((await ok("SELECT metadata FROM audit_log WHERE action_type = 'cpa.designated' AND entity_id = $1", [id]))[0]!.metadata).toMatchObject({ property_id: p, cpa_name: "Pat Accountant", firm: "Accountant & Co" });
    });

    it("only the Manager; a valid email; a name and a firm", async () => {
      const p = await llc();
      expect((await tryDesignate(p, { actor: AUTH1 })).message).toContain("Only the Manager");
      expect((await tryDesignate(p, { email: "not-an-email" })).code).toBe("23514");
      expect((await tryRpc("SELECT designate_cpa($1, ' ', 'Firm', 'a@b.co', NULL, $2)", [p, ADMIN])).code).toBe("23514");
      expect((await tryRpc("SELECT designate_cpa($1, 'Pat', '', 'a@b.co', NULL, $2)", [p, ADMIN])).code).toBe("23514");
      expect((await tryRpc("SELECT designate_cpa($1, 'Pat', 'Firm', 'a@b.co', NULL, $2)", [U(999), ADMIN])).message).toContain("Property not found");
      expect(await count("SELECT count(*) n FROM cpa_designations WHERE property_id = $1", [p])).toBe(0);
    });

    it("an LLC has one CPA at a time: a second designation is refused while one is invited or active, however it is tried", async () => {
      const p = await llc();
      const id = await designate(p);
      expect((await tryDesignate(p, { email: "other@accountant.example" })).message).toContain("already has a designated CPA");
      await activate(id, CPA1);
      expect((await tryDesignate(p, { email: "other@accountant.example" })).message).toContain("already has a designated CPA");
      // and the database itself won't hold two, even around the function
      expect((await fails("INSERT INTO cpa_designations (property_id, cpa_name, firm, email, designated_by) VALUES ($1, 'X', 'Y', 'x@y.co', $2)", [p, ADMIN])).code).toBe("23505");
      expect(await count("SELECT count(*) n FROM cpa_designations WHERE property_id = $1 AND status IN ('invited', 'active')", [p])).toBe(1);
    });

    it("the same CPA can be designated for another LLC: the limit is per LLC", async () => {
      const a = await llc();
      const b = await llc();
      const ida = await designate(a);
      const idb = await designate(b);
      await activate(ida, CPA1);
      await activate(idb, CPA1);
      expect(await isCpa(CPA1, a)).toBe(true);
      expect(await isCpa(CPA1, b)).toBe(true);
    });
  });

  describe("the CPA's access is scoped to the designated LLC", () => {
    it("is on only after the CPA's first sign-in, and only for that property", async () => {
      const a = await llc();
      const b = await llc();
      const id = await designate(a);
      expect(await isCpa(CPA1, a)).toBe(false); // invited: no login yet, nothing readable
      await rpc("SELECT attach_cpa_login($1, $2) AS r", [id, CPA1]);
      expect(await isCpa(CPA1, a)).toBe(false); // a login that hasn't signed in isn't active
      const rows = await activate(id, CPA1);
      expect(rows.map((r) => [r.property_id, r.cpa_name])).toEqual([[a, "Pat Accountant"]]);
      expect(await isCpa(CPA1, a)).toBe(true);
      expect(await isCpa(CPA1, b)).toBe(false); // another LLC
      expect(await isCpa(CPA2, a)).toBe(false); // another person
      expect(await isCpa(AUTH1, a)).toBe(false); // an owner is not a CPA
      expect(await isCpa(ADMIN, a)).toBe(false); // the CPA test is only for designated CPAs
      await rpc("SELECT attach_cpa_login($1, $2) AS r", [id, CPA2]); // the login of a designation never changes
      expect(await isCpa(CPA2, a)).toBe(false);
      expect((await ok("SELECT activated_at FROM cpa_designations WHERE id = $1", [id]))[0]!.activated_at).not.toBeNull();
      expect(await count("SELECT count(*) n FROM audit_log WHERE action_type = 'cpa.activated' AND entity_id = $1", [id])).toBe(1);
    });

    it("the CPA's own login can read nothing directly: not the ledger, the capital ledger, the statements or any other table, even for their own LLC", async () => {
      const p = await llc();
      await rpc("SELECT post_entry($1, $2::jsonb, $3::jsonb) AS r", [p, JSON.stringify([{ code: "1000", debit_cents: 1000 }, { code: "4000", credit_cents: 1000 }]), JSON.stringify({ source: "manual", entry_date: "2025-04-10", memo: "Rent", created_by: ADMIN })]);
      await rpc("SELECT generate_monthly_statements($1, '2025-04', $2) AS r", [p, ADMIN]);
      await rpc("SELECT issue_monthly_statements($1, '2025-04', $2) AS r", [p, ADMIN]);
      const id = await designate(p);
      await activate(id, CPA1);
      for (const t of ["journal_entries", "journal_lines", "capital_account_ledger", "monthly_statements", "accounting_periods", "buyer_accounts_secret", "cpa_worksheet_flags", "member_w9"]) {
        const r = await asRole("authenticated", CPA1, () => fails(`SELECT count(*) FROM ${t}`));
        if (t === "buyer_accounts_secret") continue;
        const n = await asRole("authenticated", CPA1, async () => {
          try {
            return Number((await ok(`SELECT count(*) n FROM ${t}`))[0]!.n);
          } catch {
            return 0; // permission denied is nothing readable too
          }
        });
        expect(n, `${t} ${r.message}`).toBe(0);
      }
      // the Manager and an owner could read what exists
      expect(await count("SELECT count(*) n FROM journal_entries WHERE property_id = $1", [p])).toBeGreaterThan(0);
    });

    it("and can write nothing anywhere: every write is refused, including to their own designation", async () => {
      const p = await llc();
      const id = await designate(p);
      await activate(id, CPA1);
      const writes = [
        "INSERT INTO journal_entries (property_id, entry_date, source, period, coa_version_id) VALUES (gen_random_uuid(), '2025-01-01', 'manual', '2025-01', gen_random_uuid())",
        "UPDATE journal_entries SET memo = 'x'",
        "DELETE FROM journal_lines",
        "INSERT INTO monthly_statements (property_id, member_key, period, data_snapshot, snapshot_hash) VALUES (gen_random_uuid(), gen_random_uuid(), '2025-01', '{}', 'x')",
        "UPDATE monthly_statements SET manager_notes = 'x'",
        "UPDATE capital_account_ledger SET amount_cents = 0",
        "INSERT INTO cpa_designations (property_id, cpa_name, firm, email, designated_by) VALUES (gen_random_uuid(), 'a', 'b', 'a@b.co', gen_random_uuid())",
        "UPDATE cpa_designations SET status = 'rescinded'",
        "DELETE FROM cpa_designations",
        "INSERT INTO audit_log (action_type) VALUES ('forged')",
        "UPDATE audit_log SET action_type = 'x'",
      ];
      for (const w of writes) expect((await asRole("authenticated", CPA1, () => fails(w))).message, w).toMatch(/permission denied|new row violates|violates row-level/);
      // nor can they call the functions that designate, rescind or activate
      for (const f of ["SELECT designate_cpa(gen_random_uuid(), 'a', 'b', 'a@b.co', NULL, gen_random_uuid())", "SELECT rescind_cpa(gen_random_uuid(), 'x', gen_random_uuid())", "SELECT attach_cpa_login(gen_random_uuid(), gen_random_uuid())", "SELECT activate_cpa_designations(gen_random_uuid())", "SELECT is_property_cpa(gen_random_uuid(), gen_random_uuid())"])
        expect((await asRole("authenticated", CPA1, () => fails(f))).message, f).toContain("permission denied");
    });

    it("the CPA sees only their own active designation row", async () => {
      const a = await llc();
      const b = await llc();
      const ida = await designate(a);
      await designate(b, { email: "other@accountant.example" });
      await activate(ida, CPA1);
      const seen = await asRole("authenticated", CPA1, () => ok("SELECT property_id FROM cpa_designations"));
      expect(seen.map((r) => r.property_id)).toEqual([a]);
      expect((await asRole("authenticated", ADMIN, () => ok("SELECT id FROM cpa_designations"))).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("rescinding ends access at once", () => {
    it("the very next check says no; it needs a reason and the Manager; it is final and audit logged", async () => {
      const p = await llc();
      const id = await designate(p);
      await activate(id, CPA1);
      expect(await isCpa(CPA1, p)).toBe(true);
      expect((await tryRpc("SELECT rescind_cpa($1, ' ', $2)", [id, ADMIN])).message).toContain("Say why");
      expect((await tryRpc("SELECT rescind_cpa($1, 'Change of CPA', $2)", [id, AUTH1])).message).toContain("Only the Manager");
      expect(await isCpa(CPA1, p)).toBe(true);
      const r = await rpc("SELECT rescind_cpa($1, 'Change of CPA', $2, $3::jsonb) AS r", [id, ADMIN, JSON.stringify({ ip_address: "1.2.3.4" })]);
      expect(r).toMatchObject({ status: "rescinded", auth_user_id: CPA1, other_active: 0 });
      expect(await isCpa(CPA1, p)).toBe(false); // the same instant
      expect((await ok("SELECT status, reason, rescinded_by FROM cpa_designations WHERE id = $1", [id]))[0]).toMatchObject({ status: "rescinded", reason: "Change of CPA", rescinded_by: ADMIN });
      const log = (await ok("SELECT actor_id, metadata FROM audit_log WHERE action_type = 'cpa.rescinded' AND entity_id = $1", [id]))[0]!;
      expect(log).toMatchObject({ actor_id: ADMIN });
      expect(log.metadata).toMatchObject({ property_id: p, reason: "Change of CPA", was: "active", ip_address: "1.2.3.4" });
      // final: it can't be revived, edited or deleted, and signing in again doesn't reactivate it
      expect((await fails("UPDATE cpa_designations SET status = 'active', rescinded_at = NULL WHERE id = $1", [id])).message).toMatch(/stays rescinded|check/);
      expect((await fails("UPDATE cpa_designations SET status = 'active' WHERE id = $1", [id])).message).not.toBe("");
      expect((await fails("DELETE FROM cpa_designations WHERE id = $1", [id])).message).toContain("never deleted");
      expect((await svc(async () => ok("SELECT * FROM activate_cpa_designations($1)", [CPA1]))).length).toBe(0);
      expect(await isCpa(CPA1, p)).toBe(false);
      expect((await rpc("SELECT rescind_cpa($1, 'again', $2) AS r", [id, ADMIN])).status).toBe("already_rescinded");
    });

    it("an invited designation can be rescinded before the CPA ever signs in; then a new CPA can be designated", async () => {
      const p = await llc();
      const id = await designate(p);
      await rpc("SELECT rescind_cpa($1, 'Wrong person', $2) AS r", [id, ADMIN]);
      expect(await status(id)).toBe("rescinded");
      const next = await designate(p, { name: "New CPA", email: "new@accountant.example" });
      await activate(next, CPA2);
      expect(await isCpa(CPA2, p)).toBe(true);
      expect(await isCpa(CPA1, p)).toBe(false);
      expect(await count("SELECT count(*) n FROM cpa_designations WHERE property_id = $1 AND status = 'active'", [p])).toBe(1);
      expect(await count("SELECT count(*) n FROM cpa_designations WHERE property_id = $1", [p])).toBe(2); // the history stays
    });

    it("tells the app whether the same login still serves another LLC, so only an unneeded login is closed", async () => {
      const a = await llc();
      const b = await llc();
      const ida = await designate(a);
      const idb = await designate(b);
      await activate(ida, CPA1);
      await activate(idb, CPA1);
      expect((await rpc("SELECT rescind_cpa($1, 'Dissolution', $2) AS r", [ida, ADMIN])).other_active).toBe(1);
      expect(await isCpa(CPA1, a)).toBe(false);
      expect(await isCpa(CPA1, b)).toBe(true);
      expect((await rpc("SELECT rescind_cpa($1, 'Dissolution', $2) AS r", [idb, ADMIN])).other_active).toBe(0);
    });
  });

  describe("owners see who the CPA is, and nothing more", () => {
    it("name, firm and since, only for a member of that LLC (or the Manager), and no email or license number", async () => {
      const p = await llc();
      const other = await llc();
      await ok("INSERT INTO owners VALUES ($1, $2)", [AUTH1, p]);
      const id = await designate(p, { license: "CPA-777" });
      await activate(id, CPA1);
      const mine = await asRole("authenticated", AUTH1, () => ok("SELECT * FROM designated_cpa($1)", [p]));
      expect(mine).toHaveLength(1);
      expect(Object.keys(mine[0]!).sort()).toEqual(["cpa_name", "firm", "since"]);
      expect(mine[0]).toMatchObject({ cpa_name: "Pat Accountant", firm: "Accountant & Co" });
      expect(mine[0]!.since).not.toBeNull();
      expect(JSON.stringify(mine)).not.toMatch(/pat@accountant|CPA-777/);
      expect(await asRole("authenticated", AUTH1, () => ok("SELECT * FROM designated_cpa($1)", [other]))).toHaveLength(0);
      expect(await asRole("authenticated", U(88), () => ok("SELECT * FROM designated_cpa($1)", [p]))).toHaveLength(0);
      expect(await asRole("authenticated", ADMIN, () => ok("SELECT * FROM designated_cpa($1)", [p]))).toHaveLength(1);
      // the owner can't read the designation table itself
      expect(await asRole("authenticated", AUTH1, () => ok("SELECT id FROM cpa_designations"))).toHaveLength(0);
      await rpc("SELECT rescind_cpa($1, 'Change of CPA', $2) AS r", [id, ADMIN]);
      expect(await asRole("authenticated", AUTH1, () => ok("SELECT * FROM designated_cpa($1)", [p]))).toHaveLength(0);
    });
  });

  describe("a TIN is in scope only for the CPA's own LLC", () => {
    it("the W-9 of a member who holds shares in the CPA's LLC, and nobody else's", async () => {
      const a = await llc();
      const b = await llc();
      const outsider = U(13);
      await ok("INSERT INTO buyer_accounts VALUES ($1, $2)", [outsider, U(33)]);
      const w1 = (await ok("INSERT INTO member_w9 (buyer_account_id, legal_name, tin_kind, tin_last4) VALUES ($1, 'Ann Member', 'ssn', '1111') RETURNING id", [A1]))[0]!.id as string;
      const w3 = (await ok("INSERT INTO member_w9 (buyer_account_id, legal_name, tin_kind, tin_last4) VALUES ($1, 'Zed Elsewhere', 'ssn', '2222') RETURNING id", [outsider]))[0]!.id as string;
      const id = await designate(a);
      await activate(id, CPA1);
      const can = async (user: string, p: string, w: string) => (await svc(async () => ok("SELECT cpa_can_view_tin($1, $2, $3) AS r", [user, p, w])))[0]!.r as boolean;
      expect(await can(CPA1, a, w1)).toBe(true);
      expect(await can(CPA1, b, w1)).toBe(false); // the account holds shares in b too, but this CPA isn't designated to b
      expect(await can(CPA1, a, w3)).toBe(false); // a member of no share in this LLC
      expect(await can(CPA2, a, w1)).toBe(false); // another person
      expect(await can(CPA1, U(5), w1)).toBe(false);
      await rpc("SELECT rescind_cpa($1, 'Done', $2) AS r", [id, ADMIN]);
      expect(await can(CPA1, a, w1)).toBe(false); // rescinded: no TIN
    });
  });

  it("running cpa-credential.sql again keeps the data", async () => {
    expect(await count("SELECT count(*) n FROM cpa_designations")).toBeGreaterThan(5);
  });
});
