/**
 * Month 6, Prompt 3, on a real Postgres (PGlite): bookkeeping.sql then bank-feed.sql, exactly as written.
 * Consent, idempotent ingestion, pending to posted, categorization, the income and short-term-rental guards, reconciliation.
 * Skips when PGlite isn't installed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { defaultSimulatedScript } from "@/lib/bank-feed-adapters/simulated";
import { STR_REVENUE_HINTS, looksLikeStrRevenue } from "@/lib/bank-feed";

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
const rpc = async (sql: string, params?: unknown[]) => (await svc(async () => ok(sql, params)))[0]!.r as Record<string, any>;
const ITEM = JSON.stringify({ ciphertext: "abc", iv: "iv", auth_tag: "tag", key_version: 1 });

async function property(link = true) {
  const id = (await ok("INSERT INTO properties DEFAULT VALUES RETURNING id"))[0]!.id as string;
  await ok("INSERT INTO cap_table_entries (property_id, share_number, holder_type, buyer_account_id) VALUES ($1, 1, 'buyer_account', $2)", [id, M1]);
  if (link) await rpc("SELECT grant_llc_plaid_consent($1, $2, $3::jsonb) AS r", [id, ADMIN, JSON.stringify({ plaid_item_ref: JSON.parse(ITEM), institution_name: "Test Bank", account_mask: "1234" })]);
  return id;
}
const tx = (id: string, o: Record<string, unknown> = {}) => ({ plaid_txn_id: id, posted_date: "2026-11-02", amount_cents: 1000, direction: "out", merchant_name: null, raw_category: null, description: null, pending: false, ...o });
const upsert = (p: string, t: Record<string, unknown>) => rpc("SELECT upsert_bank_transaction($1, $2::jsonb) AS r", [p, JSON.stringify(t)]);
const categorize = (p: string) => rpc("SELECT categorize_new_bank_transactions($1) AS r", [p]);
const row = async (txnId: string) => (await ok("SELECT * FROM bank_transactions WHERE plaid_txn_id = $1", [txnId]))[0]!;
const count = async (sql: string, params?: unknown[]) => Number((await ok(sql, params))[0]!.n);
const lines = (entry: string) => ok("SELECT a.code, l.debit_cents, l.credit_cents FROM journal_lines l JOIN coa_accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY a.code", [entry]);

describe.skipIf(!pg)("bank-feed.sql", () => {
  beforeAll(async () => {
    await pg!.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role; GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
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
    const sql = readFileSync("bank-feed.sql", "utf8");
    await pg!.exec(sql);
    await pg!.exec(sql); // safe to run again
  }, 60_000);

  describe("consent", () => {
    it("is the LLC's own, granted by the Manager, a separate record from the buyer Block 1 consent", async () => {
      const p = await property();
      const c = (await ok("SELECT * FROM llc_plaid_consents WHERE property_id = $1", [p]))[0]!;
      expect(c).toMatchObject({ granted_by_manager_user_id: ADMIN, granted_by_entity: "divieight, LLC as Manager", status: "active", revoked_at: null, scope: "transactions:read", institution_name: "Test Bank", account_mask: "1234" });
      expect(c.plaid_item_ref).toMatchObject({ ciphertext: "abc" }); // stored encrypted, never a plaintext token
      const sql = readFileSync("bank-feed.sql", "utf8").split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join(" ");
      // It never reads or writes the buyer-side consent tables or fields.
      expect(sql).not.toMatch(/member_plaid_consents|plaid_consent_at|buyer_account_plaid|plaid_links?\b/i);
      expect(sql).not.toMatch(/REFERENCES public\.buyer_accounts/);
      expect((await ok("SELECT count(*)::int n FROM audit_log WHERE action_type = 'bank_feed.consent_granted' AND entity_id = $1", [c.id]))[0]!.n).toBe(1);
    });

    it("only the Manager links an account, once per LLC, and the item reference must be an encrypted object", async () => {
      const p = await property(false);
      const grant = (who: string | null, item: unknown) => svc(async () => fails("SELECT grant_llc_plaid_consent($1, $2, $3::jsonb)", [p, who, JSON.stringify({ plaid_item_ref: item })]));
      expect((await grant(MEMBER, JSON.parse(ITEM))).message).toMatch(/Only the Manager/);
      expect((await grant(null, JSON.parse(ITEM))).message).toMatch(/Only the Manager/);
      expect((await grant(ADMIN, "access-sandbox-plain-token")).code).not.toBe(""); // a bare string is refused
      expect(await count("SELECT count(*)::int n FROM llc_plaid_consents WHERE property_id = $1", [p])).toBe(0);
      expect((await grant(ADMIN, JSON.parse(ITEM))).message).toBe("");
      expect((await grant(ADMIN, JSON.parse(ITEM))).message).toMatch(/already has an operating account linked/);
      for (const [role, uid] of [["authenticated", ADMIN], ["anon", null]] as const) {
        expect((await asRole(role, uid, () => fails("SELECT grant_llc_plaid_consent($1, $2, '{}'::jsonb)", [p, ADMIN]))).code).toBe("42501");
      }
    });

    it("the encrypted reference is readable by the server only; nobody writes the table directly", async () => {
      const p = await property();
      expect((await asRole("authenticated", ADMIN, () => fails("SELECT plaid_item_ref FROM llc_plaid_consents"))).code).toBe("42501");
      expect((await asRole("authenticated", ADMIN, () => ok("SELECT id, status FROM llc_plaid_consents WHERE property_id = $1", [p]))).length).toBe(1);
      expect((await asRole("authenticated", MEMBER, () => ok("SELECT id FROM llc_plaid_consents"))).length).toBe(0);
      expect((await svc(async () => ok("SELECT plaid_item_ref FROM llc_plaid_consents WHERE property_id = $1", [p]))).length).toBe(1);
      for (const s of [`INSERT INTO llc_plaid_consents (property_id, granted_by_manager_user_id, plaid_item_ref) VALUES ('${p}', '${ADMIN}', '{"ciphertext":"x"}')`, "UPDATE llc_plaid_consents SET status = 'revoked'", "DELETE FROM llc_plaid_consents"]) {
        for (const [role, uid] of [["service_role", null], ["authenticated", ADMIN], ["anon", null]] as const) expect((await asRole(role, uid, () => fails(s))).code, `${role}: ${s}`).toBe("42501");
      }
      expect((await fails("DELETE FROM llc_plaid_consents")).message).toMatch(/never deleted/);
    });

    it("revoking it stops ingestion at once, is audit logged, and a revoked consent stays revoked", async () => {
      const p = await property();
      expect((await upsert(p, tx("rv-1"))).action).toBe("inserted");
      const consent = (await ok("SELECT id FROM llc_plaid_consents WHERE property_id = $1", [p]))[0]!.id;
      const revoke = (who: string) => svc(async () => fails("SELECT revoke_llc_plaid_consent($1, $2, $3::jsonb)", [consent, who, JSON.stringify({ ip_address: "203.0.113.5" })]));
      expect((await revoke(MEMBER)).message).toMatch(/Only the Manager/);
      expect((await revoke(ADMIN)).message).toBe("");
      expect((await revoke(ADMIN)).message).toMatch(/already revoked/);
      const c = (await ok("SELECT * FROM llc_plaid_consents WHERE id = $1", [consent]))[0]!;
      expect(c).toMatchObject({ status: "revoked", revoked_by: ADMIN });
      expect(c.revoked_at).toBeTruthy();
      // Nothing more comes in or is categorized.
      expect((await svc(async () => fails("SELECT upsert_bank_transaction($1, $2::jsonb)", [p, JSON.stringify(tx("rv-2"))]))).message).toMatch(/no active bank-feed consent/);
      expect((await svc(async () => fails("SELECT remove_bank_transaction($1, 'rv-1')", [p]))).message).toMatch(/no active bank-feed consent/);
      expect((await svc(async () => fails("SELECT categorize_new_bank_transactions($1)", [p]))).message).toMatch(/no active bank-feed consent/);
      expect(await count("SELECT count(*)::int n FROM bank_transactions WHERE property_id = $1", [p])).toBe(1);
      const log = (await ok("SELECT metadata FROM audit_log WHERE action_type = 'bank_feed.consent_revoked' AND entity_id = $1", [consent]))[0]!;
      expect(log.metadata).toMatchObject({ property_id: p, ip_address: "203.0.113.5" });
      // A new link makes a new consent; the old one is unchanged.
      await rpc("SELECT grant_llc_plaid_consent($1, $2, $3::jsonb) AS r", [p, ADMIN, JSON.stringify({ plaid_item_ref: JSON.parse(ITEM) })]);
      expect(await count("SELECT count(*)::int n FROM llc_plaid_consents WHERE property_id = $1", [p])).toBe(2);
      expect((await upsert(p, tx("rv-2"))).action).toBe("inserted");
      expect((await fails("UPDATE llc_plaid_consents SET status = 'active' WHERE id = $1", [consent])).message).toMatch(/stays revoked/);
    });
  });

  describe("ingestion", () => {
    it("is idempotent: the same transactions again create nothing new", async () => {
      const p = await property();
      const batch = [tx("a1", { merchant_name: "State Farm" }), tx("a2", { amount_cents: 5000 }), tx("a3", { direction: "in", amount_cents: 700 })];
      expect((await Promise.all(batch.map((t) => upsert(p, t)))).map((r) => r.action)).toEqual(["inserted", "inserted", "inserted"]);
      for (let i = 0; i < 3; i++) expect((await Promise.all(batch.map((t) => upsert(p, t)))).map((r) => r.action)).toEqual(["unchanged", "unchanged", "unchanged"]);
      expect(await count("SELECT count(*)::int n FROM bank_transactions WHERE property_id = $1", [p])).toBe(3);
      // A duplicate id can't exist at all.
      expect((await fails(`INSERT INTO bank_transactions (property_id, plaid_txn_id, posted_date, amount_cents, direction) VALUES ('${p}', 'a1', '2026-11-02', 1, 'out')`)).code).toBe("23505");
    });

    it("a pending transaction becomes its posted version on the SAME record, with no duplicate", async () => {
      const p = await property();
      const pending = await upsert(p, tx("pend-1", { amount_cents: 3000, pending: true, merchant_name: "Rapid Plumbing" }));
      const before = await row("pend-1");
      expect(before).toMatchObject({ is_pending: true, status: "new" });
      const posted = await upsert(p, tx("post-1", { pending_txn_id: "pend-1", amount_cents: 3050, posted_date: "2026-11-04", merchant_name: "Rapid Plumbing" }));
      expect(posted).toMatchObject({ action: "pending_to_posted", id: pending.id });
      expect(await count("SELECT count(*)::int n FROM bank_transactions WHERE property_id = $1", [p])).toBe(1);
      const after = await row("post-1");
      expect(after).toMatchObject({ id: before.id, is_pending: false, status: "new" });
      expect(Number(after.amount_cents)).toBe(3050); // the posted amount wins
      expect(after.posted_date).toEqual(new Date("2026-11-04T00:00:00Z"));
      expect((await ok("SELECT 1 FROM bank_transactions WHERE plaid_txn_id = 'pend-1'")).length).toBe(0);
      // Delivering the posted one again, or the pending one after it, changes nothing and adds nothing.
      expect((await upsert(p, tx("post-1", { pending_txn_id: "pend-1", amount_cents: 3050, posted_date: "2026-11-04", merchant_name: "Rapid Plumbing" }))).action).toBe("unchanged");
      expect(await count("SELECT count(*)::int n FROM bank_transactions WHERE property_id = $1", [p])).toBe(1);
    });

    it("a pending transaction is not categorized until it posts, and a pending one the bank takes back is ignored, not deleted", async () => {
      const p = await property();
      await upsert(p, tx("pn-1", { pending: true, merchant_name: "State Farm" }));
      await upsert(p, tx("pn-2", { pending: true, merchant_name: "Whoever" }));
      expect(await categorize(p)).toEqual({ posted: 0, needs_review: 0 });
      expect((await row("pn-1")).status).toBe("new");
      expect((await rpc("SELECT remove_bank_transaction($1, 'pn-2') AS r", [p])).action).toBe("ignored");
      expect(await row("pn-2")).toMatchObject({ status: "ignored", review_reason: "removed_by_bank" });
      expect((await rpc("SELECT remove_bank_transaction($1, 'nope') AS r", [p])).action).toBe("unknown");
      expect((await fails("DELETE FROM bank_transactions")).message).toMatch(/never deleted/);
    });

    it("a transaction already posted to the ledger can't be changed by the feed or by anyone", async () => {
      const p = await property();
      await upsert(p, tx("fx-1", { merchant_name: "State Farm", amount_cents: 9000 }));
      await categorize(p);
      const posted = await row("fx-1");
      expect(posted.status).toBe("posted");
      expect((await upsert(p, tx("fx-1", { merchant_name: "State Farm", amount_cents: 9500 }))).action).toBe("refused_after_posting");
      expect(Number((await row("fx-1")).amount_cents)).toBe(9000);
      expect((await fails("UPDATE bank_transactions SET amount_cents = 1 WHERE plaid_txn_id = 'fx-1'")).message).toMatch(/already posted to the ledger/);
      expect((await rpc("SELECT remove_bank_transaction($1, 'fx-1') AS r", [p])).action).toBe("flagged");
      expect(await row("fx-1")).toMatchObject({ status: "posted", review_reason: "removed_by_bank_after_posting" });
    });

    it("refuses a bad transaction", async () => {
      const p = await property();
      for (const bad of [tx("b1", { amount_cents: 0 }), tx("b2", { amount_cents: -5 }), tx("b3", { direction: "sideways" }), tx("", {}), tx("b5", { posted_date: null })]) {
        expect((await svc(async () => fails("SELECT upsert_bank_transaction($1, $2::jsonb)", [p, JSON.stringify(bad)]))).code).not.toBe("");
      }
      expect(await count("SELECT count(*)::int n FROM bank_transactions WHERE property_id = $1", [p])).toBe(0);
    });
  });

  describe("categorization", () => {
    it("a matched transaction posts through post_entry as source plaid: Dr the expense, Cr Cash; unmatched goes to review", async () => {
      const p = await property();
      await upsert(p, tx("c1", { merchant_name: "Converse County Treasurer", description: "PROPERTY TAX", amount_cents: 450_000, posted_date: "2026-11-03" }));
      await upsert(p, tx("c2", { merchant_name: "Zeta Widgets Co", description: "POS PURCHASE", amount_cents: 8_800 }));
      expect(await categorize(p)).toEqual({ posted: 1, needs_review: 1 });
      const tax = await row("c1");
      expect(tax).toMatchObject({ status: "posted" });
      expect((await lines(tax.journal_entry_id)).map((l) => [l.code, Number(l.debit_cents), Number(l.credit_cents)])).toEqual([["1000", 0, 450_000], ["6000", 450_000, 0]]);
      const e = (await ok("SELECT * FROM journal_entries WHERE id = $1", [tax.journal_entry_id]))[0]!;
      expect(e).toMatchObject({ source: "plaid", source_ref: "plaid:c1", created_by: null, property_id: p });
      expect(e.entry_date).toEqual(new Date("2026-11-03T00:00:00Z"));
      expect(await row("c2")).toMatchObject({ status: "needs_review", review_reason: "no_matching_rule", journal_entry_id: null });
      // Run again: nothing new is posted.
      expect(await categorize(p)).toEqual({ posted: 0, needs_review: 0 });
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p])).toBe(1);
    });

    it("the seeded global rules cover property tax, insurance, HOA, utilities, repairs, management fees and cleaning", async () => {
      const p = await property();
      const cases: Array<[string, string, string]> = [
        ["County Treasurer", "PROPERTY TAX", "6000"], ["State Farm", "PREMIUM", "6100"], ["Liberty Mutual", "AUTO PAY", "6100"], ["Umbrella Policy Co", "UMBRELLA", "6110"],
        ["Aspen HOA", "DUES", "6200"], ["Xcel Electric", "BILL", "6300"], ["City Water Dept", "BILL", "6300"], ["Rapid Plumbing", "REPAIR", "6400"],
        ["Home Depot", "PURCHASE", "6400"], ["Acme Property Management", "MANAGEMENT FEE", "6500"], ["Sparkle Cleaning", "TURNOVER CLEAN", "6600"],
      ];
      for (const [i, [merchant, desc]] of cases.entries()) await upsert(p, tx(`rule-${i}`, { merchant_name: merchant, description: desc, amount_cents: 100 + i }));
      await categorize(p);
      for (const [i, [merchant, , code]] of cases.entries()) {
        const t = await row(`rule-${i}`);
        expect(t.status, merchant).toBe("posted");
        const debit = (await lines(t.journal_entry_id)).find((l) => Number(l.debit_cents) > 0)!;
        expect(debit.code, merchant).toBe(code);
      }
    });

    it("money in that doesn't match a known source goes to review and is NEVER posted to income", async () => {
      const p = await property();
      await upsert(p, tx("in-1", { direction: "in", amount_cents: 250_000, merchant_name: "ACH CREDIT", description: "DEPOSIT" }));
      await upsert(p, tx("in-2", { direction: "in", amount_cents: 90_000, merchant_name: "Rapid Plumbing", description: "SERVICE PAYMENT" })); // a rule matches an expense: it's a refund
      await upsert(p, tx("in-3", { direction: "in", amount_cents: 400, merchant_name: "Unknown", description: "INTEREST" }));
      await categorize(p);
      expect(await row("in-1")).toMatchObject({ status: "needs_review", review_reason: "money_in_unknown_source" });
      expect(await row("in-3")).toMatchObject({ status: "needs_review", review_reason: "money_in_unknown_source" });
      // The only way money in posts is as a refund of an expense.
      const refund = await row("in-2");
      expect(refund.status).toBe("posted");
      expect((await lines(refund.journal_entry_id)).map((l) => [l.code, Number(l.debit_cents), Number(l.credit_cents)])).toEqual([["1000", 90_000, 0], ["6400", 0, 90_000]]);
      expect(await count("SELECT count(*)::int n FROM journal_lines l JOIN coa_accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.entry_id WHERE e.property_id = $1 AND a.type = 'income'", [p])).toBe(0);
      // Even a rule that names the income account doesn't post money in.
      const other = (await ok("SELECT id FROM coa_accounts WHERE code = '4000'"))[0]!.id;
      await svc(async () => ok("INSERT INTO categorization_rules (property_id, match_type, pattern, coa_account_id, priority) VALUES ($1, 'keyword', 'owner payment', $2, 1)", [p, other]));
      await upsert(p, tx("in-4", { direction: "in", amount_cents: 777, description: "OWNER PAYMENT" }));
      await categorize(p);
      expect(await row("in-4")).toMatchObject({ status: "needs_review", review_reason: "money_in_not_an_expense_refund" });
    });

    it("anything that looks like short-term-rental revenue is never posted to the LLC, even with a rule that would match", async () => {
      const p = await property();
      const repairs = (await ok("SELECT id FROM coa_accounts WHERE code = '6400'"))[0]!.id;
      await svc(async () => ok("INSERT INTO categorization_rules (property_id, match_type, pattern, coa_account_id, priority) VALUES ($1, 'keyword', 'airbnb', $2, 1)", [p, repairs]));
      for (const [i, [merchant, desc]] of [["Airbnb", "AIRBNB PAYOUT"], ["VRBO", "GUEST PAYOUT 11/04"], ["ACH CREDIT", "Booking.com reservation payout"], ["Hostaway", "Rental income transfer"]].entries()) {
        await upsert(p, tx(`str-${i}`, { direction: "in", amount_cents: 100_000 + i, merchant_name: merchant, description: desc }));
      }
      await categorize(p);
      for (let i = 0; i < 4; i++) expect(await row(`str-${i}`), `str-${i}`).toMatchObject({ status: "needs_review", review_reason: "looks_like_str_revenue", journal_entry_id: null });
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p])).toBe(0);
    });

    it("the short-term-rental word list in the database and in the app are the same", async () => {
      const probes = ["airbnb", "vrbo", "homeaway", "booking.com", "guesty", "hostaway", "lodgify", "turno payout", "guest payout", "rental income", "rental revenue", "str revenue", "short-term rental", "short term rental", "nightly rate", "reservation payout", "state farm", "property tax", "refund", "DEPOSIT", "Rental"];
      for (const s of probes) {
        const db = (await ok("SELECT looks_like_str_revenue($1, NULL, NULL) AS v", [s]))[0]!.v;
        expect(db, s).toBe(looksLikeStrRevenue(s));
      }
      expect(STR_REVENUE_HINTS.length).toBe(15);
    });

    it("rules: a property's own rule beats a global one, priority orders them, an inactive rule is ignored, amount ranges work", async () => {
      const p = await property();
      const acct = async (code: string) => (await ok("SELECT id FROM coa_accounts WHERE code = $1", [code]))[0]!.id as string;
      // Global rule would put "insurance" on 6100; this property's own rule says utilities, at the same priority.
      await svc(async () => ok("INSERT INTO categorization_rules (property_id, match_type, pattern, coa_account_id, priority) VALUES ($1, 'keyword', 'special insurance', $2, 20)", [p, await acct("6300")]));
      await upsert(p, tx("r1", { description: "Special Insurance Co" }));
      await categorize(p);
      expect((await lines((await row("r1")).journal_entry_id)).find((l) => Number(l.debit_cents) > 0)!.code).toBe("6300");
      // A lower priority number runs first.
      await svc(async () => ok("INSERT INTO categorization_rules (property_id, match_type, pattern, coa_account_id, priority) VALUES ($1, 'merchant', 'Acme Co', $2, 5), ($1, 'merchant', 'Acme Co 2', $3, 6)", [p, await acct("6500"), await acct("6600")]));
      await upsert(p, tx("r2", { merchant_name: "acme co" }));
      await categorize(p);
      expect((await lines((await row("r2")).journal_entry_id)).find((l) => Number(l.debit_cents) > 0)!.code).toBe("6500"); // merchant is an exact (case-insensitive) match
      // Inactive: ignored.
      await svc(async () => ok("UPDATE categorization_rules SET active = false WHERE property_id = $1 AND pattern = 'Acme Co'", [p]));
      await upsert(p, tx("r3", { merchant_name: "Acme Co" }));
      await categorize(p);
      expect(await row("r3")).toMatchObject({ status: "needs_review" });
      // Amount range.
      await svc(async () => ok("INSERT INTO categorization_rules (property_id, match_type, pattern, coa_account_id, priority) VALUES ($1, 'amount_range', '12345-12345', $2, 1)", [p, await acct("6600")]));
      await upsert(p, tx("r4", { amount_cents: 12_345, description: "mystery" }));
      await upsert(p, tx("r5", { amount_cents: 12_346, description: "mystery" }));
      await categorize(p);
      expect((await row("r4")).status).toBe("posted");
      expect((await row("r5")).status).toBe("needs_review");
      // Another property's rule is not used here.
      const other = await property();
      await upsert(other, tx("r6", { merchant_name: "Acme Co" }));
      await categorize(other);
      expect((await row("r6")).status).toBe("needs_review");
    });

    it("a rule that points at a member's capital account is never auto-posted; a closed period sends it to review", async () => {
      const p = await property();
      const member = (await ok("SELECT id FROM coa_accounts WHERE code = '3100'"))[0]!.id;
      await svc(async () => ok("INSERT INTO categorization_rules (property_id, match_type, pattern, coa_account_id, priority) VALUES ($1, 'keyword', 'owner draw', $2, 1)", [p, member]));
      await upsert(p, tx("m1", { description: "OWNER DRAW" }));
      await categorize(p);
      expect(await row("m1")).toMatchObject({ status: "needs_review", review_reason: "rule_account_not_postable" });
      await svc(async () => ok("SELECT close_period($1, 2026, 1, $2)", [p, ADMIN]));
      await upsert(p, tx("m2", { merchant_name: "State Farm", posted_date: "2026-01-15" }));
      await categorize(p);
      const t = await row("m2");
      expect(t.status).toBe("needs_review");
      expect(t.review_reason).toMatch(/^ledger_refused: .*closed/);
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p])).toBe(0);
    });

    it("one ledger entry per bank transaction, whatever happens twice", async () => {
      const p = await property();
      await upsert(p, tx("one-1", { merchant_name: "State Farm" }));
      await categorize(p);
      const entry = (await row("one-1")).journal_entry_id;
      // Even a direct second posting with the same reference is refused by the database.
      const again = await svc(async () => fails("SELECT post_entry($1, $2::jsonb, $3::jsonb)", [p, JSON.stringify([{ code: "6100", debit_cents: 1000 }, { code: "1000", credit_cents: 1000 }]), JSON.stringify({ source: "plaid", source_ref: "plaid:one-1" })]));
      expect(again.code).toBe("23505");
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1 AND source_ref = 'plaid:one-1'", [p])).toBe(1);
      expect(entry).toBeTruthy();
    });
  });

  describe("the simulated feed, end to end", () => {
    it("running the daily feed again and again creates no duplicates; pending to posted updates one record; every transaction lands where it should", async () => {
      const p = await property();
      const script = defaultSimulatedScript();
      const feed = async (batch: (typeof script)[number]) => {
        for (const t of [...batch.transactions].sort((a, b) => a.postedDate.localeCompare(b.postedDate))) {
          await upsert(p, { plaid_txn_id: t.plaidTxnId, pending_txn_id: t.pendingTxnId, posted_date: t.postedDate, amount_cents: t.amountCents, direction: t.direction, merchant_name: t.merchantName, raw_category: t.rawCategory, description: t.description, pending: t.pending });
        }
        return categorize(p);
      };
      const day1 = await feed(script[0]!);
      expect(day1).toEqual({ posted: 2, needs_review: 3 }); // tax + insurance post; unknown merchant, unknown deposit, Airbnb wait
      const day2 = await feed(script[1]!);
      expect(day2).toEqual({ posted: 2, needs_review: 0 }); // the plumbing posts (rule: plumb), the refund posts as a refund; the tax is a duplicate
      for (let i = 0; i < 3; i++) expect(await feed(script[1]!)).toEqual({ posted: 0, needs_review: 0 });
      expect(await feed(script[0]!)).toEqual({ posted: 0, needs_review: 0 });
      const all = await ok("SELECT plaid_txn_id, status, is_pending FROM bank_transactions WHERE property_id = $1 ORDER BY plaid_txn_id", [p]);
      expect(all.map((r) => [r.plaid_txn_id, r.status, r.is_pending])).toEqual([
        ["sim-in-1", "needs_review", false], ["sim-ins-1", "posted", false], ["sim-post-1", "posted", false], ["sim-refund-1", "posted", false], ["sim-str-1", "needs_review", false], ["sim-tax-1", "posted", false], ["sim-unknown-1", "needs_review", false],
      ]);
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1 AND source = 'plaid'", [p])).toBe(4);
      const tb = await svc(async () => ok("SELECT * FROM trial_balance($1, '2026-12-31')", [p]));
      expect(tb.reduce((s, r) => s + Number(r.debit_cents), 0)).toBe(tb.reduce((s, r) => s + Number(r.credit_cents), 0));
      const income = tb.filter((r) => r.type === "income");
      expect(income).toEqual([]); // nothing was ever posted to income
    });
  });

  describe("reconciliation", () => {
    it("shows the bank balance against the ledger Cash, with what is unmatched and what is still unexplained", async () => {
      const p = await property();
      await svc(async () => ok("SELECT record_bank_feed_position($1, '2026-11-07', 1000000)", [p]));
      await upsert(p, tx("rc-1", { merchant_name: "State Farm", amount_cents: 20_000 })); // posts: ledger Cash -20,000
      await upsert(p, tx("rc-2", { merchant_name: "Mystery", amount_cents: 5_000 })); // unmatched out
      await upsert(p, tx("rc-3", { direction: "in", amount_cents: 12_000, merchant_name: "Mystery In" })); // unmatched in
      await upsert(p, tx("rc-4", { pending: true, amount_cents: 700 }));
      await categorize(p);
      const r = (await svc(async () => ok("SELECT * FROM bank_reconciliation WHERE property_id = $1", [p])))[0]!;
      expect(Number(r.bank_balance_cents)).toBe(1_000_000);
      expect(Number(r.ledger_cash_cents)).toBe(-20_000);
      expect(Number(r.difference_cents)).toBe(1_020_000);
      expect([r.unmatched_count, Number(r.unmatched_in_cents), Number(r.unmatched_out_cents), r.needs_review_count, r.pending_count]).toEqual([2, 12_000, 5_000, 2, 1]);
      expect(Number(r.unreconciled_cents)).toBe(1_020_000 - (12_000 - 5_000));
      expect(r.last_ingested_through).toEqual(new Date("2026-11-07T00:00:00Z"));
      // The balance only counts for an active consent.
      const unlinked = await property(false);
      expect((await svc(async () => ok("SELECT * FROM bank_reconciliation WHERE property_id = $1", [unlinked]))).length).toBe(0);
      // Only the server reads it.
      expect((await asRole("authenticated", ADMIN, () => fails("SELECT * FROM bank_reconciliation"))).code).toBe("42501");
    });
  });
});
