/**
 * Month 6, Prompt 4, on a real Postgres (PGlite): bookkeeping.sql, bank-feed.sql, then books.sql, exactly as written.
 * The Manager's working functions: the review queue, manual entries, corrections, capitalize, recurring expenses,
 * the rules manager and period close/reopen. Skips when PGlite isn't installed.
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
const MEMBER = U(2);
const M1 = U(11);
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
const J = JSON.stringify;

async function property() {
  const id = (await ok("INSERT INTO properties DEFAULT VALUES RETURNING id"))[0]!.id as string;
  await ok("INSERT INTO cap_table_entries (property_id, share_number, holder_type, buyer_account_id) VALUES ($1, 1, 'buyer_account', $2)", [id, M1]);
  await rpc("SELECT grant_llc_plaid_consent($1, $2, $3::jsonb) AS r", [id, ADMIN, J({ plaid_item_ref: JSON.parse(ITEM) })]);
  return id;
}
let seq = 0;
const bank = async (p: string, o: Record<string, unknown> = {}) => {
  const t = { plaid_txn_id: `bt-${++seq}`, posted_date: "2026-11-02", amount_cents: 10_000, direction: "out", merchant_name: null, raw_category: null, description: null, pending: false, ...o };
  await rpc("SELECT upsert_bank_transaction($1, $2::jsonb) AS r", [p, J(t)]);
  return (await ok("SELECT * FROM bank_transactions WHERE plaid_txn_id = $1", [t.plaid_txn_id]))[0]!;
};
/** A transaction that waits in the review queue. */
const review = async (p: string, o: Record<string, unknown> = {}) => {
  const t = await bank(p, { merchant_name: "Zeta Widgets", description: "POS", ...o });
  await rpc("SELECT categorize_new_bank_transactions($1) AS r", [p]);
  return (await ok("SELECT * FROM bank_transactions WHERE id = $1", [t.id]))[0]!;
};
const postBank = (txn: string, splits: unknown[], who = ADMIN) => tryRpc("SELECT post_bank_transaction($1, $2::jsonb, $3, $4::jsonb)", [txn, J(splits), who, J({ ip_address: "203.0.113.8" })]);
const lines = (entry: string) => ok("SELECT l.id, a.code, l.debit_cents, l.credit_cents FROM journal_lines l JOIN coa_accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY a.code, l.debit_cents", [entry]);
const shape = (rows: Array<Record<string, any>>) => rows.map((l) => [l.code, Number(l.debit_cents), Number(l.credit_cents)]);
const balance = async (p: string, code: string) => {
  const tb = await svc(async () => ok("SELECT * FROM trial_balance($1, '2100-01-01')", [p]));
  return tb.filter((r) => r.code === code).reduce((s, r) => s + Number(r.balance_cents), 0);
};
const manual = (p: string, o: Record<string, unknown> = {}) => {
  const a = { date: "2026-11-03", cents: 5_000, dir: "out", code: "6400", memo: "Hardware store, cash", attach: null, who: ADMIN, ...o };
  return svc(async () => ok("SELECT post_manual_entry($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb) AS r", [p, a.date, a.cents, a.dir, a.code, a.memo, a.attach ? J(a.attach) : null, a.who, J({ ip_address: "198.51.100.2" })]));
};
const tryManual = (p: string, o: Record<string, unknown> = {}) => manual(p, o).then(() => ({ message: "" })).catch((e: Error) => ({ message: e.message }));
const entryOf = async (p: string, memo: string) => (await ok("SELECT id FROM journal_entries WHERE property_id = $1 AND memo = $2", [p, memo]))[0]!.id as string;

describe.skipIf(!pg)("books.sql", () => {
  beforeAll(async () => {
    await pg!.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role; GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
      CREATE TABLE storage.objects (bucket_id text, name text);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE TABLE properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now());
      CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid, actor_type text NOT NULL DEFAULT 'seller', action_type text NOT NULL, entity_type text, entity_id text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE cap_table_entries (property_id uuid, share_number int, holder_type text, buyer_account_id uuid, seller_id uuid);
      CREATE TABLE cap_table_history (property_id uuid, from_buyer_account_id uuid, from_seller_id uuid, to_buyer_account_id uuid, to_seller_id uuid);
      CREATE TABLE user_roles (user_id uuid NOT NULL, role text NOT NULL);
      CREATE TABLE owners (user_id uuid NOT NULL, property_id uuid NOT NULL);
      CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
      CREATE FUNCTION public.is_property_owner(_user uuid, _property uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.owners WHERE user_id = _user AND property_id = _property) $$;
      GRANT ALL ON audit_log TO service_role; GRANT SELECT ON properties, cap_table_entries, cap_table_history, user_roles, owners TO service_role;
      GRANT EXECUTE ON FUNCTION public.has_role(uuid, text), public.is_property_owner(uuid, uuid) TO authenticated, service_role;
      INSERT INTO user_roles VALUES ('${ADMIN}', 'admin');
    `);
    await pg!.exec(readFileSync("bookkeeping.sql", "utf8"));
    await pg!.exec(readFileSync("bank-feed.sql", "utf8"));
    const sql = readFileSync("books.sql", "utf8");
    await pg!.exec(sql);
    await pg!.exec(sql); // safe to run again
  }, 60_000);

  describe("the needs-review queue", () => {
    it("suggests an account from the rules; the Manager posts to the account they choose, and it posts through post_entry as source plaid", async () => {
      const p = await property();
      const t = await review(p, { merchant_name: "Rapid Plumbing", description: "Mystery job", amount_cents: 33_000 });
      expect(t.status).toBe("posted"); // the rules already knew this one
      const u = await review(p, { merchant_name: "Zeta Widgets", description: "POS", amount_cents: 12_345 });
      expect(u.status).toBe("needs_review");
      expect(await svc(async () => ok("SELECT * FROM suggest_bank_account($1)", [u.id]))).toEqual([]);
      const guess = await review(p, { merchant_name: "Acme", description: "Cleaning Co weekend", amount_cents: 700, plaid_txn_id: "g-1" }); // matched on 'cleaning'
      expect(guess.status).toBe("posted");
      await svc(async () => ok("INSERT INTO categorization_rules (property_id, match_type, pattern, coa_account_id, priority) VALUES ($1, 'keyword', 'zeta', (SELECT id FROM coa_accounts WHERE code = '6300'), 1)", [p]));
      expect((await svc(async () => ok("SELECT code, name FROM suggest_bank_account($1)", [u.id])))[0]).toMatchObject({ code: "6300", name: "Utilities Expense" });
      // The Manager picks a different account than the suggestion.
      expect((await postBank(u.id, [{ code: "6400", cents: 12_345 }])).message).toBe("");
      const after = (await ok("SELECT * FROM bank_transactions WHERE id = $1", [u.id]))[0]!;
      expect(after.status).toBe("posted");
      expect(shape(await lines(after.journal_entry_id))).toEqual([["1000", 0, 12_345], ["6400", 12_345, 0]]);
      const e = (await ok("SELECT * FROM journal_entries WHERE id = $1", [after.journal_entry_id]))[0]!;
      expect(e).toMatchObject({ source: "plaid", created_by: ADMIN, source_ref: `plaid:${u.plaid_txn_id}` });
      expect((await ok("SELECT metadata FROM audit_log WHERE action_type = 'books.bank_transaction_posted' AND entity_id = $1", [after.journal_entry_id]))[0]!.metadata).toMatchObject({ splits: 1, amount_cents: 12_345, ip_address: "203.0.113.8" });
    });

    it("a split transaction balances: every cent is accounted for, and a split that doesn't add up is refused", async () => {
      const p = await property();
      const t = await review(p, { amount_cents: 100_001, description: "Warehouse club" });
      expect((await postBank(t.id, [{ code: "6400", cents: 60_000 }, { code: "6300", cents: 30_000 }])).message).toMatch(/add up to 90000 cents but the transaction is 100001 cents/);
      expect((await postBank(t.id, [{ code: "6400", cents: 60_000 }, { code: "6300", cents: 40_002 }])).message).toMatch(/add up to 100002/);
      expect((await postBank(t.id, [{ code: "6400", cents: 0 }, { code: "6300", cents: 100_001 }])).message).toMatch(/whole number of cents above zero/);
      expect((await postBank(t.id, [{ code: "6400", cents: 10.5 }])).message).toMatch(/whole number of cents/);
      expect((await postBank(t.id, [])).message).toMatch(/at least one account/);
      expect((await ok("SELECT status FROM bank_transactions WHERE id = $1", [t.id]))[0]!.status).toBe("needs_review");
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p])).toBe(0);
      expect((await postBank(t.id, [{ code: "6400", cents: 60_000 }, { code: "6300", cents: 30_000 }, { code: "6600", cents: 10_001 }])).message).toBe("");
      const posted = (await ok("SELECT journal_entry_id FROM bank_transactions WHERE id = $1", [t.id]))[0]!.journal_entry_id;
      const ls = await lines(posted);
      expect(shape(ls)).toEqual([["1000", 0, 100_001], ["6300", 30_000, 0], ["6400", 60_000, 0], ["6600", 10_001, 0]]);
      expect(ls.reduce((s, l) => s + Number(l.debit_cents), 0)).toBe(ls.reduce((s, l) => s + Number(l.credit_cents), 0));
      expect((await ok("SELECT memo FROM journal_entries WHERE id = $1", [posted]))[0]!.memo).toMatch(/split 3 ways/);
      // A split of money in credits the accounts and debits Cash.
      const refund = await review(p, { direction: "in", amount_cents: 9_000, merchant_name: "Mystery Vendor" });
      expect((await postBank(refund.id, [{ code: "6400", cents: 6_000 }, { code: "6300", cents: 3_000 }])).message).toBe("");
      const rl = await lines((await ok("SELECT journal_entry_id FROM bank_transactions WHERE id = $1", [refund.id]))[0]!.journal_entry_id);
      expect(shape(rl)).toEqual([["1000", 9_000, 0], ["6300", 0, 3_000], ["6400", 0, 6_000]]);
    });

    it("it is posted once: a second post or an ignore after posting is refused; a pending one can't be posted", async () => {
      const p = await property();
      const t = await review(p, { amount_cents: 500 });
      expect((await postBank(t.id, [{ code: "6400", cents: 500 }])).message).toBe("");
      expect((await postBank(t.id, [{ code: "6400", cents: 500 }])).message).toMatch(/already posted/);
      expect((await tryRpc("SELECT ignore_bank_transaction($1, 'x', $2)", [t.id, ADMIN])).message).toMatch(/already posted/);
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p])).toBe(1);
      const pending = await bank(p, { pending: true, merchant_name: "Whoever" });
      expect((await postBank(pending.id, [{ code: "6400", cents: 10_000 }])).message).toMatch(/pending transaction/);
    });

    it("short-term-rental revenue can't be posted to the LLC by anyone; it can only be ignored with a reason", async () => {
      const p = await property();
      const t = await review(p, { direction: "in", amount_cents: 180_000, merchant_name: "Airbnb", description: "AIRBNB PAYOUT" });
      expect(t.review_reason).toBe("looks_like_str_revenue");
      expect((await postBank(t.id, [{ code: "4000", cents: 180_000 }])).message).toMatch(/never posted to the LLC \(COOA Section 10\)/);
      expect((await tryRpc("SELECT ignore_bank_transaction($1, '  ', $2)", [t.id, ADMIN])).message).toMatch(/Say why/);
      expect((await tryRpc("SELECT ignore_bank_transaction($1, 'Owner-side rental payout, not LLC income', $2, $3::jsonb)", [t.id, ADMIN, J({ ip_address: "203.0.113.9" })])).message).toBe("");
      expect((await ok("SELECT status, review_reason FROM bank_transactions WHERE id = $1", [t.id]))[0]).toEqual({ status: "ignored", review_reason: "ignored: Owner-side rental payout, not LLC income" });
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p])).toBe(0);
      expect((await ok("SELECT metadata FROM audit_log WHERE action_type = 'books.bank_transaction_ignored' AND entity_id = $1", [t.id]))[0]!.metadata).toMatchObject({ reason: "Owner-side rental payout, not LLC income", ip_address: "203.0.113.9" });
    });

    it("only the Manager: nobody else posts or ignores, and a member's capital account can't take a bank transaction", async () => {
      const p = await property();
      const t = await review(p, { amount_cents: 800 });
      expect((await postBank(t.id, [{ code: "6400", cents: 800 }], MEMBER)).message).toMatch(/Only the Manager/);
      expect((await tryRpc("SELECT ignore_bank_transaction($1, 'x', $2)", [t.id, MEMBER])).message).toMatch(/Only the Manager/);
      expect((await postBank(t.id, [{ code: "3100", cents: 800 }])).message).toMatch(/kept per member/);
      for (const [role, uid] of [["authenticated", ADMIN], ["anon", null]] as const) expect((await asRole(role, uid, async () => fails("SELECT post_bank_transaction($1, '[]'::jsonb, $2)", [t.id, ADMIN]))).code).toBe("42501");
    });
  });

  describe("manual cash entries", () => {
    it("posts through post_entry with the date, amount, account and memo, a receipt attached, and logged", async () => {
      const p = await property();
      const id = (await manual(p, { attach: { path: `${p}/receipt-1.jpg`, file_name: "receipt-1.jpg", content_type: "image/jpeg" }, memo: "Padlock, cash" }))[0]!.r as string;
      expect(shape(await lines(id))).toEqual([["1000", 0, 5_000], ["6400", 5_000, 0]]);
      expect((await ok("SELECT * FROM journal_entries WHERE id = $1", [id]))[0]).toMatchObject({ source: "manual", memo: "Padlock, cash", created_by: ADMIN });
      expect((await ok("SELECT * FROM ledger_attachments WHERE entry_id = $1", [id]))[0]).toMatchObject({ storage_path: `${p}/receipt-1.jpg`, file_name: "receipt-1.jpg", content_type: "image/jpeg", uploaded_by: ADMIN, property_id: p });
      expect((await ok("SELECT metadata FROM audit_log WHERE action_type = 'books.manual_entry_posted' AND entity_id = $1", [id]))[0]!.metadata).toMatchObject({ receipt: true, amount_cents: 5_000, account: "6400", ip_address: "198.51.100.2" });
      // Cash in posts the other way.
      const back = (await manual(p, { dir: "in", cents: 1_200, code: "6400", memo: "Deposit refunded in cash" }))[0]!.r as string;
      expect(shape(await lines(back))).toEqual([["1000", 1_200, 0], ["6400", 0, 1_200]]);
    });

    it("refuses what isn't a sound entry: no memo, a future date, a bad amount, Cash or a member account, a receipt of another property, Airbnb money", async () => {
      const p = await property();
      const other = await property();
      const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      expect((await tryManual(p, { memo: "  " })).message).toMatch(/needs a memo/);
      expect((await tryManual(p, { date: future })).message).toMatch(/not in the future/);
      expect((await tryManual(p, { cents: 0 })).message).toMatch(/above zero/);
      expect((await tryManual(p, { dir: "sideways" })).message).toMatch(/in or out/);
      expect((await tryManual(p, { code: "1000" })).message).toMatch(/not Cash or a member/);
      expect((await tryManual(p, { code: "3000" })).message).toMatch(/not Cash or a member/);
      expect((await tryManual(p, { code: "9999" })).message).toMatch(/doesn't exist/);
      expect((await tryManual(p, { attach: { path: `${other}/r.jpg`, file_name: "r.jpg" } })).message).toMatch(/stored under this property/);
      expect((await tryManual(p, { dir: "in", memo: "Airbnb guest payout cash" })).message).toMatch(/short-term-rental revenue/);
      expect((await tryManual(p, { who: MEMBER })).message).toMatch(/Only the Manager/);
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p])).toBe(0);
    });

    it("a closed period refuses it, with the reason", async () => {
      const p = await property();
      await svc(async () => ok("SELECT close_period($1, 2026, 3, $2)", [p, ADMIN]));
      expect((await tryManual(p, { date: "2026-03-10" })).message).toMatch(/period 2026-03 is closed/);
    });

    it("the receipt bucket is private and only the Manager manages it; receipts are never edited or deleted", async () => {
      expect((await ok("SELECT public FROM storage.buckets WHERE id = 'ledger-receipts'"))[0]!.public).toBe(false);
      expect((await ok("SELECT policyname FROM pg_policies WHERE tablename = 'objects' AND policyname = 'The Manager manages ledger receipts'")).length).toBe(1);
      expect((await fails("UPDATE ledger_attachments SET file_name = 'x'")).message).toMatch(/append-only/);
      expect((await fails("DELETE FROM ledger_attachments")).message).toMatch(/append-only/);
    });
  });

  describe("corrections: nothing is edited in place", () => {
    it("recategorize makes a reversing entry and a corrected one, linked, the amount unchanged, and the original untouched", async () => {
      const p = await property();
      const id = (await manual(p, { cents: 25_000, code: "6400", memo: "Sofa, cash" }))[0]!.r as string;
      const before = await lines(id);
      const map = Object.fromEntries(before.filter((l) => l.code === "6400").map((l) => [l.id, "6600"]));
      expect((await tryRpc("SELECT recategorize_entry($1, $2::jsonb, '  ', $3)", [id, J(map), ADMIN])).message).toMatch(/Say why/);
      expect((await tryRpc("SELECT recategorize_entry($1, $2::jsonb, 'wrong account', $3)", [id, J(Object.fromEntries(before.filter((l) => l.code === "1000").map((l) => [l.id, "6600"]))), ADMIN])).message).toMatch(/Cash line stays/);
      expect((await tryRpc("SELECT recategorize_entry($1, '{}'::jsonb, 'x', $2)", [id, ADMIN])).message).toMatch(/Choose the account/);
      expect((await tryRpc("SELECT recategorize_entry($1, $2::jsonb, 'x', $3)", [id, J({ [U(555)]: "6600" }), ADMIN])).message).toMatch(/isn't on this entry/);
      const r = await rpc("SELECT recategorize_entry($1, $2::jsonb, 'It was cleaning, not repairs', $3, $4::jsonb) AS r", [id, J(map), ADMIN, J({ ip_address: "203.0.113.20" })]);
      // The original is exactly as it was.
      expect(shape(await lines(id))).toEqual(shape(before));
      expect((await ok("SELECT memo, status FROM journal_entries WHERE id = $1", [id]))[0]).toEqual({ memo: "Sofa, cash", status: "posted" });
      // The reversal flips it; the corrected entry puts the same amount on the new account.
      expect(shape(await lines(r.reversal_entry_id))).toEqual([["1000", 25_000, 0], ["6400", 0, 25_000]]);
      expect(shape(await lines(r.corrected_entry_id))).toEqual([["1000", 0, 25_000], ["6600", 25_000, 0]]);
      expect((await ok("SELECT reverses_entry_id, reversal_reason FROM journal_entries WHERE id = $1", [r.reversal_entry_id]))[0]).toMatchObject({ reverses_entry_id: id });
      expect((await ok("SELECT memo, source FROM journal_entries WHERE id = $1", [r.corrected_entry_id]))[0]).toMatchObject({ source: "manual", memo: `Recategorize of ${id}: It was cleaning, not repairs` });
      expect((await ok("SELECT * FROM entry_corrections WHERE original_entry_id = $1", [id]))[0]).toMatchObject({ reversal_entry_id: r.reversal_entry_id, corrected_entry_id: r.corrected_entry_id, kind: "recategorize", reason: "It was cleaning, not repairs", actor: ADMIN });
      // The books: repairs net to zero, cleaning has it, Cash is unchanged.
      expect(await balance(p, "6400")).toBe(0);
      expect(await balance(p, "6600")).toBe(25_000);
      expect(await balance(p, "1000")).toBe(-25_000);
      expect((await ok("SELECT effective_status FROM journal_entry_state WHERE entry_id = $1", [id]))[0]!.effective_status).toBe("reversed");
      expect((await ok("SELECT metadata FROM audit_log WHERE action_type = 'books.entry_recategorized' AND entity_id = $1", [r.corrected_entry_id]))[0]!.metadata).toMatchObject({ original_entry_id: id, reason: "It was cleaning, not repairs", ip_address: "203.0.113.20" });
      // Once corrected, it can't be corrected again in place: correct the corrected entry.
      expect((await tryRpc("SELECT recategorize_entry($1, $2::jsonb, 'again', $3)", [id, J(map), ADMIN])).message).toMatch(/already reversed/);
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p])).toBe(3);
    });

    it("if the corrected entry is refused the reversal is rolled back too, and only the Manager corrects", async () => {
      const p = await property();
      const id = (await manual(p, { cents: 900, code: "6400" }))[0]!.r as string;
      const line = (await lines(id)).find((l) => l.code === "6400")!.id;
      expect((await tryRpc("SELECT recategorize_entry($1, $2::jsonb, 'x', $3)", [id, J({ [line]: "9999" }), ADMIN])).message).toMatch(/doesn't exist/);
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p])).toBe(1);
      expect((await tryRpc("SELECT recategorize_entry($1, $2::jsonb, 'x', $3)", [id, J({ [line]: "6600" }), MEMBER])).message).toMatch(/Only the Manager/);
      expect((await tryRpc("SELECT capitalize_entry($1, 'x', $2)", [id, MEMBER])).message).toMatch(/Only the Manager/);
    });

    it("a correction in a closed period needs the flagged adjustment; an entry on a member's capital account is reversed, not recategorized", async () => {
      const p = await property();
      const id = (await manual(p, { cents: 700, code: "6400", date: "2026-02-10" }))[0]!.r as string;
      await svc(async () => ok("SELECT close_period($1, 2026, 2, $2)", [p, ADMIN]));
      const line = (await lines(id)).find((l) => l.code === "6400")!.id;
      expect((await tryRpc("SELECT recategorize_entry($1, $2::jsonb, 'x', $3)", [id, J({ [line]: "6600" }), ADMIN])).message).toMatch(/period 2026-02 is closed/);
      expect((await tryRpc("SELECT recategorize_entry($1, $2::jsonb, 'Late reclass', $3, $4::jsonb)", [id, J({ [line]: "6600" }), ADMIN, J({ is_adjustment: true, adjustment_reason: "Auditor asked" })])).message).toBe("");
      const member = (await svc(async () => ok("SELECT post_entry($1, $2::jsonb, $3::jsonb) AS id", [p, J([{ code: "1000", debit_cents: 100 }, { code: "3000", member_id: M1, credit_cents: 100 }]), J({ source: "capital_call", created_by: ADMIN })])))[0]!.id;
      expect((await tryRpc("SELECT capitalize_entry($1, 'x', $2)", [member, ADMIN])).message).toMatch(/Only an expense can be capitalized|member's capital account/);
      const ml = (await lines(member)).find((l) => l.code === "3000")!.id;
      expect((await tryRpc("SELECT recategorize_entry($1, $2::jsonb, 'x', $3)", [member, J({ [ml]: "3100" }), ADMIN])).message).toMatch(/reversing it, not recategorized/);
    });
  });

  describe("capitalize", () => {
    it("moves an expense to Furnishings and Capital Improvements by reversing and re-posting: the expense nets to zero, the asset gains it, Cash is unchanged", async () => {
      const p = await property();
      await manual(p, { cents: 500_000, code: "6400", memo: "New kitchen appliances" });
      const id = await entryOf(p, "New kitchen appliances");
      expect(await balance(p, "6400")).toBe(500_000);
      expect(await balance(p, "1210")).toBe(0);
      expect((await tryRpc("SELECT capitalize_entry($1, '', $2)", [id, ADMIN])).message).toMatch(/Say why/);
      const r = await rpc("SELECT capitalize_entry($1, 'Appliances last for years', $2, $3::jsonb) AS r", [id, ADMIN, J({ entry_date: "2026-11-30" })]);
      expect(shape(await lines(r.corrected_entry_id))).toEqual([["1000", 0, 500_000], ["1210", 500_000, 0]]);
      expect(shape(await lines(id))).toEqual([["1000", 0, 500_000], ["6400", 500_000, 0]]); // the original is untouched
      expect(await balance(p, "6400")).toBe(0);
      expect(await balance(p, "1210")).toBe(500_000);
      expect(await balance(p, "1000")).toBe(-500_000);
      expect((await ok("SELECT kind, reason FROM entry_corrections WHERE original_entry_id = $1", [id]))[0]).toEqual({ kind: "capitalize", reason: "Appliances last for years" });
      expect((await ok("SELECT entry_date FROM journal_entries WHERE id = $1", [r.corrected_entry_id]))[0]!.entry_date).toEqual(new Date("2026-11-30T00:00:00Z"));
      // A split expense capitalizes whole: every expense line moves.
      const t = await review(p, { amount_cents: 90_000, description: "Warehouse club" });
      await postBank(t.id, [{ code: "6400", cents: 60_000 }, { code: "6300", cents: 30_000 }]);
      const split = (await ok("SELECT journal_entry_id FROM bank_transactions WHERE id = $1", [t.id]))[0]!.journal_entry_id;
      const r2 = await rpc("SELECT capitalize_entry($1, 'Furniture haul', $2) AS r", [split, ADMIN]);
      expect(shape(await lines(r2.corrected_entry_id))).toEqual([["1000", 0, 90_000], ["1210", 30_000, 0], ["1210", 60_000, 0]]);
      expect(await balance(p, "1210")).toBe(590_000);
    });

    it("only an expense can be capitalized", async () => {
      const p = await property();
      const asset = (await svc(async () => ok("SELECT post_entry($1, $2::jsonb, $3::jsonb) AS id", [p, J([{ code: "1210", debit_cents: 100 }, { code: "1000", credit_cents: 100 }]), J({ source: "manual", created_by: ADMIN })])))[0]!.id;
      expect((await tryRpc("SELECT capitalize_entry($1, 'x', $2)", [asset, ADMIN])).message).toMatch(/Only an expense can be capitalized/);
      const rev = (await manual(p, { dir: "in", cents: 100, code: "6400", memo: "Refund in cash" }))[0]!.r as string;
      expect((await tryRpc("SELECT capitalize_entry($1, 'x', $2)", [rev, ADMIN])).message).toMatch(/Only an expense can be capitalized/);
    });
  });

  describe("recurring expenses", () => {
    const rule = (p: string, o: Record<string, unknown> = {}) => {
      const a = { desc: "Property management fee", cents: 25_000, code: "6500", freq: "monthly", first: "2026-01-31", who: ADMIN, ...o };
      return svc(async () => ok("SELECT create_recurring_rule($1, $2, $3, $4, $5, $6, $7, $8::jsonb) AS r", [p, a.desc, a.cents, a.code, a.freq, a.first, a.who, J({ ip_address: "203.0.113.30" })]));
    };
    const run = (asOf: string, p: string) => rpc("SELECT apply_due_recurring($1, NULL, $2) AS r", [asOf, p]);

    it("a scheduled job posts due entries once per due date, however often it runs, and every application is logged", async () => {
      const p = await property();
      const id = (await rule(p, { first: "2026-03-01" }))[0]!.r as string;
      expect(await count("SELECT count(*)::int n FROM audit_log WHERE action_type = 'books.recurring_rule_created' AND entity_id = $1", [id])).toBe(1);
      expect((await run("2026-02-28", p)).posted).toBe(0); // not due yet
      expect(await run("2026-03-01", p)).toMatchObject({ posted: 1, failed: 0 });
      for (let i = 0; i < 4; i++) expect(await run("2026-03-01", p)).toMatchObject({ posted: 0, failed: 0 });
      expect(await run("2026-03-20", p)).toMatchObject({ posted: 0 });
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1 AND source = 'system'", [p])).toBe(1);
      const e = (await ok("SELECT * FROM journal_entries WHERE property_id = $1 AND source = 'system'", [p]))[0]!;
      expect(shape(await lines(e.id))).toEqual([["1000", 0, 25_000], ["6500", 25_000, 0]]);
      expect(e).toMatchObject({ memo: "Property management fee", source_ref: `recurring:${id}:2026-03-01` });
      expect(e.entry_date).toEqual(new Date("2026-03-01T00:00:00Z"));
      expect((await ok("SELECT next_run FROM recurring_rules WHERE id = $1", [id]))[0]!.next_run).toEqual(new Date("2026-04-01T00:00:00Z"));
      // Each application is in the table and in the Audit Vault.
      expect((await ok("SELECT * FROM recurring_applications WHERE rule_id = $1", [id]))).toHaveLength(1);
      expect((await ok("SELECT metadata FROM audit_log WHERE action_type = 'ledger.recurring_applied' AND entity_id = $1", [e.id]))[0]!.metadata).toMatchObject({ rule_id: id, run_date: "2026-03-01", amount_cents: 25_000, account: "6500" });
      // The next due date posts exactly once too.
      expect(await run("2026-04-01", p)).toMatchObject({ posted: 1 });
      expect(await run("2026-04-01", p)).toMatchObject({ posted: 0 });
      expect(await count("SELECT count(*)::int n FROM recurring_applications WHERE rule_id = $1", [id])).toBe(2);
    });

    it("a missed day is caught up one posting per due date, and the date is never posted twice even if the pointer is moved back", async () => {
      const p = await property();
      const id = (await rule(p, { first: "2026-01-10" }))[0]!.r as string;
      expect(await run("2026-04-10", p)).toMatchObject({ posted: 4 }); // Jan, Feb, Mar, Apr
      expect((await ok("SELECT run_date FROM recurring_applications WHERE rule_id = $1 ORDER BY run_date", [id])).map((r) => r.run_date.toISOString().slice(0, 10))).toEqual(["2026-01-10", "2026-02-10", "2026-03-10", "2026-04-10"]);
      await ok("UPDATE recurring_rules SET next_run = '2026-02-10' WHERE id = $1", [id]); // something rewinds the pointer
      expect(await run("2026-04-10", p)).toMatchObject({ posted: 0, already_applied: 3 });
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1 AND source = 'system'", [p])).toBe(4);
      expect((await ok("SELECT next_run FROM recurring_rules WHERE id = $1", [id]))[0]!.next_run).toEqual(new Date("2026-05-10T00:00:00Z"));
      expect((await svc(async () => fails("INSERT INTO recurring_applications (rule_id, property_id, run_date, status, entry_id) VALUES ($1, $2, '2026-01-10', 'posted', (SELECT id FROM journal_entries LIMIT 1))", [id, p]))).code).toBe("42501");
    });

    it("frequencies advance correctly, including month ends", async () => {
      const next = async (from: string, freq: string, anchor: number) => (await ok("SELECT recurring_next_date($1, $2, $3) AS d", [from, freq, anchor]))[0]!.d.toISOString().slice(0, 10);
      expect(await next("2026-01-31", "monthly", 31)).toBe("2026-02-28");
      expect(await next("2026-02-28", "monthly", 31)).toBe("2026-03-31");
      expect(await next("2026-11-30", "quarterly", 30)).toBe("2027-02-28");
      expect(await next("2026-03-15", "annually", 15)).toBe("2027-03-15");
      expect(await next("2024-02-29", "annually", 29)).toBe("2025-02-28");
      expect(await next("2026-03-01", "weekly", 1)).toBe("2026-03-08");
    });

    it("a failure (a closed period) is logged, the date stays due, and it posts once the period is reopened, still only once", async () => {
      const p = await property();
      const id = (await rule(p, { first: "2026-05-05", desc: "Umbrella policy installment", code: "6110" }))[0]!.r as string;
      await svc(async () => ok("SELECT close_period($1, 2026, 5, $2)", [p, ADMIN]));
      expect(await run("2026-05-05", p)).toMatchObject({ posted: 0, failed: 1 });
      expect((await ok("SELECT status, error, entry_id FROM recurring_applications WHERE rule_id = $1", [id]))[0]).toMatchObject({ status: "failed", entry_id: null });
      expect((await ok("SELECT error FROM recurring_applications WHERE rule_id = $1", [id]))[0]!.error).toMatch(/closed/);
      expect((await ok("SELECT next_run FROM recurring_rules WHERE id = $1", [id]))[0]!.next_run).toEqual(new Date("2026-05-05T00:00:00Z"));
      expect(await count("SELECT count(*)::int n FROM audit_log WHERE action_type = 'ledger.recurring_failed' AND entity_id = $1", [id])).toBe(1);
      await svc(async () => ok("SELECT reopen_period($1, 2026, 5, $2, 'Post the umbrella installment')", [p, ADMIN]));
      expect(await run("2026-05-05", p)).toMatchObject({ posted: 1, failed: 0 });
      expect(await run("2026-05-05", p)).toMatchObject({ posted: 0 });
      expect((await ok("SELECT status FROM recurring_applications WHERE rule_id = $1", [id])).map((r) => r.status)).toEqual(["posted"]);
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1 AND source = 'system'", [p])).toBe(1);
    });

    it("a paused rule doesn't post, the account must be an expense account, and only the Manager sets rules up", async () => {
      const p = await property();
      const id = (await rule(p, { first: "2026-06-01" }))[0]!.r as string;
      await svc(async () => ok("SELECT set_recurring_rule_active($1, false, $2)", [id, ADMIN]));
      expect(await run("2026-06-30", p)).toMatchObject({ posted: 0 });
      await svc(async () => ok("SELECT set_recurring_rule_active($1, true, $2)", [id, ADMIN]));
      expect(await run("2026-06-30", p)).toMatchObject({ posted: 1 });
      expect((await tryRpc("SELECT set_recurring_rule_active($1, false, $2)", [id, MEMBER])).message).toMatch(/Only the Manager/);
      for (const code of ["3100", "1000", "4000", "9999"]) expect((await svc(async () => fails("SELECT create_recurring_rule($1, 'x', 100, $2, 'monthly', '2026-07-01', $3)", [p, code, ADMIN]))).message, code).toMatch(/expense account/);
      expect((await tryRpc("SELECT create_recurring_rule($1, 'x', 100, '6500', 'monthly', '2026-07-01', $2)", [p, MEMBER])).message).toMatch(/Only the Manager/);
      expect((await svc(async () => fails("SELECT create_recurring_rule($1, 'x', 0, '6500', 'monthly', '2026-07-01', $2)", [p, ADMIN]))).code).not.toBe("");
      expect((await asRole("authenticated", ADMIN, async () => fails("SELECT apply_due_recurring(current_date, NULL, NULL)"))).code).toBe("42501");
    });
  });

  describe("the categorization rules manager", () => {
    it("a new rule applies to what is already waiting for review: matches post, the rest stay, and the guards still hold", async () => {
      const p = await property();
      const a = await review(p, { merchant_name: "Pinecone Landscaping", description: "Yard", amount_cents: 15_000 });
      const b = await review(p, { merchant_name: "Pinecone Landscaping", description: "Yard", amount_cents: 17_000 });
      const c = await review(p, { merchant_name: "Mystery Vendor", description: "???", amount_cents: 99 });
      const d = await review(p, { direction: "in", merchant_name: "Pinecone Landscaping", description: "Credit", amount_cents: 3_000 });
      const e = await review(p, { direction: "in", merchant_name: "Airbnb", description: "AIRBNB PAYOUT", amount_cents: 77_000 });
      const ignored = await review(p, { merchant_name: "Pinecone Landscaping", description: "Old", amount_cents: 1 });
      await svc(async () => ok("SELECT ignore_bank_transaction($1, 'not ours', $2)", [ignored.id, ADMIN]));
      expect([a, b, c, d, e].map((t) => t.status)).toEqual(["needs_review", "needs_review", "needs_review", "needs_review", "needs_review"]);
      expect((await tryRpc("SELECT save_categorization_rule($1, 'merchant', 'Pinecone Landscaping', '6400', 10, $2)", [p, MEMBER])).message).toMatch(/Only the Manager/);
      expect((await tryRpc("SELECT save_categorization_rule($1, 'merchant', ' ', '6400', 10, $2)", [p, ADMIN])).message).toMatch(/what to match/);
      expect((await tryRpc("SELECT save_categorization_rule($1, 'amount_range', 'lots', '6400', 10, $2)", [p, ADMIN])).message).toMatch(/two amounts/);
      expect((await tryRpc("SELECT save_categorization_rule($1, 'merchant', 'X', '3100', 10, $2)", [p, ADMIN])).message).toMatch(/can post to/);
      const rule = (await rpc("SELECT save_categorization_rule($1, 'merchant', 'Pinecone Landscaping', '6400', 10, $2, $3::jsonb) AS r", [p, ADMIN, J({ ip_address: "203.0.113.40" })])) as string;
      expect(await count("SELECT count(*)::int n FROM audit_log WHERE action_type = 'books.rule_saved' AND entity_id = $1", [rule])).toBe(1);
      const result = await rpc("SELECT apply_rules_to_needs_review($1, $2, $3::jsonb) AS r", [p, ADMIN, J({ ip_address: "203.0.113.40" })]);
      // a and b post (money out, expense). c has no rule. d is money in matching an expense rule: a refund, so it posts as one. e stays: short-term-rental.
      expect(result).toEqual({ posted: 3, still_needs_review: 2 });
      const status = async (t: Record<string, any>) => (await ok("SELECT status, review_reason FROM bank_transactions WHERE id = $1", [t.id]))[0]!;
      expect((await status(a)).status).toBe("posted");
      expect((await status(b)).status).toBe("posted");
      expect(await status(c)).toMatchObject({ status: "needs_review", review_reason: "no_matching_rule" });
      expect((await status(d)).status).toBe("posted");
      expect(await status(e)).toMatchObject({ status: "needs_review", review_reason: "looks_like_str_revenue" });
      expect(await status(ignored)).toMatchObject({ status: "ignored" }); // an ignored one is not brought back
      expect(await balance(p, "6400")).toBe(15_000 + 17_000 - 3_000);
      expect((await ok("SELECT metadata FROM audit_log WHERE action_type = 'books.rules_applied' AND entity_id = $1", [p]))[0]!.metadata).toMatchObject({ posted: 3, still_needs_review: 2 });
      // Run again: nothing more to do.
      expect(await rpc("SELECT apply_rules_to_needs_review($1, $2) AS r", [p, ADMIN])).toEqual({ posted: 0, still_needs_review: 2 });
      // Disabling a rule stops it matching.
      await svc(async () => ok("SELECT set_categorization_rule_active($1, false, $2)", [rule, ADMIN]));
      const f = await review(p, { merchant_name: "Pinecone Landscaping", description: "Yard again", amount_cents: 5 });
      expect(f.status).toBe("needs_review");
      expect((await tryRpc("SELECT apply_rules_to_needs_review($1, $2)", [p, MEMBER])).message).toMatch(/Only the Manager/);
    });
  });

  describe("period close and reopen", () => {
    it("closing needs the Manager; a closed month refuses posting; reopening needs a reason, is logged in both histories, and posting works again", async () => {
      const p = await property();
      const close = (who = ADMIN) => tryRpc("SELECT close_period($1, 2026, 7, $2, $3::jsonb)", [p, who, J({ ip_address: "203.0.113.50" })]);
      expect((await close(MEMBER)).message).toMatch(/Only the Manager can close/);
      expect((await close()).message).toBe("");
      expect((await close()).message).toMatch(/already closed/);
      expect((await tryManual(p, { date: "2026-07-10" })).message).toMatch(/closed/);
      const reopen = (reason: string, who = ADMIN) => tryRpc("SELECT reopen_period($1, 2026, 7, $2, $3, $4::jsonb)", [p, who, reason, J({ ip_address: "203.0.113.51" })]);
      expect((await reopen("   ")).message).toMatch(/Say why/);
      expect((await reopen("x", MEMBER)).message).toMatch(/Only the Manager can reopen/);
      expect((await tryRpc("SELECT reopen_period($1, 2026, 8, $2, 'x')", [p, ADMIN])).message).toMatch(/not closed/);
      expect((await reopen("Late utility bill arrived")).message).toBe("");
      expect((await reopen("again")).message).toMatch(/not closed/);
      expect((await tryManual(p, { date: "2026-07-10" })).message).toBe("");
      const events = await ok("SELECT action, actor, reason FROM accounting_period_events WHERE property_id = $1 AND year = 2026 AND month = 7 ORDER BY at", [p]);
      expect(events).toEqual([{ action: "closed", actor: ADMIN, reason: null }, { action: "reopened", actor: ADMIN, reason: "Late utility bill arrived" }]);
      const audit = await ok("SELECT action_type, metadata FROM audit_log WHERE entity_id = $1 AND action_type IN ('ledger.period_closed', 'ledger.period_reopened') ORDER BY created_at, action_type", [p]);
      expect(audit.map((a) => a.action_type).sort()).toEqual(["ledger.period_closed", "ledger.period_reopened"]);
      expect(audit.find((a) => a.action_type === "ledger.period_reopened")!.metadata).toMatchObject({ reason: "Late utility bill arrived", period: "2026-07", ip_address: "203.0.113.51" });
      // Closed again, it refuses again.
      expect((await close()).message).toBe("");
      expect((await tryManual(p, { date: "2026-07-11" })).message).toMatch(/closed/);
    });

    it("a closed month can't be opened any other way, and the history can't be edited", async () => {
      const p = await property();
      await svc(async () => ok("SELECT close_period($1, 2026, 9, $2)", [p, ADMIN]));
      expect((await fails("UPDATE accounting_periods SET status = 'open'")).message).toMatch(/stays closed unless the Manager reopens it/);
      expect((await svc(async () => fails("UPDATE accounting_periods SET status = 'open'"))).code).toBe("42501");
      expect((await fails("DELETE FROM accounting_periods")).message).toMatch(/never deleted/);
      expect((await fails("UPDATE accounting_period_events SET reason = 'x'")).message).toMatch(/append-only/);
      expect((await fails("DELETE FROM accounting_period_events")).message).toMatch(/append-only/);
      expect((await fails("TRUNCATE accounting_period_events")).message).toMatch(/append-only/);
      expect((await asRole("authenticated", ADMIN, async () => fails("SELECT reopen_period($1, 2026, 9, $2, 'x')", [p, ADMIN]))).code).toBe("42501");
    });

    it("once the monthly statement exists (Prompt 10), a month closes only after it is generated", async () => {
      const p = await property();
      expect((await ok("SELECT period_statement_ready($1, 2026, 10) AS r", [p]))[0]!.r).toBe(true); // no statements table yet
      await pg!.exec("CREATE TABLE monthly_statements (property_id uuid, year int, month int, generated_at timestamptz)");
      expect((await tryRpc("SELECT close_period($1, 2026, 10, $2)", [p, ADMIN])).message).toMatch(/monthly statement for 2026-10 has not been generated/);
      await ok("INSERT INTO monthly_statements VALUES ($1, 2026, 10, NULL)", [p]);
      expect((await tryRpc("SELECT close_period($1, 2026, 10, $2)", [p, ADMIN])).message).toMatch(/has not been generated/);
      await ok("UPDATE monthly_statements SET generated_at = now() WHERE property_id = $1", [p]);
      expect((await tryRpc("SELECT close_period($1, 2026, 10, $2)", [p, ADMIN])).message).toBe("");
      await pg!.exec("DROP TABLE monthly_statements");
    });
  });

  describe("no edit in place, anywhere", () => {
    it("books.sql never updates or deletes the journal, and the journal stays append-only for every role", async () => {
      const sql = readFileSync("books.sql", "utf8").split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
      expect(sql).not.toMatch(/UPDATE\s+public\.journal_(entries|lines)/i);
      expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.journal_(entries|lines)/i);
      expect(sql).not.toMatch(/UPDATE\s+public\.entry_corrections|DELETE\s+FROM\s+public\.entry_corrections/i);
      const p = await property();
      const id = (await manual(p, { memo: "Immutable?" }))[0]!.r as string;
      for (const s of ["UPDATE journal_entries SET memo = 'x'", "UPDATE journal_lines SET debit_cents = 1", "DELETE FROM journal_entries", "DELETE FROM journal_lines"]) {
        expect((await fails(s)).message, s).toMatch(/append-only/);
        for (const [role, uid] of [["service_role", null], ["authenticated", ADMIN]] as const) expect((await asRole(role, uid, async () => fails(s))).code, `${role} ${s}`).toBe("42501");
      }
      expect((await fails("UPDATE entry_corrections SET reason = 'x'")).message).toMatch(/append-only/);
      expect((await ok("SELECT memo FROM journal_entries WHERE id = $1", [id]))[0]!.memo).toBe("Immutable?");
    });

    it("every entry made by these screens balances, and the books balance", async () => {
      const r = (await ok("SELECT (SELECT sum(debit_cents) FROM journal_lines) d, (SELECT sum(credit_cents) FROM journal_lines) c"))[0]!;
      expect(Number(r.d)).toBe(Number(r.c));
      expect(await ok("SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING sum(debit_cents) <> sum(credit_cents)")).toEqual([]);
    });
  });
});
