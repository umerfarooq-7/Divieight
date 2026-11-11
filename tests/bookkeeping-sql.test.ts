/**
 * Module 22, on a real Postgres (PGlite): bookkeeping.sql run exactly as it is written. The rules that matter live in the
 * database, so they are tested there: balanced entries, an append-only journal for every role, reversals, closed periods,
 * versioned charts, the audit trail and who can read.
 *
 * PGlite is a dev-only tool here (not a dependency of the app): when it isn't installed these tests skip.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { STANDARD_CHART } from "@/lib/bookkeeping";

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
const OWNER = U(2);
const OUTSIDER = U(3);
const READER = U(4);
const M1 = U(11); // a member (a buyer account)
const M2 = U(12);
const STRANGER = U(13);

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

let property = "";
async function newProperty(members: string[] = [M1, M2]) {
  const id = (await ok("INSERT INTO properties DEFAULT VALUES RETURNING id"))[0]!.id as string;
  for (const [i, m] of members.entries()) await ok("INSERT INTO cap_table_entries (property_id, share_number, holder_type, buyer_account_id) VALUES ($1, $2, 'buyer_account', $3)", [id, i + 1, m]);
  await ok("INSERT INTO owners (user_id, property_id) VALUES ($1, $2)", [OWNER, id]);
  return id;
}

/** Posts as the service role (how the server does it). */
const post = (property: string, lines: unknown[], meta: Record<string, unknown> = {}) =>
  asRole("service_role", null, () => ok("SELECT post_entry($1, $2::jsonb, $3::jsonb) AS id", [property, JSON.stringify(lines), JSON.stringify({ source: "manual", created_by: ADMIN, ...meta })]));
const tryPost = (property: string, lines: unknown[], meta: Record<string, unknown> = {}) =>
  asRole("service_role", null, () => fails("SELECT post_entry($1, $2::jsonb, $3::jsonb)", [property, JSON.stringify(lines), JSON.stringify({ source: "manual", created_by: ADMIN, ...meta })]));
const dr = (code: string, cents: number, member?: string) => ({ code, debit_cents: cents, ...(member ? { member_id: member } : {}) });
const cr = (code: string, cents: number, member?: string) => ({ code, credit_cents: cents, ...(member ? { member_id: member } : {}) });
const contribution = (cents: number, member = M1) => [dr("1000", cents), cr("3000", cents, member)];
const expense = (cents: number) => [dr("6400", cents), cr("1000", cents)];
const trial = (property: string, asOf = "2100-01-01") => asRole("service_role", null, () => ok("SELECT * FROM trial_balance($1, $2)", [property, asOf]));
const sumBalance = (rows: Array<Record<string, any>>, code: string) => rows.filter((r) => r.code === code).reduce((s, r) => s + Number(r.balance_cents), 0);
const entryId = (rows: Array<Record<string, any>>) => rows[0]!.id as string;

describe.skipIf(!pg)("bookkeeping.sql", () => {
  beforeAll(async () => {
    await pg!.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role; GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
      CREATE TABLE properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid, actor_type text NOT NULL DEFAULT 'seller', action_type text NOT NULL, entity_type text, entity_id text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE cap_table_entries (property_id uuid, share_number int, holder_type text, buyer_account_id uuid, seller_id uuid);
      CREATE TABLE cap_table_history (property_id uuid, from_buyer_account_id uuid, from_seller_id uuid, to_buyer_account_id uuid, to_seller_id uuid);
      CREATE TABLE user_roles (user_id uuid NOT NULL, role text NOT NULL);
      CREATE TABLE owners (user_id uuid NOT NULL, property_id uuid NOT NULL);
      CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
      CREATE FUNCTION public.is_property_owner(_user uuid, _property uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.owners WHERE user_id = _user AND property_id = _property) $$;
      GRANT ALL ON audit_log TO service_role; GRANT SELECT ON properties, cap_table_entries, cap_table_history, user_roles, owners, audit_log TO service_role;
      GRANT EXECUTE ON FUNCTION public.has_role(uuid, text), public.is_property_owner(uuid, uuid) TO authenticated, service_role;
      INSERT INTO user_roles VALUES ('${ADMIN}', 'admin');
    `);
    const sql = readFileSync("bookkeeping.sql", "utf8");
    await pg!.exec(sql);
    await pg!.exec(sql); // safe to re-run
    property = await newProperty();
  }, 60_000);

  describe("the chart", () => {
    it("is the standard chart, and the same one the app defines", async () => {
      const rows = await ok("SELECT a.code, a.name, a.type, a.normal_balance, a.is_member_control FROM coa_accounts a JOIN coa_versions v ON v.id = a.version_id WHERE v.version = 1 ORDER BY a.code");
      expect(rows.map((r) => [r.code, r.name, r.type, r.normal_balance, r.is_member_control])).toEqual(STANDARD_CHART.map((a) => [a.code, a.name, a.type, a.normalBalance, a.isMemberControl]));
      expect(await ok("SELECT count(*)::int n FROM coa_versions")).toEqual([{ n: 1 }]);
    });

    it("has every account the brief names, per member where it should be", async () => {
      const names = (await ok("SELECT name FROM coa_accounts")).map((r) => r.name).join(" | ");
      for (const n of ["Cash (LLC operating account)", "Prepaid and Other Assets", "Property Tax Expense", "Hazard Insurance Expense", "Umbrella Insurance Expense", "HOA Dues Expense", "Utilities Expense", "Repairs and Maintenance Expense", "Property Management Fee Expense", "Cleaning and Turnover Expense", "Furnishings and Capital Improvements", "Property (acquisition cost)", "Accumulated Depreciation", "Other Income", "Member Capital Contributions", "Member Distributions", "Capital Account"]) expect(names).toContain(n);
      const member = (await ok("SELECT code FROM coa_accounts WHERE is_member_control ORDER BY code")).map((r) => r.code);
      expect(member).toEqual(["3000", "3100", "3200"]);
      // Furnishings and improvements are capitalized assets, not expenses.
      expect((await ok("SELECT type FROM coa_accounts WHERE code = '1210'"))[0]!.type).toBe("asset");
    });

    it("has NO short-term-rental revenue account, and the database refuses one (COOA Section 10)", async () => {
      const incomes = (await ok("SELECT name FROM coa_accounts WHERE type = 'income'")).map((r) => r.name);
      expect(incomes).toEqual(["Other Income (incidental LLC income only)"]);
      expect(incomes.join(" ")).not.toMatch(/rental|short|str|airbnb|vrbo/i);
      const r = await asRole("service_role", null, () => fails("SELECT create_coa_version('x', current_date, '[{\"code\":\"4100\",\"name\":\"Short-Term Rental Revenue\",\"type\":\"income\",\"normal_balance\":\"credit\"}]'::jsonb)"));
      expect(r.message).toMatch(/no short-term-rental revenue account/);
      expect(await ok("SELECT count(*)::int n FROM coa_versions")).toEqual([{ n: 1 }]); // the whole revision rolled back
    });

    it("a chart is never edited or deleted, by any role", async () => {
      expect((await fails("UPDATE coa_accounts SET name = 'x'")).message).toMatch(/never edited/);
      expect((await fails("DELETE FROM coa_accounts")).message).toMatch(/never edited/);
      expect((await fails("UPDATE coa_versions SET notes = 'x'")).message).toMatch(/never edited or deleted/);
      expect((await asRole("service_role", null, () => fails("UPDATE coa_accounts SET name = 'x'"))).code).toBe("42501");
      expect((await asRole("authenticated", OWNER, () => fails("DELETE FROM coa_accounts"))).code).toBe("42501");
    });
  });

  describe("posting", () => {
    it("posts a balanced entry, in integer cents, and writes the Audit Vault entry with the time to the millisecond and where from", async () => {
      const p = await newProperty();
      const id = entryId(await post(p, contribution(1_000_000), { memo: "Initial capital", source_ref: "cc-1", ip_address: "203.0.113.7", user_agent: "test-agent" }));
      const e = (await ok("SELECT * FROM journal_entries WHERE id = $1", [id]))[0]!;
      expect(e).toMatchObject({ property_id: p, source: "manual", source_ref: "cc-1", memo: "Initial capital", status: "posted", created_by: ADMIN });
      expect(e.period).toMatch(/^\d{4}-\d{2}$/);
      const lines = await ok("SELECT l.debit_cents, l.credit_cents, l.member_id, a.code FROM journal_lines l JOIN coa_accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY a.code", [id]);
      expect(lines.map((l) => [l.code, Number(l.debit_cents), Number(l.credit_cents), l.member_id])).toEqual([["1000", 1_000_000, 0, null], ["3000", 0, 1_000_000, M1]]);
      const audit = (await ok("SELECT * FROM audit_log WHERE entity_id = $1 AND action_type = 'ledger.entry_posted'", [id]))[0]!;
      expect(audit.actor_id).toBe(ADMIN);
      expect(audit.metadata).toMatchObject({ property_id: p, source: "manual", lines: 2, total_cents: 1_000_000, coa_version: 1, ip_address: "203.0.113.7", user_agent: "test-agent" });
      expect(audit.metadata.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("rejects an unbalanced entry, and leaves nothing behind", async () => {
      const p = await newProperty();
      const r = await tryPost(p, [dr("1000", 10_000), cr("3000", 9_999, M1)]);
      expect(r.message).toMatch(/unbalanced: debits 10000 cents, credits 9999 cents/);
      expect(await ok("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p])).toEqual([{ n: 0 }]);
      expect(await ok("SELECT count(*)::int n FROM audit_log WHERE metadata->>'property_id' = $1", [p])).toEqual([{ n: 0 }]);
    });

    it("the database refuses an unbalanced entry on its own, even if something writes it directly", async () => {
      const p = await newProperty();
      const cash = (await ok("SELECT a.id FROM coa_accounts a WHERE a.code = '1000'"))[0]!.id;
      const rent = (await ok("SELECT a.id FROM coa_accounts a WHERE a.code = '6400'"))[0]!.id;
      const v = (await ok("SELECT id FROM coa_versions WHERE version = 1"))[0]!.id;
      const attempt = async (sql: string) => {
        try {
          await pg!.exec(sql);
          return { message: "" };
        } catch (e) {
          await pg!.exec("ROLLBACK");
          return { message: (e as Error).message };
        }
      };
      const r = await attempt(`BEGIN; INSERT INTO journal_entries (id, property_id, entry_date, source, coa_version_id, period) VALUES ('${U(900)}', '${p}', current_date, 'manual', '${v}', to_char(current_date, 'YYYY-MM'));
        INSERT INTO journal_lines (entry_id, account_id, debit_cents) VALUES ('${U(900)}', '${rent}', 500);
        INSERT INTO journal_lines (entry_id, account_id, credit_cents) VALUES ('${U(900)}', '${cash}', 400); COMMIT;`);
      expect(r.message).toMatch(/unbalanced/);
      expect(await ok("SELECT count(*)::int n FROM journal_entries WHERE id = $1", [U(900)])).toEqual([{ n: 0 }]);
      const empty = await attempt(`BEGIN; INSERT INTO journal_entries (property_id, entry_date, source, coa_version_id, period) VALUES ('${p}', current_date, 'manual', '${v}', to_char(current_date, 'YYYY-MM')); COMMIT;`);
      expect(empty.message).toMatch(/at least two lines/);
    });

    it("refuses bad lines: fewer than two, both sides or neither, fractions, negatives, unknown or retired accounts, an unknown source", async () => {
      const p = await newProperty();
      expect((await tryPost(p, [dr("1000", 100)])).message).toMatch(/at least two lines/);
      expect((await tryPost(p, [{ code: "1000", debit_cents: 100, credit_cents: 100 }, cr("6400", 0)])).message).toMatch(/a debit or a credit/);
      expect((await tryPost(p, [dr("1000", 0), cr("6400", 0)])).message).toMatch(/a debit or a credit/);
      expect((await tryPost(p, [dr("1000", 100.5), cr("6400", 100.5)])).message).toMatch(/whole numbers of cents/);
      expect((await tryPost(p, [dr("1000", -100), cr("6400", -100)])).message).toMatch(/a debit or a credit/);
      expect((await tryPost(p, [dr("9999", 100), cr("1000", 100)])).message).toMatch(/doesn't exist/);
      expect((await tryPost(p, expense(100), { source: "stripe" })).message).toMatch(/Say where this entry comes from/);
      expect((await tryPost(U(777), expense(100))).message).toMatch(/Property not found/);
      expect(await ok("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p])).toEqual([{ n: 0 }]);
    });

    it("member accounts need a member who is, or was, a member of this property; other accounts take none", async () => {
      const p = await newProperty();
      expect((await tryPost(p, [dr("1000", 100), cr("3000", 100)])).message).toMatch(/kept per member: name the member/);
      expect((await tryPost(p, [dr("1000", 100, M1), cr("3000", 100, M1)])).message).toMatch(/isn't kept per member/);
      expect((await tryPost(p, contribution(100, STRANGER))).message).toMatch(/isn't a member of this property/);
      // A former member (they sold their share) still can be named: their capital account stays on the books.
      await ok("INSERT INTO cap_table_history (property_id, from_buyer_account_id, to_buyer_account_id) VALUES ($1, $2, $3)", [p, STRANGER, M1]);
      expect(await post(p, contribution(100, STRANGER))).toHaveLength(1);
      expect(await post(p, contribution(250, M2))).toHaveLength(1);
    });

    it("an account is named by id or by code", async () => {
      const p = await newProperty();
      const cash = (await ok("SELECT id FROM coa_accounts WHERE code = '1000'"))[0]!.id;
      const tax = (await ok("SELECT id FROM coa_accounts WHERE code = '6000'"))[0]!.id;
      expect(await post(p, [{ account_id: tax, debit_cents: 700 }, { account_id: cash, credit_cents: 700 }])).toHaveLength(1);
    });
  });

  describe("append-only", () => {
    let entry = "";
    beforeAll(async () => {
      const p = await newProperty();
      entry = entryId(await post(p, contribution(5_000)));
    });

    it("no UPDATE or DELETE on the journal for any role: the owner of the tables, the service role, a signed-in member, an admin, anonymous", async () => {
      const statements = [
        "UPDATE journal_entries SET memo = 'tampered'",
        "DELETE FROM journal_entries",
        "UPDATE journal_lines SET debit_cents = 1 WHERE debit_cents > 0",
        "UPDATE journal_lines SET credit_cents = 1 WHERE credit_cents > 0",
        "DELETE FROM journal_lines",
        "TRUNCATE journal_entries CASCADE",
        "TRUNCATE journal_lines",
      ];
      // The table owner (a superuser here): the trigger refuses.
      for (const s of statements) expect((await fails(s)).message, s).toMatch(/append-only/);
      // Every other role: no privilege at all.
      for (const [role, uid] of [["service_role", null], ["authenticated", OWNER], ["authenticated", ADMIN], ["anon", null]] as const) {
        for (const s of statements) expect((await asRole(role, uid, () => fails(s))).code, `${role}: ${s}`).toBe("42501");
      }
      const e = (await ok("SELECT memo FROM journal_entries WHERE id = $1", [entry]))[0]!;
      expect(e.memo).toBeNull();
      expect(Number((await ok("SELECT sum(debit_cents) s FROM journal_lines WHERE entry_id = $1", [entry]))[0]!.s)).toBe(5_000);
    });

    it("nobody inserts into the journal directly either: only the functions do", async () => {
      for (const [role, uid] of [["service_role", null], ["authenticated", ADMIN], ["anon", null]] as const) {
        expect((await asRole(role, uid, () => fails(`INSERT INTO journal_entries (property_id, entry_date, source, coa_version_id, period) VALUES ('${property}', current_date, 'manual', '${U(1)}', '2026-01')`))).code, role).toBe("42501");
        expect((await asRole(role, uid, () => fails(`INSERT INTO journal_lines (entry_id, account_id, debit_cents) VALUES ('${entry}', '${U(1)}', 1)`))).code, role).toBe("42501");
      }
    });

    it("a signed-in user can't call the posting functions; only the server (service role) can", async () => {
      const call = `SELECT post_entry('${property}', '[]'::jsonb, '{}'::jsonb)`;
      expect((await asRole("authenticated", ADMIN, () => fails(call))).code).toBe("42501");
      expect((await asRole("anon", null, () => fails(call))).code).toBe("42501");
      expect((await asRole("authenticated", ADMIN, () => fails(`SELECT reverse_entry('${entry}', 'x')`))).code).toBe("42501");
      expect((await asRole("authenticated", ADMIN, () => fails(`SELECT close_period('${property}', 2026, 1, '${ADMIN}')`))).code).toBe("42501");
    });
  });

  describe("reversals", () => {
    it("reverse_entry makes a new linked entry with every line flipped, and the trial balance nets to zero for it", async () => {
      const p = await newProperty();
      await post(p, contribution(100_000));
      const bad = entryId(await post(p, expense(30_000), { memo: "Roof, posted twice by mistake", source_ref: "inv-9" }));
      expect(sumBalance(await trial(p), "6400")).toBe(30_000);
      expect(sumBalance(await trial(p), "1000")).toBe(70_000);
      const rev = (await asRole("service_role", null, () => ok("SELECT reverse_entry($1, $2, $3::jsonb) AS id", [bad, "Duplicate of inv-9", JSON.stringify({ created_by: ADMIN, ip_address: "198.51.100.4", user_agent: "ua" })])))[0]!.id as string;
      const r = (await ok("SELECT * FROM journal_entries WHERE id = $1", [rev]))[0]!;
      expect(r).toMatchObject({ reverses_entry_id: bad, reversal_reason: "Duplicate of inv-9", property_id: p, created_by: ADMIN, source: "manual", source_ref: "inv-9" });
      expect(r.memo).toContain("Reversal of " + bad);
      const orig = (await ok("SELECT coa_version_id FROM journal_entries WHERE id = $1", [bad]))[0]!;
      expect(r.coa_version_id).toBe(orig.coa_version_id);
      const flipped = await ok("SELECT a.code, l.debit_cents, l.credit_cents FROM journal_lines l JOIN coa_accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY a.code", [rev]);
      expect(flipped.map((l) => [l.code, Number(l.debit_cents), Number(l.credit_cents)])).toEqual([["1000", 30_000, 0], ["6400", 0, 30_000]]);
      // The original is still there, untouched; the trial balance nets.
      expect(Number((await ok("SELECT count(*)::int n FROM journal_lines WHERE entry_id = $1", [bad]))[0]!.n)).toBe(2);
      const tb = await trial(p);
      expect(sumBalance(tb, "6400")).toBe(0);
      expect(sumBalance(tb, "1000")).toBe(100_000);
      expect(tb.reduce((s, x) => s + Number(x.debit_cents), 0)).toBe(tb.reduce((s, x) => s + Number(x.credit_cents), 0));
      // Derived state, never stored.
      const state = await ok("SELECT entry_id, effective_status, reversed_by_entry_id FROM journal_entry_state WHERE property_id = $1 ORDER BY entry_id", [p]);
      expect(state.find((s) => s.entry_id === bad)).toMatchObject({ effective_status: "reversed", reversed_by_entry_id: rev });
      expect(state.find((s) => s.entry_id === rev)).toMatchObject({ effective_status: "posted" });
      expect((await ok("SELECT status FROM journal_entries WHERE id = $1", [bad]))[0]!.status).toBe("posted");
      const audit = (await ok("SELECT * FROM audit_log WHERE entity_id = $1 AND action_type = 'ledger.entry_reversed'", [rev]))[0]!;
      expect(audit.metadata).toMatchObject({ reverses_entry_id: bad, reason: "Duplicate of inv-9", total_cents: 30_000, ip_address: "198.51.100.4" });
      expect(audit.metadata.at).toMatch(/\.\d{3}Z$/);
    });

    it("needs a reason, can't be done twice, and a reversal can't itself be reversed", async () => {
      const p = await newProperty();
      const id = entryId(await post(p, expense(500)));
      const call = (entry: string, reason: string) => asRole("service_role", null, () => fails("SELECT reverse_entry($1, $2, $3::jsonb)", [entry, reason, JSON.stringify({ created_by: ADMIN })]));
      expect((await call(id, "  ")).message).toMatch(/Say why/);
      expect((await call(U(555), "x")).message).toMatch(/Entry not found/);
      const rev = (await asRole("service_role", null, () => ok("SELECT reverse_entry($1, 'mistake', $2::jsonb) AS id", [id, JSON.stringify({ created_by: ADMIN })])))[0]!.id as string;
      expect((await call(id, "again")).message).toMatch(/already reversed/);
      expect((await call(rev, "undo the undo")).message).toMatch(/can't itself be reversed/);
      expect(await ok("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p])).toEqual([{ n: 2 }]);
    });

    it("reversing a per-member entry reverses that member's balance", async () => {
      const p = await newProperty();
      const id = entryId(await post(p, contribution(40_000, M2)));
      await asRole("service_role", null, () => ok("SELECT reverse_entry($1, 'wrong member', $2::jsonb)", [id, JSON.stringify({ created_by: ADMIN })]));
      const tb = await trial(p);
      expect(tb.filter((r) => r.code === "3000").map((r) => [r.member_id, Number(r.balance_cents)])).toEqual([[M2, 0]]);
    });
  });

  describe("the trial balance and the account ledger", () => {
    it("the trial balance balances, is as of a date, and carries each member's own accounts", async () => {
      const p = await newProperty();
      await post(p, contribution(300_000, M1), { entry_date: "2026-01-10" });
      await post(p, contribution(200_000, M2), { entry_date: "2026-01-20" });
      await post(p, expense(120_000), { entry_date: "2026-02-05", source: "expense" });
      await post(p, [dr("3100", 50_000, M1), cr("1000", 50_000)], { entry_date: "2026-03-01", source: "distribution" });
      const tb = await trial(p, "2026-12-31");
      expect(tb.reduce((s, x) => s + Number(x.debit_cents), 0)).toBe(tb.reduce((s, x) => s + Number(x.credit_cents), 0));
      expect(sumBalance(tb, "1000")).toBe(300_000 + 200_000 - 120_000 - 50_000);
      expect(tb.filter((r) => r.code === "3000").map((r) => [r.member_id, Number(r.balance_cents)]).sort()).toEqual([[M1, 300_000], [M2, 200_000]].sort());
      expect(tb.filter((r) => r.code === "3100").map((r) => [r.member_id, Number(r.balance_cents)])).toEqual([[M1, 50_000]]);
      const early = await trial(p, "2026-01-31");
      expect(sumBalance(early, "1000")).toBe(500_000);
      expect(early.some((r) => r.code === "6400")).toBe(false);
      expect(await trial(p, "2025-12-31")).toEqual([]);
    });

    it("another property's entries never appear", async () => {
      const a = await newProperty();
      const b = await newProperty();
      await post(a, contribution(111));
      expect(await trial(b)).toEqual([]);
    });

    it("the account ledger shows the activity with a running balance, from the start even for a later range", async () => {
      const p = await newProperty();
      await post(p, contribution(100_000), { entry_date: "2026-01-05" });
      await post(p, expense(30_000), { entry_date: "2026-02-05" });
      await post(p, expense(20_000), { entry_date: "2026-03-05" });
      const cash = (await ok("SELECT id FROM coa_accounts WHERE code = '1000'"))[0]!.id;
      const all = await asRole("service_role", null, () => ok("SELECT * FROM account_ledger($1, $2)", [p, cash]));
      expect(all.map((r) => [Number(r.debit_cents), Number(r.credit_cents), Number(r.running_balance_cents)])).toEqual([[100_000, 0, 100_000], [0, 30_000, 70_000], [0, 20_000, 50_000]]);
      const later = await asRole("service_role", null, () => ok("SELECT * FROM account_ledger($1, $2, '2026-03-01', '2026-03-31')", [p, cash]));
      expect(later.map((r) => Number(r.running_balance_cents))).toEqual([50_000]);
      // A credit-normal account runs the other way.
      const capital = (await ok("SELECT id FROM coa_accounts WHERE code = '3000'"))[0]!.id;
      const cap = await asRole("service_role", null, () => ok("SELECT * FROM account_ledger($1, $2)", [p, capital]));
      expect(cap.map((r) => [r.member_id, Number(r.running_balance_cents)])).toEqual([[M1, 100_000]]);
    });
  });

  describe("accounting periods", () => {
    it("a closed period refuses posting, with the reason; other months and other properties are unaffected", async () => {
      const p = await newProperty();
      const other = await newProperty();
      await post(p, expense(1_000), { entry_date: "2026-01-15" });
      await asRole("service_role", null, () => ok("SELECT close_period($1, 2026, 1, $2, $3::jsonb)", [p, ADMIN, JSON.stringify({ ip_address: "203.0.113.9" })]));
      expect((await tryPost(p, expense(500), { entry_date: "2026-01-20" })).message).toMatch(/period 2026-01 is closed\. Only a flagged adjustment by the Manager, with a reason/);
      expect(await post(p, expense(500), { entry_date: "2026-02-01" })).toHaveLength(1);
      expect(await post(other, expense(500), { entry_date: "2026-01-20" })).toHaveLength(1);
      const row = (await ok("SELECT * FROM accounting_periods WHERE property_id = $1", [p]))[0]!;
      expect(row).toMatchObject({ year: 2026, month: 1, status: "closed", closed_by: ADMIN });
      expect(row.closed_at).toBeTruthy();
      const audit = (await ok("SELECT * FROM audit_log WHERE action_type = 'ledger.period_closed' AND entity_id = $1", [p]))[0]!;
      expect(audit.metadata).toMatchObject({ period: "2026-01", ip_address: "203.0.113.9" });
    });

    it("only a flagged adjustment by the Manager, with a reason, posts to a closed period, and it is logged", async () => {
      const p = await newProperty();
      await asRole("service_role", null, () => ok("SELECT close_period($1, 2026, 3, $2)", [p, ADMIN]));
      const date = { entry_date: "2026-03-10" };
      expect((await tryPost(p, expense(900), { ...date, is_adjustment: true })).message).toMatch(/adjustment needs a reason/);
      expect((await tryPost(p, expense(900), { ...date, is_adjustment: true, adjustment_reason: "  " })).message).toMatch(/adjustment needs a reason/);
      expect((await tryPost(p, expense(900), { ...date, is_adjustment: true, adjustment_reason: "Late invoice", created_by: OWNER })).message).toMatch(/Only the Manager can post an adjustment/);
      expect((await tryPost(p, expense(900), { ...date, is_adjustment: true, adjustment_reason: "Late invoice", created_by: null })).message).toMatch(/Only the Manager/);
      const id = entryId(await post(p, expense(900), { ...date, is_adjustment: true, adjustment_reason: "Late insurance invoice found" }));
      expect((await ok("SELECT is_adjustment, adjustment_reason FROM journal_entries WHERE id = $1", [id]))[0]).toEqual({ is_adjustment: true, adjustment_reason: "Late insurance invoice found" });
      const log = await ok("SELECT action_type, metadata FROM audit_log WHERE entity_id = $1 ORDER BY action_type", [id]);
      expect(log.map((l) => l.action_type)).toEqual(["ledger.adjustment_posted", "ledger.entry_posted"]);
      expect(log[0]!.metadata).toMatchObject({ reason: "Late insurance invoice found", period: "2026-03" });
      // A flagged adjustment can also reverse into a closed period.
      const today = new Date().toISOString().slice(0, 10);
      const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
      await asRole("service_role", null, () => ok("SELECT close_period($1, $2, $3, $4)", [p, y, m, ADMIN]));
      const live = entryId(await post(p, expense(100), { entry_date: `${y}-${String(m).padStart(2, "0")}-01`, is_adjustment: true, adjustment_reason: "x" }));
      const noFlag = await asRole("service_role", null, () => fails("SELECT reverse_entry($1, 'x', $2::jsonb)", [live, JSON.stringify({ created_by: ADMIN })]));
      expect(noFlag.message).toMatch(/is closed/);
      const flagged = await asRole("service_role", null, () => fails("SELECT reverse_entry($1, 'x', $2::jsonb)", [live, JSON.stringify({ created_by: ADMIN, is_adjustment: true, adjustment_reason: "Correcting after close" })]));
      expect(flagged.message).toBe("");
    });

    it("only the Manager closes a period, a period closes once, and a closed period stays closed", async () => {
      const p = await newProperty();
      const close = (by: string) => asRole("service_role", null, () => fails("SELECT close_period($1, 2026, 5, $2)", [p, by]));
      expect((await close(OWNER)).message).toMatch(/Only the Manager can close a period/);
      expect((await close(ADMIN)).message).toBe("");
      expect((await close(ADMIN)).message).toMatch(/already closed/);
      expect((await fails("UPDATE accounting_periods SET status = 'open'")).message).toMatch(/stays closed/);
      expect((await fails("DELETE FROM accounting_periods")).message).toMatch(/never deleted/);
      expect((await asRole("service_role", null, () => fails("UPDATE accounting_periods SET status = 'open'"))).code).toBe("42501");
    });
  });

  describe("chart versions", () => {
    it("revising the chart makes a new version; version-1 entries keep their original accounts and are never remapped", async () => {
      const p = await newProperty();
      const old = entryId(await post(p, expense(10_000), { entry_date: "2026-01-10" }));
      const v2 = (await asRole("service_role", null, () => ok("SELECT create_coa_version($1, DATE '2026-06-01', $2::jsonb) AS id", ["Rename repairs, retire cleaning, add Pest Control", JSON.stringify([{ code: "6400", name: "Repairs and Upkeep Expense" }, { code: "6600", active: false }, { code: "6700", name: "Pest Control Expense", type: "expense", normal_balance: "debit" }])])))[0]!.id as string;
      expect(await ok("SELECT version FROM coa_versions ORDER BY version")).toEqual([{ version: 1 }, { version: 2 }]);
      // Version 1 is exactly as it was.
      const v1 = await ok("SELECT code, name, active FROM coa_accounts a JOIN coa_versions v ON v.id = a.version_id WHERE v.version = 1 AND code IN ('6400','6600','6700') ORDER BY code");
      expect(v1).toEqual([{ code: "6400", name: "Repairs and Maintenance Expense", active: true }, { code: "6600", name: "Cleaning and Turnover Expense", active: true }]);
      const v2rows = await ok("SELECT code, name, active FROM coa_accounts WHERE version_id = $1 AND code IN ('6400','6600','6700') ORDER BY code", [v2]);
      expect(v2rows).toEqual([{ code: "6400", name: "Repairs and Upkeep Expense", active: true }, { code: "6600", name: "Cleaning and Turnover Expense", active: false }, { code: "6700", name: "Pest Control Expense", active: true }]);
      expect((await ok("SELECT count(*)::int n FROM coa_accounts WHERE version_id = $1", [v2]))[0]!.n).toBe(18);
      // The old entry still shows its original classification.
      const classified = await ok("SELECT a.name, v.version FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN coa_accounts a ON a.id = l.account_id JOIN coa_versions v ON v.id = a.version_id WHERE e.id = $1 AND a.code = '6400'", [old]);
      expect(classified).toEqual([{ name: "Repairs and Maintenance Expense", version: 1 }]);
      expect((await ok("SELECT coa_version_id FROM journal_entries WHERE id = $1", [old]))[0]!.coa_version_id).toBe((await ok("SELECT id FROM coa_versions WHERE version = 1"))[0]!.id);
      // An entry dated before v2 takes effect still uses v1; one after uses v2.
      const early = entryId(await post(p, expense(1_000), { entry_date: "2026-05-31" }));
      const late = entryId(await post(p, expense(2_000), { entry_date: "2026-06-01" }));
      expect((await ok("SELECT v.version FROM journal_entries e JOIN coa_versions v ON v.id = e.coa_version_id WHERE e.id = $1", [early]))[0]!.version).toBe(1);
      expect((await ok("SELECT v.version FROM journal_entries e JOIN coa_versions v ON v.id = e.coa_version_id WHERE e.id = $1", [late]))[0]!.version).toBe(2);
      // A retired account can't be used on the new chart; a new one can.
      expect((await tryPost(p, [dr("6600", 100), cr("1000", 100)], { entry_date: "2026-06-02" })).message).toMatch(/retired/);
      expect(await post(p, [dr("6700", 100), cr("1000", 100)], { entry_date: "2026-06-02" })).toHaveLength(1);
      // The trial balance shows each classification as it was posted: the old account name stays on the old entries.
      const tb = await trial(p, "2026-12-31");
      expect(tb.filter((r) => r.code === "6400").map((r) => [Number(r.coa_version), r.name, Number(r.balance_cents)]).sort()).toEqual([[1, "Repairs and Maintenance Expense", 11_000], [2, "Repairs and Upkeep Expense", 2_000]].sort());
      expect(tb.reduce((s, x) => s + Number(x.debit_cents), 0)).toBe(tb.reduce((s, x) => s + Number(x.credit_cents), 0));
      // Reversing an old entry stays on its own version, even after the chart moved on.
      const rev = (await asRole("service_role", null, () => ok("SELECT reverse_entry($1, 'wrong', $2::jsonb) AS id", [old, JSON.stringify({ created_by: ADMIN, entry_date: "2026-07-01" })])))[0]!.id as string;
      expect((await ok("SELECT v.version FROM journal_entries e JOIN coa_versions v ON v.id = e.coa_version_id WHERE e.id = $1", [rev]))[0]!.version).toBe(1);
    });

    it("an account from the old version can't be used on an entry the new version governs, and a new version can't predate the last", async () => {
      const p = await newProperty();
      const old6400 = (await ok("SELECT a.id FROM coa_accounts a JOIN coa_versions v ON v.id = a.version_id WHERE v.version = 1 AND a.code = '1000'"))[0]!.id;
      const cash = old6400;
      const exp = (await ok("SELECT a.id FROM coa_accounts a JOIN coa_versions v ON v.id = a.version_id WHERE v.version = 1 AND a.code = '6000'"))[0]!.id;
      const r = await tryPost(p, [{ account_id: exp, debit_cents: 100 }, { account_id: cash, credit_cents: 100 }], { entry_date: "2026-08-01" });
      expect(r.message).toMatch(/is on chart version 1, but chart version 2 is in force on 2026-08-01/);
      const back = await asRole("service_role", null, () => fails("SELECT create_coa_version('too early', DATE '2001-01-01')"));
      expect(back.message).toMatch(/can't take effect before/);
      // The version history is append-only and carries who and why.
      expect((await ok("SELECT notes FROM coa_versions WHERE version = 2"))[0]!.notes).toMatch(/Pest Control/);
    });
  });

  describe("who can read", () => {
    it("an Account Member reads their property's ledger, read-only; an outsider reads nothing; the Manager reads all", async () => {
      const mine = await newProperty();
      const theirs = await newProperty([M1]);
      await ok("INSERT INTO owners (user_id, property_id) VALUES ($1, $2)", [READER, mine]); // READER is a member of `mine` only
      const e1 = entryId(await post(mine, contribution(1_000)));
      await post(theirs, contribution(2_000));
      const count = (role: string, uid: string | null, table: string) => asRole(role, uid, async () => Number((await ok(`SELECT count(*)::int n FROM ${table}`))[0]!.n));
      // The member sees only their own property's rows.
      const seen = await asRole("authenticated", READER, () => ok("SELECT DISTINCT property_id FROM journal_entries"));
      expect(seen.map((r) => r.property_id)).toEqual([mine]);
      expect(await asRole("authenticated", READER, async () => Number((await ok("SELECT count(*)::int n FROM journal_lines WHERE entry_id = $1", [e1]))[0]!.n))).toBe(2);
      expect(await asRole("authenticated", READER, async () => Number((await ok("SELECT count(*)::int n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.property_id = $1", [theirs]))[0]!.n))).toBe(0);
      // An outsider sees nothing.
      expect(await count("authenticated", OUTSIDER, "journal_entries")).toBe(0);
      expect(await count("authenticated", OUTSIDER, "journal_lines")).toBe(0);
      expect((await asRole("anon", null, () => fails("SELECT count(*) FROM journal_entries"))).code).toBe("42501");
      // The Manager sees everything.
      expect(await count("authenticated", ADMIN, "journal_entries")).toBeGreaterThan(2);
      // And the members' read is read-only (covered above for UPDATE/DELETE; INSERT too).
      expect((await asRole("authenticated", READER, () => fails(`INSERT INTO journal_entries (property_id, entry_date, source, coa_version_id, period) VALUES ('${mine}', current_date, 'manual', '${U(1)}', '2026-01')`))).code).toBe("42501");
    });

    it("the chart is readable by anyone signed in, and by nobody who isn't", async () => {
      expect(await asRole("authenticated", OUTSIDER, async () => Number((await ok("SELECT count(*)::int n FROM coa_accounts"))[0]!.n))).toBeGreaterThan(10);
      expect((await asRole("anon", null, () => fails("SELECT count(*) FROM coa_accounts"))).code).toBe("42501");
    });
  });

  describe("the rest of the brief", () => {
    it("amounts are integer cents everywhere, and the journal stores no money as decimals", async () => {
      const cols = await ok("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'journal_lines' AND column_name LIKE '%cents'");
      expect(cols.map((c) => [c.column_name, c.data_type]).sort()).toEqual([["credit_cents", "bigint"], ["debit_cents", "bigint"]]);
    });

    it("doesn't duplicate the existing money tables", () => {
      const sql = readFileSync("bookkeeping.sql", "utf8");
      for (const t of ["owner_capital_accounts", "distribution_events", "capital_call_allocations", "expense_allocations"]) expect(sql).not.toMatch(new RegExp(`CREATE TABLE[^;]*public\\.${t}\\b`));
      for (const source of ["expense", "capital_call", "distribution", "resale", "opening", "plaid", "manual", "system"]) expect(sql).toContain(`'${source}'`);
    });

    it("every entry in this run balances: debits equal credits across the whole journal", async () => {
      const r = (await ok("SELECT (SELECT sum(debit_cents) FROM journal_lines) d, (SELECT sum(credit_cents) FROM journal_lines) c"))[0]!;
      expect(Number(r.d)).toBe(Number(r.c));
      const unbalanced = await ok("SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING sum(debit_cents) <> sum(credit_cents)");
      expect(unbalanced).toEqual([]);
    });
  });
});
