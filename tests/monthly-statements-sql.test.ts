/**
 * Month 6, Prompt 10, on a real Postgres (PGlite): the real bookkeeping, capital-accounts, bank-feed, books, expenses, capital-events,
 * expense-books and then monthly-statements.sql, as written. One statement per capital account per month, never duplicated by a re-run,
 * a correction is a new version that leaves the old one viewable, the totals reconcile to the journal (recomputed here from the raw journal
 * lines, independently of the function under test), and an owner sees only their own. Skips when PGlite isn't installed.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { splitProRata } from "@/lib/expenses";

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
const AUTH2 = U(32);
const PERIOD = "2025-04";

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
const J = JSON.stringify;
const count = async (sql: string, params?: unknown[]) => Number((await ok(sql, params))[0]!.n);
const HOLDERS = [{ holderKey: A1, shares: 4, rank: 1 }, { holderKey: A2, shares: 3, rank: 2 }, { holderKey: SK, shares: 1, rank: 3 }];

/** An open LLC of 8 shares: A1 holds 4 (rank 1), A2 holds 3, the retained seller holds 1. Opened 2025-03-01 at $8,000 ($1,000 a share). */
async function llc(name = "5632 Independence Ave LLC") {
  const id = (await ok("INSERT INTO properties (listing_price, address, city, state) VALUES (8000, '5632 Independence Ave', 'Lusk', 'WY') RETURNING id"))[0]!.id as string;
  let n = 1;
  for (const [h, kind, shares] of [[A1, "buyer", 4], [A2, "buyer", 3], [SELLER, "seller", 1]] as const) {
    for (let i = 0; i < shares; i++) await ok("INSERT INTO cap_table_entries (property_id, share_number, holder_type, buyer_account_id, seller_id) VALUES ($1, $2, $3, $4, $5)", [id, n++, kind === "buyer" ? "buyer_account" : "retained_seller", kind === "buyer" ? h : null, kind === "seller" ? h : null]);
  }
  await ok("INSERT INTO entity_genesis (property_id, cap_table_locked_at, llc_name) VALUES ($1, now(), $2)", [id, name]);
  await pg!.exec("ALTER TABLE properties DISABLE TRIGGER properties_open_ledger");
  await svc(async () => ok("UPDATE properties SET deed_recorded_at = '2025-03-01T00:00:00Z' WHERE id = $1", [id]));
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
/** A busy April: a deposit of $500 allocated to the members, a $800 repair, and a $300 distribution to A1. */
async function april() {
  const p = await llc();
  await income(p, "2025-04-10", 50_000, "April rent");
  expect((await rpc("SELECT allocate_income($1, '2025-04-30', $2) AS r", [p, ADMIN])).status).toBe("posted");
  await expense(p, 800, "2025-04-15");
  await entry(p, "2025-04-20", [{ code: "3100", member_id: A1, debit_cents: 30_000 }, { code: "1000", credit_cents: 30_000 }], "distribution", `distribution:test-${p}:${A1}`, "Distribution");
  return p;
}
const gen = (p: string, period = PERIOD) => rpc("SELECT generate_monthly_statements($1, $2, $3) AS r", [p, period, ADMIN]);
const issue = (p: string, period = PERIOD, force: string | null = null) => rpc("SELECT issue_monthly_statements($1, $2, $3, $4) AS r", [p, period, ADMIN, force]);
const stmts = (p: string, period = PERIOD) => ok("SELECT id, member_key, version, status, snapshot_hash, manager_notes, data_snapshot FROM monthly_statements WHERE property_id = $1 AND period = $2 ORDER BY member_key, version", [p, period]);
const forMember = async (p: string, m: string, version = 1, period = PERIOD) => (await stmts(p, period)).find((s) => s.member_key === m && s.version === version)!;

/** The truth, from the raw journal lines, with none of the statement functions. */
async function journalTruth(p: string, member: string, from: string, to: string) {
  const cap = async (a: string, b: string, codes: string[]) =>
    Number((await ok("SELECT COALESCE(sum(l.credit_cents - l.debit_cents), 0)::bigint s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN coa_accounts a ON a.id = l.account_id WHERE e.property_id = $1 AND l.member_id = $2 AND a.code = ANY($3) AND e.entry_date BETWEEN $4 AND $5", [p, member, codes, a, b]))[0]!.s);
  const llcSide = async (type: string, a: string, b: string) =>
    Number((await ok("SELECT COALESCE(sum(l.debit_cents - l.credit_cents), 0)::bigint s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN coa_accounts a ON a.id = l.account_id WHERE e.property_id = $1 AND a.type = $2 AND e.entry_date BETWEEN $3 AND $4 AND COALESCE(e.source_ref, '') NOT LIKE 'allocation-%'", [p, type, a, b]))[0]!.s);
  return {
    closing: await cap("1900-01-01", to, ["3000", "3100", "3200"]),
    opening: await cap("1900-01-01", new Date(Date.parse(from) - 86_400_000).toISOString().slice(0, 10), ["3000", "3100", "3200"]),
    contributions: await cap(from, to, ["3000"]),
    distributions: await cap(from, to, ["3100"]),
    llcExpense: await llcSide("expense", from, to),
    llcIncome: -(await llcSide("income", from, to)),
  };
}

describe.skipIf(!pg)("monthly-statements.sql", () => {
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
      CREATE TABLE user_roles (user_id uuid NOT NULL, role text NOT NULL);
      CREATE TABLE owners (user_id uuid NOT NULL, property_id uuid NOT NULL);
      CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
      CREATE FUNCTION public.is_property_owner(_user uuid, _property uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.owners WHERE user_id = _user AND property_id = _property) $$;
      GRANT ALL ON audit_log, owner_capital_accounts, owner_capital_contributions, distribution_events, cap_table_history, resale_transactions, cpa_worksheet_flags, cap_table_entries, maintenance_requests, votes TO service_role;
      GRANT SELECT ON properties, user_roles, owners, entity_genesis, buyer_accounts, closing_funds_obligations TO service_role; GRANT UPDATE ON properties TO service_role;
      GRANT SELECT ON buyer_accounts TO authenticated;
      GRANT EXECUTE ON FUNCTION public.has_role(uuid, text), public.is_property_owner(uuid, uuid) TO authenticated, service_role;
      INSERT INTO user_roles VALUES ('${ADMIN}', 'admin');
      INSERT INTO buyer_accounts VALUES ('${A1}', '${AUTH1}'), ('${A2}', '${AUTH2}');
    `);
    for (const f of ["bookkeeping.sql", "capital-accounts.sql", "bank-feed.sql", "books.sql", "expenses.sql", "capital-events.sql", "expense-books.sql"]) await pg!.exec(readFileSync(f, "utf8"));
    const sql = readFileSync("monthly-statements.sql", "utf8");
    await pg!.exec(sql);
    await pg!.exec(sql); // safe to run again
  }, 120_000);

  beforeEach(async () => {
    await pg!.exec("RESET ROLE");
  });

  describe("one statement per member per month", () => {
    it("makes a draft for every capital account, once, however often the job runs", async () => {
      const p = await april();
      const first = await gen(p);
      expect(first).toMatchObject({ status: "ok", created: 3, corrections: 0 });
      expect((await stmts(p)).map((s) => [s.member_key, s.version, s.status]).sort()).toEqual([[A1, 1, "draft"], [A2, 1, "draft"], [SELLER, 1, "draft"]].sort());
      const hashes = (await stmts(p)).map((s) => s.snapshot_hash);
      for (let i = 0; i < 3; i++) expect(await gen(p)).toMatchObject({ created: 0, refreshed: 0, corrections: 0, unchanged: 3 });
      expect(await count("SELECT count(*) n FROM monthly_statements WHERE property_id = $1", [p])).toBe(3);
      expect((await stmts(p)).map((s) => s.snapshot_hash)).toEqual(hashes); // the same ledger gives the same hash
    });

    it("a two-member Buyer Account is ONE capital account, so it is one shared statement (keyed by the account, not by either member)", async () => {
      const p = await april();
      await gen(p);
      expect((await stmts(p)).filter((s) => s.member_key === A1)).toHaveLength(1);
      // The account has one login that both members use: the one statement is theirs, whoever of the two signs in.
      await ok("INSERT INTO owners VALUES ($1, $2)", [AUTH1, p]);
      await issue(p);
      const seen = await asRole("authenticated", AUTH1, () => ok("SELECT member_key FROM monthly_statements WHERE property_id = $1", [p]));
      expect(seen.map((r) => r.member_key)).toEqual([A1]);
    });

    it("only after the month has ended, and only for an open ledger", async () => {
      const p = await april();
      const thisMonth = new Date().toISOString().slice(0, 7);
      expect((await tryRpc("SELECT generate_monthly_statements($1, $2, $3)", [p, thisMonth, ADMIN])).message).toContain("after its month has ended");
      expect((await tryRpc("SELECT generate_monthly_statements($1, '2025-13', $2)", [p, ADMIN])).message).toContain("YYYY-MM");
      const unopened = (await ok("INSERT INTO properties (listing_price) VALUES (1) RETURNING id"))[0]!.id as string;
      expect((await rpc("SELECT generate_monthly_statements($1, $2, $3) AS r", [unopened, PERIOD, ADMIN])).status).toBe("not_open");
      expect((await tryRpc("SELECT generate_monthly_statements($1, $2, $3)", [p, PERIOD, AUTH1])).message).toContain("Only the Manager");
    });
  });

  describe("what a statement says", () => {
    it("the property, the member's capital account for the month, the LLC's own income and expense with line items, and the year to date", async () => {
      const p = await april();
      await gen(p);
      const s = (await forMember(p, A1)).data_snapshot;
      expect(s.property).toMatchObject({ address: "5632 Independence Ave", llc_name: "5632 Independence Ave LLC", shares: 4, total_shares: 8, interest_percent: "50.00" });
      expect((await forMember(p, A2)).data_snapshot.property.interest_percent).toBe("37.50");
      // A1: opened at 4 x $1,000 in March; April: + $250 of the $500 income, - $400 of the $800 repair, - $300 distributed.
      expect(s.capital).toMatchObject({ opening_cents: 400_000, contributions_cents: 0, income_cents: 25_000, expense_cents: -40_000, distributions_cents: -30_000, depreciation_cents: 0, closing_cents: 400_000 + 25_000 - 40_000 - 30_000 });
      expect(s.capital.lines.map((l: any) => l.type).sort()).toEqual(["distribution", "expense", "income"]);
      // The LLC: it earned $500 and spent $800 (the allocation that passes both on to the members is not the LLC's activity).
      expect(s.llc_month).toMatchObject({ income_cents: 50_000, expense_cents: 80_000, net_cents: -30_000 });
      expect(s.llc_month.income[0]).toMatchObject({ code: "4000", total_cents: 50_000 });
      expect(s.llc_month.income[0].items.map((i: any) => [i.date, i.memo, i.amount_cents])).toEqual([["2025-04-10", "April rent", 50_000]]);
      expect(s.llc_month.expense[0]).toMatchObject({ code: "6400", total_cents: 80_000 });
      // Year to date: the March opening counts in the year's contributions; the month's activity adds to it.
      expect(s.ytd.year).toBe(2025);
      expect(s.ytd.capital).toMatchObject({ beginning_cents: 0, contributions_cents: 400_000, income_cents: 25_000, expense_cents: -40_000, distributions_cents: -30_000, closing_cents: s.capital.closing_cents });
      expect(s.ytd.llc).toMatchObject({ income_cents: 50_000, expense_cents: 80_000, net_cents: -30_000 });
    });

    it("March (the opening month) and a month with nothing in it still reconcile, and the next month opens where the last closed", async () => {
      const p = await april();
      await gen(p, "2025-03");
      await gen(p, "2025-05");
      const march = (await forMember(p, A1, 1, "2025-03")).data_snapshot;
      expect(march.capital.contributions_cents).toBe(400_000);
      const rows = await ok("SELECT member_key, data_snapshot FROM monthly_statements WHERE property_id = $1 AND period IN ('2025-03', '2025-05') ORDER BY period, member_key", [p]);
      expect(rows.length).toBe(6);
      await gen(p, "2025-04");
      const apr = (await ok("SELECT data_snapshot FROM monthly_statements WHERE property_id = $1 AND period = '2025-04' AND member_key = $2", [p, A1]))[0]!.data_snapshot;
      const may = (await ok("SELECT data_snapshot FROM monthly_statements WHERE property_id = $1 AND period = '2025-05' AND member_key = $2", [p, A1]))[0]!.data_snapshot;
      expect(may.capital.opening_cents).toBe(apr.capital.closing_cents);
      expect(apr.capital.opening_cents).toBe(march.capital.closing_cents);
    });
  });

  describe("the totals reconcile to the ledger", () => {
    it("every statement's closing balance and the LLC's income, expense and year to date equal the journal totals, recomputed from the raw journal lines", async () => {
      const p = await april();
      await gen(p);
      for (const m of [A1, A2, SELLER]) {
        const s = (await forMember(p, m)).data_snapshot;
        const t = await journalTruth(p, m, "2025-04-01", "2025-04-30");
        expect(s.capital.closing_cents, `closing ${m}`).toBe(t.closing);
        expect(s.capital.opening_cents, `opening ${m}`).toBe(t.opening);
        expect(s.capital.distributions_cents, `distributions ${m}`).toBe(t.distributions);
        expect(s.llc_month.expense_cents).toBe(t.llcExpense);
        expect(s.llc_month.income_cents).toBe(t.llcIncome);
        expect(s.capital.opening_cents + s.capital.contributions_cents + s.capital.income_cents + s.capital.expense_cents + s.capital.depreciation_cents + s.capital.distributions_cents + s.capital.transfers_cents).toBe(s.capital.closing_cents);
      }
      // The members' closing balances add up to what the LLC's books say the members own.
      const total = (await stmts(p)).reduce((n, s) => n + Number(s.data_snapshot.capital.closing_cents), 0);
      const equity = Number((await ok("SELECT COALESCE(sum(l.credit_cents - l.debit_cents), 0)::bigint s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN coa_accounts a ON a.id = l.account_id WHERE e.property_id = $1 AND a.is_member_control AND e.entry_date <= '2025-04-30'", [p]))[0]!.s);
      expect(total).toBe(equity);
      const rec = await svc(async () => ok("SELECT * FROM statement_reconciliation($1, $2)", [p, PERIOD]));
      expect(rec).toHaveLength(3);
      expect(rec.every((r) => r.reconciles)).toBe(true);
    });

    it("the reconciliation FAILS when a statement no longer matches the journal", async () => {
      const p = await april();
      await gen(p);
      await issue(p);
      expect((await svc(async () => ok("SELECT * FROM statement_reconciliation($1, $2)", [p, PERIOD]))).every((r) => r.reconciles)).toBe(true);
      await income(p, "2025-04-25", 12_345, "Late rent"); // the books change after the statement was issued
      const rec = await svc(async () => ok("SELECT * FROM statement_reconciliation($1, $2)", [p, PERIOD]));
      expect(rec.every((r) => !r.reconciles)).toBe(true);
      expect(Number(rec[0]!.journal_income_cents) - Number(rec[0]!.snapshot_income_cents)).toBe(12_345);
    });
  });

  describe("issuing, the Manager's notes, and the review queue", () => {
    it("drafts stay drafts, and an owner sees nothing until they are issued; then every issued statement is theirs to read", async () => {
      const p = await april();
      await ok("INSERT INTO owners VALUES ($1, $2), ($3, $2)", [AUTH1, p, AUTH2]);
      await gen(p);
      const mine = () => asRole("authenticated", AUTH1, () => ok("SELECT member_key, status FROM monthly_statements WHERE property_id = $1", [p]));
      expect(await mine()).toHaveLength(0);
      const r = await issue(p);
      expect(r.issued).toBe(3);
      expect(await mine()).toEqual([{ member_key: A1, status: "issued" }]);
      const row = await forMember(p, A1);
      expect(row.status).toBe("issued");
      expect((await ok("SELECT issued_at, issued_by FROM monthly_statements WHERE id = $1", [row.id]))[0]).toMatchObject({ issued_by: ADMIN });
      expect((await tryRpc("SELECT issue_monthly_statements($1, $2, $3)", [p, PERIOD, AUTH1])).message).toContain("Only the Manager");
      expect((await issue(p)).issued).toBe(0); // issuing twice issues nothing twice
    });

    it("the Manager's notes go onto the statement before it is issued, and can't be changed after", async () => {
      const p = await april();
      await gen(p);
      expect(await rpc("SELECT set_statement_notes($1, $2, NULL, $3, $4) AS r", [p, PERIOD, "A capital call for the roof is coming in June. Flagged for the CPA: the $800 repair.", ADMIN])).toBe(3);
      expect(await rpc("SELECT set_statement_notes($1, $2, $3, 'Your note only', $4) AS r", [p, PERIOD, A2, ADMIN])).toBe(1);
      expect((await tryRpc("SELECT set_statement_notes($1, $2, NULL, 'x', $3)", [p, PERIOD, AUTH1])).message).toContain("Only the Manager");
      await issue(p);
      expect((await forMember(p, A1)).data_snapshot.manager_notes).toContain("capital call for the roof");
      expect((await forMember(p, A2)).data_snapshot.manager_notes).toBe("Your note only");
      expect(await rpc("SELECT set_statement_notes($1, $2, NULL, 'too late', $3) AS r", [p, PERIOD, ADMIN])).toBe(0);
      expect((await forMember(p, A1)).data_snapshot.manager_notes).toContain("capital call for the roof");
    });

    it("refuses while the needs-review queue has transactions, unless the Manager says why", async () => {
      const p = await april();
      await ok("INSERT INTO bank_transactions (property_id, plaid_txn_id, posted_date, amount_cents, direction, status) VALUES ($1, 'tx-1', '2025-04-12', 5000, 'in', 'needs_review')", [p]);
      await gen(p);
      expect((await tryRpc("SELECT issue_monthly_statements($1, $2, $3, NULL)", [p, PERIOD, ADMIN])).message).toContain("needs-review queue");
      expect(await count("SELECT count(*) n FROM monthly_statements WHERE property_id = $1 AND status = 'issued'", [p])).toBe(0);
      expect((await issue(p, PERIOD, "Waiting on the bank; the CPA has been told")).issued).toBe(3);
      const log = (await ok("SELECT metadata FROM audit_log WHERE action_type = 'statement.issued' ORDER BY created_at DESC, id LIMIT 1"))[0]!.metadata;
      expect(log.forced_reason).toContain("Waiting on the bank");
      expect(log.review_queue_pending).toBe(1);
    });

    it("every step is audit logged", async () => {
      const p = await april();
      await gen(p);
      await issue(p);
      const actions = (await ok("SELECT DISTINCT action_type FROM audit_log WHERE entity_type = 'monthly_statement'")).map((r) => r.action_type);
      expect(actions).toEqual(expect.arrayContaining(["statement.drafted", "statement.issued"]));
    });
  });

  describe("immutable snapshots, and corrections as new versions", () => {
    it("an issued statement can't be edited or deleted", async () => {
      const p = await april();
      await gen(p);
      await issue(p);
      const id = (await forMember(p, A1)).id;
      expect((await fails("UPDATE monthly_statements SET data_snapshot = '{}'::jsonb WHERE id = $1", [id])).message).toContain("snapshot and can't be edited");
      expect((await fails("UPDATE monthly_statements SET manager_notes = 'changed' WHERE id = $1", [id])).message).toContain("can't be edited");
      expect((await fails("UPDATE monthly_statements SET status = 'draft' WHERE id = $1", [id])).message).toMatch(/can't go from|can't be edited/);
      expect((await fails("UPDATE monthly_statements SET version = 9 WHERE id = $1", [id])).message).toContain("never change");
      expect((await fails("DELETE FROM monthly_statements WHERE id = $1", [id])).message).toContain("never deleted");
      // the PDF's place is set once
      await rpc("SELECT set_statement_pdf($1, 'statements/a.pdf') AS r", [id]);
      await rpc("SELECT set_statement_pdf($1, 'statements/b.pdf') AS r", [id]);
      expect((await ok("SELECT pdf_url FROM monthly_statements WHERE id = $1", [id]))[0]!.pdf_url).toBe("statements/a.pdf");
    });

    it("a correction to a past month makes version 2 and keeps version 1; issuing it supersedes version 1, and both stay viewable", async () => {
      const p = await april();
      await ok("INSERT INTO owners VALUES ($1, $2)", [AUTH1, p]);
      await gen(p);
      await issue(p);
      const v1 = await forMember(p, A1);
      await expense(p, 160, "2025-04-28", "Electrical"); // a late expense dated inside April
      const r = await gen(p);
      expect(r).toMatchObject({ created: 0, corrections: 3 });
      const v2 = await forMember(p, A1, 2);
      expect([v1.status, v2.status]).toEqual(["issued", "draft"]); // version 1 is untouched until version 2 is issued
      expect(v2.data_snapshot.capital.expense_cents).toBe(-40_000 - 8_000);
      expect(v1.data_snapshot.capital.expense_cents).toBe(-40_000);
      // running the job again adds no third version
      expect(await gen(p)).toMatchObject({ corrections: 0 });
      expect(await count("SELECT count(*) n FROM monthly_statements WHERE property_id = $1 AND member_key = $2", [p, A1])).toBe(2);
      // the owner still sees version 1 while version 2 is a draft
      expect((await asRole("authenticated", AUTH1, () => ok("SELECT version, status FROM monthly_statements WHERE property_id = $1", [p])))).toEqual([{ version: 1, status: "issued" }]);
      const out = await issue(p);
      expect(out.issued).toBe(3);
      expect(out.statements.find((s: any) => s.member_key === A1).superseded_id).toBe(v1.id);
      expect((await ok("SELECT version, status FROM monthly_statements WHERE property_id = $1 AND member_key = $2 ORDER BY version", [p, A1])).map((r) => [r.version, r.status])).toEqual([[1, "superseded"], [2, "issued"]]);
      // both are readable by the owner, and the old one is exactly as it was issued
      const seen = await asRole("authenticated", AUTH1, () => ok("SELECT version, status, data_snapshot FROM monthly_statements WHERE property_id = $1 ORDER BY version", [p]));
      expect(seen.map((r) => [r.version, r.status])).toEqual([[1, "superseded"], [2, "issued"]]);
      expect(seen[0]!.data_snapshot.capital.expense_cents).toBe(-40_000);
      expect(seen[1]!.data_snapshot.version).toBe(2);
      // and the new version reconciles to the journal
      expect((await svc(async () => ok("SELECT * FROM statement_reconciliation($1, $2)", [p, PERIOD]))).every((x) => x.reconciles)).toBe(true);
      // nothing more to correct
      expect(await gen(p)).toMatchObject({ corrections: 0, created: 0 });
    });

    it("a correction that changes nothing for a member makes no new version for them", async () => {
      const p = await april();
      await gen(p);
      await issue(p);
      await expense(p, 160, "2025-04-28");
      expect((await gen(p)).corrections).toBe(3);
      // A different month's correction leaves April alone.
      await expense(p, 50, "2025-06-02");
      expect(await gen(p)).toMatchObject({ corrections: 0 });
    });
  });

  describe("an owner sees only their own, and is never kept from them", () => {
    it("the owner of A can't open B's statement, nor another account's statement in their own LLC", async () => {
      const a = await april();
      const b = await april();
      await ok("INSERT INTO owners VALUES ($1, $2), ($3, $2)", [AUTH1, a, AUTH2]);
      await gen(a);
      await gen(b);
      await issue(a);
      await issue(b);
      const ownerOfA = await asRole("authenticated", AUTH1, () => ok("SELECT id, property_id, member_key FROM monthly_statements WHERE property_id IN ($1, $2)", [a, b]));
      expect(ownerOfA.map((r) => [r.property_id, r.member_key])).toEqual([[a, A1]]);
      const bIds = (await stmts(b)).map((s) => s.id);
      const direct = await asRole("authenticated", AUTH1, () => ok("SELECT id FROM monthly_statements WHERE id = ANY($1)", [bIds]));
      expect(direct).toHaveLength(0);
      // A2 in the same LLC sees their own account's statement, not A1's
      const ownerA2 = await asRole("authenticated", AUTH2, () => ok("SELECT member_key FROM monthly_statements WHERE property_id = $1", [a]));
      expect(ownerA2.map((r) => r.member_key)).toEqual([A2]);
      // a stranger sees nothing, and an owner can't write
      expect(await asRole("authenticated", U(88), () => ok("SELECT id FROM monthly_statements"))).toHaveLength(0);
      expect((await asRole("authenticated", AUTH1, () => fails("UPDATE monthly_statements SET manager_notes = 'x'"))).message).toMatch(/permission denied/);
      // the Manager sees everything
      expect((await asRole("authenticated", ADMIN, () => ok("SELECT id FROM monthly_statements"))).length).toBeGreaterThanOrEqual(6);
    });

    it("an owner with an overdue expense, and one under the Retention Lock, still gets their statement: nothing about their standing is looked at", async () => {
      const p = await april(); // the $800 repair is unpaid by every owner
      await ok("INSERT INTO owners VALUES ($1, $2)", [AUTH2, p]);
      expect(await count("SELECT count(*) n FROM expense_allocations WHERE status = 'due'")).toBeGreaterThan(0);
      await gen(p);
      await issue(p);
      expect(await asRole("authenticated", AUTH2, () => ok("SELECT id FROM monthly_statements WHERE property_id = $1", [p]))).toHaveLength(1);
      const code = readFileSync("monthly-statements.sql", "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      expect(code.replace(/CHECK \(email_enabled[^;]*;/, "")).not.toMatch(/overdue|retention|eligib|capital_call|expense_allocations|votes/i);
    });
  });
});
