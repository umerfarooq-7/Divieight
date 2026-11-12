/**
 * Month 6, Prompt 9, on a real Postgres (PGlite): the real bookkeeping, capital-accounts, bank-feed, books, expenses, capital-events,
 * expense-books and then distributions.sql, as written. A distribution can't exceed the distributable cash, uses the holders on the
 * record date, moves the books and the capital accounts exactly once, a failed payment posts nothing, and a member without a payout
 * method is held. Skips when PGlite isn't installed.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
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
const A1 = U(11); // rank 1, auth user U(31)
const A2 = U(12); // rank 2, auth user U(32)
const SELLER = U(21);
const SK = `seller:${SELLER}`;
const AUTH1 = U(31);
const AUTH2 = U(32);

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
const today = () => new Date().toISOString().slice(0, 10);

/** An open LLC of 8 shares: A1 holds 4 (rank 1), A2 holds 3, the retained seller holds 1. */
async function llc() {
  const id = (await ok("INSERT INTO properties (listing_price) VALUES (8000) RETURNING id"))[0]!.id as string;
  let n = 1;
  for (const [h, kind, shares] of [[A1, "buyer", 4], [A2, "buyer", 3], [SELLER, "seller", 1]] as const) {
    for (let i = 0; i < shares; i++) await ok("INSERT INTO cap_table_entries (property_id, share_number, holder_type, buyer_account_id, seller_id) VALUES ($1, $2, $3, $4, $5)", [id, n++, kind === "buyer" ? "buyer_account" : "retained_seller", kind === "buyer" ? h : null, kind === "seller" ? h : null]);
  }
  await ok("INSERT INTO entity_genesis (property_id, cap_table_locked_at) VALUES ($1, now())", [id]);
  await pg!.exec("ALTER TABLE properties DISABLE TRIGGER properties_open_ledger");
  await svc(async () => ok("UPDATE properties SET deed_recorded_at = '2025-03-01T00:00:00Z' WHERE id = $1", [id]));
  await pg!.exec("ALTER TABLE properties ENABLE TRIGGER properties_open_ledger");
  expect((await rpc("SELECT open_property_ledger($1, $2) AS r", [id, ADMIN])).status).toBe("opened");
  return id;
}
/** Cash in the bank, from a deposit (Dr Cash, Cr Other Income). */
const fund = (p: string, cents: number) =>
  rpc("SELECT post_entry($1, $2::jsonb, $3::jsonb) AS r", [p, J([{ code: "1000", debit_cents: cents }, { code: "4000", credit_cents: cents }]), J({ source: "manual", entry_date: "2026-01-05", memo: "Deposit", created_by: ADMIN })]);
const cashOf = async (p: string) => {
  const r = (await svc(async () => ok("SELECT * FROM trial_balance($1, '2100-01-01')", [p]))).find((x) => x.code === "1000");
  return r ? Number(r.debit_cents) - Number(r.credit_cents) : 0;
};
const HOLDERS = [{ holderKey: A1, shares: 4, rank: 1 }, { holderKey: A2, shares: 3, rank: 2 }, { holderKey: SK, shares: 1, rank: 3 }];
const linesFor = (cents: number) => splitProRata(cents / 100, HOLDERS);

const CREATE = "SELECT create_distribution($1, $2, $3::date, $4, $5, $6::jsonb, $7::jsonb, $8, '{}'::jsonb, $9) AS r";
const args = (p: string, cents: number, o: { date?: string; reason?: string; method?: string; override?: unknown; lines?: unknown; actor?: string; replaces?: string | null } = {}) => [
  p, cents, o.date ?? today(), o.reason ?? "Quarterly distribution", o.method ?? "pro_rata", o.override ? J(o.override) : null, J(o.lines ?? linesFor(cents)), o.actor ?? ADMIN, o.replaces ?? null,
];
const make = async (p: string, cents: number, o: Parameters<typeof args>[2] = {}) => (await rpc(CREATE, args(p, cents, o))) as string;
const tryMake = (p: string, cents: number, o: Parameters<typeof args>[2] = {}) => tryRpc(CREATE, args(p, cents, o));
const authorize = (id: string, name = "Mark Manager", actor = ADMIN) => rpc("SELECT authorize_distribution($1, $2, $3) AS r", [id, name, actor]);
const claim = (id: string, holder: string | null = null, actor: string | null = ADMIN) => rpc("SELECT claim_distribution_payments($1, $2, '{}'::jsonb, $3) AS r", [id, actor, holder]);
const result = (payment: string, state: string, reason: string | null = null) => rpc("SELECT record_payment_result($1, $2, $3, $4, $5) AS r", [payment, state, "ref-1", reason, ADMIN]);
const finalize = (id: string) => rpc("SELECT finalize_distribution($1, $2) AS r", [id, ADMIN]);
const payments = (id: string) => ok("SELECT id, holder_key, amount_cents, status, bank_last4, failure_reason, entry_id FROM distribution_payments WHERE distribution_id = $1 ORDER BY holder_key", [id]);
const payOf = async (id: string, holder: string) => (await payments(id)).find((x) => x.holder_key === holder)!;
const status = async (id: string) => (await ok("SELECT status FROM distribution_events WHERE id = $1", [id]))[0]!.status as string;
const method = (holder: string, actor: string, last4 = "1234") => rpc("SELECT save_payout_method($1, $2, $3, 'Test Bank', $4) AS r", [holder, `tok_sim_ok_abcdef${last4}00`, last4, actor]);
const allMethods = async () => {
  await method(A1, AUTH1);
  await method(A2, AUTH2);
  await method(SK, SELLER);
};
const distEntries = (p: string) => ok("SELECT id, source_ref, reverses_entry_id FROM journal_entries WHERE property_id = $1 AND source_ref LIKE 'distribution:%' ORDER BY posted_at, source_ref", [p]);
const lines = (entry: string) => ok("SELECT a.code, l.member_id, l.debit_cents, l.credit_cents FROM journal_lines l JOIN coa_accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY a.code", [entry]);
const capital = async (p: string, m: string) => Number((await ok("SELECT COALESCE(sum(amount_cents), 0)::bigint s FROM capital_account_ledger WHERE property_id = $1 AND member_key = $2 AND line_type = 'distribution'", [p, m]))[0]!.s);

/** Authorize and execute a whole distribution through to sent, the way the app does. */
async function runAll(p: string, cents: number, o: Parameters<typeof args>[2] = {}) {
  const id = await make(p, cents, o);
  await authorize(id);
  const c = await claim(id);
  for (const s of c.send) await result(s.payment_id, "sent");
  await finalize(id);
  return id;
}

describe.skipIf(!pg)("distributions.sql", () => {
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
      CREATE TABLE cap_table_entries (property_id uuid, share_number int, holder_type text, buyer_account_id uuid, seller_id uuid, retention_lock_expires_at timestamptz);
      CREATE TABLE resale_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), price numeric);
      CREATE TABLE cap_table_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, share_number int, from_buyer_account_id uuid, from_seller_id uuid, to_buyer_account_id uuid, to_seller_id uuid, resale_transaction_id uuid, changed_at timestamptz DEFAULT now());
      CREATE TABLE cpa_worksheet_flags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, resale_transaction_id uuid, flag_type text NOT NULL DEFAULT 'section_754_review', note text);
      CREATE TABLE closing_funds_obligations (property_id uuid, amount numeric, status text);
      CREATE TABLE owner_capital_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, user_id uuid NOT NULL, contributed_amount numeric NOT NULL DEFAULT 0, distributions_amount numeric NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (property_id, user_id));
      CREATE TABLE owner_capital_contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, user_id uuid NOT NULL, holder_key text NOT NULL, amount numeric NOT NULL CHECK (amount > 0), contribution_type text NOT NULL CHECK (contribution_type IN ('capital_call', 'expense')), source_allocation_id uuid, created_at timestamptz NOT NULL DEFAULT now());
      -- owner-notifications.sql + money-decisions.sql section 3, as they leave the table.
      CREATE TABLE distribution_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE, total_amount numeric(12, 2) NOT NULL CHECK (total_amount > 0), record_date date NOT NULL, note text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
        status text NOT NULL DEFAULT 'posted', voided_at timestamptz, voided_by uuid, void_reason text, replaces_id uuid REFERENCES distribution_events(id), replaced_by_id uuid REFERENCES distribution_events(id), lines jsonb);
      ALTER TABLE distribution_events ADD CONSTRAINT distribution_events_status_check CHECK (status IN ('posted', 'voided'));
      CREATE FUNCTION public.distribution_events_keep_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
      CREATE TRIGGER distribution_events_history BEFORE UPDATE OR DELETE ON distribution_events FOR EACH ROW EXECUTE FUNCTION public.distribution_events_keep_history();
      ALTER TABLE distribution_events ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON distribution_events TO authenticated;
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
    const sql = readFileSync("distributions.sql", "utf8");
    await pg!.exec(sql);
    await pg!.exec(sql); // safe to run again
  }, 120_000);

  beforeEach(async () => {
    // Payout methods belong to the holder, across properties: every test starts with none.
    await pg!.exec("UPDATE member_payout_methods SET status = 'removed', removed_at = now() WHERE status = 'active'");
  });

  describe("initiating: never more than the distributable cash", () => {
    it("is cash, minus the minimum reserve (a $1,000 placeholder by default), and one cent more is refused", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      const cash = await rpc("SELECT distributable_cash($1) AS r", [p]);
      expect(cash).toMatchObject({ cash_cents: 1_000_000, reserve_cents: 100_000, committed_cents: 0, distributable_cents: 900_000 });
      const over = await tryMake(p, 900_001);
      expect(over.message).toMatch(/more than the distributable cash: 900001 cents against 900000 cents/);
      expect(await status(await make(p, 900_000))).toBe("draft");
    });

    it("follows the property's own reserve, and only the Manager can set it", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      expect((await tryRpc("SELECT set_minimum_reserve($1, 500000, $2)", [p, AUTH1])).message).toContain("Only the Manager");
      await svc(async () => ok("SELECT set_minimum_reserve($1, 500000, $2)", [p, ADMIN]));
      expect((await rpc("SELECT distributable_cash($1) AS r", [p])).distributable_cents).toBe(500_000);
      expect((await tryMake(p, 500_001)).message).toMatch(/more than the distributable cash/);
      await make(p, 500_000);
      expect(await count("SELECT count(*) n FROM audit_log WHERE action_type = 'distribution.reserve_set'")).toBeGreaterThan(0);
    });

    it("counts what authorized distributions still owe, so two of them can't spend the same cash", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      const first = await make(p, 400_000);
      const second = await make(p, 500_000); // a draft owes nothing yet, so both can be drafted
      await authorize(first);
      expect((await rpc("SELECT distributable_cash($1) AS r", [p])).committed_cents).toBe(400_000);
      expect((await tryMake(p, 500_001)).message).toMatch(/more than the distributable cash/);
      expect((await tryRpc("SELECT authorize_distribution($1, 'Mark Manager', $2)", [second, ADMIN])).message).toBe("");
      // the second now owes 500000 on top of 400000 against 900000 available: authorized, and nothing more can be drafted
      expect((await rpc("SELECT distributable_cash($1) AS r", [p])).distributable_cents).toBe(0);
    });

    it("an authorized draft that no longer fits (cash fell after it was drafted) is refused", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      const a = await make(p, 900_000);
      const b = await make(p, 900_000);
      await authorize(a);
      expect((await tryRpc("SELECT authorize_distribution($1, 'Mark Manager', $2)", [b, ADMIN])).message).toMatch(/now more than the distributable cash/);
      expect(await status(b)).toBe("draft");
    });

    it("only the Manager, an open ledger, a reason, a positive total and a record date that isn't in the future", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      expect((await tryMake(p, 1000, { actor: AUTH1 })).message).toContain("Only the Manager");
      expect((await tryMake(p, 1000, { reason: "  " })).message).toContain("Say why");
      expect((await tryMake(p, 0, { lines: linesFor(1000) })).message).toContain("above zero");
      expect((await tryMake(p, 1000, { date: "2999-01-01" })).message).toContain("future");
      const unopened = (await ok("INSERT INTO properties (listing_price) VALUES (1) RETURNING id"))[0]!.id as string;
      expect((await tryMake(unopened, 1000)).message).toContain("not open");
    });
  });

  describe("the split: the holders on the record date, and the cents rule", () => {
    it("uses who held the shares ON THE RECORD DATE, not today's cap table", async () => {
      const p = await llc();
      await fund(p, 2_000_000);
      // Today the seller's one share belongs to A2 (a resale just now); yesterday it was still the seller's.
      await ok("UPDATE cap_table_entries SET holder_type = 'buyer_account', buyer_account_id = $2, seller_id = NULL WHERE property_id = $1 AND share_number = 8", [p, A2]);
      await ok("INSERT INTO cap_table_history (property_id, share_number, from_seller_id, to_buyer_account_id, changed_at) VALUES ($1, 8, $2, $3, now())", [p, SELLER, A2]);
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      // Yesterday's holders: A1 4, A2 3, seller 1.
      const then = await make(p, 800_000, { date: yesterday });
      expect((await ok("SELECT lines FROM distribution_events WHERE id = $1", [then]))[0]!.lines.map((l: any) => [l.holder_key, l.amount])).toEqual([[A1, 4000], [A2, 3000], [SK, 1000]]);
      // Today's: A1 4, A2 4, and the seller is no longer a holder, so a line for them is refused.
      expect((await tryMake(p, 800_000, { date: today() })).message).toMatch(/exactly the holders|did not hold/);
      const nowLines = splitProRata(8000, [{ holderKey: A1, shares: 4, rank: 1 }, { holderKey: A2, shares: 4, rank: 2 }]);
      expect(await status(await make(p, 800_000, { date: today(), lines: nowLines }))).toBe("draft");
      // and yesterday's holders can't be paid on today's table
      expect((await tryMake(p, 800_000, { date: yesterday, lines: nowLines })).message).toMatch(/exactly the holders/);
    });

    it("each line is the rule's amount: rounded down, at most 7 leftover cents, adding up to the total", async () => {
      const p = await llc();
      await fund(p, 2_000_000);
      const lines0 = linesFor(100_003);
      expect(lines0.map((l) => l.amount)).toEqual([500.02, 375.01, 125]);
      await make(p, 100_003, { lines: lines0 });
      const wrong = linesFor(100_003).map((l, i) => (i === 1 ? { ...l, amount: l.amount + 0.2 } : i === 0 ? { ...l, amount: l.amount - 0.2 } : l));
      expect((await tryMake(p, 100_003, { lines: wrong })).message).toContain("not what the split rule gives");
      const short = linesFor(100_003);
      short[2] = { ...short[2]!, amount: short[2]!.amount - 0.01 };
      expect((await tryMake(p, 100_003, { lines: short })).message).toMatch(/not what the split rule gives|add up/);
      expect((await tryMake(p, 100_003, { lines: [...lines0, lines0[0]!] })).message).toMatch(/exactly the holders/);
      const dup = [lines0[0]!, lines0[0]!, lines0[2]!];
      expect((await tryMake(p, 100_003, { lines: dup })).message).toMatch(/did not hold|share count|appears twice|not what the split rule gives/);
    });

    it("an Operating Agreement override: percentages that add up to 100 and name every holder, with the section", async () => {
      const p = await llc();
      await fund(p, 2_000_000);
      const percents = { [A1]: 50, [A2]: 30, [SK]: 20 };
      const lines0 = splitByPercents(8000, HOLDERS, percents);
      expect(lines0.map((l) => l.amount)).toEqual([4000, 2400, 1600]);
      const id = await make(p, 800_000, { method: "oa_override", override: { percents, oa_section: "OA 6.2" }, lines: lines0 });
      expect((await ok("SELECT split_method, override_oa_section, override_percents FROM distribution_events WHERE id = $1", [id]))[0]).toMatchObject({ split_method: "oa_override", override_oa_section: "OA 6.2" });
      expect((await tryMake(p, 800_000, { method: "oa_override", override: { percents, oa_section: "OA 6.2" } })).message).toContain("not what the split rule gives"); // pro rata lines under an override
      expect((await tryMake(p, 800_000, { method: "oa_override", override: { percents: { [A1]: 50, [A2]: 40, [SK]: 20 }, oa_section: "OA 6.2" }, lines: lines0 })).message).toContain("add up to exactly 100");
      expect((await tryMake(p, 800_000, { method: "oa_override", override: { percents, oa_section: " " }, lines: lines0 })).message).toContain("Operating Agreement section");
      expect((await tryMake(p, 800_000, { method: "oa_override", override: { percents: { [A1]: 60, [A2]: 40 }, oa_section: "OA 6.2" }, lines: lines0 })).message).toMatch(/name every holder/);
    });
  });

  describe("authorizing and executing: the books and the capital accounts move once", () => {
    it("draft to authorized needs the Manager's signature; the payments are made at authorization", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      const id = await make(p, 800_000);
      expect(await count("SELECT count(*) n FROM distribution_payments WHERE distribution_id = $1", [id])).toBe(0);
      expect((await tryRpc("SELECT authorize_distribution($1, '  ', $2)", [id, ADMIN])).message).toContain("Sign with your full name");
      expect((await tryRpc("SELECT authorize_distribution($1, 'Mark', $2)", [id, AUTH1])).message).toContain("Only the Manager");
      expect((await authorize(id, "Mark Manager")).status).toBe("authorized");
      expect((await ok("SELECT authorized_by, authorized_signature FROM distribution_events WHERE id = $1", [id]))[0]).toMatchObject({ authorized_by: ADMIN, authorized_signature: "Mark Manager" });
      expect((await payments(id)).map((x) => [x.holder_key, Number(x.amount_cents), x.status])).toEqual(expect.arrayContaining([[A1, 400_000, "pending"], [A2, 300_000, "pending"], [SK, 100_000, "pending"]]));
      expect((await authorize(id)).status).toBe("not_draft"); // authorizing twice changes nothing
      expect(await count("SELECT count(*) n FROM distribution_payments WHERE distribution_id = $1", [id])).toBe(3);
      // nothing is posted by authorizing
      expect(await distEntries(p)).toHaveLength(0);
      expect(await cashOf(p)).toBe(1_000_000);
    });

    it("each payment that goes out posts ONE entry: Dr Member Distributions for that member, Cr Cash; the capital account follows", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      await allMethods();
      const id = await make(p, 800_000);
      await authorize(id);
      const c = await claim(id);
      expect(c.send).toHaveLength(3);
      expect(c.held).toHaveLength(0);
      expect((await payments(id)).every((x) => x.status === "processing")).toBe(true);
      // Still nothing in the books while the bank has it.
      expect(await distEntries(p)).toHaveLength(0);
      for (const s of c.send) expect((await result(s.payment_id, "sent")).status).toBe("sent");
      const entries = await distEntries(p);
      expect(entries).toHaveLength(3);
      const a1 = await payOf(id, A1);
      expect((await lines(a1.entry_id)).map((l) => [l.code, l.member_id ?? null, Number(l.debit_cents), Number(l.credit_cents)])).toEqual([["1000", null, 0, 400_000], ["3100", A1, 400_000, 0]]);
      expect(await cashOf(p)).toBe(200_000);
      expect(await capital(p, A1)).toBe(-400_000);
      expect(await capital(p, A2)).toBe(-300_000);
      expect(await capital(p, SELLER)).toBe(-100_000);
      expect(Number((await ok("SELECT round(distributions_amount * 100) d FROM owner_capital_accounts WHERE property_id = $1 AND user_id = $2", [p, AUTH1]))[0]!.d)).toBe(400_000);
      expect((await finalize(id)).status).toBe("executed");
      expect((await ok("SELECT executed_at FROM distribution_events WHERE id = $1", [id]))[0]!.executed_at).not.toBeNull();
    });

    it("exactly once: asking again to claim, record, execute or finalize changes nothing", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      await allMethods();
      const id = await make(p, 800_000);
      await authorize(id);
      const c = await claim(id);
      expect((await claim(id)).send).toHaveLength(0); // nothing to send twice
      for (const s of c.send) await result(s.payment_id, "sent");
      for (const s of c.send) expect((await result(s.payment_id, "sent")).status).toBe("already_sent");
      await finalize(id);
      await finalize(id);
      expect((await claim(id)).send).toHaveLength(0);
      expect(await distEntries(p)).toHaveLength(3);
      expect(await cashOf(p)).toBe(200_000);
      expect(await capital(p, A1)).toBe(-400_000);
      expect(await count("SELECT count(*) n FROM capital_account_ledger WHERE property_id = $1 AND line_type = 'distribution'", [p])).toBe(3);
      // the same entry can't be posted a second time by any other route either
      expect((await tryRpc("SELECT post_entry($1, $2::jsonb, $3::jsonb)", [p, J([{ code: "3100", member_id: A1, debit_cents: 400_000 }, { code: "1000", credit_cents: 400_000 }]), J({ source: "distribution", source_ref: `distribution:${id}:${A1}`, entry_date: today() })])).message).not.toBe("");
    });

    it("a payment can't be recorded before it was claimed", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      const id = await make(p, 800_000);
      await authorize(id);
      const a1 = await payOf(id, A1);
      expect((await tryRpc("SELECT record_payment_result($1, 'sent', 'x', NULL, $2)", [a1.id, ADMIN])).message).toContain("was not sent to the bank");
      expect(await distEntries(p)).toHaveLength(0);
    });
  });

  describe("a failed ACH posts nothing", () => {
    it("a failed payment leaves the books, the capital account and the cash exactly as they were, and the Manager can retry it", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      await allMethods();
      const id = await make(p, 800_000);
      await authorize(id);
      const c = await claim(id);
      const a1 = c.send.find((s: any) => s.holder_key === A1);
      for (const s of c.send) await result(s.payment_id, s === a1 ? "failed" : "sent", s === a1 ? "Account closed" : null);
      expect((await payOf(id, A1)).status).toBe("failed");
      expect((await payOf(id, A1)).failure_reason).toBe("Account closed");
      expect((await payOf(id, A1)).entry_id).toBeNull();
      expect(await distEntries(p)).toHaveLength(2);
      expect(await capital(p, A1)).toBe(0);
      expect(await cashOf(p)).toBe(1_000_000 - 400_000);
      expect((await finalize(id)).status).toBe("executed"); // the others went out
      expect((await result(a1.payment_id, "sent")).status).toBe("already_failed");
      // retry
      expect((await rpc("SELECT retry_failed_payment($1, $2) AS r", [a1.payment_id, ADMIN])).status).toBe("pending");
      const again = await claim(id);
      expect(again.send.map((s: any) => s.holder_key)).toEqual([A1]);
      await result(again.send[0].payment_id, "sent");
      expect(await capital(p, A1)).toBe(-400_000);
      expect(await distEntries(p)).toHaveLength(3);
    });

    it("when every payment fails the distribution is failed and nothing at all was posted", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      await allMethods();
      const id = await make(p, 800_000);
      await authorize(id);
      const c = await claim(id);
      for (const s of c.send) await result(s.payment_id, "failed", "Returned");
      expect((await finalize(id)).status).toBe("failed");
      expect(await distEntries(p)).toHaveLength(0);
      expect(await cashOf(p)).toBe(1_000_000);
      expect(await count("SELECT count(*) n FROM capital_account_ledger WHERE property_id = $1 AND line_type = 'distribution'", [p])).toBe(0);
      expect((await ok("SELECT failed_at, failure_reason FROM distribution_events WHERE id = $1", [id]))[0]!.failed_at).not.toBeNull();
      // a failed payment owes nothing against the cash
      expect((await rpc("SELECT distributable_cash($1) AS r", [p])).committed_cents).toBe(0);
      // retried, it can still complete
      for (const s of c.send) await rpc("SELECT retry_failed_payment($1, $2) AS r", [s.payment_id, ADMIN]);
      expect(await status(id)).toBe("authorized");
      for (const s of (await claim(id)).send) await result(s.payment_id, "sent");
      expect((await finalize(id)).status).toBe("executed");
    });

    it("a payment still with the bank keeps the distribution open, posts nothing yet, and blocks a void", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      await allMethods();
      const id = await make(p, 800_000);
      await authorize(id);
      const c = await claim(id);
      await result(c.send[0].payment_id, "processing");
      expect((await finalize(id)).status).toBe("authorized");
      expect((await tryRpc("SELECT void_distribution($1, 'Mistake', $2)", [id, ADMIN])).message).toContain("still with the bank");
      for (const s of c.send) await result(s.payment_id, "sent");
      expect((await finalize(id)).status).toBe("executed");
    });
  });

  describe("a member without a payout method is held, and nobody else waits", () => {
    it("is not paid, not posted, not blocking: the others are paid, and the held payment goes out once they add a method", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      await method(A1, AUTH1);
      await method(SK, SELLER); // A2 has none
      const id = await make(p, 800_000);
      await authorize(id);
      const c = await claim(id);
      expect(c.send.map((s: any) => s.holder_key).sort()).toEqual([A1, SK].sort());
      expect(c.held.map((h: any) => h.holder_key)).toEqual([A2]);
      for (const s of c.send) await result(s.payment_id, "sent");
      expect((await finalize(id)).status).toBe("executed");
      expect((await payOf(id, A2)).status).toBe("held");
      expect(await capital(p, A2)).toBe(0);
      expect(await distEntries(p)).toHaveLength(2);
      // the held amount is still owed, so it stays out of the distributable cash
      const cash = await rpc("SELECT distributable_cash($1) AS r", [p]);
      expect(cash.committed_cents).toBe(300_000);
      expect(cash.distributable_cents).toBe(1_000_000 - 500_000 - 100_000 - 300_000);
      // claiming again changes nothing for the held member
      expect((await claim(id)).send).toHaveLength(0);
      // they add a method: only THEIR held payment is released
      await method(A2, AUTH2, "9876");
      const rel = await claim(id, A2);
      expect(rel.send.map((s: any) => [s.holder_key, s.last4])).toEqual([[A2, "9876"]]);
      await result(rel.send[0].payment_id, "sent");
      expect((await payOf(id, A2)).status).toBe("sent");
      expect(await capital(p, A2)).toBe(-300_000);
      expect(await distEntries(p)).toHaveLength(3);
    });

    it("releasing one member's held payment never sends anyone else's pending payment before the Manager executes", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      await allMethods();
      const id = await make(p, 800_000);
      await authorize(id);
      const rel = await claim(id, A2);
      expect(rel.send).toHaveLength(0); // A2's payment is pending, not held
      expect((await payments(id)).every((x) => x.status === "pending")).toBe(true);
    });

    it("everyone held: nothing is paid, the distribution stays authorized and owes the cash", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      const id = await make(p, 800_000);
      await authorize(id);
      const c = await claim(id);
      expect(c.send).toHaveLength(0);
      expect(c.held).toHaveLength(3);
      expect((await finalize(id)).status).toBe("authorized");
      expect((await rpc("SELECT distributable_cash($1) AS r", [p])).committed_cents).toBe(800_000);
    });
  });

  describe("void and re-post: every version is kept", () => {
    it("voiding an executed distribution reverses exactly the entries that were posted, and the corrected one posts new ones", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      await method(A1, AUTH1);
      await method(SK, SELLER);
      const id = await runAll(p, 800_000);
      const before = await distEntries(p);
      expect(before).toHaveLength(2);
      const v = await rpc("SELECT void_distribution($1, 'Wrong record date', $2) AS r", [id, ADMIN]);
      expect(v).toMatchObject({ status: "voided", entries_reversed: 2 });
      const after = await distEntries(p);
      expect(after).toHaveLength(4); // nothing deleted, two reversals added
      expect(after.filter((e) => e.reverses_entry_id).map((e) => e.reverses_entry_id).sort()).toEqual(before.map((e) => e.id).sort());
      expect(await cashOf(p)).toBe(1_000_000);
      expect(await capital(p, A1)).toBe(0);
      expect(await capital(p, SELLER)).toBe(0);
      expect((await ok("SELECT status, void_reason, voided_by FROM distribution_events WHERE id = $1", [id]))[0]).toMatchObject({ status: "voided", void_reason: "Wrong record date", voided_by: ADMIN });
      expect((await payments(id)).map((x) => x.status).sort()).toEqual(["cancelled", "sent", "sent"].sort());
      expect((await rpc("SELECT void_distribution($1, 'again', $2) AS r", [id, ADMIN])).status).toBe("already_voided");
      expect(await distEntries(p)).toHaveLength(4);
      // the corrected one
      const fixed = await make(p, 600_000, { replaces: id, lines: linesFor(600_000) });
      expect((await ok("SELECT replaces_id FROM distribution_events WHERE id = $1", [fixed]))[0]!.replaces_id).toBe(id);
      expect((await ok("SELECT replaced_by_id FROM distribution_events WHERE id = $1", [id]))[0]!.replaced_by_id).toBe(fixed);
      await authorize(fixed);
      for (const s of (await claim(fixed)).send) await result(s.payment_id, "sent");
      await finalize(fixed);
      expect(await distEntries(p)).toHaveLength(6);
      expect(await capital(p, A1)).toBe(-300_000);
      // the old record is still there, voided
      expect(await count("SELECT count(*) n FROM distribution_events WHERE property_id = $1", [p])).toBe(2);
    });

    it("needs a reason and the Manager; a draft or an authorized one voids with nothing to reverse; only a voided one can be replaced", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      const d = await make(p, 100_000);
      expect((await tryRpc("SELECT void_distribution($1, ' ', $2)", [d, ADMIN])).message).toContain("Say why");
      expect((await tryRpc("SELECT void_distribution($1, 'x', $2)", [d, AUTH1])).message).toContain("Only the Manager");
      expect((await tryMake(p, 100_000, { replaces: d })).message).toContain("Only a voided distribution");
      await authorize(d);
      expect((await rpc("SELECT void_distribution($1, 'Changed our mind', $2) AS r", [d, ADMIN])).entries_reversed).toBe(0);
      expect((await payments(d)).every((x) => x.status === "cancelled")).toBe(true);
      expect((await rpc("SELECT distributable_cash($1) AS r", [p])).committed_cents).toBe(0);
      expect(await distEntries(p)).toHaveLength(0);
    });

    it("a distribution never changes once made, only its status moves, and only forward", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      const id = await make(p, 100_000);
      expect((await tryRpc("UPDATE distribution_events SET total_amount = 5, total_cents = 500 WHERE id = $1", [id])).message).toContain("can't be edited");
      expect((await tryRpc("UPDATE distribution_events SET record_date = '2020-01-01' WHERE id = $1", [id])).message).toContain("can't be edited");
      expect((await tryRpc("UPDATE distribution_events SET status = 'executed' WHERE id = $1", [id])).message).toContain("can't go from draft to executed");
      expect((await tryRpc("DELETE FROM distribution_events WHERE id = $1", [id])).message).toContain("never deleted");
      await authorize(id);
      const pay = await payOf(id, A1);
      expect((await tryRpc("UPDATE distribution_payments SET amount_cents = 1 WHERE id = $1", [pay.id])).message).toContain("can't be edited");
      expect((await tryRpc("DELETE FROM distribution_payments WHERE id = $1", [pay.id])).message).toContain("never deleted");
      await rpc("SELECT void_distribution($1, 'x', $2) AS r", [id, ADMIN]);
      expect((await tryRpc("UPDATE distribution_events SET status = 'authorized' WHERE id = $1", [id])).message).toContain("stays as it was");
    });
  });

  describe("what does not block a distribution", () => {
    it("neither the Retention Lock nor an overdue expense stops one", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      await ok("UPDATE cap_table_entries SET retention_lock_expires_at = now() + interval '5 years' WHERE property_id = $1", [p]);
      // An expense every owner owes and nobody has paid, long past due.
      const e = (await ok("INSERT INTO expenses (property_id, description, category, total_amount, incurred_on) VALUES ($1, 'Roof', 'Structure & roof', 100, '2025-01-10') RETURNING id", [p]))[0]!.id as string;
      expect((await tryRpc("SELECT post_expense($1, $2::jsonb, $3)", [e, J(splitProRata(100, HOLDERS)), ADMIN])).message).toBe("");
      expect(await count("SELECT count(*) n FROM expense_allocations WHERE expense_id = $1 AND status = 'due'", [e])).toBe(3);
      await allMethods();
      const id = await runAll(p, 500_000);
      expect(await status(id)).toBe("executed");
      expect(await capital(p, A1)).toBe(-250_000);
    });

    it("the SQL never looks at either", () => {
      const code = readFileSync("distributions.sql", "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n");
      expect(code).not.toMatch(/retention|overdue|capital_call/i);
    });
  });

  describe("a member's payout method: a token and the last four, never a full number", () => {
    it("the table has nowhere to put a full number, and refuses anything that isn't a token", async () => {
      const cols = (await ok("SELECT column_name FROM information_schema.columns WHERE table_name = 'member_payout_methods'")).map((r) => r.column_name as string);
      expect(cols.filter((c) => /account|routing|number/i.test(c))).toEqual([]);
      for (const bad of ["123456789012", "021000021", "tok_", "tok_short"]) expect((await tryRpc("SELECT save_payout_method($1, $2, '1234', 'Bank', $3)", [A1, bad, AUTH1])).code, bad).toBe("23514");
      expect((await tryRpc("SELECT save_payout_method($1, 'tok_sim_ok_abcdef123400', '12345', 'Bank', $2)", [A1, AUTH1])).code).toBe("23514");
    });

    it("only the member sets their own; a new one replaces the old and the old stays on record", async () => {
      expect((await tryRpc("SELECT save_payout_method($1, 'tok_sim_ok_abcdef123400', '1234', 'Bank', $2)", [A1, AUTH2])).message).toContain("your own");
      expect((await tryRpc("SELECT save_payout_method($1, 'tok_sim_ok_abcdef123400', '1234', 'Bank', $2)", [A1, ADMIN])).message).toContain("your own");
      await method(A1, AUTH1, "1111");
      await method(A1, AUTH1, "2222");
      const rows = await ok("SELECT last4, status FROM member_payout_methods WHERE holder_key = $1 ORDER BY created_at, last4", [A1]);
      expect(rows.filter((r) => r.status === "active").map((r) => r.last4)).toEqual(["2222"]);
      expect(rows.some((r) => r.status === "removed")).toBe(true);
      await svc(async () => ok("SELECT remove_payout_method($1, $2)", [A1, AUTH1]));
      expect(await count("SELECT count(*) n FROM member_payout_methods WHERE holder_key = $1 AND status = 'active'", [A1])).toBe(0);
    });
  });

  describe("audit and access", () => {
    it("every step is written to the audit log, with the signature and no bank detail", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      await allMethods();
      const id = await make(p, 800_000);
      await authorize(id, "Mark Manager");
      const c = await claim(id);
      await result(c.send[0].payment_id, "sent");
      await result(c.send[1].payment_id, "failed", "Returned");
      await result(c.send[2].payment_id, "sent");
      await finalize(id);
      await rpc("SELECT void_distribution($1, 'Test', $2) AS r", [id, ADMIN]);
      const actions = (await ok("SELECT action_type FROM audit_log WHERE entity_id = $1 AND entity_type = 'distribution_event' ORDER BY created_at, id", [id])).map((r) => r.action_type);
      for (const a of ["distribution.created", "distribution.authorized", "distribution.execution_started", "distribution.payment_sent", "distribution.payment_failed", "distribution.executed", "distribution.voided"]) expect(actions, a).toContain(a);
      const authorized = (await ok("SELECT metadata FROM audit_log WHERE action_type = 'distribution.authorized' AND entity_id = $1", [id]))[0]!.metadata;
      expect(authorized.signed_name).toBe("Mark Manager");
      const all = J(await ok("SELECT metadata FROM audit_log WHERE entity_type = 'distribution_event'"));
      expect(all).not.toMatch(/tok_sim|routing/);
    });

    it("owners see a distribution once it is authorized, never a draft; and only their own payment", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      await ok("INSERT INTO owners VALUES ($1, $2), ($3, $2)", [AUTH1, p, AUTH2]);
      const id = await make(p, 800_000);
      const seen = () => asRole("authenticated", AUTH1, () => ok("SELECT id FROM distribution_events WHERE property_id = $1", [p]));
      expect(await seen()).toHaveLength(0);
      await authorize(id);
      expect((await seen()).map((r) => r.id)).toEqual([id]);
      const mine = await asRole("authenticated", AUTH1, () => ok("SELECT holder_key FROM distribution_payments WHERE distribution_id = $1", [id]));
      expect(mine.map((r) => r.holder_key)).toEqual([A1]);
      const tokens = await asRole("authenticated", AUTH1, () => fails("SELECT token FROM member_payout_methods"));
      expect(tokens.message).toMatch(/permission denied/);
    });

    it("the Month 5 notice (a legacy posted distribution) still posts at once, as before", async () => {
      const p = await llc();
      await fund(p, 1_000_000);
      const id = (await ok("INSERT INTO distribution_events (property_id, total_amount, record_date, status) VALUES ($1, 800, $2, 'posted') RETURNING id", [p, today()]))[0]!.id as string;
      expect((await distEntries(p)).map((e) => e.source_ref)).toEqual([`distribution:${id}`]);
      expect((await ok("SELECT workflow FROM distribution_events WHERE id = $1", [id]))[0]!.workflow).toBe("notice");
    });

    it("running distributions.sql again keeps the data", async () => {
      expect(await count("SELECT count(*) n FROM distribution_events WHERE workflow = 'payout'")).toBeGreaterThan(3);
    });
  });
});
