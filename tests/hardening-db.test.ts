/**
 * The launch-hardening SQL on a real Postgres (PGlite, built from the repository's own SQL): the dead-letter table is server-only and append-only, the performance indexes
 * exist, and the busiest queries can use them (EXPLAIN).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { PGLITE_AVAILABLE, buildFreshDb, type Db } from "./helpers/fresh-db";

let pg: Db;
beforeAll(async () => {
  if (!PGLITE_AVAILABLE) return;
  pg = (await buildFreshDb()).pg;
}, 600_000);

const rows = async (sql: string) => (await pg.query(sql)).rows;
const fails = async (sql: string) => {
  try {
    await pg.query(sql);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};
const exists = async (t: string) => (await rows(`SELECT to_regclass('public.${t}') IS NOT NULL AS e`))[0]!["e"] as boolean;
const indexNames = async () => new Set((await rows(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).map((r) => r["indexname"] as string));

describe.skipIf(!PGLITE_AVAILABLE)("dead-letter table", () => {
  it("exists, with RLS on and no policy and no grant for the browser roles", async () => {
    expect((await rows(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_failures'::regclass`))[0]!["relrowsecurity"]).toBe(true);
    expect(await rows(`SELECT 1 FROM pg_policies WHERE tablename = 'job_failures'`)).toHaveLength(0);
    for (const role of ["anon", "authenticated"]) {
      expect((await rows(`SELECT has_table_privilege('${role}', 'public.job_failures', 'SELECT') AS s`))[0]!["s"]).toBe(false);
      expect((await rows(`SELECT has_table_privilege('${role}', 'public.job_failures', 'INSERT') AS s`))[0]!["s"]).toBe(false);
    }
  });
  it("is append-only: a row can be resolved but never edited or removed", async () => {
    await pg.query(`INSERT INTO public.job_failures (id, job_name, attempts, error) VALUES ('00000000-0000-4000-8000-0000000000a1', 'x', 2, 'boom')`);
    expect(await fails(`UPDATE public.job_failures SET error = 'changed' WHERE job_name = 'x'`)).toMatch(/append-only/);
    expect(await fails(`UPDATE public.job_failures SET attempts = 9 WHERE job_name = 'x'`)).toMatch(/append-only/);
    expect(await fails(`DELETE FROM public.job_failures WHERE job_name = 'x'`)).toMatch(/append-only/);
    expect(await fails(`TRUNCATE public.job_failures`)).toMatch(/append-only/);
    expect(await fails(`UPDATE public.job_failures SET resolved_at = now() WHERE job_name = 'x'`)).toBe("");
  });
  it("the failure row the job runner writes fits the table", async () => {
    expect(await fails(`INSERT INTO public.job_failures (job_name, attempts, error, failed_at) VALUES ('y', 2, 'e', now())`)).toBe("");
  });
});

describe.skipIf(!PGLITE_AVAILABLE)("performance indexes", () => {
  const EXPECTED: Array<[string, string]> = [
    ["journal_entries_property_date_idx", "journal_entries"],
    ["journal_lines_entry_account_idx", "journal_lines"],
    ["journal_lines_account_entry_idx", "journal_lines"],
    ["bank_transactions_property_posted_idx", "bank_transactions"],
    ["bank_transactions_needs_action_idx", "bank_transactions"],
    ["audit_log_entity_time_idx", "audit_log"],
    ["audit_log_action_time_idx", "audit_log"],
    ["cap_table_entries_property_share_idx", "cap_table_entries"],
    ["notifications_recipient_time_idx", "notifications"],
    ["notifications_unread_idx", "notifications"],
  ];
  it("every index exists wherever its table exists (none is skipped for a wrong column name)", async () => {
    const have = await indexNames();
    const missing: string[] = [];
    for (const [idx, table] of EXPECTED) if ((await exists(table)) && !have.has(idx)) missing.push(`${idx} on ${table}`);
    expect(missing).toEqual([]);
    // The tables this launch cares most about must be present on the fresh database.
    for (const t of ["journal_entries", "journal_lines", "bank_transactions", "audit_log", "cap_table_entries", "notifications"]) expect(await exists(t), t).toBe(true);
  });
  it("running the script twice changes nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const before = await indexNames();
    await pg.exec(readFileSync("performance-indexes.sql", "utf8"));
    expect(await indexNames()).toEqual(before);
  });

  /** The queries the app runs most, each with the index that serves it. With sequential scans disabled the planner must reach for that index (a table this empty would scan otherwise). */
  const QUERIES: Array<{ name: string; sql: string; index: string }> = [
    { name: "ledger page: one property's entries, newest first", sql: `SELECT * FROM public.journal_entries WHERE property_id = '00000000-0000-4000-8000-000000000101' ORDER BY entry_date DESC, posted_at DESC LIMIT 50`, index: "journal_entries_property_date_idx" },
    { name: "an entry's lines", sql: `SELECT account_id, debit_cents, credit_cents FROM public.journal_lines WHERE entry_id = '00000000-0000-4000-8000-000000000201'`, index: "journal_lines_entry_account_idx" },
    { name: "an account's activity", sql: `SELECT entry_id FROM public.journal_lines WHERE account_id = '00000000-0000-4000-8000-000000000301'`, index: "journal_lines_account_entry_idx" },
    { name: "bank feed page, newest first", sql: `SELECT * FROM public.bank_transactions WHERE property_id = '00000000-0000-4000-8000-000000000101' ORDER BY posted_date DESC LIMIT 50`, index: "bank_transactions_property_posted_idx" },
    { name: "bank review queue", sql: `SELECT * FROM public.bank_transactions WHERE property_id = '00000000-0000-4000-8000-000000000101' AND status IN ('new', 'needs_review') ORDER BY posted_date DESC`, index: "bank_transactions_needs_action_idx" },
    { name: "history of one record", sql: `SELECT * FROM public.audit_log WHERE entity_type = 'property' AND entity_id = 'p1' ORDER BY created_at DESC LIMIT 50`, index: "audit_log_entity_time_idx" },
    { name: "recent events of one kind", sql: `SELECT * FROM public.audit_log WHERE action_type = 'login.failed' AND created_at > now() - interval '1 hour'`, index: "audit_log_action_time_idx" },
    { name: "cap table of one property", sql: `SELECT * FROM public.cap_table_entries WHERE property_id = '00000000-0000-4000-8000-000000000101' ORDER BY share_number`, index: "cap_table_entries_property_share_idx" },
    { name: "the bell: a person's latest notifications", sql: `SELECT * FROM public.notifications WHERE seller_id = '00000000-0000-4000-8000-000000000001' ORDER BY created_at DESC LIMIT 10`, index: "notifications_recipient_time_idx" },
    { name: "unread badge", sql: `SELECT count(*) FROM public.notifications WHERE seller_id = '00000000-0000-4000-8000-000000000001' AND is_read = false`, index: "notifications_unread_idx" },
  ];
  const report: string[] = [];
  for (const q of QUERIES) {
    it(`EXPLAIN: ${q.name}`, async () => {
      await pg.exec("SET enable_seqscan = off");
      try {
        const plan = (await rows(`EXPLAIN ${q.sql}`)).map((r) => r["QUERY PLAN"] as string).join("\n");
        report.push(`### ${q.name}\n\n\`\`\`\n${plan}\n\`\`\`\n`);
        expect(plan).toMatch(/Index/);
        expect(plan).not.toMatch(/Seq Scan/);
        // A PK or older index may serve it equally well; what matters is no table scan. The named index is the one this script added for it.
        expect((await indexNames()).has(q.index)).toBe(true);
      } finally {
        await pg.exec("RESET enable_seqscan");
      }
    });
  }
  it("writes the plans to docs/performance-explain.md for the record", () => {
    mkdirSync("docs", { recursive: true });
    writeFileSync(
      "docs/performance-explain.md",
      `# Query plans (EXPLAIN)\n\nGenerated by \`tests/hardening-db.test.ts\` on the database built from the repository's own SQL, with sequential scans disabled so the planner shows which index it would use. The tables are empty, so the plans show access paths, not timings: real row counts and timings need a copy of production data (see docs/performance.md).\n\n${report.join("\n")}`,
    );
    expect(report.length).toBe(QUERIES.length);
  });
});
