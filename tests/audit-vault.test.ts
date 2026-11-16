/**
 * Audit Vault: completeness (every critical action leaves a row), redaction, the nightly chain check, Suspicious Activity Alerts, and logged read-only access.
 * The database side (append-only, the hash chain, tamper detection, the row-level safety net) is proven on a real Postgres in audit-vault-sql.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { seedClosing } from "./closing-fixture";
import { AUDIT_INVENTORY, PROTECTED_TABLES } from "@/lib/audit-inventory";
import { REDACTED, accountedFor, canonicalJson, findSensitive, isSensitiveKey, redactPayload } from "@/lib/audit-vault";
import { checkDecryptBurst, complianceRecipients, notifyPendingAlerts, readVault, reconcileProtectedChanges, runAuditVaultSweep, verifyChain, acknowledgeAlert, requireVaultOfficer } from "@/lib/audit-vault.server";
import { flushPiiAlerts, runWithPiiRule } from "@/lib/pii-access.server";
import { decryptPii, encryptPii } from "@/lib/pii-crypto.server";
import { decryptTinForTaxExport } from "@/lib/w9.server";
import { enrichAuditRow, routeOf, withAuditContext } from "@/lib/audit-context.server";
import { getAuditVault, acknowledgeSecurityAlert, verifyAuditChainNow } from "@/lib/audit-vault.functions";
import { acknowledgePraReview } from "@/lib/document-access.functions";
import { signMemberDocumentFn } from "@/lib/member-steps.functions";
import { publishTcVersion } from "@/lib/tc.server";
import { TERMS_TEXT } from "@/lib/terms";
import { exportReport } from "@/lib/analytics.server";
import { buildPRA, hashDocument, PRA_VERSION } from "@/lib/legal-documents";
import { generateAndTransmit, latestSourceOfTruth } from "@/lib/settlement.server";
import { simulateMilestone } from "@/lib/title-escrow.server";
import * as serverRuntime from "@tanstack/react-start/server";

const db = () => harness.db;
const as = (u: string) => (harness.userId = u);
const src = (f: string) => readFileSync(f, "utf8");
const OFFICER = "u-officer";
const AUDITOR = "u-auditor";
const NOW = new Date("2026-11-16T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const emails: Array<{ to: string[]; subject: string; html: string }> = [];

beforeEach(() => {
  seedPod(db());
  db().seed("user_roles", [{ user_id: OFFICER, role: "compliance_officer" }, { user_id: AUDITOR, role: "auditor" }]);
  db().rpcResults.has_role = (a: { _user_id: string; _role: string }) => db().table("user_roles").some((r) => r.user_id === a._user_id && r.role === a._role) || (a._role === "admin" && a._user_id === USERS.admin);
  (db() as unknown as { auth: unknown }).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: `${id}@officer.test` } } }) } };
  for (const m of db().table("account_members")) Object.assign(m, { status: "active" });
  emails.length = 0;
  process.env.RESEND_API_KEY = "test-key";
  process.env.W9_TIN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
    emails.push(JSON.parse(init.body));
    return { ok: true } as Response;
  });
});
afterEach(() => vi.unstubAllGlobals());

const actions = () => db().table("audit_log").map((a) => String(a.action_type));
const alerts = () => db().table("suspicious_activity_alerts");
const notices = () => db().table("notifications").filter((n) => n.type === "suspicious_activity");

// ---------------------------------------------------------------------------------------------------------
// 3. The completeness inventory
// ---------------------------------------------------------------------------------------------------------
describe("completeness inventory: every state-changing event, and whether it writes to the Audit Vault", () => {
  const sqlTables = () => {
    const sql = src("audit-vault.sql");
    const block = sql.slice(sql.indexOf("FOREACH spec IN ARRAY ARRAY["), sql.indexOf("] LOOP", sql.indexOf("FOREACH spec IN ARRAY ARRAY[")));
    return new Map([...block.matchAll(/'([a-z_]+)\|(true|false)\|([a-z_]+)\|[^']*'/g)].map((m) => [m[1]!, m[2] === "true"]));
  };
  const textOf = (file: string) => (existsSync(file) ? src(file) : "");
  /** The action is written by the file: its full name, or (for a name built from a prefix) its last part as a quoted word. */
  const writes = (file: string, action: string) => {
    const t = textOf(file);
    const suffix = action.split(".").slice(1).join(".");
    return [`"${action}"`, `'${action}'`, `\`${action}\``, `'${suffix}'`, `"${suffix}"`].some((s) => t.includes(s)) || t.includes(action);
  };

  it("every event is covered by an application audit row, by the database safety net, or both", () => {
    for (const e of AUDIT_INVENTORY) expect((e.actions?.length ?? 0) + (e.tables?.length ?? 0), `${e.area}: ${e.event}`).toBeGreaterThan(0);
  });

  it("every action the inventory lists is still written by the file it names: remove an audit call and this fails", () => {
    const missing: string[] = [];
    for (const e of AUDIT_INVENTORY) {
      for (const a of e.actions ?? []) if (!(e.files ?? []).some((f) => writes(f, a))) missing.push(`${e.area} / ${e.event}: ${a} is not written by ${(e.files ?? []).join(", ")}`);
      for (const d of e.dynamic ?? []) if (!(e.files ?? []).some((f) => textOf(f).includes(d))) missing.push(`${e.area} / ${e.event}: the pattern ${d} is not in ${(e.files ?? []).join(", ")}`);
      for (const f of e.files ?? []) expect(existsSync(f), `${f} exists`).toBe(true);
    }
    expect(missing).toEqual([]);
  });

  it("every table the inventory lists has the database safety net, and the protected ones are marked protected", () => {
    const tables = sqlTables();
    const lacking: string[] = [];
    for (const e of AUDIT_INVENTORY) for (const t of e.tables ?? []) if (!tables.has(t)) lacking.push(`${e.event}: ${t}`);
    expect(lacking).toEqual([]);
    for (const t of Object.keys(PROTECTED_TABLES)) expect(tables.get(t), `${t} is protected in audit-vault.sql`).toBe(true);
    expect([...tables].filter(([, p]) => p).map(([t]) => t).sort()).toEqual(Object.keys(PROTECTED_TABLES).sort());
  });

  it("the inventory covers every kind of event the Audit Vault is meant to hold", () => {
    const text = AUDIT_INVENTORY.map((e) => `${e.area} ${e.event}`.toLowerCase()).join("\n");
    for (const need of ["registers", "onboarding", "declaration", "result", "enrollment fee", "reserved", "tether", "hard-locked", "authorization", "earnest", "closing funds", "entity", "signed", "saga", "disbursement", "cap table", "vote", "resale", "expense", "capital call", "distribution", "journal", "statement", "cpa designated", "export", "tin is decrypted", "admin role", "settings", "audit vault is read"]) {
      expect(text, need).toContain(need);
    }
  });

  it("the gaps found by the audit are closed, and say how", () => {
    const fixed = AUDIT_INVENTORY.filter((e) => e.status === "fixed_app" || e.status === "fixed_db").map((e) => e.event);
    for (const gap of ["Agent registers", "Broker of Record registers", "Buyer enrollment fee paid", "Pod hard-locked", "Admin role granted or removed", "Platform settings changed"]) expect(fixed, gap).toContain(gap);
    expect(src("src/lib/reservations.functions.ts")).toContain("pod.hard_locked");
    expect(src("src/utils/payments.functions.ts")).toContain("payment.enrollment_fee_confirmed");
  });
});

// ---------------------------------------------------------------------------------------------------------
// ...and a test that fails when a registered critical action does not produce an audit row
// ---------------------------------------------------------------------------------------------------------
describe("a registered critical action that produces no audit row fails the test", () => {
  const before = () => db().table("audit_log").length;
  /** Runs the action and requires every listed action to have been written by it. */
  async function expectAudited(name: string, expected: string[], run: () => Promise<unknown>) {
    const mark = before();
    await run();
    const written = db().table("audit_log").slice(mark).map((a) => String(a.action_type));
    const missing = expected.filter((a) => !written.includes(a));
    if (missing.length) throw new Error(`${name}: no audit row for ${missing.join(", ")}`);
    return written;
  }
  const praText = (name: string) => buildPRA(name, { intent: "personal_use", primary_target_market: "Lusk, WY" });

  it("the check itself catches an action that writes nothing", async () => {
    await expect(expectAudited("a silent action", ["x.silent"], async () => undefined)).rejects.toThrow(/no audit row for x\.silent/);
    await expect(expectAudited("an action that audits the wrong thing", ["x.wanted"], async () => db().table("audit_log").push({ action_type: "x.other" }))).rejects.toThrow(/x\.wanted/);
  });

  it("onboarding signatures and acknowledgments", async () => {
    as(USERS.b1);
    const text = praText("Alice One");
    await expectAudited("PRA review", ["buyer.pra_review_acknowledged"], () => acknowledgePraReview({ data: { actingMemberId: IDS.b1m1, documentVersion: PRA_VERSION, documentHash: hashDocument(text), reachedEnd: true } }));
    await expectAudited("PRA signature", ["buyer.pra_signed"], () => signMemberDocumentFn({ data: { actingMemberId: IDS.b1m1, documentType: "PRA", documentVersion: PRA_VERSION, documentHash: hashDocument(text), typedName: "Alice One" } }));
    await expectAudited("Hold Harmless signature", ["buyer.hold_harmless_signed"], () => signMemberDocumentFn({ data: { actingMemberId: IDS.b1m1, documentType: "HOLD_HARMLESS", documentVersion: "hh-v2", documentHash: "h", typedName: "Alice One" } }));
  });

  it("configuration, exports and reads of the vault", async () => {
    await expectAudited("Terms published", ["tc.version_published"], () => publishTcVersion(db() as never, { adminId: USERS.admin, input: { version: "1.1", effectiveDate: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10), body: `${TERMS_TEXT}\nAn added line.`, isMaterial: false, summary: "" } }));
    await expectAudited("Report export", ["analytics.report_exported"], () => exportReport(db() as never, { userId: USERS.admin, kind: "revenue", filters: { from: null, to: null, state: null }, now: NOW }));
    await expectAudited("Vault read", ["audit.vault_accessed"], () => readVault(db() as never, { userId: AUDITOR }));
  });

  it("a TIN decryption writes its audit row first, and the row never holds the TIN", async () => {
    const tin = "587-65-4321";
    db().seed("member_w9_tin_secrets", [{ w9_id: "w9-1", ...encryptPii(tin, "member_w9:w9-1") }]);
    const written = await expectAudited("TIN decrypt", ["admin.w9_tin_decrypted"], async () => {
      expect(await decryptTinForTaxExport(db() as never, { actorId: USERS.admin, w9Id: "w9-1", reason: "Year-end packet" })).toBe(tin);
    });
    expect(written).toEqual(["admin.w9_tin_decrypted"]);
    expect(JSON.stringify(db().table("audit_log"))).not.toContain(tin);
    expect(JSON.stringify(db().table("audit_log"))).not.toContain("587654321");
  });

  it("the closing: source of truth, saga steps, disbursement check, entity and cap table events", async () => {
    // A clean database: the closing fixture builds its own pod.
    db().tables.clear();
    db().rpcResults.has_role = (a: { _user_id: string; _role: string }) => a._role === "admin" && a._user_id === USERS.admin;
    await seedClosing();
    const r = await generateAndTransmit(db() as never, USERS.admin, IDS.property);
    expect(r.status).toBe("transmitted");
    const payees = (await latestSourceOfTruth(db() as never, IDS.property))!.structured.payees as Array<{ brokerId: string; amountCents: number }>;
    const written = await expectAudited("closing", ["closing_saga.saga_started", "closing_saga.step_succeeded", "closing_saga.saga_completed", "disbursement_check.passed"], async () => {
      const out = await simulateMilestone(db() as never, USERS.admin, IDS.property, "funded_and_recorded", { commissionDisbursements: payees.map((p) => ({ payeeReference: p.brokerId, amount: p.amountCents / 100 })) });
      expect((out as { closingSaga?: string }).closingSaga).toBe("completed");
    });
    expect(written.filter((a) => a === "closing_saga.step_succeeded").length).toBeGreaterThanOrEqual(7);
    expect(actions()).toEqual(expect.arrayContaining(["settlement.source_of_truth_generated", "settlement.cda_transmitted"]));
  });
});

// ---------------------------------------------------------------------------------------------------------
// 1. Nothing sensitive in the log
// ---------------------------------------------------------------------------------------------------------
describe("never a TIN, a full bank number or a declaration answer in plain text", () => {
  it("redaction, as the database does it", () => {
    const p = redactPayload({ tin: "123-45-6789", tin_last4: "6789", tin_kind: "ssn", account_number: "000123456789", declaration_answers: { q1: "no" }, answers: ["a"], nested: { password: "x", ok: 1, list: [{ secret: "s" }, "987-65-4321", "fine"] }, token_id: "t" });
    expect(p).toEqual({ tin: REDACTED, tin_last4: "6789", tin_kind: "ssn", account_number: REDACTED, declaration_answers: REDACTED, answers: REDACTED, nested: { password: REDACTED, ok: 1, list: [{ secret: REDACTED }, REDACTED, "fine"] }, token_id: "t" });
    expect(findSensitive(p)).toEqual([]);
    expect(findSensitive({ a: { tin: "123456789" }, b: "111-22-3333" })).toEqual([".a.tin", ".b"]);
  });
  it("the application's rule and the database's rule name the same keys", () => {
    const sql = src("audit-vault.sql");
    const words = (re: RegExp, text: string) => (re.exec(text)?.[1] ?? "").split("|").sort();
    const sqlSensitive = words(/\(\^\|_\)\(([^)]+)\)\(\$\|_\)/, sql);
    const tsSource = src("src/lib/audit-vault.ts");
    const tsSensitive = words(/\(\^\|_\)\(([^)]+)\)\(\$\|_\)/, tsSource);
    expect(tsSensitive).toEqual(sqlSensitive);
    for (const k of ["tin", "ssn", "ein", "account_number", "routing_number", "declaration_answers", "answers", "password", "secret", "ciphertext"]) expect(isSensitiveKey(k), k).toBe(true);
    for (const k of ["tin_last4", "tin_kind", "w9_id", "amount_cents", "reason", "property_id", "token_id"]) expect(isSensitiveKey(k), k).toBe(false);
  });
  it("the canonical form is the same however the JSON was written", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
  it("what is written about a request, and where it came from, is filled in without overwriting what the writer said", () => {
    const ctx = { ip: "203.0.113.4", userAgent: "UA", route: "/admin/tax" };
    expect(enrichAuditRow({ action_type: "x", metadata: { a: 1 } }, ctx).metadata).toEqual({ a: 1, route: "/admin/tax", ip_address: "203.0.113.4", user_agent: "UA" });
    expect(enrichAuditRow({ action_type: "x", metadata: { ip_address: "198.51.100.1", route: "/own" } }, ctx).metadata).toMatchObject({ ip_address: "198.51.100.1", route: "/own", user_agent: "UA" });
    expect(enrichAuditRow({ action_type: "x" }, ctx).metadata).toMatchObject({ route: "/admin/tax" });
    expect(routeOf("https://x.test/_serverFn/abc?x=1", "https://x.test/admin/tax?y=2")).toBe("/admin/tax");
    expect(routeOf("https://x.test/api/public/sweep", null)).toBe("/api/public/sweep");
  });
  it("every insert into the audit log through the server's client is enriched; other tables are untouched", () => {
    const inserted: unknown[] = [];
    const builder = { insert: (rows: unknown) => (inserted.push(rows), "ok"), select: () => "sel" };
    expect(withAuditContext("audit_log", builder).insert({ action_type: "x", metadata: {} } as never)).toBe("ok");
    expect(withAuditContext("audit_log", builder).select()).toBe("sel");
    expect(withAuditContext("notifications", builder)).toBe(builder);
    expect(src("src/integrations/supabase/admin.server.ts")).toContain("withAuditContext(table");
    expect(src("src/lib/audit.ts")).toContain("window.location.pathname");
  });
});

// ---------------------------------------------------------------------------------------------------------
// 2. The nightly chain check
// ---------------------------------------------------------------------------------------------------------
describe("the nightly verification of the hash chain", () => {
  const cp = (o: Record<string, unknown>) => ({ ok: true, rows_checked: 120, last_seq: 120, last_hash: "h", first_bad_seq: null, reason: null, verified_at: NOW.toISOString(), ...o });
  it("an intact chain is recorded, with no alert", async () => {
    db().rpcResults.record_audit_checkpoint = () => cp({});
    const c = await verifyChain(db() as never, { source: "nightly" });
    expect(c).toMatchObject({ installed: true, ok: true, rowsChecked: 120, firstBadSeq: null });
    expect(alerts()).toHaveLength(0);
    expect(actions()).toContain("audit.chain_verified");
  });
  it("a broken chain raises a critical alert to the Compliance Officer, once however often the check runs", async () => {
    db().rpcResults.record_audit_checkpoint = () => cp({ ok: false, first_bad_seq: 57, reason: "This row was changed after it was written." });
    await verifyChain(db() as never, { source: "nightly" });
    await verifyChain(db() as never, { source: "nightly" });
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({ kind: "chain_break", severity: "critical" });
    expect(alerts()[0]!.detail).toMatchObject({ first_bad_seq: 57, why: "This row was changed after it was written." });
    expect(notices().map((n) => n.seller_id)).toEqual([OFFICER]);
    expect(emails.map((e) => e.to[0])).toContain(`${OFFICER}@officer.test`);
  });
  it("before the hardening is installed the check says so instead of failing", async () => {
    db().rpcResults.record_audit_checkpoint = undefined;
    (db() as unknown as { rpc: unknown }).rpc = async () => ({ data: null, error: { message: "Could not find the function public.record_audit_checkpoint" } });
    expect(await verifyChain(db() as never, { source: "manual" })).toMatchObject({ installed: false, ok: false });
  });
  it("the nightly job verifies, reconciles and notifies; the schedule and the route exist", async () => {
    db().rpcResults.record_audit_checkpoint = () => cp({});
    const r = await runAuditVaultSweep(db() as never, { now: NOW });
    expect(r.chain.ok).toBe(true);
    expect(src("cron-sweeps.sql")).toContain("audit-vault-sweep");
    expect(src("src/routes/api.public.audit-vault-sweep.ts")).toContain("runAuditVaultSweep");
    expect(src("src/routes/api.public.audit-vault-sweep.ts")).toContain("x-sweep-secret");
  });
});

// ---------------------------------------------------------------------------------------------------------
// 4. Suspicious Activity Alerts
// ---------------------------------------------------------------------------------------------------------
describe("Suspicious Activity Alerts: out-of-band changes to splits, shares, ownership and the cap table", () => {
  /** What the database writes about a change to a protected table that was made through the application. */
  const change = (id: string, table: string, o: Record<string, unknown> = {}, at = minutesAgo(60), who: { direct?: boolean } = {}) =>
    db().seed("audit_log", [{ id, action_type: "db.row_changed", actor_type: "service_role", entity_type: table, entity_id: `${table}-1`, created_at: at, source: "trigger", metadata: { table, operation: "UPDATE", primary_key: `${table}-1`, property_id: IDS.property, changed_columns: ["share_number"], protected: true, direct_database_change: who.direct ?? false, db_role: "authenticator", request_role: "service_role", ...o } }]);
  const app = (action: string, at = minutesAgo(58), entity = IDS.property) => db().seed("audit_log", [{ action_type: action, actor_type: "admin", entity_type: "property", entity_id: entity, created_at: at, metadata: { property_id: entity } }]);

  it("a change to a commission split with no application record raises an alert, and the Compliance Officer is told in the app and by email", async () => {
    change("c1", "commission_ledger", { changed_columns: ["gross_cents", "role"], operation: "UPDATE" });
    const r = await reconcileProtectedChanges(db() as never, { now: NOW });
    expect(r).toEqual({ checked: 1, raised: 1 });
    const a = alerts()[0]!;
    expect(a).toMatchObject({ kind: "unreconciled_change", severity: "high", subject_table: "commission_ledger", audit_row_id: "c1", dedupe_key: "unrec:c1" });
    expect(a.detail).toMatchObject({ changed_columns: ["gross_cents", "role"], why: "No application record accounts for this change" });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ seller_id: OFFICER });
    expect(notices()[0]!.message).toMatch(/Protected data|commission_ledger/);
    const mail = emails.find((e) => e.to[0] === `${OFFICER}@officer.test`)!;
    expect(mail.subject).toContain("Suspicious Activity Alert");
    expect(mail.html).toContain("commission_ledger");
    expect(mail.html).toContain("Open the Audit Vault");
    expect(a.notified_at).toBeTruthy();
    expect(actions()).toContain("security.suspicious_activity");
  });

  it("the same change is alerted once, however often the check runs", async () => {
    change("c1", "cap_table_entries");
    await reconcileProtectedChanges(db() as never, { now: NOW });
    await reconcileProtectedChanges(db() as never, { now: NOW });
    await runAuditVaultSweep(db() as never, { now: NOW }).catch(() => undefined);
    expect(alerts()).toHaveLength(1);
    expect(notices()).toHaveLength(1);
  });

  it("a change the standardized code path made is accounted for by its own audit row: no alert", async () => {
    change("c1", "cap_table_entries");
    app("entity.cap_table_updated");
    change("c2", "commission_ledger", { property_id: IDS.property });
    app("closing_saga.step_succeeded", minutesAgo(61));
    change("c3", "settlement_documents");
    app("settlement.source_of_truth_generated", minutesAgo(55));
    expect(await reconcileProtectedChanges(db() as never, { now: NOW })).toEqual({ checked: 3, raised: 0 });
    expect(alerts()).toHaveLength(0);
  });

  it("an application row that is the wrong kind, far away in time, or about another property does not account for it", async () => {
    const c = (id: string) => db().table("audit_log").find((r) => r.id === id)!;
    change("c1", "commission_ledger");
    app("buyer.share_reserved"); // wrong kind of action for a commission change
    app("closing_saga.step_succeeded", minutesAgo(300)); // hours away
    app("closing_saga.step_succeeded", minutesAgo(58), "some-other-property");
    expect(accountedFor(c("c1") as never, db().table("audit_log") as never)).toBe(false);
    expect(await reconcileProtectedChanges(db() as never, { now: NOW })).toEqual({ checked: 1, raised: 1 });
  });

  it("a change that has only just happened is given time for the application's own row to arrive", async () => {
    change("c1", "cap_table_entries", {}, minutesAgo(3));
    expect(await reconcileProtectedChanges(db() as never, { now: NOW })).toEqual({ checked: 0, raised: 0 });
    expect(alerts()).toHaveLength(0);
  });

  it("every protected table is watched: the cap table, commission, referral shares, ownership allocation and the Source of Truth", async () => {
    for (const t of Object.keys(PROTECTED_TABLES)) change(`c-${t}`, t);
    const r = await reconcileProtectedChanges(db() as never, { now: NOW });
    expect(r.raised).toBe(Object.keys(PROTECTED_TABLES).length);
    expect(alerts().map((a) => a.subject_table).sort()).toEqual(Object.keys(PROTECTED_TABLES).sort());
  });

  it("a change made directly in the database is alerted by the database itself; the job tells the Compliance Officer about it", async () => {
    // What the trigger writes for a direct change (proven on a real Postgres in audit-vault-sql.test.ts): an alert with no notification yet.
    db().seed("suspicious_activity_alerts", [{ id: "a-direct", kind: "out_of_band_change", severity: "critical", subject_table: "cap_table_entries", subject_pk: "ct-9", detail: { operation: "UPDATE", changed_columns: ["share_number"], db_role: "postgres", why: "Changed directly in the database, not through the application" }, dedupe_key: "oob:x", notified_at: null }]);
    expect(await notifyPendingAlerts(db() as never)).toEqual({ notified: 1 });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.message).toMatch(/directly in the database/);
    expect(emails.some((e) => e.subject.includes("Protected data changed directly in the database"))).toBe(true);
    expect(alerts()[0]!.notified_at).toBeTruthy();
    expect(await notifyPendingAlerts(db() as never)).toEqual({ notified: 0 });
    expect(notices()).toHaveLength(1);
  });

  it("with no Compliance Officer named, every Manager is told: an alert never goes to nobody", async () => {
    db().table("user_roles").length = 0;
    db().seed("user_roles", [{ user_id: USERS.admin, role: "admin" }]);
    expect(await complianceRecipients(db() as never)).toEqual([USERS.admin]);
    change("c1", "cap_table_entries");
    await reconcileProtectedChanges(db() as never, { now: NOW });
    expect(notices().map((n) => n.seller_id)).toEqual([USERS.admin]);
  });
});

describe("Suspicious Activity Alerts: a TIN decrypted outside the business rules", () => {
  const aad = "member_w9:w9-7";
  const sealed = () => encryptPii("587-65-4321", aad);

  it("decrypting a TIN with no declared rule raises an alert and the Compliance Officer is told", async () => {
    expect(decryptPii(sealed(), aad)).toBe("587-65-4321");
    await flushPiiAlerts();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({ kind: "tin_decrypt_outside_rules", severity: "critical", subject_table: "member_w9" });
    expect(alerts()[0]!.detail).toMatchObject({ why: expect.stringMatching(/without an audited reason/) });
    expect(JSON.stringify(alerts())).not.toContain("587-65-4321");
    expect(notices()).toHaveLength(1);
    expect(emails.some((e) => e.subject.includes("TIN was decrypted outside the business rules"))).toBe(true);
  });
  it("inside the declared rule (a person and a reason), and through the audited paths, there is no alert", async () => {
    runWithPiiRule({ actorId: USERS.admin, actorType: "admin", reason: "Year-end packet" }, () => decryptPii(sealed(), aad));
    db().seed("member_w9_tin_secrets", [{ w9_id: "w9-8", ...encryptPii("123-45-6789", "member_w9:w9-8") }]);
    await decryptTinForTaxExport(db() as never, { actorId: USERS.admin, w9Id: "w9-8", reason: "K-1 preparation" });
    await flushPiiAlerts();
    expect(alerts()).toHaveLength(0);
  });
  it("a rule with no reason is not a rule", async () => {
    runWithPiiRule({ actorId: USERS.admin, actorType: "admin", reason: "  " }, () => decryptPii(sealed(), aad));
    await flushPiiAlerts();
    expect(alerts()).toHaveLength(1);
  });
  it("only TINs are watched: the bank-feed reference is decrypted by its own path", async () => {
    const v = encryptPii("plaid-ref", "llc_plaid_consent:abc");
    expect(decryptPii(v, "llc_plaid_consent:abc")).toBe("plaid-ref");
    await flushPiiAlerts();
    expect(alerts()).toHaveLength(0);
  });
  it("every TIN decryption in the code sits inside a declared rule", () => {
    const w9 = src("src/lib/w9.server.ts");
    expect(w9.match(/decryptPii\(/g)!.length).toBe(w9.match(/runWithPiiRule\(/g)!.length + 1 /* the import line */ - 1);
    expect(w9).toContain("watchDecryptBurst");
  });
  it("an unusual number of decryptions by one person in an hour is an alert, once; the limit itself is not", async () => {
    const rows = (n: number, at: string) => Array.from({ length: n }, (_, i) => ({ id: `d${i}-${at}`, actor_id: USERS.admin, action_type: "admin.w9_tin_decrypted", created_at: at }));
    db().seed("audit_log", rows(50, minutesAgo(10)));
    expect(await checkDecryptBurst(db() as never, { actorId: USERS.admin, now: NOW })).toEqual({ alerted: false });
    db().seed("audit_log", rows(1, minutesAgo(5)));
    expect(await checkDecryptBurst(db() as never, { actorId: USERS.admin, now: NOW })).toEqual({ alerted: true });
    expect(await checkDecryptBurst(db() as never, { actorId: USERS.admin, now: NOW })).toEqual({ alerted: false });
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({ kind: "tin_decrypt_burst", severity: "critical" });
  });
  it("decryptions older than the hour do not count", async () => {
    db().seed("audit_log", Array.from({ length: 80 }, (_, i) => ({ id: `o${i}`, actor_id: USERS.admin, action_type: "cpa.w9_tin_viewed", created_at: minutesAgo(180) })));
    expect(await checkDecryptBurst(db() as never, { actorId: USERS.admin, now: NOW })).toEqual({ alerted: false });
  });
});

// ---------------------------------------------------------------------------------------------------------
// 5. Access: read-only, and logged
// ---------------------------------------------------------------------------------------------------------
describe("access to the Audit Vault is read-only and is itself logged", () => {
  it("the Manager, the Compliance Officer and an auditor can read; anyone else gets a 403", async () => {
    const status = vi.mocked(serverRuntime.setResponseStatus);
    for (const who of [USERS.admin, OFFICER, AUDITOR]) {
      as(who);
      const r = await getAuditVault({ data: {} });
      expect(r.rows.length).toBeGreaterThan(0);
    }
    for (const who of [USERS.b1, USERS.ra, "u-nobody"]) {
      as(who);
      status.mockClear();
      await expect(getAuditVault({ data: {} })).rejects.toThrow("Not authorized");
      expect(status).toHaveBeenCalledWith(403);
    }
  });
  it("every read is a row: who, in what role, with which filters, from where, and the read is refused if it cannot be logged", async () => {
    as(AUDITOR);
    await getAuditVault({ data: { filters: { action: "x.y", actor: null, entity: "e1", from: null, to: null } as never, limit: 50 } });
    const row = db().table("audit_log").find((a) => a.action_type === "audit.vault_accessed")!;
    expect(row).toMatchObject({ actor_id: AUDITOR, actor_type: "auditor", entity_type: "audit_log" });
    expect(row.metadata).toMatchObject({ via: "app", limit: 50, filters: { action: "x.y", entity: "e1" }, route: "/admin/audit-vault" });
    const guarded = { ...db(), from: (t: string) => (t === "audit_log" ? { insert: async () => ({ error: { message: "down" } }), select: () => { throw new Error("must not read"); } } : db().from(t)), rpc: db().rpc.bind(db()) };
    await expect(readVault(guarded as never, { userId: AUDITOR })).rejects.toThrow(/could not be logged/);
  });
  it("an auditor reads only: no acknowledging, no verifying; the Compliance Officer and the Manager act", async () => {
    db().seed("suspicious_activity_alerts", [{ id: "a1", kind: "out_of_band_change", severity: "critical", detail: {}, dedupe_key: "k1" }]);
    as(AUDITOR);
    await expect(acknowledgeSecurityAlert({ data: { alertId: "a1", note: "I looked at it" } })).rejects.toThrow("Not authorized");
    await expect(verifyAuditChainNow()).rejects.toThrow("Not authorized");
    await expect(requireVaultOfficer(db() as never, AUDITOR)).rejects.toThrow("Not authorized");
    as(OFFICER);
    await expect(acknowledgeSecurityAlert({ data: { alertId: "a1", note: "no" } })).rejects.toThrow(/note of at least five/);
    await acknowledgeSecurityAlert({ data: { alertId: "a1", note: "Checked with the title company: a legitimate correction." } });
    expect(alerts()[0]).toMatchObject({ acknowledged_by: OFFICER, acknowledgement_note: "Checked with the title company: a legitimate correction." });
    expect(actions()).toContain("security.alert_acknowledged");
    expect((await acknowledgeAlert(db() as never, { userId: USERS.admin, alertId: "a1", note: "again please" })).already).toBe(true);
  });
  it("nothing in the Audit Vault's code edits or deletes a log row", () => {
    for (const f of ["src/lib/audit-vault.server.ts", "src/lib/audit-vault.functions.ts", "src/lib/audit-context.server.ts", "src/components/AuditVaultViewer.tsx"]) {
      const s = src(f);
      expect(s, f).not.toMatch(/from\("audit_log"\)\s*\.(update|delete|upsert)/);
    }
    expect(src("src/routes/admin.audit-log.tsx")).not.toContain('from("audit_log")');
    expect(src("src/routes/admin.audit-log.tsx")).toContain("getAuditVault");
  });
  it("the screen is in the Manager's menu and open to the Compliance Officer and auditors at /audit-vault", () => {
    expect(src("src/routes/audit-vault.tsx")).toContain('createFileRoute("/audit-vault")');
    expect(src("src/routes/admin.tsx")).toContain('"/audit-vault"');
    expect(src("src/components/AuditVaultViewer.tsx")).toContain("403");
  });
});
