/**
 * Month 6, Prompt 11, on a real Postgres (PGlite): the real bookkeeping, capital-accounts, bank-feed, books, expenses, capital-events,
 * expense-books, monthly-statements and then year-end-packet.sql, as written. The packet's ledger sections reconcile to the journal (recomputed
 * here from the raw lines), the trial balance and balance sheet balance, a member's beginning equals the prior year's ending, a packet is an
 * immutable versioned snapshot, and the worksheet is flags only. Skips when PGlite isn't installed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { splitProRata } from "@/lib/expenses";
import { PACKET_SCHEMA, composePacket, validatePacket, type PacketMember } from "@/lib/year-end-packet";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";

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
const SK = `seller:${SELLER}`;
const AUTH1 = U(31);
const HOLDERS = [{ holderKey: A1, shares: 4, rank: 1 }, { holderKey: A2, shares: 3, rank: 2 }, { holderKey: SK, shares: 1, rank: 3 }];
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

/** An LLC opened 2024-03-01 at $8,000 ($1,000 a share): A1 4 shares, A2 3, the retained seller 1. */
async function llc() {
  const id = (await ok("INSERT INTO properties (listing_price, address) VALUES (8000, '5632 Independence Ave') RETURNING id"))[0]!.id as string;
  let n = 1;
  for (const [h, kind, shares] of [[A1, "buyer", 4], [A2, "buyer", 3], [SELLER, "seller", 1]] as const) {
    for (let i = 0; i < shares; i++) await ok("INSERT INTO cap_table_entries (property_id, share_number, holder_type, buyer_account_id, seller_id) VALUES ($1, $2, $3, $4, $5)", [id, n++, kind === "buyer" ? "buyer_account" : "retained_seller", kind === "buyer" ? h : null, kind === "seller" ? h : null]);
  }
  await ok("INSERT INTO entity_genesis (property_id, cap_table_locked_at, llc_name) VALUES ($1, now(), 'LLC')", [id]);
  await pg!.exec("ALTER TABLE properties DISABLE TRIGGER properties_open_ledger");
  await svc(async () => ok("UPDATE properties SET deed_recorded_at = '2024-03-01T00:00:00Z' WHERE id = $1", [id]));
  await pg!.exec("ALTER TABLE properties ENABLE TRIGGER properties_open_ledger");
  expect((await rpc("SELECT open_property_ledger($1, $2) AS r", [id, ADMIN])).status).toBe("opened");
  return id;
}
const entry = (p: string, date: string, lines: unknown[], source: string, ref: string | null, memo: string) =>
  rpc("SELECT post_entry($1, $2::jsonb, $3::jsonb) AS r", [p, J(lines), J({ source, source_ref: ref, entry_date: date, memo, created_by: ADMIN })]);
const income = (p: string, date: string, cents: number, memo = "Rent") => entry(p, date, [{ code: "1000", debit_cents: cents }, { code: "4000", credit_cents: cents }], "manual", null, memo);
const expense = async (p: string, dollars: number, date: string, category = "Plumbing") => {
  const id = (await ok("INSERT INTO expenses (property_id, description, category, total_amount, incurred_on) VALUES ($1, 'Repair', $2, $3, $4) RETURNING id", [p, category, dollars, date]))[0]!.id as string;
  expect((await tryRpc("SELECT post_expense($1, $2::jsonb, $3)", [id, J(splitProRata(dollars, HOLDERS)), ADMIN])).message).toBe("");
  return id;
};
/** Two busy years: 2024 and 2025 each with rent, a repair, an income allocation and a distribution. */
async function twoYears() {
  const p = await llc();
  for (const y of [2024, 2025]) {
    await income(p, `${y}-04-10`, 50_000, `${y} rent`);
    expect((await rpc("SELECT allocate_income($1, $2, $3) AS r", [p, `${y}-04-30`, ADMIN])).status).toBe("posted");
    await expense(p, 800, `${y}-04-15`);
    await entry(p, `${y}-04-20`, [{ code: "3100", member_id: A1, debit_cents: 30_000 }, { code: "1000", credit_cents: 30_000 }], "distribution", `distribution:test-${p}-${y}:${A1}`, `${y} distribution`);
  }
  return p;
}
const sections = (p: string, year = 2025) => rpc("SELECT packet_ledger_sections($1, $2) AS r", [p, year]);
const payloadFor = async (p: string, year = 2025) => {
  const id = randomUUID();
  return { id, payload: { schema_version: "1.0.0", packet_id: id, property: { property_id: p }, period: { year }, ...(await sections(p, year)), members: [], worksheet: { items: [] } } };
};
const record = (p: string, year: number, id: string, payload: unknown, trigger = "manual", actor: string | null = ADMIN) =>
  rpc("SELECT record_year_end_packet($1, $2, $3, $4::jsonb, $5, $6) AS r", [id, p, year, J(payload), trigger, actor]);
const recon = (id: string) => svc(async () => ok("SELECT * FROM packet_reconciliation($1)", [id]));

/** The truth from the raw journal, with none of the packet functions. */
const raw = async (sql: string, params: unknown[]) => Number((await ok(sql, params))[0]!.s);

describe.skipIf(!pg)("year-end-packet.sql", () => {
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
    for (const f of ["bookkeeping.sql", "capital-accounts.sql", "bank-feed.sql", "books.sql", "expenses.sql", "capital-events.sql", "expense-books.sql", "monthly-statements.sql"]) await pg!.exec(readFileSync(f, "utf8"));
    const sql = readFileSync("year-end-packet.sql", "utf8");
    await pg!.exec(sql);
    await pg!.exec(sql); // safe to run again
  }, 120_000);

  describe("the ledger sections come from the journal", () => {
    it("the general ledger has every entry of the year with every line, categorized by account, and nothing from another year", async () => {
      const p = await twoYears();
      const s = await sections(p);
      const inYear = await raw("SELECT count(*) s FROM journal_entries WHERE property_id = $1 AND entry_date BETWEEN '2025-01-01' AND '2025-12-31'", [p]);
      expect(s.entries).toHaveLength(inYear);
      expect(s.entries.every((e: any) => String(e.date).startsWith("2025"))).toBe(true);
      const rent = s.entries.find((e: any) => e.memo === "2025 rent");
      expect(rent.lines.map((l: any) => [l.account_code, l.account_name, l.category, l.debit_cents, l.credit_cents])).toEqual(expect.arrayContaining([["1000", expect.any(String), "asset", 50_000, 0], ["4000", expect.any(String), "income", 0, 50_000]]));
      const dist = s.entries.find((e: any) => e.memo === "2025 distribution");
      expect(dist).toMatchObject({ source: "distribution" });
      expect(dist.lines.find((l: any) => l.account_code === "3100")).toMatchObject({ member_key: A1, debit_cents: 30_000, category: "equity" });
      expect(s.accounts.map((a: any) => a.code)).toEqual(expect.arrayContaining(["1000", "3000", "3100", "3200", "4000", "6400"]));
    });

    it("includes the reversing entries too: a void is an entry like any other", async () => {
      const p = await twoYears();
      const id = await expense(p, 160, "2025-06-01", "Electrical");
      await svc(async () => ok("UPDATE expenses SET status = 'voided', voided_at = now(), void_reason = 'duplicate' WHERE id = $1", [id]));
      // The reversal is dated the day it was made.
      const s = await sections(p, new Date().getUTCFullYear());
      expect(s.entries.some((e: any) => e.reverses_entry_id)).toBe(true);
      const d = s.entries.flatMap((e: any) => e.lines).reduce((n: number, l: any) => n + l.debit_cents, 0);
      const c = s.entries.flatMap((e: any) => e.lines).reduce((n: number, l: any) => n + l.credit_cents, 0);
      expect(d).toBe(c);
    });

    it("the trial balance as of December 31 balances and equals the journal's totals, account by account", async () => {
      const p = await twoYears();
      const tb = (await sections(p)).trial_balance;
      expect(tb.as_of).toBe("2025-12-31");
      expect(tb.balanced).toBe(true);
      expect(tb.total_debit_cents).toBe(tb.total_credit_cents);
      expect(tb.total_debit_cents).toBe(await raw("SELECT COALESCE(sum(l.debit_cents), 0)::bigint s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.property_id = $1 AND e.entry_date <= '2025-12-31'", [p]));
      const cash = tb.rows.find((r: any) => r.code === "1000");
      expect(cash.balance_cents).toBe(await raw("SELECT COALESCE(sum(l.debit_cents - l.credit_cents), 0)::bigint s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN coa_accounts a ON a.id = l.account_id WHERE e.property_id = $1 AND a.code = '1000' AND e.entry_date <= '2025-12-31'", [p]));
      // a year earlier, the same books give a different (also balanced) trial balance
      const earlier = (await sections(p, 2024)).trial_balance;
      expect(earlier.balanced).toBe(true);
      expect(earlier.total_debit_cents).toBeLessThan(tb.total_debit_cents);
    });

    it("the balance sheet balances: assets equal the members' capital plus anything not yet allocated", async () => {
      const p = await twoYears();
      await income(p, "2025-12-20", 12_345, "Unallocated December rent"); // earned, not yet allocated to the members
      const bs = (await sections(p)).balance_sheet;
      expect(bs.balanced).toBe(true);
      expect(bs.total_assets_cents).toBe(bs.total_liabilities_and_equity_cents);
      expect(bs.unallocated_net_income_cents).toBe(12_345);
      expect(bs.member_capital.reduce((n: number, m: any) => n + m.balance_cents, 0) + bs.unallocated_net_income_cents).toBe(bs.total_liabilities_and_equity_cents);
      expect(bs.assets.find((a: any) => a.code === "1000").balance_cents).toBeTypeOf("number");
    });

    it("the income statement is what the LLC itself earned and spent, with line items, and shows what was passed on to the members", async () => {
      const p = await twoYears();
      const inc = (await sections(p)).income_statement;
      expect(inc).toMatchObject({ year: 2025, income_cents: 50_000, expense_cents: 80_000, net_cents: -30_000 });
      expect(inc.income[0].items[0]).toMatchObject({ date: "2025-04-10", memo: "2025 rent", amount_cents: 50_000 });
      expect(inc.expense[0]).toMatchObject({ code: "6400", total_cents: 80_000 });
      expect(inc.allocated_to_members).toEqual({ income_allocated_cents: 50_000, expense_allocated_cents: 80_000 });
    });

    it("each member's roll-forward: beginning equals the prior year's ending, and it adds up", async () => {
      const p = await twoYears();
      const s = await sections(p);
      expect(s.roll_forwards).toHaveLength(3);
      const prior = await sections(p, 2024);
      for (const r of s.roll_forwards) {
        const before = prior.roll_forwards.find((x: any) => x.member_key === r.member_key);
        expect(r.beginning_cents, r.member_key).toBe(before.ending_cents);
        expect(r.prior_year_ending_cents).toBe(before.ending_cents);
        expect(r.beginning_matches_prior_ending).toBe(true);
        expect(r.beginning_cents + r.contributions_cents + r.distributions_cents + r.income_cents + r.expense_cents + r.depreciation_cents + r.transfers_cents).toBe(r.ending_cents);
      }
      const a1 = s.roll_forwards.find((r: any) => r.member_key === A1);
      expect(a1).toMatchObject({ contributions_cents: 0, distributions_cents: -30_000, income_cents: 25_000, expense_cents: -40_000, depreciation_cents: 0 });
      // 2024 holds the opening contribution
      expect(prior.roll_forwards.find((r: any) => r.member_key === A1).contributions_cents).toBe(400_000);
    });

    it("depreciation entered from the CPA's schedule shows in the roll-forward (the platform never computes it)", async () => {
      const p = await twoYears();
      await rpc("SELECT post_depreciation($1, 2025, 9000, 'CPA schedule 2025-A', 'from the CPA', $2) AS r", [p, ADMIN]);
      const a1 = (await sections(p)).roll_forwards.find((r: any) => r.member_key === A1);
      expect(a1.depreciation_cents).toBe(-4_500); // 4/8 of what the CPA's schedule says
    });
  });

  describe("a packet is an immutable, versioned snapshot", () => {
    it("is recorded with a hash, a version, who generated it and the trigger; and every generation is a new version", async () => {
      const p = await twoYears();
      const one = await payloadFor(p);
      const r1 = await record(p, 2025, one.id, one.payload);
      expect(r1).toMatchObject({ id: one.id, version: 1 });
      const expected = (await ok("SELECT encode(sha256(convert_to($1::jsonb::text, 'UTF8')), 'hex') h", [J(one.payload)]))[0]!.h;
      expect(r1.hash).toBe(expected);
      const two = await payloadFor(p);
      const r2 = await record(p, 2025, two.id, two.payload, "scheduled", null);
      expect(r2.version).toBe(2);
      expect((await ok("SELECT version, trigger, generated_by FROM year_end_packets WHERE property_id = $1 ORDER BY version", [p])).map((r) => [r.version, r.trigger, r.generated_by])).toEqual([[1, "manual", ADMIN], [2, "scheduled", null]]);
      const a = await ok("SELECT actor_id, actor_type, metadata FROM audit_log WHERE action_type = 'packet.generated' AND entity_id = $1", [two.id]);
      expect(a[0]).toMatchObject({ actor_type: "system" });
      expect(a[0]!.metadata).toMatchObject({ year: 2025, version: 2, trigger: "scheduled", hash: r2.hash });
    });

    it("only the Manager (or the scheduled job), only for a year that has ended, only for an open ledger, and the packet must carry its own id", async () => {
      const p = await twoYears();
      const x = await payloadFor(p);
      expect((await tryRpc("SELECT record_year_end_packet($1, $2, 2025, $3::jsonb, 'manual', $4)", [x.id, p, J(x.payload), AUTH1])).message).toContain("Only the Manager");
      expect((await tryRpc("SELECT record_year_end_packet($1, $2, 2025, $3::jsonb, 'manual', NULL)", [x.id, p, J(x.payload)])).message).toContain("Only the scheduled job");
      const thisYear = new Date().getUTCFullYear();
      expect((await tryRpc("SELECT record_year_end_packet($1, $2, $3, $4::jsonb, 'manual', $5)", [x.id, p, thisYear, J(x.payload), ADMIN])).message).toContain("after the year has ended");
      expect((await tryRpc("SELECT record_year_end_packet($1, $2, 2025, $3::jsonb, 'manual', $4)", [randomUUID(), p, J(x.payload), ADMIN])).message).toContain("packet's own id");
      const unopened = (await ok("INSERT INTO properties (listing_price) VALUES (1) RETURNING id"))[0]!.id as string;
      const y = await payloadFor(unopened);
      expect((await tryRpc("SELECT record_year_end_packet($1, $2, 2025, $3::jsonb, 'manual', $4)", [y.id, unopened, J(y.payload), ADMIN])).message).toContain("not open");
      expect(await count("SELECT count(*) n FROM year_end_packets WHERE property_id = $1", [p])).toBe(0);
    });

    it("can't be edited or deleted; its files are set once", async () => {
      const p = await twoYears();
      const x = await payloadFor(p);
      await record(p, 2025, x.id, x.payload);
      for (const w of ["UPDATE year_end_packets SET data = '{}'::jsonb WHERE id = $1", "UPDATE year_end_packets SET hash = 'x' WHERE id = $1", "UPDATE year_end_packets SET version = 9 WHERE id = $1", "UPDATE year_end_packets SET generated_by = NULL WHERE id = $1"])
        expect((await fails(w, [x.id])).message, w).toContain("snapshot and can't be edited");
      expect((await fails("DELETE FROM year_end_packets WHERE id = $1", [x.id])).message).toContain("never deleted");
      const files = [{ name: "packet.pdf", path: "a/packet.pdf", kind: "pdf", bytes: 10, sha256: "x", pii: false }];
      await rpc("SELECT set_packet_files($1, $2::jsonb, true) AS r", [x.id, J(files)]);
      await rpc("SELECT set_packet_files($1, $2::jsonb, false) AS r", [x.id, J([])]);
      expect((await ok("SELECT files, has_tins FROM year_end_packets WHERE id = $1", [x.id]))[0]).toMatchObject({ files, has_tins: true });
      expect((await fails("UPDATE year_end_packets SET files = '[]'::jsonb WHERE id = $1", [x.id])).message).toContain("fixed once");
    });
  });

  describe("the packet's totals reconcile to the ledger", () => {
    it("every check passes against the journal recomputed from the raw lines: ledger, trial balance, balance sheet, income, members, roll-forward", async () => {
      const p = await twoYears();
      const x = await payloadFor(p);
      await record(p, 2025, x.id, x.payload);
      const rows = await recon(x.id);
      expect(rows.map((r) => r.check_name)).toEqual(["general ledger debits", "general ledger credits", "trial balance debits", "trial balance credits", "trial balance balances", "balance sheet balances", "income statement income", "income statement expense", "members ending capital", "roll-forward beginning = prior ending"]);
      for (const r of rows) expect(r.ok, `${r.check_name}: ${r.packet_cents} vs ${r.ledger_cents}`).toBe(true);
    });

    it("FAILS when the ledger no longer matches the packet (a late entry in the year after it was made)", async () => {
      const p = await twoYears();
      const x = await payloadFor(p);
      await record(p, 2025, x.id, x.payload);
      await income(p, "2025-11-05", 7_777, "Late rent");
      const bad = (await recon(x.id)).filter((r) => !r.ok).map((r) => r.check_name);
      expect(bad).toEqual(expect.arrayContaining(["general ledger debits", "general ledger credits", "income statement income"]));
    });
  });

  describe("the CPA Cooperation Worksheet is flags only", () => {
    it("flags a depreciation entry needed, a Section 754 question per resale (no figure), the lodging-tax exposure (who only) and any other flag", async () => {
      const p = await twoYears();
      await ok("INSERT INTO cpa_worksheet_flags (property_id, flag_type, note, created_at) VALUES ($1, 'section_754_review', 'A share was resold', '2025-06-01')", [p]);
      await ok("INSERT INTO cpa_worksheet_flags (property_id, flag_type, note, created_at) VALUES ($1, 'cpa_cooperation_worksheet', 'Ask about the new roof', '2025-07-01')", [p]);
      await ok("INSERT INTO cpa_worksheet_flags (property_id, flag_type, note, created_at) VALUES ($1, 'section_754_review', 'A different year', '2024-06-01')", [p]);
      expect(await rpc("SELECT refresh_worksheet_items($1, 2025, $2) AS r", [p, ADMIN])).toBe(4);
      const items = await ok("SELECT item_type, title, detail, status, source_key FROM cpa_worksheet_items WHERE property_id = $1 AND year = 2025 ORDER BY item_type", [p]);
      expect(items.map((i) => i.item_type)).toEqual(["depreciation_needed", "lodging_tax_exposure", "other", "section_754_review"]);
      expect(items.find((i) => i.item_type === "depreciation_needed")).toMatchObject({ status: "open", title: expect.stringContaining("the CPA supplies the schedule") });
      expect(items.find((i) => i.item_type === "depreciation_needed")!.detail).toMatchObject({ entered: false });
      const s754 = items.find((i) => i.item_type === "section_754_review")!;
      expect(s754.title).toContain("never computes basis");
      expect(JSON.stringify(s754.detail)).not.toMatch(/amount|basis_cents|step|cents/i);
      expect(items.find((i) => i.item_type === "lodging_tax_exposure")!.detail.members[0]).toEqual({ member_key: A2, statuses: ["owed"], record_count: 3 }); // who, never how much
      expect(items.find((i) => i.item_type === "other")!.detail).toMatchObject({ note: "Ask about the new roof" });
    });

    it("running it again makes nothing new and keeps the Manager's notes; once the CPA's depreciation is entered the item says so", async () => {
      const p = await twoYears();
      await rpc("SELECT refresh_worksheet_items($1, 2025, $2) AS r", [p, ADMIN]);
      const dep = (await ok("SELECT id FROM cpa_worksheet_items WHERE property_id = $1 AND item_type = 'depreciation_needed'", [p]))[0]!.id as string;
      await svc(async () => ok("SELECT annotate_worksheet_item($1, 'Waiting on the schedule from Pat', 'open', $2)", [dep, ADMIN]));
      expect(await rpc("SELECT refresh_worksheet_items($1, 2025, $2) AS r", [p, ADMIN])).toBe(0);
      await rpc("SELECT post_depreciation($1, 2025, 9000, 'CPA schedule 2025-A', NULL, $2) AS r", [p, ADMIN]);
      await rpc("SELECT refresh_worksheet_items($1, 2025, $2) AS r", [p, ADMIN]);
      const item = (await ok("SELECT title, detail, manager_note FROM cpa_worksheet_items WHERE id = $1", [dep]))[0]!;
      expect(item.title).toContain("was entered from the CPA's schedule");
      expect(item.detail).toMatchObject({ entered: true, entered_cents: 9_000 });
      expect(item.manager_note).toBe("Waiting on the schedule from Pat");
    });

    it("only the Manager refreshes or annotates; an item is open or reviewed", async () => {
      const p = await twoYears();
      expect((await tryRpc("SELECT refresh_worksheet_items($1, 2025, $2)", [p, AUTH1])).message).toContain("Only the Manager");
      await rpc("SELECT refresh_worksheet_items($1, 2025, $2) AS r", [p, ADMIN]);
      const id = (await ok("SELECT id FROM cpa_worksheet_items WHERE property_id = $1 LIMIT 1", [p]))[0]!.id as string;
      expect((await tryRpc("SELECT annotate_worksheet_item($1, 'x', 'reviewed', $2)", [id, AUTH1])).message).toContain("Only the Manager");
      expect((await tryRpc("SELECT annotate_worksheet_item($1, 'x', 'done', $2)", [id, ADMIN])).code).toBe("23514");
      await svc(async () => ok("SELECT annotate_worksheet_item($1, 'Looked at', 'reviewed', $2)", [id, ADMIN]));
      expect((await ok("SELECT status, manager_note FROM cpa_worksheet_items WHERE id = $1", [id]))[0]).toMatchObject({ status: "reviewed", manager_note: "Looked at" });
    });
  });

  describe("access, audit, and what is never produced", () => {
    it("only the Manager reads packets, items and 1099 copies; no login writes any of them; both buckets are private with no policy", async () => {
      const p = await twoYears();
      const x = await payloadFor(p);
      await record(p, 2025, x.id, x.payload);
      await rpc("SELECT refresh_worksheet_items($1, 2025, $2) AS r", [p, ADMIN]);
      for (const t of ["year_end_packets", "cpa_worksheet_items", "vendor_1099_copies"]) {
        expect((await asRole("authenticated", AUTH1, () => ok(`SELECT id FROM ${t}`))), t).toHaveLength(0);
        expect((await asRole("authenticated", U(51), () => ok(`SELECT id FROM ${t}`))), t).toHaveLength(0);
        expect((await asRole("authenticated", AUTH1, () => fails(`INSERT INTO ${t} (id) VALUES (gen_random_uuid())`))).message, t).toMatch(/permission denied/);
        expect((await asRole("authenticated", AUTH1, () => fails(`UPDATE ${t} SET id = id`))).message, t).toMatch(/permission denied/);
      }
      expect((await asRole("authenticated", ADMIN, () => ok("SELECT id FROM year_end_packets WHERE property_id = $1", [p]))).length).toBe(1);
      expect((await ok("SELECT id, public FROM storage.buckets WHERE id IN ('year-end-packets', 'packet-pii') ORDER BY id")).map((b) => [b.id, b.public])).toEqual([["packet-pii", false], ["year-end-packets", false]]);
      expect(await count("SELECT count(*) n FROM pg_policies WHERE tablename = 'objects' AND (qual ILIKE '%packet%' OR with_check ILIKE '%packet%')")).toBe(0);
      expect((await asRole("authenticated", AUTH1, () => fails("SELECT record_year_end_packet(gen_random_uuid(), gen_random_uuid(), 2025, '{}'::jsonb, 'scheduled', NULL)"))).message).toContain("permission denied");
    });

    it("a download is logged, and a TIN-file download is logged as such", async () => {
      const p = await twoYears();
      const x = await payloadFor(p);
      await record(p, 2025, x.id, x.payload);
      await rpc("SELECT log_packet_download($1, 'packet.pdf', false, $2) AS r", [x.id, ADMIN]);
      await rpc("SELECT log_packet_download($1, 'roster-with-tins.csv', true, $2) AS r", [x.id, ADMIN]);
      const a = (await ok("SELECT action_type, metadata FROM audit_log WHERE entity_id = $1 AND action_type LIKE 'packet.%download%' ORDER BY action_type", [x.id]));
      expect(a.map((r) => r.action_type)).toEqual(["packet.downloaded", "packet.pii_file_downloaded"]);
      expect(a[1]!.metadata).toMatchObject({ file: "roster-with-tins.csv", pii: true });
    });

    it("the file makes no tax return, K-1, depreciation or Section 754 figure, and the packet data carries no TIN", () => {
      const code = readFileSync("year-end-packet.sql", "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      expect(code).not.toMatch(/k-1|1065|schedule k/i);
      expect(code).not.toMatch(/member_w9|tin_|\btin\b|ssn/i);
      expect(code).not.toMatch(/(basis|step_up|stepup)_cents/i);
    });
  });

  describe("the JSON schema and the two sample packets, made from real ledger output", () => {
    // Ids are replaced, in order of appearance, so the samples are the same every time they are made.
    const stable = (value: unknown) => {
      const seen = new Map<string, string>();
      const text = JSON.stringify(value, null, 2).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => {
        if (!seen.has(id)) seen.set(id, `00000000-0000-4000-8000-${String(seen.size + 1).padStart(12, "0")}`);
        return seen.get(id)!;
      });
      return text + "\n";
    };
    const members = (): PacketMember[] => [
      { member_key: A1, legal_name: "Ann Example", share_count: 4, interest_percent: "50.00", mailing_address: "12 Oak St, Lusk, WY 82225", tin_kind: "ssn", tin_status: "on_file" },
      { member_key: A1, legal_name: "Ben Example", share_count: 4, interest_percent: "50.00", mailing_address: "12 Oak St, Lusk, WY 82225", tin_kind: "ssn", tin_status: "on_file" },
      { member_key: A2, legal_name: "Casey Sample", share_count: 3, interest_percent: "37.50", mailing_address: "9 Pine Rd, Casper, WY 82601", tin_kind: "ein", tin_status: "on_file" },
      { member_key: SELLER, legal_name: "Dana Seller (retained)", share_count: 1, interest_percent: "12.50", mailing_address: null, tin_kind: null, tin_status: "missing" },
    ];
    const build = async (p: string, worksheet: Array<Record<string, any>>, forms: any[], bank: Record<string, any>) =>
      composePacket({
        packetId: "11111111-1111-4111-8111-111111111111",
        generatedAt: "2026-01-05T09:00:00Z",
        trigger: "scheduled",
        property: { property_id: p, llc_name: "5632 Independence Ave LLC", address: "5632 Independence Ave", city: "Lusk", state: "WY", zip: "82225", total_shares: 8 },
        year: 2025,
        sections: await sections(p),
        members: members(),
        forms1099: forms,
        worksheetItems: worksheet as never,
        bank,
      });
    const items = async (p: string) => (await ok("SELECT item_type, title, status, manager_note, detail FROM cpa_worksheet_items WHERE property_id = $1 AND year = 2025 ORDER BY item_type, title", [p])) as any[];

    it("both samples validate against the schema, and the schema file is the schema", async () => {
      const one = await twoYears();
      await rpc("SELECT refresh_worksheet_items($1, 2025, $2) AS r", [one, ADMIN]);
      const sample1 = await build(one, await items(one), [], {});
      const two = await twoYears();
      await rpc("SELECT post_depreciation($1, 2025, 9000, 'CPA schedule 2025-A', NULL, $2) AS r", [two, ADMIN]);
      await ok("INSERT INTO cpa_worksheet_flags (property_id, flag_type, note, created_at) VALUES ($1, 'section_754_review', 'A share was resold in June', '2025-06-01')", [two]);
      await rpc("SELECT refresh_worksheet_items($1, 2025, $2) AS r", [two, ADMIN]);
      const roof = (await sections(two)).entries.find((e: any) => e.memo === "2025 rent");
      const sample2 = await build(two, await items(two), [{ vendor_name: "Lusk Roofing", form_type: "1099-NEC", tax_year: 2025, amount_cents: 80_000, issued_at: "2026-01-20T00:00:00Z", file: null }], { [roof.id]: { merchant: "Tenant ACH", raw_category: "INCOME" } });
      expect(validatePacket(sample1), "sample 1").toEqual([]);
      expect(validatePacket(sample2), "sample 2").toEqual([]);
      const write = !!process.env["UPDATE_SAMPLES"];
      for (const [file, text] of [["schemas/year-end-packet.schema.json", JSON.stringify(PACKET_SCHEMA, null, 2) + "\n"], ["samples/year-end-packet/sample-packet-1.json", stable(sample1)], ["samples/year-end-packet/sample-packet-2.json", stable(sample2)]] as const) {
        if (write) {
          mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
          writeFileSync(file, text);
        }
        expect(existsSync(file), file).toBe(true);
        expect(readFileSync(file, "utf8"), file).toBe(text);
      }
    });
  });
});
