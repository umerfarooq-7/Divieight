/**
 * Month 6, Prompt 2, on a real Postgres (PGlite): bookkeeping.sql then capital-accounts.sql, exactly as written.
 * Opening entries from the cap table, the derived capital_account_ledger, owner_capital_accounts as a read model,
 * the idempotent backfill and the balance check. Skips when PGlite isn't installed.
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
const B1 = U(11); // a two-member Buyer Account: ONE joint member
const B2 = U(12);
const B3 = U(13);
const SELLER = U(21); // a Hybrid Exit seller (the seller id is the user id)
const USER1 = U(31); // auth user of B1
const USER2 = U(32);
const USER3 = U(33);

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
const rpc = async (sql: string, params?: unknown[]) => svc(async () => (await ok(sql, params))[0]!);

/** A closed property: deed recorded, cap table locked, shares as given: [holder id, type, share count]. */
async function property(opts: { price?: number; shares: Array<[string, "buyer" | "seller", number]>; locked?: boolean; deed?: boolean; closingFunded?: number[] }) {
  const id = (await ok("INSERT INTO properties (listing_price, created_at) VALUES ($1, now()) RETURNING id", [opts.price ?? 2_500_000]))[0]!.id as string;
  let n = 1;
  for (const [holder, kind, count] of opts.shares) for (let i = 0; i < count; i++) await ok("INSERT INTO cap_table_entries (property_id, share_number, holder_type, buyer_account_id, seller_id) VALUES ($1, $2, $3, $4, $5)", [id, n++, kind === "buyer" ? "buyer_account" : "retained_seller", kind === "buyer" ? holder : null, kind === "seller" ? holder : null]);
  await ok("INSERT INTO entity_genesis (property_id, cap_table_locked_at) VALUES ($1, $2)", [id, opts.locked === false ? null : "2026-09-01T00:00:00Z"]);
  for (const amount of opts.closingFunded ?? []) await ok("INSERT INTO closing_funds_obligations (property_id, amount, status) VALUES ($1, $2, 'funded')", [id, amount]);
  if (opts.deed !== false) {
    // The deed trigger would open the books at once; these tests open them by hand (the trigger has its own test).
    await pg!.exec("ALTER TABLE properties DISABLE TRIGGER properties_open_ledger");
    await svc(() => ok("UPDATE properties SET deed_recorded_at = '2026-10-15T12:00:00Z' WHERE id = $1", [id]));
    await pg!.exec("ALTER TABLE properties ENABLE TRIGGER properties_open_ledger");
  }
  return id;
}
const open = (p: string, cash = 0) => rpc("SELECT open_property_ledger($1, $2, $3) AS r", [p, ADMIN, cash]).then((r) => r.r as Record<string, any>);
const sumCredits = async (entry: string, code: string) => Number((await ok("SELECT COALESCE(sum(l.credit_cents), 0) s FROM journal_lines l JOIN coa_accounts a ON a.id = l.account_id WHERE l.entry_id = $1 AND a.code = $2", [entry, code]))[0]!.s);
const memberCredits = async (entry: string) => Object.fromEntries((await ok("SELECT l.member_id, l.credit_cents FROM journal_lines l JOIN coa_accounts a ON a.id = l.account_id WHERE l.entry_id = $1 AND a.code = '3000'", [entry])).map((r) => [r.member_id, Number(r.credit_cents)]));
const capital = (p: string) => ok("SELECT member_key, line_type, amount_cents, balance_after_cents FROM capital_account_ledger WHERE property_id = $1 ORDER BY seq", [p]);

describe.skipIf(!pg)("capital-accounts.sql", () => {
  beforeAll(async () => {
    await pg!.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role; GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
      CREATE TABLE properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), listing_price numeric, deed_recorded_at timestamptz, created_at timestamptz DEFAULT now());
      CREATE TABLE entity_genesis (property_id uuid PRIMARY KEY, cap_table_locked_at timestamptz);
      CREATE TABLE buyer_accounts (id uuid PRIMARY KEY, auth_user_id uuid);
      CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid, actor_type text NOT NULL DEFAULT 'seller', action_type text NOT NULL, entity_type text, entity_id text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE cap_table_entries (property_id uuid, share_number int, holder_type text, buyer_account_id uuid, seller_id uuid);
      CREATE TABLE cap_table_history (property_id uuid, from_buyer_account_id uuid, from_seller_id uuid, to_buyer_account_id uuid, to_seller_id uuid);
      CREATE TABLE closing_funds_obligations (property_id uuid, amount numeric, status text);
      CREATE TABLE owner_capital_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, user_id uuid NOT NULL, contributed_amount numeric NOT NULL DEFAULT 0, distributions_amount numeric NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (property_id, user_id));
      CREATE TABLE user_roles (user_id uuid NOT NULL, role text NOT NULL);
      CREATE TABLE owners (user_id uuid NOT NULL, property_id uuid NOT NULL);
      CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
      CREATE FUNCTION public.is_property_owner(_user uuid, _property uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.owners WHERE user_id = _user AND property_id = _property) $$;
      GRANT ALL ON audit_log, owner_capital_accounts TO service_role; GRANT SELECT ON properties, cap_table_entries, cap_table_history, user_roles, owners, entity_genesis, buyer_accounts, closing_funds_obligations TO service_role;
      GRANT UPDATE ON properties TO service_role;
      GRANT SELECT ON buyer_accounts TO authenticated;
      GRANT EXECUTE ON FUNCTION public.has_role(uuid, text), public.is_property_owner(uuid, uuid) TO authenticated, service_role;
      INSERT INTO user_roles VALUES ('${ADMIN}', 'admin');
      INSERT INTO buyer_accounts VALUES ('${B1}', '${USER1}'), ('${B2}', '${USER2}'), ('${B3}', '${USER3}');
    `);
    await pg!.exec(readFileSync("bookkeeping.sql", "utf8"));
    const sql = readFileSync("capital-accounts.sql", "utf8");
    await pg!.exec(sql);
    await pg!.exec(sql); // safe to run again
  }, 60_000);

  describe("opening entries from the cap table", () => {
    it("match the cap table share by share: Property + capitalized closing costs on the asset side, each member's pro-rata contribution on the other", async () => {
      // 8 shares: the joint Buyer Account B1 holds 3, B2 holds 2, B3 holds 1, a Hybrid Exit seller keeps 2.
      const p = await property({ price: 2_500_000, shares: [[B1, "buyer", 3], [B2, "buyer", 2], [B3, "buyer", 1], [SELLER, "seller", 2]], closingFunded: [1000.55, 2000] });
      const r = await open(p);
      expect(r).toMatchObject({ status: "opened", members: 4 });
      const total = 250_000_000 + 100_055 + 200_000;
      expect(r.total_cents).toBe(total);
      const credits = await memberCredits(r.entry_id);
      // Exactly the shares: 3/8, 2/8, 1/8, 2/8 of the total, to the cent.
      expect(Object.keys(credits).sort()).toEqual([B1, B2, B3, SELLER].sort());
      expect(credits[B1]! / total).toBeCloseTo(3 / 8, 6);
      expect(credits[B2]! / total).toBeCloseTo(2 / 8, 6);
      expect(credits[B3]! / total).toBeCloseTo(1 / 8, 6);
      expect(credits[SELLER]! / total).toBeCloseTo(2 / 8, 6);
      expect(Object.values(credits).reduce((s, c) => s + c, 0)).toBe(total); // not a cent lost or made
      // The assets: Property at the price and the funded closing costs, no cash.
      const debits = await ok("SELECT a.code, l.debit_cents FROM journal_lines l JOIN coa_accounts a ON a.id = l.account_id WHERE l.entry_id = $1 AND l.debit_cents > 0 ORDER BY l.debit_cents DESC", [r.entry_id]);
      expect(debits.map((d) => [d.code, Number(d.debit_cents)])).toEqual([["1200", 250_000_000], ["1200", 300_055]]);
      const e = (await ok("SELECT * FROM journal_entries WHERE id = $1", [r.entry_id]))[0]!;
      expect(e).toMatchObject({ source: "opening", source_ref: `opening:${p}`, created_by: ADMIN, entry_date: new Date("2026-10-15T00:00:00Z") });
      expect((await ok("SELECT count(*)::int n FROM audit_log WHERE action_type = 'ledger.opened' AND entity_id = $1", [r.entry_id]))[0]!.n).toBe(1);
    });

    it("cents that don't divide evenly go one each to the lowest share numbers, and the total is exact", async () => {
      const p = await property({ price: 1000.01, shares: [[B1, "buyer", 3], [B2, "buyer", 3], [B3, "buyer", 2]] }); // 100,001 cents over 8 shares
      const r = await open(p);
      const credits = await memberCredits(r.entry_id);
      expect(Object.values(credits).reduce((s, c) => s + c, 0)).toBe(100_001);
      expect(credits[B1]).toBe(37_501); // 37,500.375 -> +1 (lowest share numbers first)
      expect(credits[B2]).toBe(37_500);
      expect(credits[B3]).toBe(25_000);
    });

    it("a two-member Buyer Account is ONE joint member with ONE capital account; a Hybrid Exit seller gets one for the retained shares", async () => {
      const p = await property({ shares: [[B1, "buyer", 4], [SELLER, "seller", 4]] });
      await open(p);
      const rows = await capital(p);
      expect(rows.map((r) => r.member_key).sort()).toEqual([B1, SELLER].sort()); // one per member, never one per person
      expect(rows.every((r) => r.line_type === "opening")).toBe(true);
      expect(Number(rows.find((r) => r.member_key === B1)!.balance_after_cents)).toBe(125_000_000);
      expect(Number(rows.find((r) => r.member_key === SELLER)!.balance_after_cents)).toBe(125_000_000);
    });

    it("initial cash from the Manager goes on the asset side and is funded by the members too", async () => {
      const p = await property({ price: 1000, shares: [[B1, "buyer", 4], [B2, "buyer", 4]] });
      const r = await open(p, 50_000);
      const cash = await ok("SELECT l.debit_cents FROM journal_lines l JOIN coa_accounts a ON a.id = l.account_id WHERE l.entry_id = $1 AND a.code = '1000'", [r.entry_id]);
      expect(Number(cash[0]!.debit_cents)).toBe(50_000);
      expect(await sumCredits(r.entry_id, "3000")).toBe(150_000);
    });

    it("waits for the deed and the locked cap table, and says why", async () => {
      expect((await open(await property({ shares: [[B1, "buyer", 8]], deed: false })))).toMatchObject({ status: "not_ready", reason: "The deed has not been recorded yet." });
      expect((await open(await property({ shares: [[B1, "buyer", 8]], locked: false })))).toMatchObject({ status: "not_ready", reason: "The cap table is not locked yet." });
      expect((await open(await property({ shares: [] })))).toMatchObject({ status: "not_ready", reason: "The cap table has no shares." });
      expect((await open(await property({ price: 0, shares: [[B1, "buyer", 8]] })))).toMatchObject({ status: "not_ready" });
    });

    it("opens by itself when the deed is recorded on a locked cap table, once", async () => {
      const p = await property({ shares: [[B1, "buyer", 4], [B2, "buyer", 4]], deed: false });
      expect(await ok("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p])).toEqual([{ n: 0 }]);
      await svc(() => ok("UPDATE properties SET deed_recorded_at = now() WHERE id = $1", [p]));
      expect(await ok("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1 AND source = 'opening'", [p])).toEqual([{ n: 1 }]);
      await svc(() => ok("UPDATE properties SET deed_recorded_at = now() + interval '1 day' WHERE id = $1", [p]));
      expect(await ok("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p])).toEqual([{ n: 1 }]);
    });

    it("is idempotent: opening again changes nothing, and says if the cap table has moved since", async () => {
      const p = await property({ shares: [[B1, "buyer", 4], [B2, "buyer", 4]] });
      const first = await open(p);
      const again = await open(p);
      expect(again).toMatchObject({ status: "already_open", entry_id: first.entry_id, cap_table_changed: false });
      expect((await ok("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p]))[0]!.n).toBe(1);
      expect((await ok("SELECT count(*)::int n FROM capital_account_ledger WHERE property_id = $1", [p]))[0]!.n).toBe(2);
      await ok("UPDATE cap_table_entries SET buyer_account_id = $2 WHERE property_id = $1 AND share_number = 8", [p, B3]);
      const drifted = await open(p);
      expect(drifted).toMatchObject({ status: "already_open", cap_table_changed: true });
      expect((await ok("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p]))[0]!.n).toBe(1); // reported, not changed
    });

    it("the trial balance balances after opening: assets = liabilities + equity, and equity is the sum of the member capital accounts", async () => {
      const p = await property({ shares: [[B1, "buyer", 3], [B2, "buyer", 3], [SELLER, "seller", 2]], closingFunded: [12345.67] });
      await open(p, 99_999);
      const tb = await svc(() => ok("SELECT * FROM trial_balance($1, current_date)", [p]));
      expect(tb.reduce((s, r) => s + Number(r.debit_cents), 0)).toBe(tb.reduce((s, r) => s + Number(r.credit_cents), 0));
      const check = (await svc(() => ok("SELECT * FROM ledger_balance_check($1)", [p])))[0]!;
      expect(check.balanced).toBe(true);
      expect(Number(check.liabilities_cents)).toBe(0);
      expect(Number(check.assets_cents)).toBe(Number(check.equity_cents));
      expect(Number(check.member_capital_cents)).toBe(Number(check.equity_cents));
      expect(Number(check.assets_cents)).toBe(250_000_000 + 1_234_567 + 99_999);
    });
  });

  describe("capital_account_ledger", () => {
    it("is fed by posted journal lines on the member accounts, with signed amounts and a running balance", async () => {
      const p = await property({ price: 1000, shares: [[B1, "buyer", 4], [B2, "buyer", 4]] });
      await open(p); // 50,000 cents each
      await svc(() => ok("SELECT post_entry($1, $2::jsonb, $3::jsonb)", [p, JSON.stringify([{ code: "1000", debit_cents: 7_000 }, { code: "3000", member_id: B1, credit_cents: 7_000 }]), JSON.stringify({ source: "capital_call", created_by: ADMIN, entry_date: "2026-11-01" })]));
      await svc(() => ok("SELECT post_entry($1, $2::jsonb, $3::jsonb)", [p, JSON.stringify([{ code: "3100", member_id: B1, debit_cents: 2_000 }, { code: "1000", credit_cents: 2_000 }]), JSON.stringify({ source: "distribution", created_by: ADMIN, entry_date: "2026-11-02" })]));
      await svc(() => ok("SELECT post_entry($1, $2::jsonb, $3::jsonb)", [p, JSON.stringify([{ code: "6000", debit_cents: 100 }, { code: "1000", credit_cents: 100 }]), JSON.stringify({ source: "expense", created_by: ADMIN })])); // no member line: no row
      const b1 = (await capital(p)).filter((r) => r.member_key === B1);
      expect(b1.map((r) => [r.line_type, Number(r.amount_cents), Number(r.balance_after_cents)])).toEqual([["opening", 50_000, 50_000], ["contribution", 7_000, 57_000], ["distribution", -2_000, 55_000]]);
      expect((await capital(p)).filter((r) => r.member_key === B2)).toHaveLength(1);
      const row = (await ok("SELECT * FROM capital_account_ledger WHERE property_id = $1 AND line_type = 'distribution'", [p]))[0]!;
      expect(row.effective_date).toEqual(new Date("2026-11-02T00:00:00Z"));
      expect(row.entry_id).toBeTruthy();
    });

    it("a reversal flows through: the reversing lines are negative and the balance returns", async () => {
      const p = await property({ price: 1000, shares: [[B1, "buyer", 4], [B2, "buyer", 4]] });
      await open(p);
      const e = (await svc(() => ok("SELECT post_entry($1, $2::jsonb, $3::jsonb) AS id", [p, JSON.stringify([{ code: "1000", debit_cents: 900 }, { code: "3000", member_id: B2, credit_cents: 900 }]), JSON.stringify({ source: "capital_call", created_by: ADMIN })])))[0]!.id;
      await svc(() => ok("SELECT reverse_entry($1, 'wrong', $2::jsonb)", [e, JSON.stringify({ created_by: ADMIN })]));
      const b2 = (await capital(p)).filter((r) => r.member_key === B2);
      expect(b2.map((r) => [Number(r.amount_cents), Number(r.balance_after_cents)])).toEqual([[50_000, 50_000], [900, 50_900], [-900, 50_000]]);
    });

    it("can't be written directly, by any role: not inserted, updated, deleted or truncated", async () => {
      const p = await property({ price: 1000, shares: [[B1, "buyer", 8]] });
      const o = await open(p);
      const line = (await ok("SELECT id FROM journal_lines WHERE entry_id = $1 LIMIT 1", [o.entry_id]))[0]!.id;
      const insert = `INSERT INTO capital_account_ledger (property_id, member_key, entry_id, line_id, line_type, amount_cents, balance_after_cents, effective_date) VALUES ('${p}', '${B1}', '${o.entry_id}', '${line}', 'opening', 1, 1, current_date)`;
      // The table owner is refused by the trigger.
      expect((await fails(insert)).message).toMatch(/derived from the journal/);
      expect((await fails("UPDATE capital_account_ledger SET amount_cents = 1")).message).toMatch(/append-only and derived/);
      expect((await fails("DELETE FROM capital_account_ledger")).message).toMatch(/append-only and derived/);
      expect((await fails("TRUNCATE capital_account_ledger")).message).toMatch(/append-only and derived/);
      // Faking the flag doesn't help the owner outside the projection either.
      expect((await fails(`SELECT set_config('app.capital_projection', 'on', false); ${insert}`)).code).not.toBe("");
      await pg!.exec("SELECT set_config('app.capital_projection', 'off', false)");
      // Every other role has no privilege at all.
      for (const [role, uid] of [["service_role", null], ["authenticated", ADMIN], ["anon", null]] as const) {
        for (const s of [insert, "UPDATE capital_account_ledger SET amount_cents = 1", "DELETE FROM capital_account_ledger", "TRUNCATE capital_account_ledger"]) {
          expect((await asRole(role, uid, () => fails(s))).code, `${role}: ${s}`).toBe("42501");
        }
      }
      expect(Number((await ok("SELECT amount_cents FROM capital_account_ledger WHERE property_id = $1", [p]))[0]!.amount_cents)).toBe(100_000);
    });

    it("a member reads only their own capital account; the Manager reads all", async () => {
      const p = await property({ price: 1000, shares: [[B1, "buyer", 4], [B2, "buyer", 4]] });
      await open(p);
      const mine = await asRole("authenticated", USER1, () => ok("SELECT member_key FROM capital_account_ledger WHERE property_id = $1", [p]));
      expect(mine.map((r) => r.member_key)).toEqual([B1]);
      expect(await asRole("authenticated", U(99), () => ok("SELECT * FROM capital_account_ledger WHERE property_id = $1", [p]))).toEqual([]);
      expect((await asRole("authenticated", ADMIN, () => ok("SELECT * FROM capital_account_ledger WHERE property_id = $1", [p]))).length).toBe(2);
    });
  });

  describe("owner_capital_accounts as a read model", () => {
    it("a Month 5 write is captured as a ledger entry, and the table equals the ledger", async () => {
      const p = await property({ price: 1000, shares: [[B1, "buyer", 4], [B2, "buyer", 4]] });
      await open(p);
      // What the Month 5 functions do on a confirmed capital call: add to the running total.
      await svc(() => ok("INSERT INTO owner_capital_accounts (property_id, user_id, contributed_amount) VALUES ($1, $2, 25.50) ON CONFLICT (property_id, user_id) DO UPDATE SET contributed_amount = owner_capital_accounts.contributed_amount + EXCLUDED.contributed_amount", [p, USER1]));
      await svc(() => ok("INSERT INTO owner_capital_accounts (property_id, user_id, contributed_amount) VALUES ($1, $2, 10) ON CONFLICT (property_id, user_id) DO UPDATE SET contributed_amount = owner_capital_accounts.contributed_amount + EXCLUDED.contributed_amount", [p, USER1]));
      const row = (await ok("SELECT contributed_amount, distributions_amount FROM owner_capital_accounts WHERE property_id = $1 AND user_id = $2", [p, USER1]))[0]!;
      expect([Number(row.contributed_amount), Number(row.distributions_amount)]).toEqual([35.5, 0]);
      const b1 = (await capital(p)).filter((r) => r.member_key === B1);
      expect(b1.map((r) => [r.line_type, Number(r.amount_cents)])).toEqual([["opening", 50_000], ["contribution", 2_550], ["contribution", 1_000]]);
      const rec = (await svc(() => ok("SELECT * FROM owner_capital_reconciliation WHERE property_id = $1", [p])))[0]!;
      expect(rec).toMatchObject({ matches: true, member_key: B1 });
      expect([Number(rec.table_contributed_cents), Number(rec.ledger_contributed_cents), Number(rec.opening_cents), Number(rec.capital_balance_cents)]).toEqual([3_550, 3_550, 50_000, 53_550]);
      expect((await svc(() => ok("SELECT * FROM ledger_balance_check($1)", [p])))[0]!.balanced).toBe(true);
    });

    it("existing values are migrated into ledger entries with a reason, every difference is reported, and the table's numbers are not changed", async () => {
      // A property that closed before the ledger existed: the Month 5 table has numbers, the ledger is not open yet.
      const p = await property({ price: 1000, shares: [[B1, "buyer", 4], [B2, "buyer", 4], ], deed: false });
      await ok("INSERT INTO owner_capital_accounts (property_id, user_id, contributed_amount, distributions_amount) VALUES ($1, $2, 120.25, 40), ($1, $3, 0, 15.10), ($1, $4, 9, 0)", [p, USER1, USER2, U(98)]);
      await svc(() => ok("UPDATE properties SET deed_recorded_at = now() WHERE id = $1", [p]));
      const rep = (await rpc("SELECT reconcile_owner_capital($1, $2) AS r", [p, ADMIN])).r as Record<string, any>;
      expect(rep.status).toBe("ok");
      const diffs = rep.differences as Array<Record<string, any>>;
      expect(diffs.filter((d) => d.kind).map((d) => [d.member_key, d.kind, d.difference_cents]).sort()).toEqual([[B1, "contributed", 12_025], [B1, "distributions", 4_000], [B2, "distributions", 1_510]].sort());
      expect(diffs.find((d) => d.problem)).toMatchObject({ user_id: U(98), problem: "no capital account for this user on this property" }); // reported, not forced in
      // The table's numbers are exactly what they were.
      const rows = await ok("SELECT user_id, contributed_amount, distributions_amount FROM owner_capital_accounts WHERE property_id = $1 ORDER BY user_id", [p]);
      expect(rows.map((r) => [r.user_id, Number(r.contributed_amount), Number(r.distributions_amount)])).toEqual([[USER1, 120.25, 40], [USER2, 0, 15.1], [U(98), 9, 0]]);
      // The migration entries carry the reason and the audit trail.
      const e = await ok("SELECT source, memo FROM journal_entries WHERE property_id = $1 AND source = 'system'", [p]);
      expect(e).toHaveLength(3);
      expect(e.every((x) => /Migrated from owner_capital_accounts/.test(x.memo))).toBe(true);
      expect((await ok("SELECT count(*)::int n FROM audit_log WHERE action_type = 'ledger.owner_capital_reconciled' AND entity_id = $1", [p]))[0]!.n).toBe(1);
      // The values equal the ledger now (except the one that has no capital account, which is still reported).
      const recon = await svc(() => ok("SELECT user_id, matches FROM owner_capital_reconciliation WHERE property_id = $1 ORDER BY user_id", [p]));
      expect(recon.map((r) => [r.user_id, r.matches])).toEqual([[USER1, true], [USER2, true], [U(98), false]]);
      // Running it again finds the same unresolved one and posts nothing new.
      const before = (await ok("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p]))[0]!.n;
      const again = (await rpc("SELECT reconcile_owner_capital($1, $2) AS r", [p, ADMIN])).r as Record<string, any>;
      expect((again.differences as any[]).filter((d) => d.kind)).toEqual([]);
      expect((await ok("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p]))[0]!.n).toBe(before);
    });

    it("a disagreeing old row is left alone and reported, never silently overwritten", async () => {
      const p = await property({ price: 1000, shares: [[B1, "buyer", 4], [B2, "buyer", 4]] });
      await open(p);
      // The old row already disagrees with the ledger (it was edited outside the ledger while the capture was off).
      await pg!.exec("SELECT set_config('app.ledger_sync', 'on', false)");
      await ok("INSERT INTO owner_capital_accounts (property_id, user_id, contributed_amount) VALUES ($1, $2, 77)", [p, USER1]);
      await pg!.exec("SELECT set_config('app.ledger_sync', 'off', false)");
      await svc(() => ok("SELECT post_entry($1, $2::jsonb, $3::jsonb)", [p, JSON.stringify([{ code: "1000", debit_cents: 500 }, { code: "3000", member_id: B1, credit_cents: 500 }]), JSON.stringify({ source: "capital_call", created_by: ADMIN })]));
      expect(Number((await ok("SELECT contributed_amount FROM owner_capital_accounts WHERE property_id = $1 AND user_id = $2", [p, USER1]))[0]!.contributed_amount)).toBe(77);
      const rec = (await svc(() => ok("SELECT * FROM owner_capital_reconciliation WHERE property_id = $1", [p])))[0]!;
      expect(rec.matches).toBe(false);
      expect([Number(rec.table_contributed_cents), Number(rec.ledger_contributed_cents)]).toEqual([7_700, 500]);
    });
  });

  describe("the backfill", () => {
    it("opens the books of every LLC that already closed, once: running it twice creates nothing new", async () => {
      const a = await property({ shares: [[B1, "buyer", 4], [B2, "buyer", 4]], deed: false });
      const b = await property({ shares: [[B1, "buyer", 2], [B3, "buyer", 4], [SELLER, "seller", 2]], deed: false });
      const open_ = await property({ shares: [[B1, "buyer", 8]], deed: false }); // not closed yet: skipped
      await ok("INSERT INTO owner_capital_accounts (property_id, user_id, contributed_amount) VALUES ($1, $2, 5)", [a, USER1]);
      // They closed before the ledger existed: switch the open-on-deed trigger off while recording the deeds.
      await pg!.exec("ALTER TABLE properties DISABLE TRIGGER properties_open_ledger");
      await svc(() => ok("UPDATE properties SET deed_recorded_at = '2026-10-01' WHERE id IN ($1, $2)", [a, b]));
      await pg!.exec("ALTER TABLE properties ENABLE TRIGGER properties_open_ledger");
      const count = async () => ({
        entries: Number((await ok("SELECT count(*)::int n FROM journal_entries"))[0]!.n),
        lines: Number((await ok("SELECT count(*)::int n FROM journal_lines"))[0]!.n),
        capital: Number((await ok("SELECT count(*)::int n FROM capital_account_ledger"))[0]!.n),
      });
      const before = await count();
      const first = (await rpc("SELECT backfill_opening_entries($1) AS r", [ADMIN])).r as Array<Record<string, any>>;
      const mine = first.filter((r) => [a, b].includes(r.property_id));
      expect(mine.map((r) => r.opening.status)).toEqual(["opened", "opened"]);
      expect(mine.find((r) => r.property_id === a)!.reconciliation.differences[0]).toMatchObject({ kind: "contributed", difference_cents: 500 });
      const afterFirst = await count();
      expect(afterFirst.entries).toBeGreaterThan(before.entries);
      expect((await ok("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [open_]))[0]!.n).toBe(0);
      const second = (await rpc("SELECT backfill_opening_entries($1) AS r", [ADMIN])).r as Array<Record<string, any>>;
      expect(second.filter((r) => [a, b].includes(r.property_id)).map((r) => r.opening.status)).toEqual(["already_open", "already_open"]);
      expect(await count()).toEqual(afterFirst); // nothing new anywhere
      for (const p of [a, b]) expect((await svc(() => ok("SELECT balanced FROM ledger_balance_check($1)", [p])))[0]!.balanced).toBe(true);
    });
  });

  describe("owner_capital_accounts equals the ledger", () => {
    it("for every row on every property that has a ledger and a capital account", async () => {
      const rows = await svc(() => ok("SELECT property_id, user_id, matches, member_key FROM owner_capital_reconciliation WHERE member_key IS NOT NULL"));
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.matches, `${r.property_id} ${r.user_id}`).toBe(true);
    });
  });
});
