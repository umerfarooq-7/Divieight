/**
 * Month 6, Prompt 7, on a real Postgres (PGlite): bookkeeping, capital-accounts, bank-feed, books, then str-treatment.sql, as written.
 * STR income never posts as LLC income; a deposit that looks like STR can only be ignored or reclassified; the owner's tracker
 * never touches the ledger; the lodging-tax flag lists who, never how much. Skips when PGlite isn't installed.
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
const OWN1 = U(31); // owner of the STR property (account ACC1)
const OWN2 = U(32); // another owner of it (ACC2)
const OUTSIDER = U(39);
const ACC1 = U(11);
const ACC2 = U(12);
const ITEM = JSON.stringify({ ciphertext: "abc", iv: "iv", auth_tag: "tag", key_version: 1 });

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

async function property(usage: string | null) {
  const id = (await ok("INSERT INTO properties (usage_tag) VALUES ($1) RETURNING id", [usage]))[0]!.id as string;
  await ok("INSERT INTO cap_table_entries (property_id, share_number, holder_type, buyer_account_id) VALUES ($1, 1, 'buyer_account', $2), ($1, 2, 'buyer_account', $3)", [id, ACC1, ACC2]);
  await rpc("SELECT grant_llc_plaid_consent($1, $2, $3::jsonb) AS r", [id, ADMIN, JSON.stringify({ plaid_item_ref: JSON.parse(ITEM), institution_name: "Test Bank", account_mask: "1234" })]);
  return id;
}
const tx = (id: string, o: Record<string, unknown> = {}) => ({ plaid_txn_id: id, posted_date: "2026-11-02", amount_cents: 1000, direction: "in", merchant_name: null, raw_category: null, description: null, pending: false, ...o });
const upsert = (p: string, t: Record<string, unknown>) => rpc("SELECT upsert_bank_transaction($1, $2::jsonb) AS r", [p, JSON.stringify(t)]);
const categorize = (p: string) => rpc("SELECT categorize_new_bank_transactions($1) AS r", [p]);
const row = async (txnId: string) => (await ok("SELECT * FROM bank_transactions WHERE plaid_txn_id = $1", [txnId]))[0]!;
const post = (p: string, lines: unknown[], meta: Record<string, unknown>) =>
  tryRpc("SELECT post_entry($1, $2::jsonb, $3::jsonb)", [p, JSON.stringify(lines), JSON.stringify({ source: "manual", entry_date: "2026-11-03", created_by: ADMIN, ...meta })]);
const ledgerCounts = async () => ({
  entries: await count("SELECT count(*)::int n FROM journal_entries"),
  lines: await count("SELECT count(*)::int n FROM journal_lines"),
  capital: await count("SELECT count(*)::int n FROM capital_account_ledger"),
});
const record = (p: string, user: string | null, o: Record<string, unknown> = {}, id: string | null = null) => {
  const r = { start: "2026-07-01", end: "2026-07-14", nights: 9, gross: 250_000, fees: 30_000, status: "owed", note: null, ...o };
  return [p, user, id, r.start, r.end, r.nights, r.gross, r.fees, r.status, r.note];
};
const SAVE = "SELECT save_owner_str_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS r";

let STR = "";
let HOME = "";

describe.skipIf(!pg)("str-treatment.sql", () => {
  beforeAll(async () => {
    await pg!.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role; GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
      CREATE TABLE storage.objects (bucket_id text, name text);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE TABLE properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usage_tag text, listing_price numeric, deed_recorded_at timestamptz, created_at timestamptz DEFAULT now());
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
      CREATE FUNCTION public.is_property_owner(_user uuid, _property uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
        SELECT EXISTS (SELECT 1 FROM public.cap_table_entries c JOIN public.buyer_accounts b ON b.id = c.buyer_account_id WHERE c.property_id = _property AND b.auth_user_id = _user) $$;
      GRANT ALL ON audit_log, owner_capital_accounts TO service_role; GRANT SELECT ON properties, cap_table_entries, cap_table_history, user_roles, owners, entity_genesis, buyer_accounts, closing_funds_obligations TO service_role;
      GRANT UPDATE ON properties TO service_role; GRANT SELECT ON buyer_accounts, properties, cap_table_entries TO authenticated;
      GRANT EXECUTE ON FUNCTION public.has_role(uuid, text), public.is_property_owner(uuid, uuid) TO authenticated, service_role;
      INSERT INTO user_roles VALUES ('${ADMIN}', 'admin');
      INSERT INTO buyer_accounts VALUES ('${ACC1}', '${OWN1}'), ('${ACC2}', '${OWN2}');
    `);
    for (const f of ["bookkeeping.sql", "capital-accounts.sql", "bank-feed.sql", "books.sql"]) await pg!.exec(readFileSync(f, "utf8"));
    const sql = readFileSync("str-treatment.sql", "utf8");
    await pg!.exec(sql);
    await pg!.exec(sql); // safe to run again
    STR = await property("short_term_rental");
    HOME = await property("owner_occupied");
  }, 60_000);

  describe("the ledger refuses STR income", () => {
    it("post_entry will not credit an LLC income account for an entry that describes STR activity, and writes nothing", async () => {
      const before = await ledgerCounts();
      for (const memo of ["Airbnb payout Nov", "VRBO guest payout", "Booking.com reservation payout", "Rental income, November", "short-term rental revenue"]) {
        const r = await post(STR, [{ code: "1000", debit_cents: 50_000 }, { code: "4000", credit_cents: 50_000 }], { memo });
        expect(r.message, memo).toMatch(/STR income does not belong to the LLC/);
        expect(r.code, memo).toBe("23514");
      }
      // The reference counts too, not only the memo.
      expect((await post(STR, [{ code: "1000", debit_cents: 5_000 }, { code: "4000", credit_cents: 5_000 }], { memo: "Deposit", source_ref: "airbnb:payout-77" })).message).toMatch(/STR income does not belong/);
      expect(await ledgerCounts()).toEqual(before);
    });

    it("ordinary entries still post: incidental income, and an expense refund from a booking platform", async () => {
      expect((await post(STR, [{ code: "1000", debit_cents: 1_200 }, { code: "4000", credit_cents: 1_200 }], { memo: "Interest on the operating account" })).message).toBe("");
      // A refund of an expense credits an expense account, not revenue.
      expect((await post(STR, [{ code: "1000", debit_cents: 4_000 }, { code: "6400", credit_cents: 4_000 }], { memo: "Refund: Airbnb cleaning supplies credit" })).message).toBe("");
    });

    it("the manual-entry door is shut as well, so is the guard any other caller would meet", async () => {
      const r = await tryRpc("SELECT post_manual_entry($1, '2026-11-03', 20000, 'in', '4000', 'Airbnb payout', NULL, $2, '{}'::jsonb)", [STR, ADMIN]);
      expect(r.message).toMatch(/short-term-rental revenue/i);
      expect((await ok("SELECT tgname FROM pg_trigger WHERE tgname = 'journal_lines_refuse_str_income'")).length).toBe(1);
    });
  });

  describe("a deposit that looks like STR income", () => {
    it("goes to needs_review with the STR reason and can never be posted as LLC income", async () => {
      await upsert(STR, tx("str-dep-1", { merchant_name: "AIRBNB", description: "Airbnb payout HM123", amount_cents: 84_000 }));
      await categorize(STR);
      const t = await row("str-dep-1");
      expect(t).toMatchObject({ status: "needs_review", review_reason: "looks_like_str_revenue", journal_entry_id: null });
      const before = await ledgerCounts();
      const r = await tryRpc("SELECT post_bank_transaction($1, $2::jsonb, $3, '{}'::jsonb)", [t.id, JSON.stringify([{ code: "4000", cents: 84_000 }]), ADMIN]);
      expect(r.message).toMatch(/never posted to the LLC/);
      expect(await ledgerCounts()).toEqual(before);
      expect((await row("str-dep-1")).status).toBe("needs_review");
    });

    it("can be ignored, or reclassified as the owner's: neither posts, and each is audit logged", async () => {
      await upsert(STR, tx("str-dep-2", { merchant_name: "VRBO", description: "VRBO payout", amount_cents: 61_000 }));
      await upsert(STR, tx("str-dep-3", { merchant_name: "Booking.com", description: "Booking.com payout", amount_cents: 33_000 }));
      await categorize(STR);
      const before = await ledgerCounts();
      const a = await row("str-dep-2");
      const b = await row("str-dep-3");
      expect((await tryRpc("SELECT ignore_bank_transaction($1, 'Owner Dana''s own week', $2, '{}'::jsonb)", [a.id, ADMIN])).message).toBe("");
      expect((await row("str-dep-2")).status).toBe("ignored");
      expect((await tryRpc("SELECT reclassify_str_deposit($1, 'Owner Dana''s own week, deposited here by mistake', $2, '{}'::jsonb)", [b.id, ADMIN])).message).toBe("");
      const t = await row("str-dep-3");
      expect(t).toMatchObject({ status: "ignored", journal_entry_id: null });
      expect(t.review_reason).toMatch(/^reclassified: owner STR income, not the LLC's/);
      expect(await ledgerCounts()).toEqual(before);
      const log = (await ok("SELECT actor_id, metadata FROM audit_log WHERE action_type = 'books.str_deposit_reclassified' AND entity_id = $1", [b.id]))[0]!;
      expect(log.actor_id).toBe(ADMIN);
      expect(log.metadata).toMatchObject({ property_id: STR, amount_cents: 33_000 });
    });

    it("reclassifying needs the Manager and a reason, and only suits a deposit that looks like STR income", async () => {
      await upsert(STR, tx("str-dep-4", { merchant_name: "AIRBNB", description: "Airbnb payout", amount_cents: 9_000 }));
      await upsert(STR, tx("plain-dep-1", { merchant_name: "Unknown payer", description: "Wire", amount_cents: 9_000 }));
      await upsert(STR, tx("plain-out-1", { direction: "out", merchant_name: "Airbnb", description: "Airbnb host fee", amount_cents: 700 }));
      await categorize(STR);
      const d = await row("str-dep-4");
      for (const who of [OWN1, null, OUTSIDER]) expect((await tryRpc("SELECT reclassify_str_deposit($1, 'why', $2, '{}'::jsonb)", [d.id, who])).message, String(who)).toMatch(/Only the Manager/);
      expect((await tryRpc("SELECT reclassify_str_deposit($1, '   ', $2, '{}'::jsonb)", [d.id, ADMIN])).message).toMatch(/Say whose income/);
      expect((await tryRpc("SELECT reclassify_str_deposit($1, 'why', $2, '{}'::jsonb)", [(await row("plain-dep-1")).id, ADMIN])).message).toMatch(/Only a deposit that looks like short-term-rental income/);
      expect((await tryRpc("SELECT reclassify_str_deposit($1, 'why', $2, '{}'::jsonb)", [(await row("plain-out-1")).id, ADMIN])).message).toMatch(/Only a deposit that looks like short-term-rental income/);
      expect((await tryRpc("SELECT reclassify_str_deposit($1, 'Dana''s week', $2, '{}'::jsonb)", [d.id, ADMIN])).message).toBe("");
      expect((await tryRpc("SELECT reclassify_str_deposit($1, 'again', $2, '{}'::jsonb)", [d.id, ADMIN])).message).toMatch(/already ignored/);
      for (const [role, uid] of [["authenticated", ADMIN], ["anon", null]] as const) {
        expect((await asRole(role, uid, () => fails("SELECT reclassify_str_deposit($1, 'x', $2, '{}'::jsonb)", [d.id, ADMIN]))).code).toBe("42501");
      }
    });
  });

  describe("the owner's own tracker", () => {
    it("an owner records their own weeks; the property's intent profile must include short-term rental", async () => {
      const id = await rpc(SAVE, record(STR, OWN1));
      const r = (await ok("SELECT * FROM owner_str_records WHERE id = $1", [id]))[0]!;
      expect(r).toMatchObject({ property_id: STR, member_key: ACC1, entered_by_member_id: ACC1, nights: 9, lodging_tax_status: "owed" });
      expect(Number(r.gross_amount_cents)).toBe(250_000);
      expect(Number(r.platform_fees_cents)).toBe(30_000);
      expect((await tryRpc(SAVE, record(HOME, OWN1))).message).toMatch(/doesn't include short-term rental/);
      expect(await rpc("SELECT str_tracker_allowed($1) AS r", [STR])).toBe(true);
      expect(await rpc("SELECT str_tracker_allowed($1) AS r", [HOME])).toBe(false);
      const none = (await ok("INSERT INTO properties DEFAULT VALUES RETURNING id"))[0]!.id as string;
      expect(await rpc("SELECT str_tracker_allowed($1) AS r", [none])).toBe(false); // no stated intent: hidden
    });

    it("only an owner of the home can record, and only their own records can be changed or removed", async () => {
      expect((await tryRpc(SAVE, record(STR, OUTSIDER))).message).toMatch(/don't have ownership/);
      expect((await tryRpc(SAVE, record(STR, null))).message).toMatch(/Sign in/);
      const mine = await rpc(SAVE, record(STR, OWN1, { start: "2026-08-01", end: "2026-08-07", nights: 5 }));
      expect((await tryRpc(SAVE, record(STR, OWN2, { nights: 1 }, mine))).message).toMatch(/isn't yours to change/);
      expect((await tryRpc("SELECT delete_owner_str_record($1, $2, $3)", [STR, OWN2, mine])).message).toMatch(/isn't yours to remove/);
      expect((await tryRpc("SELECT delete_owner_str_record($1, $2, $3)", [STR, OUTSIDER, mine])).message).toMatch(/don't have ownership/);
      expect((await tryRpc(SAVE, record(STR, OWN1, { nights: 6 }, mine))).message).toBe("");
      expect((await ok("SELECT nights FROM owner_str_records WHERE id = $1", [mine]))[0]!.nights).toBe(6);
      expect((await tryRpc("SELECT delete_owner_str_record($1, $2, $3)", [STR, OWN1, mine])).message).toBe("");
      expect(await count("SELECT count(*)::int n FROM owner_str_records WHERE id = $1", [mine])).toBe(0);
    });

    it("refuses nonsense: more nights than days, fees above gross, a backwards period, an unknown tax status", async () => {
      expect((await tryRpc(SAVE, record(STR, OWN1, { nights: 20 }))).code).toBe("23514");
      expect((await tryRpc(SAVE, record(STR, OWN1, { fees: 999_999 }))).code).toBe("23514");
      expect((await tryRpc(SAVE, record(STR, OWN1, { start: "2026-07-14", end: "2026-07-01", nights: 0 }))).code).toBe("23514");
      expect((await tryRpc(SAVE, record(STR, OWN1, { status: "maybe" }))).code).toBe("23514");
    });

    it("an owner reads only their own records through the API; nobody writes to the table directly", async () => {
      await rpc(SAVE, record(STR, OWN2, { start: "2026-09-01", end: "2026-09-05", nights: 4, gross: 99_900, status: "unknown" }));
      const mine = await asRole("authenticated", OWN1, () => ok("SELECT DISTINCT member_key FROM owner_str_records"));
      expect(mine.map((r) => r.member_key)).toEqual([ACC1]);
      const theirs = await asRole("authenticated", OWN2, () => ok("SELECT DISTINCT member_key FROM owner_str_records"));
      expect(theirs.map((r) => r.member_key)).toEqual([ACC2]);
      // The Manager and strangers get nothing from the table itself.
      expect(await asRole("authenticated", ADMIN, () => ok("SELECT 1 FROM owner_str_records"))).toHaveLength(0);
      expect(await asRole("authenticated", OUTSIDER, () => ok("SELECT 1 FROM owner_str_records"))).toHaveLength(0);
      for (const [role, uid] of [["authenticated", OWN1], ["anon", null], ["service_role", null]] as const) {
        expect((await asRole(role, uid, () => fails("INSERT INTO owner_str_records (property_id, member_key, period_start, period_end, nights, gross_amount_cents, entered_by_member_id) VALUES ($1, $2, '2026-01-01', '2026-01-02', 1, 1, $2)", [STR, ACC1]))).code, role).toBe("42501");
        expect((await asRole(role, uid, () => fails("UPDATE owner_str_records SET nights = 0"))).code, role).toBe("42501");
        expect((await asRole(role, uid, () => fails("DELETE FROM owner_str_records"))).code, role).toBe("42501");
      }
      for (const [role, uid] of [["authenticated", OWN1], ["anon", null]] as const) {
        expect((await asRole(role, uid, () => fails(SAVE, record(STR, OWN1)))).code, role).toBe("42501");
      }
    });

    it("never changes the ledger or any LLC report: no journal entry, no capital line, no balance moves", async () => {
      const before = await ledgerCounts();
      const tb = await ok("SELECT * FROM trial_balance($1, '2026-12-31')", [STR]).catch(() => null);
      const id = await rpc(SAVE, record(STR, OWN1, { start: "2026-10-01", end: "2026-10-10", nights: 8, gross: 777_700 }));
      await rpc(SAVE, record(STR, OWN1, { nights: 7, gross: 123_400 }, id));
      await tryRpc("SELECT delete_owner_str_record($1, $2, $3)", [STR, OWN1, id]);
      expect(await ledgerCounts()).toEqual(before);
      expect(await ok("SELECT * FROM trial_balance($1, '2026-12-31')", [STR]).catch(() => null)).toEqual(tb);
      // And by construction: the table has no foreign key to the journal, and the file writes to no ledger table.
      expect(await count("SELECT count(*)::int n FROM pg_constraint WHERE conrelid = 'owner_str_records'::regclass AND contype = 'f' AND confrelid::regclass::text <> 'properties'")).toBe(0);
      const code = readFileSync("str-treatment.sql", "utf8").split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
      expect(code).not.toMatch(/INSERT INTO public\.(journal|capital_account|owner_capital)|post_entry\(|UPDATE public\.(journal|owner_capital)/);
      expect(code).not.toMatch(/owner_str_records[\s\S]{0,40}(journal|capital_account_ledger)/i);
    });
  });

  describe("the lodging-tax exposure flag, for the CPA Cooperation Worksheet", () => {
    it("lists the owners with tax owed or unknown, without any amount, and leaves out remitted and not-applicable", async () => {
      const P = await property("short_term_rental");
      await rpc(SAVE, record(P, OWN1, { status: "owed", gross: 111_100 }));
      await rpc(SAVE, record(P, OWN1, { start: "2026-08-01", end: "2026-08-04", nights: 3, status: "unknown" }));
      await rpc(SAVE, record(P, OWN2, { status: "remitted" }));
      let rows = (await rpc("SELECT lodging_tax_exposure($1, $2) AS r", [P, ADMIN])) as Array<Record<string, any>>;
      expect(rows).toEqual([{ member_key: ACC1, statuses: ["owed", "unknown"], record_count: 2 }]);
      expect(JSON.stringify(rows)).not.toMatch(/amount|cents|gross|fees|111100|\$/i);
      await rpc(SAVE, record(P, OWN2, { start: "2026-09-01", end: "2026-09-02", nights: 1, status: "not_applicable" }));
      rows = await rpc("SELECT lodging_tax_exposure($1, $2) AS r", [P, ADMIN]);
      expect(rows.map((r) => r.member_key)).toEqual([ACC1]);
      await rpc(SAVE, record(P, OWN2, { start: "2026-09-10", end: "2026-09-12", nights: 2, status: "unknown" }));
      rows = await rpc("SELECT lodging_tax_exposure($1, $2) AS r", [P, ADMIN]);
      expect(rows.map((r) => r.member_key).sort()).toEqual([ACC1, ACC2].sort());
      expect(await rpc("SELECT lodging_tax_exposure($1, $2) AS r", [HOME, ADMIN])).toEqual([]);
    });

    it("is for the Manager only", async () => {
      for (const who of [OWN1, OUTSIDER, null]) expect((await tryRpc("SELECT lodging_tax_exposure($1, $2)", [STR, who])).message, String(who)).toMatch(/Only the Manager/);
      expect((await asRole("authenticated", ADMIN, () => fails("SELECT lodging_tax_exposure($1, $2)", [STR, ADMIN]))).code).toBe("42501");
    });
  });
});
