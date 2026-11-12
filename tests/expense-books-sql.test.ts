/**
 * Month 6, Prompt 8, on a real Postgres (PGlite): bookkeeping, capital-accounts, bank-feed, books, the real Month 5 expenses.sql,
 * capital-events and then expense-books.sql, as written. Every expense posts two entries, the allocation always adds up to the
 * expense, an Operating Agreement override applies only when configured, and a void reverses the journal and the capital lines.
 * Skips when PGlite isn't installed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { splitByPercents, splitProRata } from "@/lib/expenses";

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
const A1 = U(11); // rank 1
const A2 = U(12); // rank 2
const SELLER = U(21);
const SK = `seller:${SELLER}`;
const OTHER = U(99);

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

/** An open LLC of 8 shares: A1 holds 4 (rank 1), A2 holds 3, the retained seller holds 1. */
async function llc(open = true) {
  const id = (await ok("INSERT INTO properties (listing_price) VALUES (8000) RETURNING id"))[0]!.id as string;
  let n = 1;
  for (const [h, kind, shares] of [[A1, "buyer", 4], [A2, "buyer", 3], [SELLER, "seller", 1]] as const) {
    for (let i = 0; i < shares; i++) await ok("INSERT INTO cap_table_entries (property_id, share_number, holder_type, buyer_account_id, seller_id) VALUES ($1, $2, $3, $4, $5)", [id, n++, kind === "buyer" ? "buyer_account" : "retained_seller", kind === "buyer" ? h : null, kind === "seller" ? h : null]);
  }
  await ok("INSERT INTO entity_genesis (property_id, cap_table_locked_at) VALUES ($1, now())", [id]);
  if (open) await openLedger(id);
  return id;
}
async function openLedger(id: string) {
  await pg!.exec("ALTER TABLE properties DISABLE TRIGGER properties_open_ledger");
  await svc(async () => ok("UPDATE properties SET deed_recorded_at = '2025-03-01T00:00:00Z' WHERE id = $1", [id]));
  await pg!.exec("ALTER TABLE properties ENABLE TRIGGER properties_open_ledger");
  expect((await rpc("SELECT open_property_ledger($1, $2) AS r", [id, ADMIN])).status).toBe("opened");
}
const HOLDERS = [{ holderKey: A1, shares: 4, rank: 1 }, { holderKey: A2, shares: 3, rank: 2 }, { holderKey: SK, shares: 1, rank: 3 }];
const draft = async (p: string, dollars: number, category = "Plumbing", date = "2026-05-10", description = "Burst pipe") =>
  (await ok("INSERT INTO expenses (property_id, description, category, total_amount, incurred_on) VALUES ($1, $2, $3, $4, $5) RETURNING id", [p, description, category, dollars, date]))[0]!.id as string;
const post = (id: string, lines: ReturnType<typeof splitProRata>) => tryRpc("SELECT post_expense($1, $2::jsonb, $3)", [id, J(lines), ADMIN]);
const posted = async (p: string, dollars: number, o: { category?: string; date?: string; lines?: ReturnType<typeof splitProRata> } = {}) => {
  const id = await draft(p, dollars, o.category, o.date);
  const r = await post(id, o.lines ?? splitProRata(dollars, HOLDERS));
  expect(r.message).toBe("");
  return id;
};
const entries = (id: string) => ok("SELECT id, source, source_ref, entry_date::text AS entry_date, reverses_entry_id FROM journal_entries WHERE source_ref IN ($1, $2) ORDER BY posted_at, source_ref", [`expense:${id}`, `allocation-expense:${id}`]);
const lines = (entry: string) => ok("SELECT a.code, l.member_id, l.debit_cents, l.credit_cents FROM journal_lines l JOIN coa_accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY a.code, l.debit_cents DESC, l.credit_cents DESC", [entry]);
const bal = async (p: string, m: string) => Number((await ok("SELECT COALESCE(sum(amount_cents), 0)::bigint s FROM capital_account_ledger WHERE property_id = $1 AND member_key = $2", [p, m]))[0]!.s);
const net = async (p: string, code: string) => {
  const tb = await svc(async () => ok("SELECT * FROM trial_balance($1, '2100-01-01')", [p]));
  const r = tb.find((x) => x.code === code);
  return r ? Number(r.debit_cents) - Number(r.credit_cents) : 0;
};
const saveOverride = (p: string, o: Record<string, unknown> = {}) => {
  const r = { category: "Plumbing", expense: null, method: "custom_percent", params: { percents: { [A1]: 50, [A2]: 30, [SK]: 20 } }, section: "OA 5.2", from: "2025-01-01", actor: ADMIN, ...o };
  return [p, r.category, r.expense, r.method, J(r.params), r.section, r.from, r.actor];
};
const SAVE = "SELECT save_allocation_override($1, $2, $3, $4, $5::jsonb, $6, $7, $8) AS r";

describe.skipIf(!pg)("expense-books.sql", () => {
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
      CREATE TABLE distribution_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, total_amount numeric NOT NULL, record_date date NOT NULL, status text NOT NULL DEFAULT 'posted', lines jsonb);
      -- What the real expenses.sql builds on (Month 5): a maintenance request and a vote.
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
      INSERT INTO buyer_accounts VALUES ('${A1}', '${U(31)}'), ('${A2}', '${U(32)}');
    `);
    // The deployed order: the Month 5 expenses first, then the Month 6 files.
    for (const f of ["bookkeeping.sql", "capital-accounts.sql", "bank-feed.sql", "books.sql", "expenses.sql", "capital-events.sql"]) await pg!.exec(readFileSync(f, "utf8"));
    const sql = readFileSync("expense-books.sql", "utf8");
    await pg!.exec(sql);
    await pg!.exec(sql); // safe to run again
  }, 90_000);

  describe("posting an expense writes the expense and its allocation, in cents, through post_entry", () => {
    it("Dr the expense account Cr Cash for the whole expense, then Dr each member's capital account Cr the expense account", async () => {
      const p = await llc();
      const lines0 = splitProRata(1000.03, HOLDERS); // 100003 cents: 50001 + 37501 + 12500, the 1 leftover cent to rank 1
      expect(lines0.map((l) => l.amount)).toEqual([500.02, 375.01, 125]);
      const id = await posted(p, 1000.03, { lines: lines0 });
      const [exp, alloc] = await entries(id);
      expect(exp).toMatchObject({ source: "expense", source_ref: `expense:${id}`, reverses_entry_id: null });
      expect(String(exp!.entry_date).slice(0, 10)).toBe("2026-05-10");
      expect((await lines(exp!.id)).map((l) => [l.code, l.member_id ?? null, Number(l.debit_cents), Number(l.credit_cents)])).toEqual([["1000", null, 0, 100_003], ["6400", null, 100_003, 0]]);
      const a = (await lines(alloc!.id)).map((l) => [l.code, l.member_id ?? null, Number(l.debit_cents), Number(l.credit_cents)]);
      expect(a).toEqual(expect.arrayContaining([["3200", A1, 50_002, 0], ["3200", A2, 37_501, 0], ["3200", SELLER, 12_500, 0], ["6400", null, 0, 100_003]]));
      // The cost passed through: the expense account nets to zero, cash is down by the expense, and capital fell by exactly the expense.
      expect(await net(p, "6400")).toBe(0);
      expect(await net(p, "1000")).toBe(-100_003);
      const before = (await ok("SELECT line_type, amount_cents FROM capital_account_ledger WHERE property_id = $1 AND member_key = $2 AND line_type = 'expense'", [p, A1]));
      expect(before.map((r) => Number(r.amount_cents))).toEqual([-50_002]);
      const sum = Number((await ok("SELECT sum(amount_cents)::bigint s FROM capital_account_ledger WHERE property_id = $1 AND line_type = 'expense'", [p]))[0]!.s);
      expect(sum).toBe(-100_003);
    });

    it("the expense account follows the category, and posting again changes nothing", async () => {
      const p = await llc();
      const id = await posted(p, 800, { category: "Insurance" });
      expect((await lines((await entries(id))[0]!.id)).map((l) => l.code)).toEqual(["1000", "6100"]);
      const again = await rpc("SELECT post_expense_allocation($1, $2) AS r", [id, ADMIN]);
      expect(again.status).toBe("already_posted");
      expect((await entries(id)).length).toBe(2);
      expect((await rpc("SELECT post_expense($1, $2::jsonb, $3) AS r", [id, J(splitProRata(800, HOLDERS)), ADMIN])).applied).toBe(false);
    });

    it("a two-member account counts as its share count: it is ONE capital account", async () => {
      const p = await llc();
      await posted(p, 400);
      expect(await count("SELECT count(DISTINCT member_key)::int n FROM capital_account_ledger WHERE property_id = $1 AND line_type = 'expense'", [p])).toBe(3);
      expect(await count("SELECT count(*)::int n FROM capital_account_ledger WHERE property_id = $1 AND member_key = $2 AND line_type = 'expense'", [p, A2])).toBe(1);
    });
  });

  describe("the allocation always adds up to the expense", () => {
    it("the default split is checked against the rule: pro rata to shares, down to the cent, leftover cents to rank 1", async () => {
      const p = await llc();
      for (const dollars of [0.8, 1, 99.99, 1234.56, 20000.01]) {
        const lines0 = splitProRata(dollars, HOLDERS);
        expect(lines0.reduce((s, l) => s + Math.round(l.amount * 100), 0)).toBe(Math.round(dollars * 100));
        expect((await post(await draft(p, dollars), lines0)).message, String(dollars)).toBe("");
      }
    });

    it("refuses a split that doesn't add up, one that isn't the default split, or one that skips a holder", async () => {
      const p = await llc();
      const id = await draft(p, 1000);
      const short = splitProRata(1000, HOLDERS).map((l, i) => (i === 0 ? { ...l, amount: l.amount - 0.01 } : l));
      expect((await post(id, short)).message).toMatch(/must add up to the total exactly/);
      // Adds up, but 60/20/20 isn't pro rata and there is no override.
      const wrong = [{ holder_key: A1, share_count: 4, amount: 600 }, { holder_key: A2, share_count: 3, amount: 200 }, { holder_key: SK, share_count: 1, amount: 200 }];
      expect((await post(id, wrong)).message).toMatch(/doesn't follow the default pro-rata split/);
      expect((await post(id, [{ holder_key: A1, share_count: 4, amount: 500 }, { holder_key: A2, share_count: 3, amount: 500 }])).message).toMatch(/cap table just changed/);
      expect((await ok("SELECT status FROM expenses WHERE id = $1", [id]))[0]!.status).toBe("draft");
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE source_ref LIKE $1", [`%${id}`])).toBe(0);
    });

    it("the database checks it at commit too, whoever writes the rows", async () => {
      const p = await llc();
      const id = await draft(p, 500);
      let message = "";
      try {
        await pg!.exec(`BEGIN; INSERT INTO expense_allocations (expense_id, holder_key, share_count, amount) VALUES ('${id}', '${A1}', 4, 249.99), ('${id}', '${A2}', 3, 187.50), ('${id}', '${SK}', 1, 62.50);
          UPDATE expenses SET status = 'posted' WHERE id = '${id}'; COMMIT;`);
      } catch (e) {
        message = (e as Error).message;
        await pg!.exec("ROLLBACK");
      }
      expect(message).toMatch(/add up to the total exactly|doesn't follow/);
      expect((await ok("SELECT status FROM expenses WHERE id = $1", [id]))[0]!.status).toBe("draft");
    });
  });

  describe("an Operating Agreement override", () => {
    it("applies only when configured: before it exists the default applies, after it the allocation must follow it", async () => {
      const p = await llc();
      const plain = await draft(p, 1000.01);
      const ov = await rpc(SAVE, saveOverride(p));
      // The override covers Plumbing expenses incurred from 2025-01-01: the default split no longer passes for them.
      expect((await post(plain, splitProRata(1000.01, HOLDERS))).message).toMatch(/doesn't follow the Operating Agreement override \(OA 5\.2\)/);
      const byOverride = splitByPercents(1000.01, HOLDERS, { [A1]: 50, [A2]: 30, [SK]: 20 });
      expect(byOverride.map((l) => l.amount)).toEqual([500.01, 300, 200]); // the leftover cent to rank 1
      expect((await post(plain, byOverride)).message).toBe("");
      expect((await ok("SELECT allocation_override_id FROM expenses WHERE id = $1", [plain]))[0]!.allocation_override_id).toBe(ov);
      // The capital lines follow the override, in cents.
      const alloc = (await entries(plain))[1]!;
      expect((await lines(alloc.id)).map((l) => [l.code, l.member_id ?? null, Number(l.debit_cents), Number(l.credit_cents)])).toEqual(expect.arrayContaining([["3200", A1, 50_001, 0], ["3200", A2, 30_000, 0], ["3200", SELLER, 20_000, 0]]));
      // Another category has no override: the default applies and is recorded as such.
      const other = await posted(p, 800, { category: "Utilities" });
      expect((await ok("SELECT allocation_override_id FROM expenses WHERE id = $1", [other]))[0]!.allocation_override_id).toBeNull();
      expect((await post(await draft(p, 800, "Utilities"), splitByPercents(800, HOLDERS, { [A1]: 50, [A2]: 30, [SK]: 20 }))).message).toMatch(/default pro-rata split/);
    });

    it("is not applied before its effective date or after it is retired, and a newer one replaces an older one", async () => {
      const p = await llc();
      const future = await rpc(SAVE, saveOverride(p, { category: "HVAC", from: "2026-09-01" }));
      expect((await post(await draft(p, 900, "HVAC", "2026-05-10"), splitProRata(900, HOLDERS))).message).toBe(""); // incurred before it takes effect
      expect((await post(await draft(p, 900, "HVAC", "2026-09-02"), splitProRata(900, HOLDERS))).message).toMatch(/Operating Agreement override/);
      await svc(async () => ok("SELECT retire_allocation_override($1, 'OA amended', $2)", [future, ADMIN]));
      expect((await post(await draft(p, 900, "HVAC", "2026-09-02"), splitProRata(900, HOLDERS))).message).toBe("");
      // Two in force: the latest effective date wins.
      await rpc(SAVE, saveOverride(p, { category: "Pest", from: "2025-01-01", params: { percents: { [A1]: 40, [A2]: 40, [SK]: 20 } }, section: "OA 5.1" }));
      await rpc(SAVE, saveOverride(p, { category: "Pest", from: "2026-01-01", params: { percents: { [A1]: 25, [A2]: 25, [SK]: 50 } }, section: "OA 5.3" }));
      const id = await draft(p, 1000, "Pest", "2026-06-01");
      expect((await post(id, splitByPercents(1000, HOLDERS, { [A1]: 40, [A2]: 40, [SK]: 20 }))).message).toMatch(/OA 5\.3/);
      expect((await post(id, splitByPercents(1000, HOLDERS, { [A1]: 25, [A2]: 25, [SK]: 50 }))).message).toBe("");
    });

    it("one named for a single expense beats one for its category", async () => {
      const p = await llc();
      await rpc(SAVE, saveOverride(p, { category: "Electrical" }));
      const id = await draft(p, 1000, "Electrical");
      await rpc(SAVE, saveOverride(p, { category: null, expense: id, params: { percents: { [A1]: 10, [A2]: 10, [SK]: 80 } }, section: "OA 5.9" }));
      expect((await post(id, splitByPercents(1000, HOLDERS, { [A1]: 50, [A2]: 30, [SK]: 20 }))).message).toMatch(/OA 5\.9/);
      expect((await post(id, splitByPercents(1000, HOLDERS, { [A1]: 10, [A2]: 10, [SK]: 80 }))).message).toBe("");
    });

    it("usage-adjusted is the same manual-percent entry, and needs the basis; the platform has no usage formula", async () => {
      const p = await llc();
      expect((await tryRpc(SAVE, saveOverride(p, { method: "usage_adjusted" }))).message).toMatch(/Say what the usage adjustment is based on/);
      const id = await rpc(SAVE, saveOverride(p, { method: "usage_adjusted", params: { percents: { [A1]: 70, [A2]: 20, [SK]: 10 }, basis: "Nights used, FY2025 (entered by the Manager)" } }));
      expect((await ok("SELECT method, parameters FROM allocation_overrides WHERE id = $1", [id]))[0]).toMatchObject({ method: "usage_adjusted" });
      const src = readFileSync("expense-books.sql", "utf8") + readFileSync("src/lib/capital.server.ts", "utf8");
      expect(src).not.toMatch(/nights_used|usage_formula|calculate_usage/i);
    });

    it("is Manager-entered, needs the OA section, covers every holder with percentages that total 100, and is audit logged", async () => {
      const p = await llc();
      for (const who of [OTHER, U(31), null]) expect((await tryRpc(SAVE, saveOverride(p, { actor: who }))).message, String(who)).toMatch(/Only the Manager/);
      expect((await tryRpc(SAVE, saveOverride(p, { section: "  " }))).message).toMatch(/Name the Operating Agreement section/);
      expect((await tryRpc(SAVE, saveOverride(p, { params: { percents: { [A1]: 50, [A2]: 30, [SK]: 19.99 } } }))).message).toMatch(/add up to exactly 100/);
      expect((await tryRpc(SAVE, saveOverride(p, { params: { percents: { [A1]: 100, [A2]: 0, [SK]: 0 } } }))).message).toMatch(/above zero/);
      expect((await tryRpc(SAVE, saveOverride(p, { params: { percents: { [A1]: 60, [A2]: 40 } } }))).message).toMatch(/every current holder/);
      expect((await tryRpc(SAVE, saveOverride(p, { params: { percents: { [A1]: 40, [A2]: 30, [SK]: 20, [OTHER]: 10 } } }))).message).toMatch(/every current holder/);
      expect((await tryRpc(SAVE, saveOverride(p, { category: "Plumbing", expense: await draft(p, 10) }))).message).toMatch(/either an expense category or one expense/);
      expect((await tryRpc(SAVE, saveOverride(p, { category: null, expense: null }))).message).toMatch(/either an expense category or one expense/);
      const done = await posted(p, 100, { category: "Appliance" });
      expect((await tryRpc(SAVE, saveOverride(p, { category: null, expense: done }))).message).toMatch(/already posted/);
      const id = await rpc(SAVE, saveOverride(p, { category: "Management", from: "2026-02-01" }));
      const log = (await ok("SELECT actor_id, metadata FROM audit_log WHERE action_type = 'allocation.override_saved' AND entity_id = $1", [id]))[0]!;
      expect(log.actor_id).toBe(ADMIN);
      expect(log.metadata).toMatchObject({ property_id: p, expense_category: "Management", method: "custom_percent", source_oa_section: "OA 5.2", effective_from: "2026-02-01" });
      expect(log.metadata.parameters).toEqual({ percents: { [A1]: 50, [A2]: 30, [SK]: 20 } });
    });

    it("is never edited or deleted: it is retired once, with a reason, and the retirement is audit logged", async () => {
      const p = await llc();
      const id = await rpc(SAVE, saveOverride(p, { category: "Exterior & landscaping" }));
      for (const sql of ["UPDATE allocation_overrides SET source_oa_section = 'x'", "DELETE FROM allocation_overrides", "TRUNCATE allocation_overrides"]) {
        expect((await tryRpc(sql)).code, sql).toBe("42501");
      }
      expect((await tryRpc("SELECT retire_allocation_override($1, '  ', $2)", [id, ADMIN])).message).toMatch(/Say why/);
      expect((await tryRpc("SELECT retire_allocation_override($1, 'OA amended', $2)", [id, OTHER])).message).toMatch(/Only the Manager/);
      expect((await tryRpc("SELECT retire_allocation_override($1, 'OA amended', $2)", [id, ADMIN])).message).toBe("");
      expect((await tryRpc("SELECT retire_allocation_override($1, 'again', $2)", [id, ADMIN])).message).toMatch(/already retired/);
      expect((await ok("SELECT retire_reason FROM allocation_overrides WHERE id = $1", [id]))[0]!.retire_reason).toBe("OA amended");
      expect(await count("SELECT count(*)::int n FROM audit_log WHERE action_type = 'allocation.override_retired' AND entity_id = $1", [id])).toBe(1);
      // Only the Manager reads them; an owner and an outsider see nothing.
      expect(await asRole("authenticated", ADMIN, () => ok("SELECT 1 FROM allocation_overrides WHERE id = $1", [id]))).toHaveLength(1);
      expect(await asRole("authenticated", U(31), () => ok("SELECT 1 FROM allocation_overrides"))).toHaveLength(0);
      expect((await asRole("anon", null, () => fails("SELECT 1 FROM allocation_overrides"))).code).toBe("42501");
    });

    it("the engine in code agrees with the database: down to the cent, leftover cents to rank 1", () => {
      expect(splitByPercents(1000.01, HOLDERS, { [A1]: 50, [A2]: 30, [SK]: 20 }).map((l) => l.amount)).toEqual([500.01, 300, 200]);
      expect(() => splitByPercents(100, HOLDERS, { [A1]: 60, [A2]: 40 })).toThrow(/every current holder/);
      expect(() => splitByPercents(100, HOLDERS, { [A1]: 50, [A2]: 30, [SK]: 10 })).toThrow(/exactly 100/);
      for (const total of [0.5, 1, 33.33, 1000.01, 98765.43]) {
        const l = splitByPercents(total, HOLDERS, { [A1]: 33.34, [A2]: 33.33, [SK]: 33.33 });
        expect(l.reduce((s, x) => s + Math.round(x.amount * 100), 0)).toBe(Math.round(total * 100));
      }
    });
  });

  describe("a maintenance request attributed to the LLC posts through the same path", () => {
    it("completed with an actual cost, it becomes an expense, and posting it writes the same two entries", async () => {
      const p = await llc();
      const req = (await ok("INSERT INTO maintenance_requests (property_id, title, vendor_name, category, actual_cost, status, expense_queued_by) VALUES ($1, 'Leaking tap', 'Acme Plumbing', 'Plumbing', 450.25, 'completed', $2) RETURNING id", [p, ADMIN]))[0]!.id as string;
      const made = await rpc("SELECT create_expense_from_maintenance($1, $2) AS r", [req, ADMIN]);
      expect(made.applied).toBe(true);
      const id = made.expense_id as string;
      expect((await ok("SELECT source, status, total_amount FROM expenses WHERE id = $1", [id]))[0]).toMatchObject({ source: "maintenance", status: "draft" });
      expect((await post(id, splitProRata(450.25, HOLDERS))).message).toBe("");
      const [exp, alloc] = await entries(id);
      expect(exp!.source_ref).toBe(`expense:${id}`);
      expect(alloc!.source_ref).toBe(`allocation-expense:${id}`);
      expect((await lines(exp!.id)).map((l) => Number(l.debit_cents) + Number(l.credit_cents))).toEqual([45_025, 45_025]);
      expect(await net(p, "6400")).toBe(0);
    });
  });

  describe("voiding an expense", () => {
    it("reverses the journal entry and every capital line, and the history stays visible", async () => {
      const p = await llc();
      const a1 = await bal(p, A1);
      const a2 = await bal(p, A2);
      const s = await bal(p, SELLER);
      const id = await posted(p, 1000.03);
      expect(await bal(p, A1)).toBe(a1 - 50_002);
      expect(await rpc("SELECT void_expense($1, 'Duplicate invoice', $2) AS r", [id, ADMIN])).toMatchObject({ applied: true });
      // Capital is back where it was, the expense account and cash too.
      expect([await bal(p, A1), await bal(p, A2), await bal(p, SELLER)]).toEqual([a1, a2, s]);
      expect(await net(p, "6400")).toBe(0);
      expect(await net(p, "1000")).toBe(0);
      // Both original entries are still there, each with its reversing entry pointing back at it.
      const all = await entries(id);
      expect(all.length).toBe(4);
      const originals = all.filter((e) => e.reverses_entry_id === null);
      const reversals = all.filter((e) => e.reverses_entry_id !== null);
      expect(reversals.map((r) => r.reverses_entry_id).sort()).toEqual(originals.map((o) => o.id).sort());
      expect((await ok("SELECT reversal_reason FROM journal_entries WHERE id = $1", [reversals[0]!.id]))[0]!.reversal_reason).toMatch(/The expense was voided: Duplicate invoice/);
      // The reversal also shows in the capital history: lines are added, never removed.
      expect(await count("SELECT count(*)::int n FROM capital_account_ledger WHERE property_id = $1 AND member_key = $2 AND line_type = 'expense'", [p, A1])).toBe(2);
      expect((await ok("SELECT status, void_reason FROM expenses WHERE id = $1", [id]))[0]).toEqual({ status: "voided", void_reason: "Duplicate invoice" });
      expect(await count("SELECT count(*)::int n FROM expense_allocations WHERE expense_id = $1", [id])).toBe(3); // the allocation rows stay
      // Voiding again does nothing; the books are not touched twice.
      expect(await rpc("SELECT void_expense($1, 'again', $2) AS r", [id, ADMIN])).toMatchObject({ applied: false });
      expect((await entries(id)).length).toBe(4);
    });

    it("an expense an owner has already paid can't be voided (their contribution is a decision for a person)", async () => {
      const p = await llc();
      const id = await posted(p, 200);
      await svc(async () => ok("UPDATE expense_allocations SET paid_marked_at = now() WHERE expense_id = $1 AND holder_key = $2", [id, A1]));
      expect((await tryRpc("SELECT void_expense($1, 'x', $2)", [id, ADMIN])).message).toMatch(/already paid or marked this expense paid/);
      expect((await entries(id)).length).toBe(2);
    });
  });

  describe("an expense posted before the books opened, and the Month 6 Prompt 6 shape", () => {
    it("catches up once the books are open: Post Month 5 events writes both entries, once", async () => {
      const p = await llc(false);
      const id = await posted(p, 640, { date: "2026-05-10" }); // the ledger isn't open: Month 5 carries on, nothing is written
      expect((await entries(id)).length).toBe(0);
      await openLedger(p);
      const r = await rpc("SELECT sync_month5_events($1, $2) AS r", [p, ADMIN]);
      expect(r).toMatchObject({ expenses: 1, problems: [] });
      expect((await entries(id)).length).toBe(2);
      expect((await rpc("SELECT sync_month5_events($1, $2) AS r", [p, ADMIN])).expenses).toBe(0);
    });

    it("an expense that only has its allocation entry (as Prompt 6 left it) gets its missing expense entry, and the cost isn't doubled", async () => {
      const p = await llc(false);
      const id = await posted(p, 300);
      await openLedger(p);
      // Prompt 6 wrote only: Dr each member's capital account, Cr the expense account.
      await svc(async () => ok("SELECT post_entry($1, $2::jsonb, $3::jsonb)", [p, J([{ code: "3200", member_id: A1, debit_cents: 15_000 }, { code: "3200", member_id: A2, debit_cents: 11_250 }, { code: "3200", member_id: SELLER, debit_cents: 3_750 }, { code: "6400", credit_cents: 30_000 }]), J({ source: "expense", source_ref: `allocation-expense:${id}`, entry_date: "2026-05-10", created_by: ADMIN })]));
      expect(await net(p, "6400")).toBe(-30_000); // the expense account is short: the expense itself was never posted
      expect((await rpc("SELECT sync_month5_events($1, $2) AS r", [p, ADMIN])).expenses).toBe(1);
      expect(await net(p, "6400")).toBe(0);
      expect((await entries(id)).length).toBe(2);
      expect(await net(p, "1000")).toBe(-30_000);
    });
  });
});
