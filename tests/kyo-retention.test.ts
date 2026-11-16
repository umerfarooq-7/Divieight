/**
 * Know Your Owner retention: the two classes and their dates, the archival workflow, the nightly job that never deletes, the Retention review queue, the founder's
 * approval, the legal hold, and members' deletion requests. The database side (the ledger, retention_erase) is proven on a real Postgres in kyo-retention-sql.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { USERS } from "./fixtures";
import { addYears, classifyMember, classifySeller, deletionDecision, retainUntilArchived, retainUntilForLlcs, statusFor } from "@/lib/kyo-retention";
import { decideReview, listRetentionQueue, myRetention, recordLlcDissolution, requestKyoDeletion, retentionOverview, runRetentionSweep, setLegalHold } from "@/lib/kyo-retention.server";
import { getRetentionOverview, decideRetentionReview, requestMyKyoDeletion } from "@/lib/kyo-retention.functions";
import { LAUNCH_ITEMS } from "@/lib/launch-readiness";
import * as serverRuntime from "@tanstack/react-start/server";
import { vi } from "vitest";

const db = () => harness.db;
const as = (u: string) => (harness.userId = u);
const src = (f: string) => readFileSync(f, "utf8");
const NOW = new Date("2026-11-16T12:00:00Z");
const FOUNDER = "u-founder";
const OFFICER = "u-officer";
const ADMIN = USERS.admin;
const ALL = { loginExists: async () => true };

/** Everything the retention rules look at, in one small platform. Names and emails are PII and must never come out of the admin views or the log. */
function seed() {
  db().seed("user_roles", [{ user_id: FOUNDER, role: "founder" }, { user_id: OFFICER, role: "compliance_officer" }, { user_id: ADMIN, role: "admin" }]);
  db().rpcResults.has_role = (a: { _user_id: string; _role: string }) => db().table("user_roles").some((r) => r.user_id === a._user_id && r.role === a._role);
  (db() as unknown as { auth: unknown }).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: `${id}@compliance.test` } } }) } };
  const acct = (id: string, o: Record<string, unknown> = {}) => ({ id, auth_user_id: `u-${id}`, email: `${id}@pii.example`, onboarding_status: "vetting_pending", created_at: "2025-01-01T00:00:00Z", ...o });
  db().seed("buyer_accounts", [
    acct("a1"), // owner of a living LLC
    acct("a2", { onboarding_status: "archived", archived_at: "2018-01-01T00:00:00Z", archive_reason: "abandoned" }), // archived long ago: past its 7 years
    acct("a3"), // has a removed member
    acct("a4"), // not eligible
    acct("a5"), // login deleted
    acct("a6"), // in use
    acct("a7"), // held shares in an LLC that dissolved in 2018
  ]);
  const member = (id: string, account: string, o: Record<string, unknown> = {}) => ({ id, buyer_account_id: account, full_name: `Person ${id}`, email: `${id}@pii.example`, status: "active", role: "primary", id_document_url: `u-${id}/license.jpg`, created_at: "2025-01-01T00:00:00Z", ...o });
  db().seed("account_members", [member("m1", "a1"), member("m2", "a2"), member("m3a", "a3"), member("m3b", "a3", { status: "removed", removed_at: "2026-01-01T00:00:00Z", role: "member" }), member("m4", "a4"), member("m5", "a5"), member("m6", "a6"), member("m7", "a7")]);
  db().seed("properties", [
    { id: "p1", seller_id: "s1", status: "listed", address: "1 Main St", city: "Lusk", state: "WY" },
    { id: "p2", seller_id: "s2", status: "rejected", address: "2 Elm", city: "Bend", state: "OR", updated_at: "2020-05-01T00:00:00Z" },
    { id: "p3", seller_id: "s3", status: "listed", address: "3 Oak", city: "Reno", state: "NV" },
  ]);
  db().seed("sellers", [{ id: "s1", onboarding_status: "active", email: "s1@pii.example" }, { id: "s2", onboarding_status: "active", email: "s2@pii.example" }, { id: "s6", onboarding_status: "active", email: "s6@pii.example" }]);
  db().seed("entity_genesis", [{ property_id: "p1", llc_name: "Lusk LLC", llc_dissolved_at: null }, { property_id: "p3", llc_name: "Reno LLC", llc_dissolved_at: "2018-06-01" }]);
  db().seed("cap_table_entries", [{ property_id: "p1", share_number: 1, buyer_account_id: "a1" }]);
  db().seed("cap_table_history", [{ property_id: "p3", share_number: 1, from_buyer_account_id: "a7", to_buyer_account_id: null }]);
  db().seed("eligibility_declarations", [{ id: "d4", account_member_id: "m4", status: "complete" }]);
  db().seed("eligibility_results", [{ account_member_id: "m4", declaration_id: "d4", determined_at: "2026-03-01T00:00:00Z", result: "not_eligible" }]);
  db().seed("member_liveness_checks", [{ account_member_id: "m2", id_document_ref: "u-m2/license.jpg", selfie_url: "u-m2/selfie.jpg" }]);
  db().seed("member_w9", [{ account_member_id: "m2" }]);
}

const logins = (gone: string[]) => ({ loginExists: async (id: string) => !gone.includes(id) });
const ledger = (kind: string, id: string) => db().table("kyo_retention").find((r) => r.subject_kind === kind && r.subject_id === id);
const reviews = () => db().table("retention_reviews");
const notes = () => db().table("notifications").filter((n) => n.type === "retention_review");
const PII_TABLES = ["account_members", "member_w9", "member_liveness_checks", "eligibility_declarations", "sellers", "buyer_accounts"];
const snapshot = () => JSON.stringify(PII_TABLES.map((t) => db().table(t).map((r) => ({ ...r, archived_at: undefined, onboarding_status: undefined, archive_reason: undefined }))));

beforeEach(() => {
  seed();
  process.env.RESEND_API_KEY = "";
});

// ---------------------------------------------------------------------------------------------------------
// 1. The two classes and their dates
// ---------------------------------------------------------------------------------------------------------
describe("retain_until for both classes", () => {
  it("dates add whole years, and 29 February lands on 28 February in a common year", () => {
    expect(addYears("2026-11-16", 7)).toBe("2033-11-16");
    expect(addYears("2024-02-29", 7)).toBe("2031-02-28");
    expect(addYears("2024-02-29", 4)).toBe("2028-02-29");
    expect(retainUntilArchived("2018-01-01T10:00:00Z")).toBe("2025-01-01");
  });

  it("active-property: the life of the LLC, then 7 years after dissolution; nothing guessed while it is alive", () => {
    expect(retainUntilForLlcs([{ dissolvedAt: null }])).toBeNull();
    expect(retainUntilForLlcs([{ dissolvedAt: "2030-03-31" }])).toBe("2037-03-31");
    expect(retainUntilForLlcs([{ dissolvedAt: "2030-03-31" }, { dissolvedAt: "2032-01-15" }])).toBe("2039-01-15");
    expect(retainUntilForLlcs([{ dissolvedAt: "2030-03-31" }, { dissolvedAt: null }])).toBeNull();
    expect(retainUntilForLlcs([])).toBeNull();
    const live = classifyMember({ removed: false, removedAt: null, accountLlcs: [{ propertyId: "p", dissolvedAt: null }], signedLlcs: [], accountEnd: null }, "2026-11-16T00:00:00Z");
    expect(live).toMatchObject({ retentionClass: "active_property", archivedAt: null, retainUntil: null });
    const gone = classifyMember({ removed: false, removedAt: null, accountLlcs: [{ propertyId: "p", dissolvedAt: "2030-03-31" }], signedLlcs: [], accountEnd: null }, "2026-11-16T00:00:00Z");
    expect(gone).toMatchObject({ retentionClass: "active_property", retainUntil: "2037-03-31" });
  });

  it("archived: 7 years from the archival date, for every way an account can end", () => {
    for (const reason of ["not_eligible", "withdrawn", "rejected", "abandoned", "login_deleted"] as const) {
      const c = classifyMember({ removed: false, removedAt: null, accountLlcs: [], signedLlcs: [], accountEnd: { reason, at: "2026-03-01T08:00:00Z" } }, "2026-11-16T00:00:00Z");
      expect(c, reason).toMatchObject({ retentionClass: "archived", archiveReason: reason, archivedAt: "2026-03-01T08:00:00Z", retainUntil: "2033-03-01" });
    }
    const removed = classifyMember({ removed: true, removedAt: "2026-01-01T00:00:00Z", accountLlcs: [], signedLlcs: [], accountEnd: null }, "2026-11-16T00:00:00Z");
    expect(removed).toMatchObject({ retentionClass: "archived", archiveReason: "member_removed", retainUntil: "2033-01-01" });
    // An end with no date of its own is dated the day it was noticed, and then stays that date.
    expect(classifyMember({ removed: false, removedAt: null, accountLlcs: [], signedLlcs: [], accountEnd: { reason: "login_deleted", at: null } }, "2026-11-16T00:00:00Z")).toMatchObject({ archivedAt: "2026-11-16T00:00:00Z", retainUntil: "2033-11-16" });
  });

  it("a removed member who signed an LLC's documents is kept as long as the LLC requires, if that is longer", () => {
    const base = { removed: true, removedAt: "2026-01-01T00:00:00Z", accountLlcs: [], accountEnd: null };
    expect(classifyMember({ ...base, signedLlcs: [{ propertyId: "p", dissolvedAt: null }] }, "2026-11-16T00:00:00Z")).toMatchObject({ archiveReason: "member_removed", retainUntil: null });
    expect(classifyMember({ ...base, signedLlcs: [{ propertyId: "p", dissolvedAt: "2030-01-01" }] }, "2026-11-16T00:00:00Z").retainUntil).toBe("2037-01-01");
    expect(classifyMember({ ...base, signedLlcs: [{ propertyId: "p", dissolvedAt: "2020-01-01" }] }, "2026-11-16T00:00:00Z").retainUntil).toBe("2033-01-01");
  });

  it("someone tied to an LLC is active-property whatever else happened: an owner whose login was deleted is still an owner", () => {
    const c = classifyMember({ removed: false, removedAt: null, accountLlcs: [{ propertyId: "p", dissolvedAt: null }], signedLlcs: [], accountEnd: { reason: "login_deleted", at: null } }, "2026-11-16T00:00:00Z");
    expect(c.retentionClass).toBe("active_property");
  });

  it("a seller who sold all eight shares stays under the active-property rules until the LLC dissolves", () => {
    expect(classifySeller({ llcs: [{ propertyId: "p", dissolvedAt: null }], ended: null }, "2026-11-16T00:00:00Z")).toMatchObject({ retentionClass: "active_property", retainUntil: null });
    expect(classifySeller({ llcs: [{ propertyId: "p", dissolvedAt: "2034-06-30" }], ended: null }, "2026-11-16T00:00:00Z").retainUntil).toBe("2041-06-30");
    expect(classifySeller({ llcs: [], ended: { reason: "rejected", at: "2026-05-01T00:00:00Z" } }, "2026-11-16T00:00:00Z")).toMatchObject({ retentionClass: "archived", archiveReason: "rejected", retainUntil: "2033-05-01" });
    expect(classifySeller({ llcs: [], ended: null }, "2026-11-16T00:00:00Z").retentionClass).toBe("in_use");
  });

  it("the status follows the date", () => {
    expect(statusFor({ retentionClass: "archived", retainUntil: "2025-01-01" }, "2026-11-16")).toBe("past_retention");
    expect(statusFor({ retentionClass: "archived", retainUntil: "2026-11-16" }, "2026-11-16")).toBe("retained");
    expect(statusFor({ retentionClass: "active_property", retainUntil: null }, "2026-11-16")).toBe("retained");
    expect(statusFor({ retentionClass: "in_use", retainUntil: null }, "2026-11-16")).toBe("in_use");
    expect(statusFor({ retentionClass: "archived", retainUntil: "2020-01-01" }, "2026-11-16", true)).toBe("erased");
  });
});

// ---------------------------------------------------------------------------------------------------------
// 2 and 3. The archival workflow and the nightly job
// ---------------------------------------------------------------------------------------------------------
describe("the nightly job", () => {
  it("classifies every record and sets retain_until: both classes, every way an account ends", async () => {
    const r = await runRetentionSweep(db() as never, { now: NOW, ...logins(["u-a5"]) });
    expect(r.records).toBe(11); // 8 members and 3 sellers
    // active-property
    expect(ledger("account_member", "m1")).toMatchObject({ retention_class: "active_property", retain_until: null, status: "retained", property_ids: ["p1"] });
    expect(ledger("account_member", "m7")).toMatchObject({ retention_class: "active_property", retain_until: "2025-06-01", status: "past_retention" });
    expect(ledger("seller", "s1")).toMatchObject({ retention_class: "active_property", retain_until: null });
    // archived: 7 years from archival
    expect(ledger("account_member", "m2")).toMatchObject({ retention_class: "archived", archive_reason: "abandoned", retain_until: "2025-01-01", status: "past_retention" });
    expect(ledger("account_member", "m3b")).toMatchObject({ retention_class: "archived", archive_reason: "member_removed", retain_until: "2033-01-01", status: "retained" });
    expect(ledger("account_member", "m4")).toMatchObject({ retention_class: "archived", archive_reason: "not_eligible", retain_until: "2033-03-01" });
    expect(ledger("account_member", "m5")).toMatchObject({ retention_class: "archived", archive_reason: "login_deleted", retain_until: "2033-11-16" });
    expect(ledger("seller", "s2")).toMatchObject({ retention_class: "archived", archive_reason: "rejected", retain_until: "2027-05-01", status: "retained" });
    // in use: no clock
    expect(ledger("account_member", "m6")).toMatchObject({ retention_class: "in_use", retain_until: null, status: "in_use", archived_at: null });
    expect(ledger("account_member", "m3a")).toMatchObject({ retention_class: "in_use" });
  });

  it("accounts that end move to 'archived' with archived_at set, and it is logged without personal data", async () => {
    await runRetentionSweep(db() as never, { now: NOW, ...logins(["u-a5"]) });
    const a = (id: string) => db().table("buyer_accounts").find((x) => x.id === id)!;
    expect(a("a4")).toMatchObject({ onboarding_status: "archived", archive_reason: "not_eligible" });
    expect(String(a("a4").archived_at).slice(0, 10)).toBe("2026-03-01");
    expect(a("a5")).toMatchObject({ onboarding_status: "archived", archive_reason: "login_deleted" });
    expect(String(a("a5").archived_at).slice(0, 10)).toBe("2026-11-16");
    // The owner, the in-use account and the account with a removed member are untouched.
    for (const id of ["a1", "a3", "a6", "a7"]) expect(a(id).onboarding_status, id).not.toBe("archived");
    const logs = db().table("audit_log").filter((l) => l.action_type === "retention.account_archived");
    expect(logs.map((l) => l.entity_id).sort()).toEqual(["a4", "a5"]);
    expect(JSON.stringify(logs)).not.toMatch(/pii\.example|Person m/);
  });

  it("a date given on the first night does not move on later nights", async () => {
    await runRetentionSweep(db() as never, { now: NOW, ...logins(["u-a5"]) });
    const first = String(ledger("account_member", "m5")!.archived_at);
    await runRetentionSweep(db() as never, { now: new Date("2026-11-20T03:00:00Z"), ...logins(["u-a5"]) });
    expect(String(ledger("account_member", "m5")!.archived_at)).toBe(first);
    expect(ledger("account_member", "m5")!.retain_until).toBe("2033-11-16");
  });

  it("NEVER deletes: personal data, files and the ledger are untouched; no erasure is called", async () => {
    const erasures: unknown[] = [];
    const removed: unknown[] = [];
    db().rpcResults.retention_erase = (a: unknown) => (erasures.push(a), { ok: true });
    (db() as unknown as { storage: unknown }).storage = { from: () => ({ remove: async (p: string[]) => (removed.push(p), { error: null }) }) };
    const before = snapshot();
    const r = await runRetentionSweep(db() as never, { now: NOW, ...logins(["u-a5"]) });
    await runRetentionSweep(db() as never, { now: NOW, ...logins(["u-a5"]) });
    expect(r.erased).toBe(0);
    expect(r.pastRetention).toBe(2);
    expect(snapshot()).toBe(before);
    expect(erasures).toEqual([]);
    expect(removed).toEqual([]);
    expect(db().table("kyo_retention").some((x) => x.status === "erased")).toBe(false);
    expect(db().table("audit_log").some((l) => /erased/.test(String(l.action_type)))).toBe(false);
    // And nothing in the job's own code can: no delete, no erasure, no storage.
    const code = src("src/lib/kyo-retention.server.ts");
    const job = code.slice(code.indexOf("export async function runRetentionSweep"), code.indexOf("async function notifyCompliance"));
    expect(job).not.toMatch(/\.delete\(|retention_erase|storage|\.remove\(|removeFiles/);
  });

  it("lists the records past retention in a Retention review queue for compliance, once each", async () => {
    const r = await runRetentionSweep(db() as never, { now: NOW, ...logins([]) });
    expect(r.reviewsOpened).toBe(2);
    expect(reviews().map((x) => x.retention_id).sort()).toEqual([ledger("account_member", "m2")!.id, ledger("account_member", "m7")!.id].sort());
    expect(reviews().every((x) => x.kind === "past_retention" && x.status === "open")).toBe(true);
    expect((await runRetentionSweep(db() as never, { now: NOW, ...logins([]) })).reviewsOpened).toBe(0);
    expect(reviews()).toHaveLength(2);
    // Compliance is told, in counts only.
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({ seller_id: OFFICER });
    expect(notes()[0]!.message).toMatch(/2 Know Your Owner records are past the retention period/);
    expect(notes()[0]!.message).toMatch(/Nothing has been deleted/);
    expect(notes()[0]!.message).not.toMatch(/Person|pii\.example/);
    expect(db().table("audit_log").filter((l) => l.action_type === "retention.review_opened")).toHaveLength(2);
  });

  it("records one row per PII sub-vault item, with the same class and dates", async () => {
    await runRetentionSweep(db() as never, { now: NOW, ...logins([]) });
    const rec = ledger("account_member", "m2")!;
    const items = db().table("kyo_retention_items").filter((i) => i.retention_id === rec.id);
    const kinds = items.map((i) => i.item_kind).sort();
    expect(kinds).toEqual(["correction_requests", "eligibility_declaration", "identity_document", "kyo_record", "liveness_selfie", "sanctions_screening", "w9", "w9_encrypted_value"].sort());
    expect(items.every((i) => i.retention_class === "archived" && i.retain_until === "2025-01-01" && String(i.archived_at).startsWith("2018-01-01"))).toBe(true);
    expect(items.find((i) => i.item_kind === "liveness_selfie")!.item_count).toBe(1);
    expect(items.find((i) => i.item_kind === "identity_document")!.item_count).toBe(1);
    expect(items.find((i) => i.item_kind === "sanctions_screening")!.item_count).toBe(0);
    // A record still in use has no items yet.
    expect(db().table("kyo_retention_items").some((i) => i.retention_id === ledger("account_member", "m6")!.id)).toBe(false);
  });

  it("recording an LLC's dissolution starts the 7 years for everyone tied to it", async () => {
    await runRetentionSweep(db() as never, { now: NOW, ...logins([]) });
    as(ADMIN);
    await expect(recordLlcDissolution(db() as never, { userId: ADMIN, propertyId: "p1", date: "2026-10-01", reason: "The LLC dissolved after the sale of the house." })).rejects.toThrow(/Only the founder/);
    await recordLlcDissolution(db() as never, { userId: FOUNDER, propertyId: "p1", date: "2026-10-01", reason: "The LLC dissolved after the sale of the house." });
    expect(db().table("entity_genesis").find((g) => g.property_id === "p1")!.llc_dissolved_at).toBe("2026-10-01");
    await runRetentionSweep(db() as never, { now: NOW, ...logins([]) });
    expect(ledger("account_member", "m1")).toMatchObject({ retain_until: "2033-10-01", status: "retained" });
    expect(ledger("seller", "s1")).toMatchObject({ retain_until: "2033-10-01" });
    expect(db().table("audit_log").some((l) => l.action_type === "retention.llc_dissolution_recorded")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 3. A founder approves; a legal hold blocks
// ---------------------------------------------------------------------------------------------------------
describe("an erasure needs a founder's approval, with a reason, and a legal hold blocks it", () => {
  const erasures: Array<Record<string, unknown>> = [];
  const removed: Array<{ bucket: string; paths: string[] }> = [];
  beforeEach(() => {
    erasures.length = 0;
    removed.length = 0;
    db().rpcResults.retention_erase = (a: Record<string, unknown>) => (erasures.push(a), { ok: true, counts: { account_members: 1, w9_encrypted_values: 1 } });
    (db() as unknown as { storage: unknown }).storage = { from: (bucket: string) => ({ remove: async (paths: string[]) => (removed.push({ bucket, paths }), { error: null }) }) };
  });
  const open = async (memberId = "m2") => {
    await runRetentionSweep(db() as never, { now: NOW, ...logins([]) });
    return reviews().find((r) => r.retention_id === ledger("account_member", memberId)!.id)!;
  };

  it("only the founder; a reason is required", async () => {
    const rv = await open();
    for (const who of [ADMIN, OFFICER, USERS.b1]) await expect(decideReview(db() as never, { userId: who, reviewId: rv.id, decision: "approve_erasure", reason: "Seven years have passed." })).rejects.toThrow(/Only the founder/);
    await expect(decideReview(db() as never, { userId: FOUNDER, reviewId: rv.id, decision: "approve_erasure", reason: "short" })).rejects.toThrow(/at least ten characters/);
    expect(erasures).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("approving removes the stored files, then anonymizes through the database function, passing who and why", async () => {
    const rv = await open();
    const r = await decideReview(db() as never, { userId: FOUNDER, reviewId: rv.id, decision: "approve_erasure", reason: "Seven years have passed; compliance reviewed it.", now: NOW });
    expect(r).toMatchObject({ decision: "erased", counts: { account_members: 1 } });
    expect(removed).toEqual(expect.arrayContaining([{ bucket: "identity-documents", paths: expect.arrayContaining(["u-m2/license.jpg"]) }, { bucket: "liveness-selfies", paths: ["u-m2/selfie.jpg"] }]));
    expect(erasures).toEqual([{ _retention: rv.retention_id, _founder: FOUNDER, _review: rv.id, _reason: "Seven years have passed; compliance reviewed it." }]);
  });

  it("a stored file that cannot be removed stops everything: nothing is erased", async () => {
    const rv = await open();
    (db() as unknown as { storage: unknown }).storage = { from: () => ({ remove: async () => ({ error: { message: "storage is down" } }) }) };
    await expect(decideReview(db() as never, { userId: FOUNDER, reviewId: rv.id, decision: "approve_erasure", reason: "Seven years have passed.", now: NOW })).rejects.toThrow(/nothing was erased/);
    expect(erasures).toEqual([]);
  });

  it("a legal hold blocks the erasure: refused, logged, nothing removed", async () => {
    const rv = await open();
    await setLegalHold(db() as never, { userId: OFFICER, retentionId: rv.retention_id, hold: true, reason: "Matter 2026-114" });
    await expect(decideReview(db() as never, { userId: FOUNDER, reviewId: rv.id, decision: "approve_erasure", reason: "Seven years have passed.", now: NOW })).rejects.toThrow(/legal hold/);
    expect(erasures).toEqual([]);
    expect(removed).toEqual([]);
    expect(db().table("audit_log").some((l) => l.action_type === "retention.erasure_blocked_legal_hold")).toBe(true);
    expect(reviews().find((r) => r.id === rv.id)!.status).toBe("open");
    // Lifting the hold lets it through.
    await setLegalHold(db() as never, { userId: FOUNDER, retentionId: rv.retention_id, hold: false, reason: "Matter closed" });
    expect((await decideReview(db() as never, { userId: FOUNDER, reviewId: rv.id, decision: "approve_erasure", reason: "Seven years have passed.", now: NOW })).decision).toBe("erased");
  });

  it("a record still inside its retention period cannot be erased", async () => {
    await runRetentionSweep(db() as never, { now: NOW, ...logins([]) });
    const id = ledger("account_member", "m3b")!.id; // retained until 2033
    db().seed("retention_reviews", [{ id: "rv-forced", retention_id: id, kind: "past_retention", status: "open" }]);
    await expect(decideReview(db() as never, { userId: FOUNDER, reviewId: "rv-forced", decision: "approve_erasure", reason: "Trying to erase early.", now: NOW })).rejects.toThrow(/cannot be erased yet/);
    expect(erasures).toEqual([]);
    expect(db().table("audit_log").some((l) => l.action_type === "retention.erasure_blocked_inside_retention")).toBe(true);
  });

  it("holds: placed by the Manager, the Compliance Officer or the founder; lifted only by the last two; never on an erased record; a held record gets no review", async () => {
    await runRetentionSweep(db() as never, { now: NOW, ...logins([]) });
    const id = ledger("account_member", "m7")!.id;
    await expect(setLegalHold(db() as never, { userId: USERS.b1, retentionId: id, hold: true, reason: "Matter 1" })).rejects.toThrow("Not authorized");
    await expect(setLegalHold(db() as never, { userId: ADMIN, retentionId: id, hold: true, reason: "x" })).rejects.toThrow(/reason/);
    expect(await setLegalHold(db() as never, { userId: ADMIN, retentionId: id, hold: true, reason: "Matter 2026-007" })).toEqual({ changed: true });
    expect(await setLegalHold(db() as never, { userId: ADMIN, retentionId: id, hold: true, reason: "Matter 2026-007" })).toEqual({ changed: false });
    await expect(setLegalHold(db() as never, { userId: ADMIN, retentionId: id, hold: false, reason: "Matter closed" })).rejects.toThrow(/Only the founder or the Compliance Officer/);
    expect(ledger("account_member", "m7")).toMatchObject({ legal_hold: true, legal_hold_reason: "Matter 2026-007", legal_hold_set_by: ADMIN });
    expect(db().table("audit_log").filter((l) => l.action_type === "retention.legal_hold_placed")).toHaveLength(1);
    // The held record is not offered for review (the other past-retention one still is).
    db().table("retention_reviews").length = 0;
    await runRetentionSweep(db() as never, { now: NOW, ...logins([]) });
    expect(reviews().map((r) => r.retention_id)).toEqual([ledger("account_member", "m2")!.id]);
    await setLegalHold(db() as never, { userId: OFFICER, retentionId: id, hold: false, reason: "Matter closed" });
    expect(ledger("account_member", "m7")).toMatchObject({ legal_hold: false, legal_hold_reason: null });
    expect(db().table("audit_log").some((l) => l.action_type === "retention.legal_hold_released")).toBe(true);
  });

  it("keeping a record sends it back for review in a year, not tomorrow", async () => {
    const rv = await open();
    await decideReview(db() as never, { userId: FOUNDER, reviewId: rv.id, decision: "keep", reason: "Needed for the LLC's audit.", now: NOW });
    expect(reviews().find((r) => r.id === rv.id)).toMatchObject({ status: "kept", decided_by: FOUNDER, decision_reason: "Needed for the LLC's audit." });
    expect(ledger("account_member", "m2")!.next_review_at).toBe("2027-11-16");
    const n = (await runRetentionSweep(db() as never, { now: new Date("2026-12-01T03:00:00Z"), ...logins([]) })).reviewsOpened;
    expect(n).toBe(0);
    expect((await runRetentionSweep(db() as never, { now: new Date("2027-11-17T03:00:00Z"), ...logins([]) })).reviewsOpened).toBeGreaterThanOrEqual(1);
    expect(erasures).toEqual([]);
  });

  it("a decided review cannot be decided again", async () => {
    const rv = await open();
    await decideReview(db() as never, { userId: FOUNDER, reviewId: rv.id, decision: "keep", reason: "Needed for the LLC's audit.", now: NOW });
    db().table("retention_reviews").find((r) => r.id === rv.id)!.status = "kept";
    await expect(decideReview(db() as never, { userId: FOUNDER, reviewId: rv.id, decision: "approve_erasure", reason: "Changed my mind about it.", now: NOW })).rejects.toThrow(/already been decided/);
  });

  it("the screen function refuses anyone but a founder, with a 403 for anyone without a role", async () => {
    const rv = await open();
    as(ADMIN);
    await expect(decideRetentionReview({ data: { reviewId: rv.id, decision: "approve_erasure", reason: "Seven years have passed." } })).rejects.toThrow(/Only the founder/);
    expect(erasures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 4. Data-subject deletion requests
// ---------------------------------------------------------------------------------------------------------
describe("a member's request to delete", () => {
  const ask = (who: string, member: string, note = "Please delete everything.") => requestKyoDeletion(db() as never, { userId: who, actingMemberId: member, note, now: NOW, request: { ip: "203.0.113.5", userAgent: "UA" } });
  const requests = () => db().table("kyo_deletion_requests");

  it("inside the retention period it is declined at once, with the reason recorded and logged", async () => {
    // m1 owns a share of a living LLC: kept for the life of the LLC.
    const r = await ask("u-a1", "m1");
    expect(r).toMatchObject({ status: "declined", code: "inside_retention" });
    expect(r.reason).toMatch(/LLC that has not dissolved/);
    const row = requests()[0]!;
    expect(row).toMatchObject({ status: "declined", decision_code: "inside_retention", account_member_id: "m1", member_note: "Please delete everything." });
    expect(row.decision_reason).toBe(r.reason);
    expect(row.retention_snapshot).toMatchObject({ retention_class: "active_property", retain_until: null });
    expect(row.decided_at).toBeTruthy();
    const log = db().table("audit_log").filter((l) => l.action_type === "kyo.deletion_declined")[0]!;
    expect(log.metadata).toMatchObject({ code: "inside_retention", reason: r.reason, retention_class: "active_property", request_id: row.id });
    expect(db().table("audit_log").some((l) => l.action_type === "kyo.deletion_requested")).toBe(true);
    // What the member wrote is not copied into the Audit Vault.
    expect(JSON.stringify(db().table("audit_log"))).not.toContain("Please delete everything.");
    expect(reviews()).toHaveLength(0);
  });

  it("inside a dated period it names the date; an account still in use is told to withdraw first", async () => {
    await runRetentionSweep(db() as never, { now: NOW, ...logins([]) });
    db().table("kyo_retention").find((r) => r.subject_id === "m6")!.legal_hold = false;
    const inUse = await ask("u-a6", "m6");
    expect(inUse).toMatchObject({ status: "declined", code: "account_active" });
    // m7's account held shares in an LLC that dissolved in 2018: past retention. Give one a future date instead.
    const rec = ledger("account_member", "m7")!;
    rec.retain_until = "2029-06-01";
    rec.status = "retained";
    expect((await ask("u-a7", "m7")).reason).toBe("Inside the retention period: this record is kept until 2029-06-01, and can be deleted after that date.");
    expect(requests().map((r) => r.decision_code).sort()).toEqual(["account_active", "inside_retention"]);
  });

  it("under a legal hold it is declined, whatever the dates", async () => {
    await runRetentionSweep(db() as never, { now: NOW, ...logins([]) });
    const rec = ledger("account_member", "m2")!; // past retention
    Object.assign(rec, { legal_hold: true, legal_hold_reason: "Matter 9" });
    const r = await ask("u-a2", "m2");
    expect(r).toMatchObject({ status: "declined", code: "legal_hold" });
    expect(requests()[0]!.retention_snapshot).toMatchObject({ legal_hold: true });
  });

  it("past the retention period, with no hold, it goes to the founder's queue and compliance is told", async () => {
    const r = await ask("u-a2", "m2");
    expect(r.status).toBe("open");
    expect(requests()[0]).toMatchObject({ status: "open", decided_at: null });
    expect(reviews()).toHaveLength(1);
    expect(reviews()[0]).toMatchObject({ kind: "deletion_request", status: "open" });
    expect(notes().map((n) => n.seller_id)).toEqual([OFFICER]);
    // Asking again while one is waiting does not make a second.
    expect((await ask("u-a2", "m2")).status).toBe("open");
    expect(requests()).toHaveLength(1);
    expect(reviews()).toHaveLength(1);
  });

  it("the founder decides a waiting request: erase it, or decline it with a reason", async () => {
    db().rpcResults.retention_erase = () => ({ ok: true, counts: {} });
    (db() as unknown as { storage: unknown }).storage = { from: () => ({ remove: async () => ({ error: null }) }) };
    await ask("u-a2", "m2");
    const rv = reviews()[0]!;
    await decideReview(db() as never, { userId: FOUNDER, reviewId: rv.id, decision: "keep", reason: "The LLC's audit still needs it.", now: NOW });
    expect(requests()[0]).toMatchObject({ status: "declined", decision_code: "founder_declined", decision_reason: "The LLC's audit still needs it." });
    expect(reviews()[0]).toMatchObject({ status: "declined" });
  });

  it("a member sees their own retention and their own requests, and only a member of their own account can ask for them", async () => {
    await ask("u-a1", "m1");
    const mine = await myRetention(db() as never, { userId: "u-a1", actingMemberId: "m1", now: NOW });
    expect(mine.retention).toMatchObject({ class: "Active property", retainUntil: null });
    expect(mine.requests).toHaveLength(1);
    expect(mine.requests[0]!.status).toBe("declined");
    await expect(myRetention(db() as never, { userId: "u-a1", actingMemberId: "m2", now: NOW })).rejects.toThrow(/isn't on your account/);
    as("u-a1");
    await expect(requestMyKyoDeletion({ data: { actingMemberId: "m6" } })).rejects.toThrow(/isn't on your account/);
  });

  it("an erased record's request is answered plainly", async () => {
    await runRetentionSweep(db() as never, { now: NOW, ...logins([]) });
    Object.assign(ledger("account_member", "m2")!, { status: "erased", erased_at: NOW.toISOString() });
    expect(await ask("u-a2", "m2")).toMatchObject({ status: "declined", reason: "Your data has already been erased." });
  });

  it("the deletion decision rules, as a table", () => {
    const today = "2026-11-16";
    const d = (c: Parameters<typeof deletionDecision>[0]) => deletionDecision(c, today);
    expect(d({ retentionClass: "archived", retainUntil: "2025-01-01", legalHold: false })).toMatchObject({ outcome: "queued", code: null });
    expect(d({ retentionClass: "archived", retainUntil: "2026-11-16", legalHold: false })).toMatchObject({ outcome: "declined", code: "inside_retention" });
    expect(d({ retentionClass: "archived", retainUntil: "2025-01-01", legalHold: true })).toMatchObject({ outcome: "declined", code: "legal_hold" });
    expect(d({ retentionClass: "active_property", retainUntil: null, legalHold: false })).toMatchObject({ outcome: "declined", code: "inside_retention" });
    expect(d({ retentionClass: "in_use", retainUntil: null, legalHold: false })).toMatchObject({ outcome: "declined", code: "account_active" });
  });
});

// ---------------------------------------------------------------------------------------------------------
// 5. The admin view: counts, no PII
// ---------------------------------------------------------------------------------------------------------
describe("the admin view of retention status", () => {
  it("per property and per archived account, counts and references only", async () => {
    await runRetentionSweep(db() as never, { now: NOW, ...logins(["u-a5"]) });
    const o = await retentionOverview(db() as never, { userId: ADMIN, now: NOW });
    expect(o.totals).toMatchObject({ records: 11, legalHolds: 0, byClass: { active_property: 3, archived: 5, in_use: 3 }, byStatus: { retained: 6, past_retention: 2, in_use: 3, erased: 0 } });
    expect(o.queue).toEqual({ openReviews: 2, openDeletionRequests: 0, declinedDeletionRequests: 0 });
    const lusk = o.byProperty.find((p) => p.propertyId === "p1")!;
    expect(lusk).toMatchObject({ label: "1 Main St, Lusk, WY", llcName: "Lusk LLC", dissolvedAt: null, records: 2, retained: 2, pastRetention: 0 }); // the owner's member and the seller
    const reno = o.byProperty.find((p) => p.propertyId === "p3")!;
    expect(reno).toMatchObject({ dissolvedAt: "2018-06-01", records: 1, pastRetention: 1 });
    const acct = o.archivedAccounts.find((a) => a.ref === "Account #a2")!;
    expect(acct).toMatchObject({ reason: "Abandoned", archivedAt: "2018-01-01", retainUntil: "2025-01-01", status: "past_retention", pastDue: true, records: 1 });
    expect(o.archivedByReason).toMatchObject({ "Not eligible": 1, "Login deleted": 1, "Member removed": 1, Abandoned: 1, Rejected: 1 });
    // No names, emails or addresses of people anywhere in what the screen is given.
    const json = JSON.stringify(o) + JSON.stringify(await listRetentionQueue(db() as never, { userId: ADMIN }));
    expect(json).not.toMatch(/Person m|pii\.example|license\.jpg/);
  });

  it("the Manager, the Compliance Officer and the founder see it; anyone else gets a 403", async () => {
    await runRetentionSweep(db() as never, { now: NOW, ...logins([]) });
    const status = vi.mocked(serverRuntime.setResponseStatus);
    for (const who of [ADMIN, OFFICER, FOUNDER]) {
      as(who);
      expect((await getRetentionOverview()).totals.records).toBe(11);
    }
    for (const who of [USERS.b1, USERS.ra, "u-nobody"]) {
      as(who);
      status.mockClear();
      await expect(getRetentionOverview()).rejects.toThrow("Not authorized");
      expect(status).toHaveBeenCalledWith(403);
    }
  });

  it("the queue lists reviews and requests with references, with the retention dates", async () => {
    await runRetentionSweep(db() as never, { now: NOW, ...logins([]) });
    const q = await listRetentionQueue(db() as never, { userId: OFFICER });
    expect(q.reviews.filter((r) => r.status === "open").map((r) => r.record.ref).sort()).toEqual(["Member #m2", "Member #m7"]);
    expect(q.reviews.find((r) => r.record.ref === "Member #m2")!.record).toMatchObject({ class: "Archived", archivedAt: "2018-01-01", retainUntil: "2025-01-01", legalHold: false });
  });
});

// ---------------------------------------------------------------------------------------------------------
// 6. Wiring
// ---------------------------------------------------------------------------------------------------------
describe("the assumption is flagged, and the pieces are wired", () => {
  it("the launch readiness page flags the retention periods and wording as pending compliance review", () => {
    const item = LAUNCH_ITEMS.find((i) => i.key === "kyo_retention_periods")!;
    expect(item.status).toBe("Placeholder");
    expect(item.detail).toMatch(/ASSUMPTION/);
    expect(item.detail).toMatch(/pending compliance review/);
    expect(item.detail).toMatch(/7 years/);
  });
  it("the nightly route, the schedule, the screens and the SQL exist", () => {
    expect(src("src/routes/api.public.kyo-retention-sweep.ts")).toContain("runRetentionSweep");
    expect(src("src/routes/api.public.kyo-retention-sweep.ts")).toContain("x-sweep-secret");
    expect(src("cron-sweeps.sql")).toContain("kyo-retention-sweep");
    expect(src("src/routes/admin.retention.tsx")).toContain("Retention review queue");
    expect(src("src/routes/admin.tsx")).toContain('"/admin/retention"');
    expect(src("src/routes/buyer.kyo.tsx")).toContain("Ask for my data to be deleted");
    const sql = src("kyo-retention.sql");
    for (const w of ["active_property", "archived", "retain_until", "legal_hold", "retention_erase", "ASSUMPTION"]) expect(sql, w).toContain(w);
  });
  it("the existing Retention Lock (shares) module was not touched", () => {
    expect(src("src/lib/retention.ts")).toContain("RETENTION_EXCEPTION_LABELS");
  });
});
