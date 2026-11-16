/**
 * Row-level security on the real schema (PGlite, built from the repository's own SQL): every table, every role.
 *
 *   1. The audit: every table has RLS; the anon grants, the "anyone" policies and the browser's write grants are exactly the reviewed lists (a new one fails this test until reviewed).
 *   2. Cross-property and cross-role: two properties, an owner of each, a seller of each, a stranger, a Manager and a visitor. Each reads only what their role and their property allow,
 *      for documents, the records vault, ledger, inquiries, votes, expenses, distributions, the cap table, notifications and signed documents.
 *   3. Writes: nobody writes another property's or another person's rows.
 *
 * The tables whose base schema is not in the repository (agents, brokers, pods, authorization_requests and a few more: see migrations-fresh-db.test.ts) cannot be built here: run
 * the queries in docs/rls-audit.md against production for those.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PGLITE_AVAILABLE, buildFreshDb, type Db } from "./helpers/fresh-db";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SA = U(1); // seller of property A
const SB = U(2);
const BA = U(3); // owner of a share of A
const BB = U(4); // owner of a share of B
const STR = U(5); // a stranger with a buyer account and nothing else
const ADM = U(6);
const PA = U(101);
const PB = U(102);
const PL = U(103); // a listed property (public)
const ACC_A = U(201);
const ACC_B = U(202);
const ACC_S = U(203);

let pg: Db;
const ok = async (sql: string, params?: unknown[]) => (await pg.query(sql, params)).rows;
const fails = async (sql: string, params?: unknown[]) => {
  try {
    await pg.query(sql, params);
    return "";
  } catch (e) {
    return (e as { message?: string }).message ?? "failed";
  }
};
/** Run as a signed-in person (through the API: the authenticator, then the authenticated role, with that person's token). */
async function asUser<T>(uid: string | null, fn: () => Promise<T>, role: "authenticated" | "anon" = "authenticated"): Promise<T> {
  await pg.exec(`SET SESSION AUTHORIZATION authenticator; SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub', '${uid ?? ""}', false); SELECT set_config('request.jwt.claim.role', '${role}', false);`);
  try {
    return await fn();
  } finally {
    await pg.exec("RESET ROLE; SET SESSION AUTHORIZATION postgres; SELECT set_config('request.jwt.claim.sub', '', false); SELECT set_config('request.jwt.claim.role', '', false);");
  }
}
const count = (sql: string, params?: unknown[]) => ok(`SELECT count(*)::int AS n FROM (${sql}) q`, params).then((r) => r[0]!.n as number);

beforeAll(async () => {
  if (!PGLITE_AVAILABLE) return;
  ({ pg } = await buildFreshDb());
  // The rows are put in directly (as the database owner), without the record-keeping triggers: the policies are what is under test, not the posting rules.
  await pg.exec("SET session_replication_role = replica");
  const people = [SA, SB, BA, BB, STR, ADM];
  for (const id of people) await pg.query("INSERT INTO auth.users (id, email) VALUES ($1, $2)", [id, `${id.slice(-2)}@test.invalid`]);
  await pg.query("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')", [ADM]);
  await pg.query("INSERT INTO public.sellers (id, email, full_name) VALUES ($1, 'sa@test.invalid', 'Seller A'), ($2, 'sb@test.invalid', 'Seller B')", [SA, SB]);
  await pg.query("INSERT INTO public.properties (id, seller_id, address, city, state, zip, status) VALUES ($1, $4, '1 A St', 'Lusk', 'WY', '82225', 'pending'), ($2, $5, '2 B St', 'Bend', 'OR', '97701', 'pending'), ($3, $4, '3 L St', 'Reno', 'NV', '89501', 'listed')", [PA, PB, PL, SA, SB]);
  await pg.query("INSERT INTO public.buyer_accounts (id, auth_user_id, email, golden_ticket_issued) VALUES ($1, $4, 'ba@test.invalid', false), ($2, $5, 'bb@test.invalid', false), ($3, $6, 'str@test.invalid', false)", [ACC_A, ACC_B, ACC_S, BA, BB, STR]);
  await pg.query("INSERT INTO public.account_members (id, buyer_account_id, full_name, role, status) VALUES ($1, $3, 'Alice A', 'primary', 'active'), ($2, $4, 'Bob B', 'primary', 'active')", [U(301), U(302), ACC_A, ACC_B]);
  await pg.query("INSERT INTO public.cap_table_entries (property_id, share_number, holder_type, buyer_account_id, retention_lock_expires_at) VALUES ($1, 1, 'buyer_account', $3, now()), ($2, 1, 'buyer_account', $4, now())", [PA, PB, ACC_A, ACC_B]);
  await pg.query("INSERT INTO public.pod_reservations (property_id, buyer_account_id, shares_reserved, status) VALUES ($1, $3, 1, 'reserved'), ($2, $4, 1, 'reserved'), ($5, $3, 1, 'reserved')", [PA, PB, ACC_A, ACC_B, PL]);
  await pg.query("INSERT INTO public.votes (id, property_id, title, vote_type, opens_at, closes_at, status) VALUES ($1, $3, 'Vote A', 'ordinary', now(), now() + interval '1 day', 'open'), ($2, $4, 'Vote B', 'ordinary', now(), now() + interval '1 day', 'open')", [U(401), U(402), PA, PB]);
  await pg.query("INSERT INTO public.vote_ballots (vote_id, holder_key, choice) VALUES ($1, $3, 'Yes'), ($2, $4, 'Yes')", [U(401), U(402), ACC_A, ACC_B]);
  const coa = (await ok("SELECT v.id AS version_id, (SELECT a.id FROM public.coa_accounts a LIMIT 1) AS account_id FROM public.coa_versions v LIMIT 1"))[0];
  if (coa?.version_id) {
    await pg.query("INSERT INTO public.journal_entries (id, property_id, entry_date, source, coa_version_id, period) VALUES ($1, $3, '2026-10-01', 'manual', $5, '2026-10'), ($2, $4, '2026-10-01', 'manual', $5, '2026-10')", [U(501), U(502), PA, PB, coa.version_id]);
    await pg.query("INSERT INTO public.journal_lines (entry_id, account_id, debit_cents) VALUES ($1, $3, 100), ($2, $3, 100)", [U(501), U(502), coa.account_id]);
    await pg.query("INSERT INTO public.coowner_inquiries (property_id, journal_entry_id, raised_by_member_id, raised_by_user_id, type, message) VALUES ($1, $3, $5, $7, 'clarification', 'What is this?'), ($2, $4, $6, $8, 'clarification', 'And this?')", [PA, PB, U(501), U(502), U(301), U(302), BA, BB]);
  }
  await pg.query("INSERT INTO public.expenses (property_id, description, category, total_amount, incurred_on, status) VALUES ($1, 'A roof', 'repairs', 100, '2026-10-01', 'posted'), ($2, 'B roof', 'repairs', 100, '2026-10-01', 'posted')", [PA, PB]);
  await pg.query("INSERT INTO public.distribution_events (property_id, total_amount, record_date, status) VALUES ($1, 100, '2026-10-01', 'posted'), ($2, 100, '2026-10-01', 'posted')", [PA, PB]).catch(async () => {
    await pg.query("INSERT INTO public.distribution_events (property_id, total_amount, record_date) VALUES ($1, 100, '2026-10-01'), ($2, 100, '2026-10-01')", [PA, PB]);
  });
  await pg.query("INSERT INTO public.property_documents (property_id, document_name, document_type, file_url) VALUES ($1, 'Deed A', 'deed', 'a.pdf'), ($2, 'Deed B', 'deed', 'b.pdf')", [PA, PB]);
  await pg.query("INSERT INTO public.property_records_vault (property_id, document_type, file_url) VALUES ($1, 'cert', 'a.pdf'), ($2, 'cert', 'b.pdf')", [PA, PB]);
  await pg.query("INSERT INTO public.bank_transactions (property_id, plaid_txn_id, posted_date, amount_cents, direction) VALUES ($1, 'ta', '2026-10-01', 100, 'in'), ($2, 'tb', '2026-10-01', 100, 'in')", [PA, PB]).catch(() => undefined);
  await pg.query("INSERT INTO public.notifications (seller_id, message, type) VALUES ($1, 'for A', 'x'), ($2, 'for B', 'x')", [BA, BB]);
  await pg.query("INSERT INTO public.signed_documents (buyer_account_id, document_type, document_version, signed_name) VALUES ($1, 'PRA', 'v1', 'Alice A'), ($2, 'PRA', 'v1', 'Bob B')", [ACC_A, ACC_B]);
  await pg.query("INSERT INTO public.owner_notices (property_id, title, body) VALUES ($1, 'A', 'a'), ($2, 'B', 'b')", [PA, PB]);
  await pg.exec("RESET session_replication_role");
}, 600_000);

// ---------------------------------------------------------------------------------------------------------
// 1. The audit
// ---------------------------------------------------------------------------------------------------------
describe.skipIf(!PGLITE_AVAILABLE)("RLS audit: every table", () => {
  it("every table in the schema has row-level security on", async () => {
    const off = await ok("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity ORDER BY 1");
    expect(off.map((r) => r.relname)).toEqual([]);
  });

  it("only these tables can be touched by a visitor who is not signed in", async () => {
    const g = await ok("SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = 'anon' GROUP BY 1 ORDER BY 1");
    expect(Object.fromEntries(g.map((r) => [r.table_name, r.privs]))).toEqual({ contact_submissions: "INSERT", pod_reservations: "SELECT", properties: "SELECT", property_media: "SELECT", support_tickets: "INSERT" });
  });

  it("only these policies say true (anyone, or any signed-in person): reference data and the contact forms", async () => {
    const p = await ok("SELECT tablename, cmd FROM pg_policies WHERE schemaname = 'public' AND (btrim(coalesce(qual, '')) IN ('true', '(true)') OR btrim(coalesce(with_check, '')) IN ('true', '(true)')) ORDER BY 1, 2");
    expect(p.map((r) => `${r.tablename}:${r.cmd}`)).toEqual(["coa_accounts:SELECT", "coa_versions:SELECT", "contact_submissions:INSERT", "coverage_requirements:SELECT", "due_diligence_inventory:SELECT", "standard_versions:SELECT", "support_tickets:INSERT"]);
  });

  it("only these tables can be written from the browser (INSERT, UPDATE or DELETE for the signed-in role); each is held to its owner by a policy", async () => {
    const g = await ok("SELECT table_name FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = 'authenticated' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE') GROUP BY 1 ORDER BY 1");
    expect(g.map((r) => r.table_name)).toEqual([
      "account_members", "audit_log", "buyer_accounts", "buyer_enrollment_payments", "contact_submissions", "enrollment_payments", "governance_rules", "notifications", "owner_notices",
      "pod_reservations", "properties", "property_documents", "property_media", "sellers", "signed_documents", "support_tickets", "wishlist",
    ]);
    // Every one of them has a row-level policy that names who may write: a write grant with no policy would be deny-all, and one with a loose policy is what this guards.
    for (const t of ["account_members", "buyer_accounts", "buyer_enrollment_payments", "enrollment_payments", "governance_rules", "notifications", "owner_notices", "pod_reservations", "properties", "property_documents", "property_media", "sellers", "signed_documents", "wishlist"]) {
      const n = await ok("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')", [t]);
      expect(n[0]!.n, t).toBeGreaterThan(0);
    }
  });

  it("the audit log cannot be read, changed or deleted from the browser", async () => {
    const g = await ok("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'audit_log' AND grantee IN ('anon', 'authenticated') ORDER BY 1");
    expect(g.map((r) => r.privilege_type)).toEqual(["INSERT"]);
  });

  it("writes the policy listing to docs/rls-audit.md and docs/rls-policies.json, and a changed policy fails until the listing is regenerated", async () => {
    const tables = await ok("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1");
    const pols = await ok("SELECT tablename, policyname, cmd, roles::text AS roles, regexp_replace(coalesce(qual, ''), '\\s+', ' ', 'g') AS using_, regexp_replace(coalesce(with_check, ''), '\\s+', ' ', 'g') AS check_ FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2");
    const grants = await ok("SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated') GROUP BY 1, 2 ORDER BY 1, 2");
    const snapshot = { tables: tables.map((t) => t.name), policies: pols, grants };
    const file = "docs/rls-policies.json";
    if (process.env.UPDATE_RLS_SNAPSHOT || !existsSync(file)) {
      mkdirSync("docs", { recursive: true });
      writeFileSync(file, JSON.stringify(snapshot, null, 1));
      const lines = ["# Row-level security audit", "", "Generated by `tests/rls-isolation.test.ts` from the repository's own SQL (`UPDATE_RLS_SNAPSHOT=1 npx vitest run tests/rls-isolation.test.ts`). Do not edit by hand.", "",
        `${snapshot.tables.length} tables, ${pols.length} policies. Every table has row-level security on. A table with no policy and no grant is reachable only by the server (the service role), which checks who is asking.`, ""];
      for (const t of snapshot.tables) {
        const mine = pols.filter((p) => p.tablename === t);
        const gr = grants.filter((g) => g.table_name === t).map((g) => `${g.grantee}: ${g.privs}`).join("; ");
        lines.push(`## ${t}`, "", `Browser grants: ${gr || "none (server only)"}`, "");
        if (mine.length === 0) lines.push("No policies: deny by default for anon and authenticated.", "");
        for (const p of mine) lines.push(`- **${p.policyname}** (${p.cmd}, ${p.roles.replace(/[{}]/g, "")}): USING ${p.using_ || "-"}${p.check_ ? `; CHECK ${p.check_}` : ""}`);
        if (mine.length) lines.push("");
      }
      writeFileSync("docs/rls-audit.md", lines.join("\n"));
    }
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(JSON.parse(JSON.stringify(snapshot)));
  });
});

// ---------------------------------------------------------------------------------------------------------
// 2. Who reads what
// ---------------------------------------------------------------------------------------------------------
/** [rows of property A visible, rows of property B visible] for one table. */
async function seen(uid: string | null, table: string, a: string, b: string, role: "authenticated" | "anon" = "authenticated") {
  return asUser(uid, async () => [await count(a), await count(b)], role).catch((e: Error) => `denied: ${e.message}`);
}
const T = {
  votes: ["SELECT 1 FROM public.votes WHERE property_id = '" + PA + "'", "SELECT 1 FROM public.votes WHERE property_id = '" + PB + "'"],
  ballots: ["SELECT 1 FROM public.vote_ballots b JOIN public.votes v ON v.id = b.vote_id WHERE v.property_id = '" + PA + "'", "SELECT 1 FROM public.vote_ballots b JOIN public.votes v ON v.id = b.vote_id WHERE v.property_id = '" + PB + "'"],
  entries: ["SELECT 1 FROM public.journal_entries WHERE property_id = '" + PA + "'", "SELECT 1 FROM public.journal_entries WHERE property_id = '" + PB + "'"],
  lines: ["SELECT 1 FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id WHERE e.property_id = '" + PA + "'", "SELECT 1 FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id WHERE e.property_id = '" + PB + "'"],
  inquiries: ["SELECT 1 FROM public.coowner_inquiries WHERE property_id = '" + PA + "'", "SELECT 1 FROM public.coowner_inquiries WHERE property_id = '" + PB + "'"],
  expenses: ["SELECT 1 FROM public.expenses WHERE property_id = '" + PA + "'", "SELECT 1 FROM public.expenses WHERE property_id = '" + PB + "'"],
  distributions: ["SELECT 1 FROM public.distribution_events WHERE property_id = '" + PA + "'", "SELECT 1 FROM public.distribution_events WHERE property_id = '" + PB + "'"],
  documents: ["SELECT 1 FROM public.property_documents WHERE property_id = '" + PA + "'", "SELECT 1 FROM public.property_documents WHERE property_id = '" + PB + "'"],
  vault: ["SELECT 1 FROM public.property_records_vault WHERE property_id = '" + PA + "'", "SELECT 1 FROM public.property_records_vault WHERE property_id = '" + PB + "'"],
  bank: ["SELECT 1 FROM public.bank_transactions WHERE property_id = '" + PA + "'", "SELECT 1 FROM public.bank_transactions WHERE property_id = '" + PB + "'"],
  captable: ["SELECT 1 FROM public.cap_table_entries WHERE property_id = '" + PA + "'", "SELECT 1 FROM public.cap_table_entries WHERE property_id = '" + PB + "'"],
  notices: ["SELECT 1 FROM public.owner_notices WHERE property_id = '" + PA + "'", "SELECT 1 FROM public.owner_notices WHERE property_id = '" + PB + "'"],
  reservations: ["SELECT 1 FROM public.pod_reservations WHERE property_id = '" + PA + "'", "SELECT 1 FROM public.pod_reservations WHERE property_id = '" + PB + "'"],
  properties: ["SELECT 1 FROM public.properties WHERE id = '" + PA + "'", "SELECT 1 FROM public.properties WHERE id = '" + PB + "'"],
} as const;
type Key = keyof typeof T;
const matrix = (uid: string | null, keys: Key[], role: "authenticated" | "anon" = "authenticated") => Promise.all(keys.map(async (k) => [k, await seen(uid, k, T[k][0], T[k][1], role)] as const)).then((r) => Object.fromEntries(r));

describe.skipIf(!PGLITE_AVAILABLE)("a user of property A never reads property B (and the reverse)", () => {
  const PROPERTY_SCOPED: Key[] = ["votes", "ballots", "entries", "lines", "inquiries", "expenses", "distributions", "notices"];

  it("an owner of A sees A's votes, ballots, ledger, inquiries, expenses, distributions and notices, and none of B's", async () => {
    const m = await matrix(BA, PROPERTY_SCOPED);
    for (const k of PROPERTY_SCOPED) expect(m[k], `owner A: ${k}`).toEqual([1, 0]);
  });
  it("an owner of B sees B's, and none of A's", async () => {
    const m = await matrix(BB, PROPERTY_SCOPED);
    for (const k of PROPERTY_SCOPED) expect(m[k], `owner B: ${k}`).toEqual([0, 1]);
  });
  it("an owner sees only their own cap table row, only their own reservation, and nothing of the other property", async () => {
    expect(await matrix(BA, ["captable", "reservations"])).toEqual({ captable: [1, 0], reservations: [1, 0] });
    expect(await matrix(BB, ["captable", "reservations"])).toEqual({ captable: [0, 1], reservations: [0, 1] });
  });
  it("the Manager's tables (the records vault, the bank feed) are the Manager's alone: an owner of A reads none of either, for A or for B", async () => {
    for (const who of [BA, BB, SA, SB, STR]) expect(await matrix(who, ["vault", "bank"]), who).toEqual({ vault: [0, 0], bank: [0, 0] });
    expect(await matrix(ADM, ["vault", "bank"])).toEqual({ vault: [1, 1], bank: [1, 1] });
  });
  it("a stranger with an account and no share reads none of it", async () => {
    const m = await matrix(STR, [...PROPERTY_SCOPED, "captable", "documents", "reservations"]);
    for (const k of [...PROPERTY_SCOPED, "captable", "documents", "reservations"] as Key[]) expect(m[k], `stranger: ${k}`).toEqual([0, 0]);
  });
  it("the seller of A, who holds no share, reads none of the owners' records of A either: the ledger, votes, inquiries, expenses, distributions and notices belong to the owners", async () => {
    const m = await matrix(SA, PROPERTY_SCOPED);
    for (const k of PROPERTY_SCOPED) expect(m[k], `seller A: ${k}`).toEqual([0, 0]);
  });
  it("a seller reads and manages their own property's documents, and never another's", async () => {
    expect(await matrix(SA, ["documents", "properties"])).toEqual({ documents: [1, 0], properties: [1, 0] });
    expect(await matrix(SB, ["documents", "properties"])).toEqual({ documents: [0, 1], properties: [0, 1] });
  });
  it("the Manager sees both properties", async () => {
    const m = await matrix(ADM, [...PROPERTY_SCOPED, "captable", "documents", "properties"]);
    for (const k of [...PROPERTY_SCOPED, "captable", "documents", "properties"] as Key[]) expect(m[k], `manager: ${k}`).toEqual([1, 1]);
  });
  it("an inquiry is read only by the Manager and the owner who asked, not by the other owners of the same property", async () => {
    await pg.query("INSERT INTO auth.users (id, email) VALUES ($1, 'co@test.invalid')", [U(7)]);
    await pg.query("INSERT INTO public.buyer_accounts (id, auth_user_id, email) VALUES ($1, $2, 'co@test.invalid')", [U(204), U(7)]);
    await pg.query("INSERT INTO public.cap_table_entries (property_id, share_number, holder_type, buyer_account_id, retention_lock_expires_at) VALUES ($1, 2, 'buyer_account', $2, now())", [PA, U(204)]);
    expect(await matrix(U(7), ["inquiries", "votes", "entries"])).toEqual({ inquiries: [0, 0], votes: [1, 0], entries: [1, 0] });
  });
  it("a visitor who is not signed in reads no property's records, only the listed property pages", async () => {
    for (const k of [...PROPERTY_SCOPED, "captable", "documents", "vault", "bank"] as Key[]) expect(String((await matrix(null, [k], "anon"))[k]), k).toMatch(/denied/);
    expect(await matrix(null, ["properties"], "anon")).toEqual({ properties: [0, 0] }); // A and B are not listed
    expect(await asUser(null, () => count(`SELECT 1 FROM public.properties WHERE id = '${PL}'`), "anon")).toBe(1);
  });
  it("a listed property's reservation count is public (the pod page), and only that", async () => {
    expect(await asUser(null, () => count(`SELECT 1 FROM public.pod_reservations WHERE property_id = '${PL}'`), "anon")).toBe(1);
    expect(await asUser(null, () => count(`SELECT 1 FROM public.pod_reservations WHERE property_id = '${PA}'`), "anon")).toBe(0);
  });
});

describe.skipIf(!PGLITE_AVAILABLE)("a person reads only their own personal rows", () => {
  const own = (uid: string, sql: string) => asUser(uid, () => count(sql));
  it("notifications: each person reads only their own, the Manager included", async () => {
    expect(await own(BA, "SELECT 1 FROM public.notifications")).toBe(1);
    expect(await own(BB, "SELECT 1 FROM public.notifications")).toBe(1);
    expect(await own(STR, "SELECT 1 FROM public.notifications")).toBe(0);
    expect(await own(ADM, "SELECT 1 FROM public.notifications")).toBe(0);
    expect((await asUser(BA, () => ok("SELECT message FROM public.notifications")))[0]!.message).toBe("for A");
  });
  it("signed documents: a buyer reads their account's; the Manager reads all", async () => {
    expect(await own(BA, "SELECT 1 FROM public.signed_documents")).toBe(1);
    expect(await own(BB, "SELECT 1 FROM public.signed_documents")).toBe(1);
    expect(await own(STR, "SELECT 1 FROM public.signed_documents")).toBe(0);
    expect(await own(ADM, "SELECT 1 FROM public.signed_documents")).toBe(2);
  });
  it("buyer accounts and their members: a buyer reads only their own account, and a seller reads only their own seller row", async () => {
    expect(await own(BA, "SELECT 1 FROM public.buyer_accounts")).toBe(1);
    expect(await own(BA, `SELECT 1 FROM public.buyer_accounts WHERE id = '${ACC_B}'`)).toBe(0);
    expect(await own(BA, "SELECT 1 FROM public.account_members")).toBe(1);
    expect(await own(BA, `SELECT 1 FROM public.account_members WHERE buyer_account_id = '${ACC_B}'`)).toBe(0);
    expect(await own(SA, "SELECT 1 FROM public.sellers")).toBe(1);
    expect(await own(SA, `SELECT 1 FROM public.sellers WHERE id = '${SB}'`)).toBe(0);
  });
  it("nobody in the browser reads the audit log, the tax forms, the encrypted values or the Manager's books by direct query", async () => {
    for (const t of ["audit_log", "member_w9_tin_secrets", "kyo_retention", "tc_notice_deliveries"]) {
      if ((await ok("SELECT to_regclass($1) AS r", [`public.${t}`]))[0]!.r === null) continue;
      expect(await asUser(BA, () => fails(`SELECT * FROM public.${t}`)), t).toMatch(/permission denied/);
      expect(await asUser(ADM, () => fails(`SELECT * FROM public.${t}`)), `admin ${t}`).toMatch(/permission denied/);
    }
  });
  it("the alerts and the chain checks are policy-gated: only the vault readers see a row, not an owner or a seller", async () => {
    await pg.query("INSERT INTO public.suspicious_activity_alerts (kind, detail, dedupe_key) VALUES ('chain_break', '{}', 'rls-test')");
    expect(await own(BA, "SELECT 1 FROM public.suspicious_activity_alerts")).toBe(0);
    expect(await own(SA, "SELECT 1 FROM public.suspicious_activity_alerts")).toBe(0);
    expect(await own(ADM, "SELECT 1 FROM public.suspicious_activity_alerts")).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 3. Who writes what
// ---------------------------------------------------------------------------------------------------------
describe.skipIf(!PGLITE_AVAILABLE)("nobody writes another property's or another person's rows", () => {
  const rowsAfter = async (sql: string) => (await ok(sql))[0]!.n as number;
  it("a seller cannot change, delete or take over another seller's property", async () => {
    await asUser(SA, async () => {
      expect((await pg.query("UPDATE public.properties SET city = 'Hacked' WHERE id = $1 RETURNING id", [PB])).rows).toHaveLength(0);
      expect((await pg.query("DELETE FROM public.properties WHERE id = $1 RETURNING id", [PB])).rows).toHaveLength(0);
      expect(await fails("INSERT INTO public.properties (seller_id, address, city, state, zip, status) VALUES ($1, 'x', 'x', 'WY', '1', 'pending')", [SB])).toMatch(/row-level security/);
      expect(await fails("UPDATE public.properties SET seller_id = $1 WHERE id = $2", [SB, PA])).toMatch(/row-level security/);
    });
    expect(await rowsAfter("SELECT count(*)::int AS n FROM public.properties WHERE id = '" + PB + "' AND city = 'Bend'")).toBe(1);
  });
  it("a seller cannot add or change documents on another seller's property", async () => {
    await asUser(SA, async () => {
      expect(await fails("INSERT INTO public.property_documents (property_id, document_name, document_type, file_url) VALUES ($1, 'Evil', 'deed', 'evil.pdf')", [PB])).toMatch(/row-level security/);
      expect((await pg.query("DELETE FROM public.property_documents WHERE property_id = $1 RETURNING id", [PB])).rows).toHaveLength(0);
    });
    expect(await rowsAfter("SELECT count(*)::int AS n FROM public.property_documents WHERE property_id = '" + PB + "'")).toBe(1);
  });
  it("a buyer cannot reserve for, change, or read another buyer's account", async () => {
    await asUser(BA, async () => {
      expect(await fails("INSERT INTO public.pod_reservations (property_id, buyer_account_id, shares_reserved, status) VALUES ($1, $2, 1, 'reserved')", [PL, ACC_B])).toMatch(/row-level security/);
      expect((await pg.query("UPDATE public.pod_reservations SET shares_reserved = 8 WHERE buyer_account_id = $1 RETURNING id", [ACC_B])).rows).toHaveLength(0);
      expect((await pg.query("UPDATE public.buyer_accounts SET golden_ticket_issued = true WHERE id = $1 RETURNING id", [ACC_B])).rows).toHaveLength(0);
      expect((await pg.query("UPDATE public.account_members SET full_name = 'Hacked' WHERE buyer_account_id = $1 RETURNING id", [ACC_B])).rows).toHaveLength(0);
      expect(await fails("INSERT INTO public.signed_documents (buyer_account_id, document_type, document_version, signed_name) VALUES ($1, 'PRA', 'v1', 'Forged')", [ACC_B])).toMatch(/row-level security|must name/);
    });
    expect(await rowsAfter("SELECT count(*)::int AS n FROM public.buyer_accounts WHERE id = '" + ACC_B + "' AND golden_ticket_issued = false")).toBe(1);
    expect(await rowsAfter("SELECT count(*)::int AS n FROM public.account_members WHERE full_name = 'Hacked'")).toBe(0);
  });
  it("nobody writes a notification to someone else, or reads or edits anyone else's", async () => {
    await asUser(BA, async () => {
      expect(await fails("INSERT INTO public.notifications (seller_id, message, type) VALUES ($1, 'phish', 'x')", [BB])).toMatch(/row-level security/);
      expect((await pg.query("UPDATE public.notifications SET message = 'edited' WHERE seller_id = $1 RETURNING id", [BB])).rows).toHaveLength(0);
      expect((await pg.query("DELETE FROM public.notifications WHERE seller_id = $1 RETURNING id", [BB])).rows).toHaveLength(0);
    });
    expect(await rowsAfter("SELECT count(*)::int AS n FROM public.notifications WHERE seller_id = '" + BB + "'")).toBe(1);
  });
  it("owners and sellers cannot write the ledger, votes, inquiries, expenses, distributions, the cap table, the vault or the log of anyone: those are written by the server", async () => {
    for (const who of [BA, SA, STR]) {
      for (const sql of [
        "INSERT INTO public.votes (property_id, title, vote_type, opens_at, closes_at) VALUES ('" + PA + "', 'x', 'ordinary', now(), now())",
        "UPDATE public.votes SET status = 'closed'",
        "DELETE FROM public.journal_entries",
        "UPDATE public.journal_lines SET debit_cents = 0",
        "INSERT INTO public.cap_table_entries (property_id, share_number, holder_type, retention_lock_expires_at) VALUES ('" + PA + "', 8, 'buyer_account', now())",
        "UPDATE public.cap_table_entries SET share_number = 7",
        "DELETE FROM public.property_records_vault",
        "UPDATE public.expenses SET total_amount = 1",
        "UPDATE public.distribution_events SET total_amount = 1",
        "UPDATE public.audit_log SET action_type = 'x'",
        "DELETE FROM public.audit_log",
      ]) expect(await asUser(who, () => fails(sql)), `${who.slice(-2)}: ${sql.slice(0, 40)}`).toMatch(/permission denied/);
    }
    expect(await rowsAfter("SELECT count(*)::int AS n FROM public.cap_table_entries")).toBeGreaterThanOrEqual(2);
  });
  it("a visitor who is not signed in can only send the two contact forms", async () => {
    await asUser(null, async () => {
      expect(await fails("INSERT INTO public.contact_submissions (name, email, subject, message) VALUES ('x', 'x@x.invalid', 'hi', 'hello')")).toBe("");
      expect(await fails("INSERT INTO public.notifications (seller_id, message) VALUES ('" + BA + "', 'x')")).toMatch(/permission denied/);
      expect(await fails("INSERT INTO public.properties (seller_id, address, city, state, zip) VALUES ('" + SA + "', 'x', 'x', 'WY', '1')")).toMatch(/permission denied/);
      expect(await fails("UPDATE public.properties SET city = 'x'")).toMatch(/permission denied/);
    }, "anon");
  });
});
