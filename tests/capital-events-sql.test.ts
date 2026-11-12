/**
 * Month 6, Prompt 6, on a real Postgres (PGlite): bookkeeping, capital-accounts, bank-feed, books, then capital-events.sql, as
 * written, with the Month 5 tables it connects to. Every capital event posts through post_entry with the member named,
 * the capital_account_ledger follows, and the roll-forward adds up. Skips when PGlite isn't installed.
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
const A1 = U(11); // a two-member Buyer Account: ONE capital account
const A2 = U(12);
const A3 = U(13);
const SELLER = U(21); // a Hybrid Exit seller who kept shares
const USER_A1 = U(31);
const USER_A2 = U(32);
const USER_A3 = U(33);

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

/** An open LLC: price $8,000 over 8 shares (100,000 cents each), holders [[member id, kind, shares]]. */
async function llc(holders: Array<[string, "buyer" | "seller", number]> = [[A1, "buyer", 4], [A2, "buyer", 3], [SELLER, "seller", 1]]) {
  const id = (await ok("INSERT INTO properties (listing_price) VALUES (8000) RETURNING id"))[0]!.id as string;
  let n = 1;
  for (const [h, kind, shares] of holders) for (let i = 0; i < shares; i++) await ok("INSERT INTO cap_table_entries (property_id, share_number, holder_type, buyer_account_id, seller_id) VALUES ($1, $2, $3, $4, $5)", [id, n++, kind === "buyer" ? "buyer_account" : "retained_seller", kind === "buyer" ? h : null, kind === "seller" ? h : null]);
  await ok("INSERT INTO entity_genesis (property_id, cap_table_locked_at) VALUES ($1, now())", [id]);
  await pg!.exec("ALTER TABLE properties DISABLE TRIGGER properties_open_ledger");
  await svc(async () => ok("UPDATE properties SET deed_recorded_at = '2025-03-01T00:00:00Z' WHERE id = $1", [id]));
  await pg!.exec("ALTER TABLE properties ENABLE TRIGGER properties_open_ledger");
  const r = await rpc("SELECT open_property_ledger($1, $2) AS r", [id, ADMIN]);
  expect(r.status).toBe("opened");
  return id;
}
const bal = async (p: string, m: string) => Number((await ok("SELECT COALESCE(sum(amount_cents), 0)::bigint s FROM capital_account_ledger WHERE property_id = $1 AND member_key = $2", [p, m]))[0]!.s);
const totalCapital = async (p: string) => Number((await ok("SELECT COALESCE(sum(amount_cents), 0)::bigint s FROM capital_account_ledger WHERE property_id = $1", [p]))[0]!.s);
const types = (p: string, m: string) => ok("SELECT line_type, amount_cents, effective_date FROM capital_account_ledger WHERE property_id = $1 AND member_key = $2 ORDER BY seq", [p, m]);
const lines = (entry: string) => ok("SELECT a.code, l.member_id, l.debit_cents, l.credit_cents FROM journal_lines l JOIN coa_accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY a.code, l.debit_cents DESC, l.credit_cents DESC", [entry]);
const shape = (rows: Array<Record<string, any>>) => rows.map((l) => [l.code, l.member_id ?? null, Number(l.debit_cents), Number(l.credit_cents)]);
const trialMember = async (p: string, asOf = "2100-01-01") => {
  const tb = await svc(async () => ok("SELECT * FROM trial_balance($1, $2)", [p, asOf]));
  return tb.filter((r) => ["3000", "3100", "3200"].includes(r.code)).reduce((s, r) => s + (r.normal_balance === "credit" ? Number(r.credit_cents) - Number(r.debit_cents) : -(Number(r.debit_cents) - Number(r.credit_cents))), 0);
};
const post = (p: string, ls: unknown[], meta: Record<string, unknown> = {}) => svc(async () => ok("SELECT post_entry($1, $2::jsonb, $3::jsonb) AS id", [p, J(ls), J({ source: "manual", created_by: ADMIN, ...meta })])).then((r) => r[0]!.id as string);
/** What Month 5's credit_capital_contribution does: the tagged record first, then the running total. */
const confirmPayment = (p: string, holderKey: string, user: string, dollars: number, type: "capital_call" | "expense", src: string | null = null) =>
  svc(async () => ok("SELECT month5_credit($1, $2, $3, $4, $5, $6)", [p, holderKey, user, dollars, type, src]));
const table = async (p: string, user: string) => (await ok("SELECT contributed_amount, distributions_amount FROM owner_capital_accounts WHERE property_id = $1 AND user_id = $2", [p, user]))[0];

describe.skipIf(!pg)("capital-events.sql", () => {
  beforeAll(async () => {
    await pg!.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role; GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
      CREATE TABLE storage.objects (bucket_id text, name text);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE TABLE properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), listing_price numeric, deed_recorded_at timestamptz, created_at timestamptz DEFAULT now());
      CREATE TABLE entity_genesis (property_id uuid PRIMARY KEY, cap_table_locked_at timestamptz);
      CREATE TABLE buyer_accounts (id uuid PRIMARY KEY, auth_user_id uuid);
      CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid, actor_type text NOT NULL DEFAULT 'seller', action_type text NOT NULL, entity_type text, entity_id text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE cap_table_entries (property_id uuid, share_number int, holder_type text, buyer_account_id uuid, seller_id uuid);
      CREATE TABLE resale_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), price numeric);
      CREATE TABLE cap_table_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, share_number int, from_buyer_account_id uuid, from_seller_id uuid, to_buyer_account_id uuid, to_seller_id uuid, resale_transaction_id uuid, changed_at timestamptz DEFAULT now());
      CREATE TABLE cpa_worksheet_flags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, resale_transaction_id uuid, flag_type text NOT NULL DEFAULT 'section_754_review', note text);
      CREATE TABLE closing_funds_obligations (property_id uuid, amount numeric, status text);
      CREATE TABLE owner_capital_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, user_id uuid NOT NULL, contributed_amount numeric NOT NULL DEFAULT 0, distributions_amount numeric NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (property_id, user_id));
      CREATE TABLE owner_capital_contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, user_id uuid NOT NULL, holder_key text NOT NULL, amount numeric NOT NULL CHECK (amount > 0), contribution_type text NOT NULL CHECK (contribution_type IN ('capital_call', 'expense')), source_allocation_id uuid, created_at timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX one_per_payment ON owner_capital_contributions (contribution_type, source_allocation_id) WHERE source_allocation_id IS NOT NULL;
      CREATE TABLE expenses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, description text NOT NULL, category text NOT NULL, total_amount numeric NOT NULL, incurred_on date NOT NULL, status text NOT NULL DEFAULT 'draft');
      CREATE TABLE expense_allocations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), expense_id uuid NOT NULL, holder_key text NOT NULL, amount numeric NOT NULL);
      CREATE TABLE distribution_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, total_amount numeric NOT NULL, record_date date NOT NULL, status text NOT NULL DEFAULT 'posted', lines jsonb);
      CREATE TABLE user_roles (user_id uuid NOT NULL, role text NOT NULL);
      CREATE TABLE owners (user_id uuid NOT NULL, property_id uuid NOT NULL);
      CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
      CREATE FUNCTION public.is_property_owner(_user uuid, _property uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.owners WHERE user_id = _user AND property_id = _property) $$;
      -- Month 5's credit_capital_contribution (money-decisions.sql): the tagged record first, then the running total.
      CREATE FUNCTION public.month5_credit(_property uuid, _holder_key text, _user uuid, _amount numeric, _type text, _source uuid) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO public.owner_capital_contributions (property_id, user_id, holder_key, amount, contribution_type, source_allocation_id) VALUES (_property, _user, _holder_key, _amount, _type, _source) ON CONFLICT DO NOTHING;
        IF NOT FOUND THEN RETURN; END IF;
        INSERT INTO public.owner_capital_accounts (property_id, user_id, contributed_amount, updated_at) VALUES (_property, _user, _amount, now())
        ON CONFLICT (property_id, user_id) DO UPDATE SET contributed_amount = public.owner_capital_accounts.contributed_amount + EXCLUDED.contributed_amount, updated_at = now();
      END; $$;
      GRANT ALL ON audit_log, owner_capital_accounts, owner_capital_contributions, expenses, expense_allocations, distribution_events, cap_table_history, resale_transactions, cpa_worksheet_flags, cap_table_entries TO service_role;
      GRANT SELECT ON properties, user_roles, owners, entity_genesis, buyer_accounts, closing_funds_obligations TO service_role; GRANT UPDATE ON properties TO service_role;
      GRANT EXECUTE ON FUNCTION public.has_role(uuid, text), public.is_property_owner(uuid, uuid), public.month5_credit(uuid, text, uuid, numeric, text, uuid) TO authenticated, service_role;
      INSERT INTO user_roles VALUES ('${ADMIN}', 'admin');
      INSERT INTO buyer_accounts VALUES ('${A1}', '${USER_A1}'), ('${A2}', '${USER_A2}'), ('${A3}', '${USER_A3}');
    `);
    for (const f of ["bookkeeping.sql", "capital-accounts.sql", "bank-feed.sql", "books.sql", "capital-events.sql"]) await pg!.exec(readFileSync(f, "utf8"));
    await pg!.exec(readFileSync("capital-events.sql", "utf8")); // safe to run again
  }, 60_000);

  describe("(a) contributions", () => {
    it("a confirmed capital call payment and an expense payment each post one entry, tagged by type, and the Month 5 total is not counted twice", async () => {
      const p = await llc();
      const before = await bal(p, A1);
      const src1 = U(701);
      const src2 = U(702);
      await confirmPayment(p, A1, USER_A1, 250.5, "capital_call", src1);
      await confirmPayment(p, A1, USER_A1, 40, "expense", src2);
      const entries = await ok("SELECT source, source_ref, memo FROM journal_entries WHERE property_id = $1 AND source_ref LIKE 'contribution:%' ORDER BY source", [p]);
      expect(entries.map((e) => e.source)).toEqual(["capital_call", "expense"]);
      expect(entries[0]!.memo).toBe("Capital call payment confirmed");
      expect((await types(p, A1)).filter((t) => t.line_type === "contribution").map((t) => Number(t.amount_cents))).toEqual([25_050, 4_000]);
      expect(await bal(p, A1)).toBe(before + 29_050);
      // The Month 5 table holds the same figure once, equal to the ledger.
      expect(Number((await table(p, USER_A1))!.contributed_amount)).toBe(290.5);
      const rec = (await svc(async () => ok("SELECT matches, table_contributed_cents, ledger_contributed_cents FROM owner_capital_reconciliation WHERE property_id = $1 AND user_id = $2", [p, USER_A1])))[0]!;
      expect([rec.matches, Number(rec.table_contributed_cents), Number(rec.ledger_contributed_cents)]).toEqual([true, 29_050, 29_050]);
      // A retried confirmation changes nothing anywhere.
      await confirmPayment(p, A1, USER_A1, 250.5, "capital_call", src1);
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1 AND source_ref LIKE 'contribution:%'", [p])).toBe(2);
      expect(Number((await table(p, USER_A1))!.contributed_amount)).toBe(290.5);
      expect(await bal(p, A1)).toBe(before + 29_050);
      // Cash and the member's contribution line, one entry each.
      const e = await ok("SELECT id FROM journal_entries WHERE property_id = $1 AND source = 'capital_call' AND source_ref LIKE 'contribution:%'", [p]);
      expect(shape(await lines(e[0]!.id))).toEqual([["1000", null, 25_050, 0], ["3000", A1, 0, 25_050]]);
    });

    it("a retained seller's contribution lands on the seller's capital account, and before the books open nothing is posted twice later", async () => {
      const p = await llc();
      await confirmPayment(p, `seller:${SELLER}`, SELLER, 10, "capital_call", U(703));
      expect((await types(p, SELLER)).some((t) => t.line_type === "contribution" && Number(t.amount_cents) === 1_000)).toBe(true);
      expect(Number((await table(p, SELLER))!.contributed_amount)).toBe(10);
    });
  });

  describe("(c) allocable expense", () => {
    const expense = async (p: string, total: number, category: string, allocations: Array<[string, number]>, date = "2025-06-10") => {
      const id = (await ok("INSERT INTO expenses (property_id, description, category, total_amount, incurred_on) VALUES ($1, $2, $3, $4, $5) RETURNING id", [p, `${category} job`, category, total, date]))[0]!.id as string;
      for (const [holder, amount] of allocations) await ok("INSERT INTO expense_allocations (expense_id, holder_key, amount) VALUES ($1, $2, $3)", [id, holder, amount]);
      await svc(async () => ok("UPDATE expenses SET status = 'posted' WHERE id = $1", [id]));
      return id;
    };

    it("a posted expense charges each member's capital account their allocation, against the expense account, once", async () => {
      const p = await llc();
      const a1 = await bal(p, A1);
      const a2 = await bal(p, A2);
      const s = await bal(p, SELLER);
      const id = await expense(p, 800, "Plumbing", [[A1, 400], [A2, 300], [`seller:${SELLER}`, 100]]);
      const e = (await ok("SELECT * FROM journal_entries WHERE property_id = $1 AND source_ref = $2", [p, `allocation-expense:${id}`]))[0]!;
      expect(e).toMatchObject({ source: "expense", memo: "Expense allocated to members: Plumbing job" });
      expect(shape(await lines(e.id)).sort()).toEqual([["3200", A1, 40_000, 0], ["3200", A2, 30_000, 0], ["3200", SELLER, 10_000, 0], ["6400", null, 0, 80_000]].sort());
      expect(await bal(p, A1)).toBe(a1 - 40_000);
      expect(await bal(p, A2)).toBe(a2 - 30_000);
      expect(await bal(p, SELLER)).toBe(s - 10_000);
      expect((await types(p, A1)).at(-1)).toMatchObject({ line_type: "expense", amount_cents: -40000 });
      // Category decides the account.
      const ins = await expense(p, 100, "Insurance", [[A1, 100]]);
      expect((await lines((await ok("SELECT id FROM journal_entries WHERE source_ref = $1", [`allocation-expense:${ins}`]))[0]!.id)).map((l) => l.code).sort()).toEqual(["3200", "6100"]);
      // Posted again or synced again: nothing new.
      await svc(async () => ok("UPDATE expenses SET status = 'draft' WHERE id = $1", [id]));
      await svc(async () => ok("UPDATE expenses SET status = 'posted' WHERE id = $1", [id]));
      expect((await rpc("SELECT post_expense_allocation($1, $2) AS r", [id, ADMIN])).status).toBe("already_posted");
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE source_ref = $1", [`allocation-expense:${id}`])).toBe(1);
    });

    it("a voided expense is reversed in the ledger, and an expense from before the books opened is brought in by the sync, once", async () => {
      const p = await llc();
      const a1 = await bal(p, A1);
      const id = await expense(p, 80, "Utilities", [[A1, 80]]);
      expect(await bal(p, A1)).toBe(a1 - 8_000);
      await svc(async () => ok("UPDATE expenses SET status = 'voided' WHERE id = $1", [id]));
      expect(await bal(p, A1)).toBe(a1);
      expect((await ok("SELECT amount_cents, line_type FROM capital_account_ledger WHERE property_id = $1 AND member_key = $2 ORDER BY seq DESC LIMIT 1", [p, A1]))[0]).toEqual({ amount_cents: 8000, line_type: "expense" }); // the reversal keeps its kind
      // An expense whose posting the ledger missed (simulated by removing its entry's trigger effect): the sync catches it.
      await pg!.exec("ALTER TABLE expenses DISABLE TRIGGER expense_to_ledger");
      const late = await expense(p, 50, "Other", [[A2, 50]]);
      await pg!.exec("ALTER TABLE expenses ENABLE TRIGGER expense_to_ledger");
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE source_ref = $1", [`allocation-expense:${late}`])).toBe(0);
      const first = await rpc("SELECT sync_month5_events($1, $2) AS r", [p, ADMIN]);
      expect(first).toMatchObject({ expenses: 1, problems: [] });
      const again = await rpc("SELECT sync_month5_events($1, $2) AS r", [p, ADMIN]);
      expect(again).toMatchObject({ expenses: 0, distributions: 0, transfers: 0 });
      expect((await tryRpc("SELECT sync_month5_events($1, $2)", [p, USER_A1])).message).toMatch(/Only the Manager/);
    });
  });

  describe("(b) allocable income", () => {
    it("allocates Other Income to the members pro rata to shares, to the cent, once; income closes into capital", async () => {
      const p = await llc([[A1, "buyer", 4], [A2, "buyer", 3], [SELLER, "seller", 1]]);
      await post(p, [{ code: "1000", debit_cents: 10_001 }, { code: "4000", credit_cents: 10_001 }], { entry_date: "2025-05-05", memo: "Interest on the operating account" });
      const before = { a1: await bal(p, A1), a2: await bal(p, A2), s: await bal(p, SELLER) };
      expect((await tryRpc("SELECT allocate_income($1, '2025-12-31', $2)", [p, USER_A1])).message).toMatch(/Only the Manager/);
      const r = await rpc("SELECT allocate_income($1, '2025-12-31', $2, $3::jsonb) AS r", [p, ADMIN, J({ ip_address: "203.0.113.70" })]);
      expect(r).toMatchObject({ status: "posted", total_cents: 10_001 });
      // 10,001 over 8 shares: 5,000.5 (4), 3,750.375 (3), 1,250.125 (1) -> floors 5000, 3750, 1250 = 10,000; the leftover cent goes to the lowest share number (A1).
      const cr = Object.fromEntries((await lines(r.entry_id)).filter((l) => l.code === "3200").map((l) => [l.member_id, Number(l.credit_cents)]));
      expect(cr).toEqual({ [A1]: 5_001, [A2]: 3_750, [SELLER]: 1_250 });
      expect(Object.values(cr).reduce((s, c) => s + c, 0)).toBe(10_001);
      expect(await bal(p, A1)).toBe(before.a1 + 5_001);
      expect((await types(p, A2)).at(-1)).toMatchObject({ line_type: "income", amount_cents: 3750 });
      // Other Income is closed; allocating again finds nothing; later income allocates separately.
      const tb = await svc(async () => ok("SELECT * FROM trial_balance($1, '2100-01-01')", [p]));
      expect(tb.filter((x) => x.code === "4000").reduce((s, x) => s + Number(x.balance_cents), 0)).toBe(0);
      expect((await rpc("SELECT allocate_income($1, '2025-12-31', $2) AS r", [p, ADMIN])).status).toBe("nothing_to_allocate");
      await post(p, [{ code: "1000", debit_cents: 400 }, { code: "4000", credit_cents: 400 }], { entry_date: "2025-07-07" });
      expect(await rpc("SELECT allocate_income($1, '2025-12-31', $2) AS r", [p, ADMIN])).toMatchObject({ status: "posted", total_cents: 400 });
      expect((await ok("SELECT metadata FROM audit_log WHERE action_type = 'capital.income_allocated' AND entity_id = $1", [r.entry_id]))[0]!.metadata).toMatchObject({ basis: "pro rata to shares", total_cents: 10_001, ip_address: "203.0.113.70" });
    });

    it("allocates to the holders on the date: a share sold later still counts for the earlier income", async () => {
      const p = await llc([[A1, "buyer", 4], [A2, "buyer", 4]]);
      await post(p, [{ code: "1000", debit_cents: 8_000 }, { code: "4000", credit_cents: 8_000 }], { entry_date: "2025-04-01" });
      // Share 8 passes from A2 to A3 on 2025-09-01.
      await ok("UPDATE cap_table_entries SET buyer_account_id = $2 WHERE property_id = $1 AND share_number = 8", [p, A3]);
      await ok("INSERT INTO cap_table_history (property_id, share_number, from_buyer_account_id, to_buyer_account_id, resale_transaction_id, changed_at) VALUES ($1, 8, $2, $3, $4, '2025-09-01T12:00:00Z')", [p, A2, A3, (await ok("INSERT INTO resale_transactions (price) VALUES (100) RETURNING id"))[0]!.id]);
      const r = await rpc("SELECT allocate_income($1, '2025-06-30', $2) AS r", [p, ADMIN]);
      const cr = Object.fromEntries((await lines(r.entry_id)).filter((l) => l.code === "3200").map((l) => [l.member_id, Number(l.credit_cents)]));
      expect(cr).toEqual({ [A1]: 4_000, [A2]: 4_000 }); // A3 held nothing on 2025-06-30
    });

    it("refuses a future date, and income before the books are open", async () => {
      const p = await llc();
      expect((await tryRpc("SELECT allocate_income($1, current_date + 5, $2)", [p, ADMIN])).message).toMatch(/date that has passed/);
      const unopened = (await ok("INSERT INTO properties (listing_price) VALUES (1) RETURNING id"))[0]!.id;
      expect((await tryRpc("SELECT allocate_income($1, '2025-01-01', $2)", [unopened, ADMIN])).message).toMatch(/not open yet/);
    });
  });

  describe("(d) depreciation, entered by the Manager from the CPA's schedule", () => {
    it("allocates the entered figure to the members by their shares at year end: Dr Member Capital, Cr Accumulated Depreciation", async () => {
      const p = await llc();
      const a1 = await bal(p, A1);
      const call = (year: number, cents: number, sched: string | null, who = ADMIN) => tryRpc("SELECT post_depreciation($1, $2, $3, $4, 'Year 1', $5, $6::jsonb)", [p, year, cents, sched, who, J({ ip_address: "203.0.113.71" })]);
      expect((await call(2025, 80_000, "CPA schedule 2025", USER_A1)).message).toMatch(/Only the Manager/);
      expect((await call(2025, 0, "CPA schedule 2025")).message).toMatch(/whole number of cents above zero/);
      expect((await call(2025, 80_000, null)).message).toMatch(/Name the CPA's schedule/);
      expect((await call(2025, 80_000, "   ")).message).toMatch(/Name the CPA's schedule/);
      expect((await call(1999, 80_000, "x")).message).toMatch(/tax year that has begun/);
      expect((await call(2025, 80_000, "CPA schedule 2025")).message).toBe("");
      const e = (await ok("SELECT * FROM journal_entries WHERE property_id = $1 AND source_ref LIKE 'depreciation:%'", [p]))[0]!;
      expect(e.entry_date).toEqual(new Date("2025-12-31T00:00:00Z"));
      expect(e.memo).toMatch(/Depreciation for 2025 per the CPA's schedule CPA schedule 2025: Year 1/);
      expect(shape(await lines(e.id)).sort()).toEqual([["1290", null, 0, 80_000], ["3200", A1, 40_000, 0], ["3200", A2, 30_000, 0], ["3200", SELLER, 10_000, 0]].sort());
      expect(await bal(p, A1)).toBe(a1 - 40_000);
      expect((await types(p, A1)).at(-1)).toMatchObject({ line_type: "depreciation", amount_cents: -40000 });
      expect((await ok("SELECT metadata FROM audit_log WHERE action_type = 'capital.depreciation_entered' AND entity_id = $1", [e.id]))[0]!.metadata).toMatchObject({ year: 2025, amount_cents: 80_000, schedule: "CPA schedule 2025", ip_address: "203.0.113.71" });
      // One a year: a second is refused until the first is reversed; then a corrected figure can be entered.
      expect((await call(2025, 90_000, "Revised")).message).toMatch(/already entered/);
      await svc(async () => ok("SELECT reverse_entry($1, 'CPA revised the schedule', $2::jsonb)", [e.id, J({ created_by: ADMIN })]));
      expect((await call(2025, 90_000, "Revised")).message).toBe("");
      expect(await bal(p, A1)).toBe(a1 - 45_000);
      // The platform computes nothing: the only inputs are the Manager's figure and the cap table's shares.
      const src = readFileSync("capital-events.sql", "utf8");
      expect(src).not.toMatch(/useful life|MACRS|straight.line|declining balance|recovery period/i);
    });

    it("uses the holders at the end of that year, and a closed period needs the flagged adjustment", async () => {
      const p = await llc([[A1, "buyer", 4], [A2, "buyer", 4]]);
      await ok("UPDATE cap_table_entries SET buyer_account_id = $2 WHERE property_id = $1 AND share_number = 8", [p, A3]);
      await ok("INSERT INTO cap_table_history (property_id, share_number, from_buyer_account_id, to_buyer_account_id, resale_transaction_id, changed_at) VALUES ($1, 8, $2, $3, $4, '2026-02-01T12:00:00Z')", [p, A2, A3, (await ok("INSERT INTO resale_transactions (price) VALUES (1) RETURNING id"))[0]!.id]);
      const r = await rpc("SELECT post_depreciation($1, 2025, 80000, 'S25', NULL, $2) AS r", [p, ADMIN]);
      const dr = Object.fromEntries((await lines(r.entry_id)).filter((l) => l.code === "3200").map((l) => [l.member_id, Number(l.debit_cents)]));
      expect(dr).toEqual({ [A1]: 40_000, [A2]: 40_000 }); // A3 bought the share in 2026
      await svc(async () => ok("SELECT close_period($1, 2024, 12, $2)", [p, ADMIN]));
      expect((await tryRpc("SELECT post_depreciation($1, 2024, 100, 'S24', NULL, $2)", [p, ADMIN])).message).toMatch(/closed/);
    });
  });

  describe("(e) distributions", () => {
    it("a posted distribution debits each member's Distributions by their split and credits Cash; the Month 5 distributions total follows", async () => {
      const p = await llc();
      const a1 = await bal(p, A1);
      const id = (await ok("INSERT INTO distribution_events (property_id, total_amount, record_date, lines) VALUES ($1, 800, '2025-08-01', $2::jsonb) RETURNING id", [p, J([{ holder_key: A1, share_count: 4, amount: 400 }, { holder_key: A2, share_count: 3, amount: 300 }, { holder_key: `seller:${SELLER}`, share_count: 1, amount: 100 }])]))[0]!.id as string;
      const e = (await ok("SELECT * FROM journal_entries WHERE property_id = $1 AND source_ref = $2", [p, `distribution:${id}`]))[0]!;
      expect(e.source).toBe("distribution");
      expect(shape(await lines(e.id)).sort()).toEqual([["1000", null, 0, 80_000], ["3100", A1, 40_000, 0], ["3100", A2, 30_000, 0], ["3100", SELLER, 10_000, 0]].sort());
      expect(await bal(p, A1)).toBe(a1 - 40_000);
      expect((await types(p, A1)).at(-1)).toMatchObject({ line_type: "distribution", amount_cents: -40000 });
      expect(Number((await table(p, USER_A1))!.distributions_amount)).toBe(400); // the read model follows the ledger
      expect((await rpc("SELECT post_distribution_event($1, $2) AS r", [id, ADMIN])).status).toBe("already_posted");
      // Voiding reverses it.
      await ok("UPDATE distribution_events SET status = 'voided' WHERE id = $1", [id]);
      expect(await bal(p, A1)).toBe(a1);
      expect(Number((await table(p, USER_A1))!.distributions_amount)).toBe(0);
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE source_ref = $1", [`distribution:${id}`])).toBe(2);
    });

    it("an event with no stored split is divided pro rata by the holders on the record date", async () => {
      const p = await llc([[A1, "buyer", 6], [A2, "buyer", 2]]);
      const id = (await ok("INSERT INTO distribution_events (property_id, total_amount, record_date) VALUES ($1, 100.01, '2025-09-09') RETURNING id", [p]))[0]!.id as string;
      const e = (await ok("SELECT id FROM journal_entries WHERE source_ref = $1", [`distribution:${id}`]))[0]!;
      const dr = Object.fromEntries((await lines(e.id)).filter((l) => l.code === "3100").map((l) => [l.member_id, Number(l.debit_cents)]));
      expect(dr).toEqual({ [A1]: 7_501, [A2]: 2_500 });
      expect(Object.values(dr).reduce((s, c) => s + c, 0)).toBe(10_001);
    });
  });

  describe("(f) resale transfers", () => {
    const sell = async (p: string, shareNumber: number, from: string, to: string, price = 12_500, fromKind: "buyer" | "seller" = "buyer") => {
      const tx = (await ok("INSERT INTO resale_transactions (price) VALUES ($1) RETURNING id", [price]))[0]!.id as string;
      await ok("UPDATE cap_table_entries SET holder_type = 'buyer_account', buyer_account_id = $3, seller_id = NULL WHERE property_id = $1 AND share_number = $2", [p, shareNumber, to]);
      await svc(async () => ok("INSERT INTO cap_table_history (property_id, share_number, from_buyer_account_id, from_seller_id, to_buyer_account_id, resale_transaction_id, changed_at) VALUES ($1, $2, $3, $4, $5, $6, '2025-10-01T12:00:00Z')", [p, shareNumber, fromKind === "buyer" ? from : null, fromKind === "seller" ? from : null, to, tx]));
      return tx;
    };

    it("moves exactly the selling holder's balance for that share to the buyer in one entry, and total capital is unchanged", async () => {
      const p = await llc([[A1, "buyer", 4], [A2, "buyer", 4]]);
      await post(p, [{ code: "1000", debit_cents: 1_000 }, { code: "3000", member_id: A1, credit_cents: 1_000 }], { source: "capital_call", entry_date: "2025-05-01" }); // A1: 400,000 + 1,000
      const balA1 = await bal(p, A1);
      const balA2 = await bal(p, A2);
      const total = await totalCapital(p);
      const equityBefore = await trialMember(p);
      const tx = await sell(p, 4, A1, A3);
      const moved = Math.round(balA1 / 4); // the seller held 4 shares: one quarter of their balance goes with the share
      const t = (await ok("SELECT * FROM capital_transfers WHERE resale_transaction_id = $1", [tx]))[0]!;
      expect(t).toMatchObject({ property_id: p, share_number: 4, from_member: A1, to_member: A3, seller_shares_before: 4 });
      expect([Number(t.seller_balance_before_cents), Number(t.transferred_cents), Number(t.recorded_price)]).toEqual([balA1, moved, 12_500]);
      expect(moved).toBe(100_250);
      // One entry, two lines, a transfer_out on the seller and a transfer_in on the acquirer.
      const e = (await ok("SELECT * FROM journal_entries WHERE id = $1", [t.entry_id]))[0]!;
      expect(e).toMatchObject({ source: "resale", source_ref: `resale:${tx}` });
      expect(e.memo).toMatch(/share #4 at the recorded price of 12500\. No Section 754 adjustment computed/);
      expect(shape(await lines(e.id)).sort()).toEqual([["3200", A1, moved, 0], ["3200", A3, 0, moved]].sort());
      expect((await types(p, A1)).at(-1)).toMatchObject({ line_type: "transfer_out", amount_cents: -moved });
      expect((await types(p, A3))[0]).toMatchObject({ line_type: "transfer_in", amount_cents: moved });
      expect(await bal(p, A1)).toBe(balA1 - moved);
      expect(await bal(p, A3)).toBe(moved);
      expect(await bal(p, A2)).toBe(balA2); // nobody else is touched
      expect(await totalCapital(p)).toBe(total); // total capital unchanged
      expect(await trialMember(p)).toBe(equityBefore);
      // The audit trail and the CPA flag; nothing about Section 754 is computed.
      expect((await ok("SELECT metadata FROM audit_log WHERE action_type = 'capital.resale_transfer' AND entity_id = $1", [e.id]))[0]!.metadata).toMatchObject({ resale_transaction_id: tx, transferred_cents: moved, section_754: "not computed; CPA flag raised" });
      const flags = await ok("SELECT flag_type, note FROM cpa_worksheet_flags WHERE resale_transaction_id = $1", [tx]);
      expect(flags).toHaveLength(1);
      expect(flags[0]!.flag_type).toBe("cpa_cooperation_worksheet");
      expect(flags[0]!.note).toMatch(/No Section 754 basis adjustment is computed/);
      // Once only.
      const h = (await ok("SELECT id FROM cap_table_history WHERE resale_transaction_id = $1", [tx]))[0]!.id;
      expect((await rpc("SELECT post_resale_transfer($1, $2) AS r", [h, ADMIN])).status).toBe("already_posted");
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE source_ref = $1", [`resale:${tx}`])).toBe(1);
      expect(await count("SELECT count(*)::int n FROM cpa_worksheet_flags WHERE resale_transaction_id = $1", [tx])).toBe(1);
    });

    it("a holder with one share moves their whole balance; a joint account is still one capital account", async () => {
      const p = await llc([[A1, "buyer", 7], [SELLER, "seller", 1]]);
      const sellerBal = await bal(p, SELLER);
      const total = await totalCapital(p);
      const tx = await sell(p, 8, SELLER, A2, 5_000, "seller");
      expect(Number((await ok("SELECT transferred_cents FROM capital_transfers WHERE resale_transaction_id = $1", [tx]))[0]!.transferred_cents)).toBe(sellerBal);
      expect(await bal(p, SELLER)).toBe(0);
      expect(await bal(p, A2)).toBe(sellerBal);
      expect(await totalCapital(p)).toBe(total);
      // The two-person account that bought is one member: one capital account row.
      expect((await ok("SELECT DISTINCT member_key FROM capital_account_ledger WHERE property_id = $1 ORDER BY member_key", [p])).map((r) => r.member_key).sort()).toEqual([A1, A2, SELLER].sort());
    });

    it("a seller with a negative balance transfers the negative, and still nets to the same total", async () => {
      const p = await llc([[A1, "buyer", 4], [A2, "buyer", 4]]);
      await post(p, [{ code: "3200", member_id: A1, debit_cents: 500_000 }, { code: "1290", credit_cents: 500_000 }], { entry_date: "2025-06-01", source_ref: "depreciation:manual:1" });
      const balA1 = await bal(p, A1);
      expect(balA1).toBeLessThan(0);
      const total = await totalCapital(p);
      await sell(p, 1, A1, A3);
      expect(await bal(p, A3)).toBe(Math.round(balA1 / 4));
      expect(await totalCapital(p)).toBe(total);
    });

    it("never blocks a completed sale: if the ledger can't take it the sale stands, and the Manager can post it later", async () => {
      const p = await llc([[A1, "buyer", 4], [A2, "buyer", 4]]);
      await svc(async () => ok("SELECT close_period($1, 2025, 10, $2)", [p, ADMIN]));
      const tx = await sell(p, 2, A1, A3);
      expect(await count("SELECT count(*)::int n FROM cap_table_history WHERE resale_transaction_id = $1", [tx])).toBe(1); // the sale went through
      expect(await count("SELECT count(*)::int n FROM capital_transfers WHERE resale_transaction_id = $1", [tx])).toBe(0);
      const synced = await rpc("SELECT sync_month5_events($1, $2) AS r", [p, ADMIN]);
      expect(synced.transfers).toBe(0);
      expect(synced.problems).toHaveLength(1);
      expect(synced.problems[0].error).toMatch(/closed/);
      await svc(async () => ok("SELECT reopen_period($1, 2025, 10, $2, 'Post the capital transfer')", [p, ADMIN]));
      expect((await rpc("SELECT sync_month5_events($1, $2) AS r", [p, ADMIN])).transfers).toBe(1);
    });
  });

  describe("the roll-forward", () => {
    it("per member: beginning, each kind of movement, ending; year to year comparable; totals equal the ledger", async () => {
      const p = await llc([[A1, "buyer", 4], [A2, "buyer", 4]]);
      // 2025: opening (50/50 of $8,000), a contribution, income, an expense, a distribution, depreciation.
      await post(p, [{ code: "1000", debit_cents: 20_000 }, { code: "3000", member_id: A1, credit_cents: 20_000 }], { source: "capital_call", entry_date: "2025-04-04" });
      await post(p, [{ code: "1000", debit_cents: 10_000 }, { code: "4000", credit_cents: 10_000 }], { entry_date: "2025-05-05" });
      await rpc("SELECT allocate_income($1, '2025-12-31', $2) AS r", [p, ADMIN]);
      const exp = (await ok("INSERT INTO expenses (property_id, description, category, total_amount, incurred_on) VALUES ($1, 'Roof', 'Structure & roof', 600, '2025-06-06') RETURNING id", [p]))[0]!.id;
      await ok("INSERT INTO expense_allocations (expense_id, holder_key, amount) VALUES ($1, $2, 300), ($1, $3, 300)", [exp, A1, A2]);
      await svc(async () => ok("UPDATE expenses SET status = 'posted' WHERE id = $1", [exp]));
      await ok("INSERT INTO distribution_events (property_id, total_amount, record_date, lines) VALUES ($1, 200, '2025-07-07', $2::jsonb)", [p, J([{ holder_key: A1, share_count: 4, amount: 100 }, { holder_key: A2, share_count: 4, amount: 100 }])]);
      await rpc("SELECT post_depreciation($1, 2025, 40000, 'S25', NULL, $2) AS r", [p, ADMIN]);
      // 2026: more of the same, and a transfer.
      await post(p, [{ code: "1000", debit_cents: 5_000 }, { code: "3000", member_id: A2, credit_cents: 5_000 }], { source: "capital_call", entry_date: "2026-02-02" });
      await post(p, [{ code: "1000", debit_cents: 4_000 }, { code: "4000", credit_cents: 4_000 }], { entry_date: "2026-03-03" });
      await rpc("SELECT allocate_income($1, '2026-06-30', $2) AS r", [p, ADMIN]);

      const rf = async (year: number) => (await svc(async () => ok("SELECT * FROM capital_roll_forward($1, $2)", [p, year]))).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === "member_key" ? v : Number(v)])));
      const y25 = await rf(2025);
      const y26 = await rf(2026);
      const a1_25 = y25.find((r) => r.member_key === A1)!;
      // 2025 for A1: opening 400,000; contribution 20,000; income 5,000 (half of 10,000); expense -30,000; depreciation -20,000; distribution -10,000.
      expect(a1_25).toMatchObject({ beginning_cents: 0, opening_cents: 400_000, contributions_cents: 20_000, income_cents: 5_000, expense_cents: -30_000, depreciation_cents: -20_000, distributions_cents: -10_000, transfer_in_cents: 0, transfer_out_cents: 0 });
      expect(a1_25.ending_cents).toBe(400_000 + 20_000 + 5_000 - 30_000 - 20_000 - 10_000);
      for (const r of [...y25, ...y26]) {
        // Beginning plus every movement is the ending.
        expect(r.beginning_cents + r.opening_cents + r.contributions_cents + r.income_cents + r.expense_cents + r.depreciation_cents + r.distributions_cents + r.transfer_in_cents + r.transfer_out_cents).toBe(r.ending_cents);
      }
      // Beginning of 2026 is ending of 2025, member by member.
      for (const r of y26) expect(r.beginning_cents).toBe(y25.find((x) => x.member_key === r.member_key)!.ending_cents);
      // Totals equal the ledger, and the member equity on the trial balance.
      const sum = (rows: typeof y25, k: string) => rows.reduce((s, r) => s + (r as any)[k], 0);
      expect(sum(y25, "ending_cents")).toBe(Number((await ok("SELECT sum(amount_cents)::bigint s FROM capital_account_ledger WHERE property_id = $1 AND effective_date <= '2025-12-31'", [p]))[0]!.s));
      expect(sum(y25, "ending_cents")).toBe(await trialMember(p, "2025-12-31"));
      expect(sum(y26, "ending_cents")).toBe(await totalCapital(p));
      expect(sum(y26, "ending_cents")).toBe(await trialMember(p, "2026-12-31"));
      // 2026 only has its own year's movements.
      expect(y26.find((r) => r.member_key === A2)).toMatchObject({ contributions_cents: 5_000, income_cents: 2_000, opening_cents: 0, expense_cents: 0, depreciation_cents: 0 });
      // A year before the books: nothing. A year after the last entry: beginning equals ending.
      expect(await rf(2024)).toEqual([]);
      for (const r of await rf(2030)) expect([r.beginning_cents, r.ending_cents, r.contributions_cents]).toEqual([y26.find((x) => x.member_key === r.member_key)!.ending_cents, y26.find((x) => x.member_key === r.member_key)!.ending_cents, 0]);
    });

    it("a transfer shows as transfer_out and transfer_in in its year, and the total across members is unchanged", async () => {
      const p = await llc([[A1, "buyer", 4], [A2, "buyer", 4]]);
      const before = (await svc(async () => ok("SELECT * FROM capital_roll_forward($1, 2025)", [p]))).reduce((s, r) => s + Number(r.ending_cents), 0);
      const tx = (await ok("INSERT INTO resale_transactions (price) VALUES (1) RETURNING id"))[0]!.id;
      await ok("UPDATE cap_table_entries SET buyer_account_id = $2 WHERE property_id = $1 AND share_number = 1", [p, A3]);
      await svc(async () => ok("INSERT INTO cap_table_history (property_id, share_number, from_buyer_account_id, to_buyer_account_id, resale_transaction_id, changed_at) VALUES ($1, 1, $2, $3, $4, '2025-11-11T00:00:00Z')", [p, A1, A3, tx]));
      const rows = await svc(async () => ok("SELECT * FROM capital_roll_forward($1, 2025)", [p]));
      expect(rows.reduce((s, r) => s + Number(r.ending_cents), 0)).toBe(before);
      expect(Number(rows.find((r) => r.member_key === A1)!.transfer_out_cents)).toBe(-100_000);
      expect(Number(rows.find((r) => r.member_key === A3)!.transfer_in_cents)).toBe(100_000);
    });

    it("is for the server only: no signed-in user or visitor calls it", async () => {
      const p = await llc();
      for (const [role, uid] of [["authenticated", ADMIN], ["anon", null]] as const) expect((await asRole(role, uid, async () => fails("SELECT * FROM capital_roll_forward($1, 2025)", [p]))).code).toBe("42501");
    });
  });

  describe("no double counting with Month 5", () => {
    it("every Month 5 total equals the ledger after all of the above, and every capital entry balances", async () => {
      const rows = await svc(async () => ok("SELECT property_id, user_id, matches FROM owner_capital_reconciliation WHERE member_key IS NOT NULL"));
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.matches, `${r.property_id} ${r.user_id}`).toBe(true);
      expect(await ok("SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING sum(debit_cents) <> sum(credit_cents)")).toEqual([]);
      // No Month 5 event posts twice: each source reference appears once among non-reversal entries.
      expect(await ok("SELECT property_id, source_ref FROM journal_entries WHERE reverses_entry_id IS NULL AND source_ref ~ '^(contribution|allocation-expense|distribution|resale):' GROUP BY 1, 2 HAVING count(*) > 1")).toEqual([]);
      // The old contributed total isn't also posted as a second 'owner_capital_accounts' entry for a tagged contribution.
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE source_ref LIKE 'owner_capital_accounts:%'")).toBe(0);
    });
  });
});
