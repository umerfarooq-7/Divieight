/**
 * Month 6, Prompt 5, on a real Postgres (PGlite): bookkeeping, capital-accounts, bank-feed, books, then inquiries.sql, as written.
 * Co-owners raise inquiries on their own property only; the Manager answers, rejects or resolves, optionally by a correction
 * that links the new entry. Skips when PGlite isn't installed.
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
const A_OWNER = U(31); // owns property A (buyer account A1)
const A_OWNER2 = U(32); // another owner of property A (buyer account A2)
const B_OWNER = U(33); // owns property B only
const OUTSIDER = U(39);
const ACC_A1 = U(11);
const ACC_A2 = U(12);
const ACC_B1 = U(13);
const SELLER = U(21);

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

async function property(holders: Array<[string, number]>) {
  const id = (await ok("INSERT INTO properties DEFAULT VALUES RETURNING id"))[0]!.id as string;
  let n = 1;
  for (const [acc, shares] of holders) for (let i = 0; i < shares; i++) await ok("INSERT INTO cap_table_entries (property_id, share_number, holder_type, buyer_account_id) VALUES ($1, $2, 'buyer_account', $3)", [id, n++, acc]);
  return id;
}
const expense = async (p: string, cents = 25_000, code = "6400", date = "2026-11-03") =>
  (await svc(async () => ok("SELECT post_manual_entry($1, $2, $3, 'out', $4, 'Sofa, cash', NULL, $5, '{}'::jsonb) AS r", [p, date, cents, code, ADMIN])))[0]!.r as string;
const raise = (p: string, entry: string, user: string, type = "clarification", msg = "What was this for?", code: string | null = null) =>
  tryRpc("SELECT raise_inquiry($1, $2, $3, $4, $5, $6, $7::jsonb)", [p, entry, user, type, msg, code, J({ ip_address: "203.0.113.60" })]);
const raised = async (p: string, entry: string, user: string, type = "clarification", msg = "What was this for?", code: string | null = null) =>
  (await rpc("SELECT raise_inquiry($1, $2, $3, $4, $5, $6) AS r", [p, entry, user, type, msg, code])) as string;
const lines = (entry: string) => ok("SELECT l.id, a.code, l.debit_cents, l.credit_cents FROM journal_lines l JOIN coa_accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY a.code", [entry]);

let A = "";
let B = "";

describe.skipIf(!pg)("inquiries.sql", () => {
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
      CREATE TABLE cap_table_history (property_id uuid, from_buyer_account_id uuid, from_seller_id uuid, to_buyer_account_id uuid, to_seller_id uuid);
      CREATE TABLE closing_funds_obligations (property_id uuid, amount numeric, status text);
      CREATE TABLE owner_capital_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, user_id uuid NOT NULL, contributed_amount numeric NOT NULL DEFAULT 0, distributions_amount numeric NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (property_id, user_id));
      CREATE TABLE user_roles (user_id uuid NOT NULL, role text NOT NULL);
      CREATE TABLE owners (user_id uuid NOT NULL, property_id uuid NOT NULL);
      CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
      -- As in the app: an owner is a holder on the cap table (owned_share_count > 0).
      CREATE FUNCTION public.is_property_owner(_user uuid, _property uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
        SELECT EXISTS (SELECT 1 FROM public.cap_table_entries c JOIN public.buyer_accounts b ON b.id = c.buyer_account_id WHERE c.property_id = _property AND b.auth_user_id = _user) $$;
      GRANT ALL ON audit_log, owner_capital_accounts TO service_role; GRANT SELECT ON properties, cap_table_entries, cap_table_history, user_roles, owners, entity_genesis, buyer_accounts, closing_funds_obligations TO service_role;
      GRANT UPDATE ON properties TO service_role; GRANT SELECT ON buyer_accounts TO authenticated;
      GRANT EXECUTE ON FUNCTION public.has_role(uuid, text), public.is_property_owner(uuid, uuid) TO authenticated, service_role;
      INSERT INTO user_roles VALUES ('${ADMIN}', 'admin');
      INSERT INTO buyer_accounts VALUES ('${ACC_A1}', '${A_OWNER}'), ('${ACC_A2}', '${A_OWNER2}'), ('${ACC_B1}', '${B_OWNER}');
    `);
    for (const f of ["bookkeeping.sql", "capital-accounts.sql", "bank-feed.sql", "books.sql"]) await pg!.exec(readFileSync(f, "utf8"));
    const sql = readFileSync("inquiries.sql", "utf8");
    await pg!.exec(sql);
    await pg!.exec(sql); // safe to run again
    A = await property([[ACC_A1, 4], [ACC_A2, 4]]);
    B = await property([[ACC_B1, 8]]);
  }, 60_000);

  describe("raising", () => {
    it("an owner asks a question or suggests a recategorization on a transaction in their own property, and it is audit logged", async () => {
      const e = await expense(A);
      const q = await raised(A, e, A_OWNER, "clarification", "Was this a one-off?");
      const row = (await ok("SELECT * FROM coowner_inquiries WHERE id = $1", [q]))[0]!;
      expect(row).toMatchObject({ property_id: A, journal_entry_id: e, raised_by_member_id: ACC_A1, raised_by_user_id: A_OWNER, type: "clarification", message: "Was this a one-off?", status: "open", manager_response: null, resulting_entry_id: null, suggested_account_code: null });
      const r = await raised(A, e, A_OWNER2, "recategorize", "This looks like cleaning", "6600");
      expect((await ok("SELECT raised_by_member_id, suggested_account_code, type FROM coowner_inquiries WHERE id = $1", [r]))[0]).toEqual({ raised_by_member_id: ACC_A2, suggested_account_code: "6600", type: "recategorize" });
      const log = (await ok("SELECT actor_id, metadata FROM audit_log WHERE action_type = 'inquiry.raised' AND entity_id = $1", [q]))[0]!;
      expect(log.actor_id).toBe(A_OWNER);
      expect(log.metadata).toMatchObject({ property_id: A, journal_entry_id: e, type: "clarification", member: ACC_A1 });
    });

    it("an owner of property A cannot raise an inquiry on property B, or on an entry of B filed under A", async () => {
      const eB = await expense(B);
      const eA = await expense(A);
      // Not an owner of B at all.
      expect((await raise(B, eB, A_OWNER)).message).toMatch(/don't have ownership in that property/);
      // Pointing A's membership at B's entry doesn't work either.
      expect((await raise(A, eB, A_OWNER)).message).toMatch(/isn't in this property's books/);
      // And B's owner can't use A.
      expect((await raise(A, eA, B_OWNER)).message).toMatch(/don't have ownership/);
      expect((await raise(A, eA, OUTSIDER)).message).toMatch(/don't have ownership/);
      expect((await raise(A, eA, ADMIN)).message).toMatch(/don't have ownership/); // the Manager answers; they don't ask
      expect((await raise(A, eA, "00000000-0000-4000-8000-000000000000".replace(/0$/, "5"))).message).toMatch(/don't have ownership/);
      expect(await count("SELECT count(*)::int n FROM coowner_inquiries WHERE property_id = $1 AND raised_by_user_id IN ($2, $3, $4)", [B, A_OWNER, B_OWNER, OUTSIDER])).toBe(0);
      expect(await count("SELECT count(*)::int n FROM coowner_inquiries WHERE raised_by_user_id = $1", [B_OWNER])).toBe(0);
      // B's own owner can ask about B.
      expect((await raise(B, eB, B_OWNER)).message).toBe("");
    });

    it("refuses an empty or oversized message, a recategorization with no account or a member account, and no sign-in", async () => {
      const e = await expense(A);
      expect((await raise(A, e, A_OWNER, "clarification", "   ")).message).toMatch(/Say what you would like/);
      expect((await raise(A, e, A_OWNER, "clarification", "x".repeat(2001))).message).toMatch(/under 2,000/);
      expect((await raise(A, e, A_OWNER, "recategorize", "Wrong account")).message).toMatch(/which account it should be on/);
      expect((await raise(A, e, A_OWNER, "recategorize", "Wrong", "9999")).message).toMatch(/isn't an account on the chart/);
      expect((await raise(A, e, A_OWNER, "recategorize", "Wrong", "3100")).message).toMatch(/isn't an account on the chart/);
      expect((await raise(A, e, A_OWNER, "complain", "Hmm")).message).toMatch(/question or a recategorization/);
      expect((await raise(A, e, null as any)).message).toMatch(/Sign in/);
      for (const [role, uid] of [["authenticated", A_OWNER], ["anon", null]] as const) expect((await asRole(role, uid, async () => fails("SELECT raise_inquiry($1, $2, $3, 'clarification', 'x')", [A, e, A_OWNER]))).code).toBe("42501");
    });

    it("an owner who sold their share can no longer raise one", async () => {
      const p = await property([[ACC_A1, 4], [ACC_A2, 4]]);
      const e = await expense(p);
      await ok("DELETE FROM cap_table_entries WHERE property_id = $1 AND buyer_account_id = $2", [p, ACC_A2]);
      await ok("INSERT INTO cap_table_entries (property_id, share_number, holder_type, buyer_account_id) SELECT $1, g, 'buyer_account', $2 FROM generate_series(5, 8) g", [p, ACC_A1]);
      expect((await raise(p, e, A_OWNER2)).message).toMatch(/don't have ownership/);
      expect((await raise(p, e, A_OWNER)).message).toBe("");
    });
  });

  describe("owners see only their own inquiries", () => {
    it("by the database's own row security: your own, never another owner's, never another property's", async () => {
      const e = await expense(A);
      const mine = await raised(A, e, A_OWNER, "clarification", "Mine only");
      const theirs = await raised(A, e, A_OWNER2, "clarification", "Theirs only");
      const other = await raised(B, await expense(B), B_OWNER, "clarification", "Property B's");
      const idsFor = async (uid: string) => (await asRole("authenticated", uid, async () => ok("SELECT id FROM coowner_inquiries"))).map((r) => r.id);
      const a1 = await idsFor(A_OWNER);
      expect(a1).toContain(mine);
      expect(a1).not.toContain(theirs);
      expect(a1).not.toContain(other);
      const a2 = await idsFor(A_OWNER2);
      expect(a2).toContain(theirs);
      expect(a2).not.toContain(mine);
      expect(a2).not.toContain(other);
      const b = await idsFor(B_OWNER);
      expect(b).toContain(other);
      expect(b).not.toContain(mine);
      expect(b).not.toContain(theirs);
      expect(await idsFor(OUTSIDER)).toEqual([]);
      const all = await idsFor(ADMIN);
      for (const id of [mine, theirs, other]) expect(all).toContain(id);
      expect((await asRole("anon", null, async () => fails("SELECT * FROM coowner_inquiries"))).code).toBe("42501");
    });

    it("an owner who gives up their share stops seeing even their own on that property", async () => {
      const p = await property([[ACC_A1, 8]]);
      const e = await expense(p);
      const q = await raised(p, e, A_OWNER);
      expect((await asRole("authenticated", A_OWNER, async () => ok("SELECT id FROM coowner_inquiries WHERE id = $1", [q]))).length).toBe(1);
      await ok("DELETE FROM cap_table_entries WHERE property_id = $1", [p]);
      expect((await asRole("authenticated", A_OWNER, async () => ok("SELECT id FROM coowner_inquiries WHERE id = $1", [q]))).length).toBe(0);
    });
  });

  describe("the Manager's answers", () => {
    it("answers, and the owner's inquiry shows the answer and status; the Manager only", async () => {
      const e = await expense(A);
      const q = await raised(A, e, A_OWNER);
      expect((await tryRpc("SELECT answer_inquiry($1, $2, 'It was a one-off.')", [q, A_OWNER])).message).toMatch(/Only the Manager/);
      expect((await tryRpc("SELECT answer_inquiry($1, $2, '  ')", [q, ADMIN])).message).toMatch(/Write the answer/);
      expect((await tryRpc("SELECT answer_inquiry($1, $2, 'It was a one-off.', $3::jsonb)", [q, ADMIN, J({ ip_address: "203.0.113.61" })])).message).toBe("");
      const row = (await asRole("authenticated", A_OWNER, async () => ok("SELECT status, manager_response, responded_by, responded_at FROM coowner_inquiries WHERE id = $1", [q])))[0]!;
      expect(row).toMatchObject({ status: "answered", manager_response: "It was a one-off.", responded_by: ADMIN });
      expect(row.responded_at).toBeTruthy();
      expect((await ok("SELECT metadata FROM audit_log WHERE action_type = 'inquiry.answered' AND entity_id = $1", [q]))[0]!.metadata).toMatchObject({ response: "It was a one-off.", ip_address: "203.0.113.61" });
      // It can be answered again while it is still open to answers.
      expect((await tryRpc("SELECT answer_inquiry($1, $2, 'Correction: it was a deposit.')", [q, ADMIN])).message).toBe("");
      expect((await ok("SELECT manager_response FROM coowner_inquiries WHERE id = $1", [q]))[0]!.manager_response).toBe("Correction: it was a deposit.");
      expect(await count("SELECT count(*)::int n FROM audit_log WHERE action_type = 'inquiry.answered' AND entity_id = $1", [q])).toBe(2);
    });

    it("rejects a suggestion with a reason, which settles it", async () => {
      const e = await expense(A);
      const q = await raised(A, e, A_OWNER, "recategorize", "Move it", "6600");
      expect((await tryRpc("SELECT reject_inquiry($1, $2, ' ')", [q, ADMIN])).message).toMatch(/Say why/);
      expect((await tryRpc("SELECT reject_inquiry($1, $2, 'x')", [q, A_OWNER])).message).toMatch(/Only the Manager/);
      expect((await tryRpc("SELECT reject_inquiry($1, $2, 'It is a repair; the invoice says so.')", [q, ADMIN])).message).toBe("");
      expect((await ok("SELECT status, manager_response, resolved_by, resolved_at, resulting_entry_id FROM coowner_inquiries WHERE id = $1", [q]))[0]).toMatchObject({ status: "rejected", manager_response: "It is a repair; the invoice says so.", resolved_by: ADMIN, resulting_entry_id: null });
      expect((await tryRpc("SELECT answer_inquiry($1, $2, 'more')", [q, ADMIN])).message).toMatch(/already rejected/);
      expect(await count("SELECT count(*)::int n FROM audit_log WHERE action_type = 'inquiry.rejected' AND entity_id = $1", [q])).toBe(1);
    });

    it("resolving by a correction posts the Prompt 4 correction and links the new entry in resulting_entry_id", async () => {
      const e = await expense(A, 25_000, "6400");
      const before = await lines(e);
      const map = Object.fromEntries(before.filter((l) => l.code === "6400").map((l) => [l.id, "6600"]));
      const q = await raised(A, e, A_OWNER, "recategorize", "This is cleaning", "6600");
      const res = await rpc("SELECT resolve_inquiry($1, $2, 'You were right; moved to cleaning.', $3::jsonb, $4::jsonb) AS r", [q, ADMIN, J({ kind: "recategorize", mapping: map }), J({ ip_address: "203.0.113.62" })]);
      expect(res.resulting_entry_id).toBeTruthy();
      const row = (await ok("SELECT * FROM coowner_inquiries WHERE id = $1", [q]))[0]!;
      expect(row).toMatchObject({ status: "resolved", resulting_entry_id: res.resulting_entry_id, resolved_by: ADMIN, manager_response: "You were right; moved to cleaning.", journal_entry_id: e });
      expect(row.resolved_at).toBeTruthy();
      // The linked entry is the corrected one, on the new account; the original is untouched; a reversal exists.
      expect(await lines(res.resulting_entry_id)).toHaveLength(2);
      expect((await lines(res.resulting_entry_id)).map((l) => l.code).sort()).toEqual(["1000", "6600"]);
      expect((await lines(e)).map((l) => [l.code, Number(l.debit_cents), Number(l.credit_cents)])).toEqual(before.map((l) => [l.code, Number(l.debit_cents), Number(l.credit_cents)]));
      const corr = (await ok("SELECT * FROM entry_corrections WHERE original_entry_id = $1", [e]))[0]!;
      expect(corr).toMatchObject({ corrected_entry_id: res.resulting_entry_id, kind: "recategorize", actor: ADMIN });
      expect(corr.reason).toBe("Co-owner inquiry: This is cleaning");
      const audit = (await ok("SELECT metadata FROM audit_log WHERE action_type = 'inquiry.resolved' AND entity_id = $1", [q]))[0]!.metadata;
      expect(audit).toMatchObject({ correction: "recategorize", resulting_entry_id: res.resulting_entry_id, ip_address: "203.0.113.62" });
      // The owner sees the link and the response.
      const own = (await asRole("authenticated", A_OWNER, async () => ok("SELECT status, manager_response, resulting_entry_id FROM coowner_inquiries WHERE id = $1", [q])))[0]!;
      expect(own).toMatchObject({ status: "resolved", resulting_entry_id: res.resulting_entry_id });
    });

    it("capitalize and reverse also link their new entry; a plain resolution links none", async () => {
      const e1 = await expense(A, 90_000, "6400");
      const q1 = await raised(A, e1, A_OWNER, "recategorize", "This is a capital improvement", "1210");
      const r1 = await rpc("SELECT resolve_inquiry($1, $2, 'Capitalized.', $3::jsonb) AS r", [q1, ADMIN, J({ kind: "capitalize", reason: "Appliances" })]);
      expect((await lines(r1.resulting_entry_id)).map((l) => l.code).sort()).toEqual(["1000", "1210"]);
      expect((await ok("SELECT kind, reason FROM entry_corrections WHERE original_entry_id = $1", [e1]))[0]).toEqual({ kind: "capitalize", reason: "Appliances" });
      const e2 = await expense(A, 4_000, "6300");
      const q2 = await raised(A, e2, A_OWNER, "clarification", "Is this a duplicate?");
      const r2 = await rpc("SELECT resolve_inquiry($1, $2, 'Yes, a duplicate; reversed.', $3::jsonb) AS r", [q2, ADMIN, J({ kind: "reverse", reason: "Duplicate of the earlier bill" })]);
      expect((await ok("SELECT reverses_entry_id, reversal_reason FROM journal_entries WHERE id = $1", [r2.resulting_entry_id]))[0]).toEqual({ reverses_entry_id: e2, reversal_reason: "Duplicate of the earlier bill" });
      const e3 = await expense(A);
      const q3 = await raised(A, e3, A_OWNER, "clarification", "What is this?");
      const r3 = await rpc("SELECT resolve_inquiry($1, $2, 'A cash purchase for the house.') AS r", [q3, ADMIN]);
      expect(r3.resulting_entry_id).toBeNull();
      expect((await ok("SELECT status, resulting_entry_id FROM coowner_inquiries WHERE id = $1", [q3]))[0]).toEqual({ status: "resolved", resulting_entry_id: null });
    });

    it("if the correction is refused (a closed period) nothing changes: the inquiry stays open and no entry is posted", async () => {
      const e = await expense(A, 700, "6400", "2026-02-10");
      const line = (await lines(e)).find((l) => l.code === "6400")!.id;
      const q = await raised(A, e, A_OWNER, "recategorize", "Move it", "6600");
      await svc(async () => ok("SELECT close_period($1, 2026, 2, $2)", [A, ADMIN]));
      const entries = await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [A]);
      expect((await tryRpc("SELECT resolve_inquiry($1, $2, 'Done', $3::jsonb)", [q, ADMIN, J({ kind: "recategorize", mapping: { [line]: "6600" } })])).message).toMatch(/period 2026-02 is closed/);
      expect((await ok("SELECT status, resulting_entry_id FROM coowner_inquiries WHERE id = $1", [q]))[0]).toEqual({ status: "open", resulting_entry_id: null });
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [A])).toBe(entries);
      // With a dated correction in the open month it works.
      expect((await tryRpc("SELECT resolve_inquiry($1, $2, 'Done', $3::jsonb)", [q, ADMIN, J({ kind: "recategorize", mapping: { [line]: "6600" }, entry_date: "2026-11-05" })])).message).toBe("");
      expect((await ok("SELECT status FROM coowner_inquiries WHERE id = $1", [q]))[0]!.status).toBe("resolved");
    });

    it("only the Manager resolves, a response is required, an unknown correction is refused, and a settled inquiry stays settled", async () => {
      const e = await expense(A);
      const q = await raised(A, e, A_OWNER);
      expect((await tryRpc("SELECT resolve_inquiry($1, $2, 'ok')", [q, A_OWNER])).message).toMatch(/Only the Manager/);
      expect((await tryRpc("SELECT resolve_inquiry($1, $2, ' ')", [q, ADMIN])).message).toMatch(/Write the response/);
      expect((await tryRpc("SELECT resolve_inquiry($1, $2, 'ok', $3::jsonb)", [q, ADMIN, J({ kind: "delete" })])).message).toMatch(/recategorize, capitalize or reverse/);
      expect((await ok("SELECT status FROM coowner_inquiries WHERE id = $1", [q]))[0]!.status).toBe("open");
      expect((await tryRpc("SELECT resolve_inquiry($1, $2, 'All good.')", [q, ADMIN])).message).toBe("");
      expect((await tryRpc("SELECT resolve_inquiry($1, $2, 'again')", [q, ADMIN])).message).toMatch(/already resolved/);
      expect((await fails("UPDATE coowner_inquiries SET status = 'open' WHERE id = $1", [q])).message).toMatch(/stays settled/);
    });
  });

  describe("the record is protected", () => {
    it("what was asked can't be changed, an inquiry can't be deleted, and no role writes the table directly", async () => {
      const e = await expense(A);
      const q = await raised(A, e, A_OWNER, "clarification", "Original words");
      expect((await fails("UPDATE coowner_inquiries SET message = 'Changed' WHERE id = $1", [q])).message).toMatch(/can't be changed/);
      expect((await fails("UPDATE coowner_inquiries SET property_id = $2 WHERE id = $1", [q, B])).message).toMatch(/can't be changed/);
      expect((await fails("DELETE FROM coowner_inquiries")).message).toMatch(/never deleted/);
      expect((await fails("TRUNCATE coowner_inquiries")).message).toMatch(/never deleted/);
      for (const s of ["UPDATE coowner_inquiries SET status = 'resolved'", "DELETE FROM coowner_inquiries", `INSERT INTO coowner_inquiries (property_id, journal_entry_id, raised_by_member_id, raised_by_user_id, type, message) VALUES ('${A}', '${e}', '${ACC_A1}', '${A_OWNER}', 'clarification', 'x')`]) {
        for (const [role, uid] of [["service_role", null], ["authenticated", A_OWNER], ["authenticated", ADMIN], ["anon", null]] as const) expect((await asRole(role, uid, async () => fails(s))).code, `${role}: ${s}`).toBe("42501");
      }
      expect((await ok("SELECT message FROM coowner_inquiries WHERE id = $1", [q]))[0]!.message).toBe("Original words");
    });

    it("an inquiry never blocks the books: the Manager can still correct, reverse and close with an inquiry open, and nothing else reads the table", async () => {
      const p = await property([[ACC_A1, 8]]);
      const e = await expense(p, 1_000, "6400", "2026-03-04");
      await raised(p, e, A_OWNER, "clarification", "Still open");
      const entries = await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p]);
      await svc(async () => ok("SELECT reverse_entry($1, 'Manager decides', $2::jsonb)", [e, J({ created_by: ADMIN })]));
      await svc(async () => ok("SELECT close_period($1, 2026, 3, $2)", [p, ADMIN]));
      expect(await count("SELECT count(*)::int n FROM journal_entries WHERE property_id = $1", [p])).toBe(entries + 1);
      expect((await ok("SELECT status FROM coowner_inquiries WHERE journal_entry_id = $1", [e]))[0]!.status).toBe("open"); // untouched by any of it
      // Trial balance and ownership checks don't depend on it.
      expect((await svc(async () => ok("SELECT count(*)::int n FROM trial_balance($1, '2100-01-01')", [p])))[0]!.n).toBeGreaterThan(0);
      expect((await ok("SELECT is_property_owner($1, $2) AS r", [A_OWNER, p]))[0]!.r).toBe(true);
      // No function or trigger outside inquiries.sql mentions the table, so nothing can wait on it.
      const others = await ok("SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc ILIKE '%coowner_inquiries%' ORDER BY proname");
      expect(others.map((r) => r.proname)).toEqual(["answer_inquiry", "raise_inquiry", "reject_inquiry", "resolve_inquiry"]);
    });
  });
});
