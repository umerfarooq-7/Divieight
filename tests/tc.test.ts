/** Versioned Terms and Conditions: publishing, change notices, delivery records, implicit acceptance, history. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { allRecipients, ensureBaseline, listVersions, myTermsStatus, publicTerms, publishTcVersion, recordImplicitAcceptance, sendTcNotices, deliveryReport } from "@/lib/tc.server";
import { getPublicTerms, publishTerms, recordTermsContinuedUse, getMyTermsStatus, getTermsComparison } from "@/lib/tc.functions";
import { BASELINE, buildDiff, inForceVersion, noticeMessage, publishProblem } from "@/lib/tc";
import { TERMS_TEXT } from "@/lib/terms";

const db = () => harness.db;
const as = (u: string) => (harness.userId = u);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const REVISED = TERMS_TEXT.replace("9. PRIVACY AND YOUR DATA", "9. PRIVACY AND YOUR DATA (UPDATED)").replace("Sensitive identifiers", "Sensitive identifiers and payment details");
const fetchCalls: Array<{ to: string[]; subject: string; html: string }> = [];

beforeEach(() => {
  seedPod(db());
  db().seed("sellers", [{ id: IDS.seller, email: "seller@test.local", full_name: "Sam Seller" }]);
  db().seed("brokers", [{ id: IDS.broker, auth_user_id: USERS.broker, email: "broker@test.local" }]);
  // Each person on a Buyer Account has their own address; the notice reaches each of them.
  for (const m of db().table("account_members")) Object.assign(m, { status: "active", email: `${String(m.full_name).split(" ")[0]!.toLowerCase()}@members.test` });
  fetchCalls.length = 0;
  process.env.RESEND_API_KEY = "test-key";
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    fetchCalls.push(JSON.parse(init.body));
    return { ok: true } as Response;
  });
});
afterEach(() => vi.unstubAllGlobals());

const publish = (o: Partial<{ version: string; effectiveDate: string; body: string; isMaterial: boolean; summary: string }> = {}) =>
  publishTcVersion(db() as never, {
    adminId: USERS.admin,
    input: { version: "1.1", effectiveDate: day(14), body: REVISED, isMaterial: true, summary: "We now describe how payment details are handled.", ...o },
  });
const notices = () => db().table("notifications").filter((n) => n.type === "tc_update");

describe("one current version, and previous versions stay readable", () => {
  it("the Terms as first published become version 1.0, the one current version", async () => {
    await ensureBaseline(db() as never);
    await ensureBaseline(db() as never);
    const all = await listVersions(db() as never);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ version: BASELINE.version, is_current: true, is_material: false, body: TERMS_TEXT });
    expect(notices()).toHaveLength(0);
  });

  it("publishing makes the new version the only current one; the previous one stays readable, unchanged", async () => {
    await publish();
    const all = await listVersions(db() as never);
    expect(all.map((v) => v.version)).toEqual(["1.1", "1.0"]);
    expect(all.filter((v) => v.is_current).map((v) => v.version)).toEqual(["1.1"]);
    expect(all.find((v) => v.version === "1.1")!.previous_version_id).toBe(all.find((v) => v.version === "1.0")!.id);
    const old = await getPublicTerms({ data: { version: "1.0" } });
    expect(old.shown).toMatchObject({ version: "1.0", body: TERMS_TEXT });
    expect(old.history.map((h) => h.version)).toEqual(["1.1", "1.0"]);
  });

  it("only the Manager can publish", async () => {
    as(USERS.b1);
    await expect(publishTerms({ data: { version: "1.1", effectiveDate: day(14), body: REVISED, isMaterial: true, summary: "A summary of the change." } })).rejects.toThrow(/Only the Manager/);
    expect(await listVersions(db() as never)).toHaveLength(1);
  });
});

describe("what a publication must carry", () => {
  const existing = [{ version: "1.0", body: TERMS_TEXT }];
  const base = { version: "1.1", effectiveDate: day(14), body: REVISED, isMaterial: true, summary: "We now describe payment details." };
  it("a material revision requires a summary of changes", async () => {
    expect(publishProblem({ ...base, summary: "" }, existing)).toMatch(/summary of changes/);
    expect(publishProblem({ ...base, summary: "short" }, existing)).toMatch(/summary of changes/);
    expect(publishProblem(base, existing)).toBeNull();
    await expect(publish({ summary: "" })).rejects.toThrow(/summary of changes/);
    expect(await listVersions(db() as never)).toHaveLength(1);
  });
  it("a non-material edit needs no summary", () => {
    expect(publishProblem({ ...base, isMaterial: false, summary: "" }, existing)).toBeNull();
  });
  it("refuses a past effective date, a repeated version number, identical text and an empty text", () => {
    expect(publishProblem({ ...base, effectiveDate: day(-1) }, existing)).toMatch(/past/);
    expect(publishProblem({ ...base, version: "1.0" }, existing)).toMatch(/already exists/);
    expect(publishProblem({ ...base, body: TERMS_TEXT }, existing)).toMatch(/identical/);
    expect(publishProblem({ ...base, body: "  " }, existing)).toMatch(/empty/);
    expect(publishProblem({ ...base, version: "one" }, existing)).toMatch(/number/);
  });
});

describe("a MATERIAL publication notifies every user once, with the summary, the diff link and the effective date", () => {
  it("in the app and by email, to each person, and to each member of a Buyer Account", async () => {
    const eff = day(14);
    const r = await publish({ effectiveDate: eff });
    const everyone = await allRecipients(db() as never);
    // Buyers (3 accounts), the seller, 3 agents, the broker and the Manager.
    expect(everyone.map((e) => e.authUserId).sort()).toEqual([USERS.b1, USERS.b2, USERS.b3, IDS.seller, USERS.ra, USERS.ra2, USERS.hla, USERS.broker, USERS.admin].sort());
    expect(r.notices).toMatchObject({ recipients: everyone.length, notified: everyone.length, skipped: 0 });

    // In-app: exactly one notification each.
    const rows = notices();
    expect(rows).toHaveLength(everyone.length);
    expect(new Set(rows.map((n) => n.seller_id)).size).toBe(everyone.length);
    for (const n of rows) {
      expect(n.message).toContain("We now describe how payment details are handled.");
      expect(n.message).toContain(eff);
      expect(n.message).toContain("/terms-changes?from=1.0&to=1.1");
      expect(n.message).toContain("version 1.1");
    }

    // Email: the login's address and every active member's own address, each with the same summary and link.
    const sent = fetchCalls.flatMap((c) => c.to);
    for (const to of ["b1@test.local", "alice@members.test", "bob@members.test", "b2@test.local", "carol@members.test", "seller@test.local", "ra@test.local", "broker@test.local"]) expect(sent, to).toContain(to);
    const one = fetchCalls.find((c) => c.to[0] === "b1@test.local")!;
    expect(one.subject).toContain("version 1.1");
    expect(one.html).toContain("We now describe how payment details are handled.");
    expect(one.html).toContain("/terms-changes?from=1.0&amp;to=1.1");
    expect(one.html).toContain("See what changed");
  });

  it("is recorded: who, when, which channel", async () => {
    const r = await publish();
    const id = r.version.id;
    const rows = db().table("tc_notice_deliveries").filter((d) => d.tc_version_id === id);
    const everyone = await allRecipients(db() as never);
    expect(rows).toHaveLength(everyone.length * 2);
    expect(rows.filter((d) => d.channel === "portal" && d.delivered)).toHaveLength(everyone.length);
    expect(rows.every((d) => d.delivered_at && d.auth_user_id)).toBe(true);
    const b1 = rows.filter((d) => d.auth_user_id === USERS.b1);
    expect(b1.map((d) => d.channel).sort()).toEqual(["email", "portal"]);
    // A person with no address on file is told in the app and the missing email is recorded as such.
    const rep = await deliveryReport(db() as never, { adminId: USERS.admin, versionId: id });
    expect(rep.recipients).toBe(everyone.length);
    expect(rep.portalDelivered).toBe(everyone.length);
    expect(rep.notYetNotified).toBe(0);
    expect(rep.rows.length).toBe(everyone.length * 2);
    expect(db().table("audit_log").some((a) => a.action_type === "tc.notices_sent")).toBe(true);
  });

  it("sending again tells nobody twice, and reaches only anyone missed", async () => {
    const r = await publish();
    const before = notices().length;
    const mails = fetchCalls.length;
    const again = await sendTcNotices(db() as never, { versionId: r.version.id, adminId: USERS.admin });
    expect(again).toMatchObject({ notified: 0 });
    expect(again.skipped).toBe(before);
    expect(notices()).toHaveLength(before);
    expect(fetchCalls).toHaveLength(mails);
    // A user who joins later and was missed is reached by the retry, once.
    db().seed("agents", [{ id: "agent-new", auth_user_id: "u-new", full_name: "New Agent", email: "new@test.local" }]);
    const later = await sendTcNotices(db() as never, { versionId: r.version.id, adminId: USERS.admin });
    expect(later.notified).toBe(1);
    expect(notices().filter((n) => n.seller_id === "u-new")).toHaveLength(1);
  });

  it("an email that cannot be sent is recorded as not delivered, and the app notice still goes", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false }) as Response);
    const r = await publish();
    const everyone = await allRecipients(db() as never);
    expect(notices()).toHaveLength(everyone.length);
    const rows = db().table("tc_notice_deliveries").filter((d) => d.tc_version_id === r.version.id && d.channel === "email");
    expect(rows.every((d) => d.delivered === false)).toBe(true);
  });
});

describe("a NON-material edit notifies no one", () => {
  it("is published, becomes current and readable, with no notification, email or delivery record", async () => {
    const r = await publish({ isMaterial: false, summary: "" });
    expect(r.notices).toBeNull();
    expect(notices()).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
    expect(db().table("tc_notice_deliveries")).toHaveLength(0);
    const all = await listVersions(db() as never);
    expect(all.find((v) => v.is_current)!.version).toBe("1.1");
    expect(all.find((v) => v.version === "1.1")!.body).toBe(REVISED);
    await expect(sendTcNotices(db() as never, { versionId: r.version.id })).rejects.toThrow(/Only a material/);
  });
});

describe("the marked diff", () => {
  it("shows what was added, removed and changed between two versions", () => {
    const d = buildDiff("1. ONE\nkeep\nold line here\n2. TWO\n", "1. ONE\nkeep\nnew line here\n2. TWO\n3. THREE\n");
    expect(d.stats).toEqual({ added: 1, removed: 0, changed: 1, unchanged: 3 });
    const changed = d.rows.find((r) => r.kind === "changed")!;
    expect(changed.left!.find((s) => s.mark === "del")!.text).toContain("old");
    expect(changed.right!.find((s) => s.mark === "add")!.text).toContain("new");
    expect(d.rows.find((r) => r.kind === "added")!.right![0]!.text).toBe("3. THREE");
  });
  it("identical text has no changes, and the real revision marks the new words", () => {
    expect(buildDiff(TERMS_TEXT, TERMS_TEXT).stats).toMatchObject({ added: 0, removed: 0, changed: 0 });
    const d = buildDiff(TERMS_TEXT, REVISED);
    expect(d.stats.changed).toBeGreaterThanOrEqual(2);
    expect(d.rows.some((r) => r.right?.some((s) => s.mark === "add" && /UPDATED|payment details/.test(s.text)))).toBe(true);
  });
  it("any two versions can be compared by anyone, without signing in", async () => {
    await publish();
    as("");
    const c = await getTermsComparison({ data: { from: "1.0", to: "1.1" } });
    expect(c.from.body).toBe(TERMS_TEXT);
    expect(c.to).toMatchObject({ version: "1.1", isMaterial: true, summary: "We now describe how payment details are handled." });
    await expect(getTermsComparison({ data: { from: "1.0", to: "9.9" } })).rejects.toThrow(/does not exist/);
  });
  it("the notice says what it must say", () => {
    const m = noticeMessage({ version: "2.0", effectiveDate: "2027-01-01", summary: "Fees are explained.", diffUrl: "https://x/terms-changes?from=1.0&to=2.0" });
    expect(m.message).toContain("Fees are explained.");
    expect(m.message).toContain("2027-01-01");
    expect(m.message).toContain("https://x/terms-changes?from=1.0&to=2.0");
    expect(m.message).toMatch(/do not need to sign/);
  });
});

describe("implicit acceptance by continued use, with the version", () => {
  const req = { ip: "203.0.113.7", userAgent: "test" };
  it("is stored once per person per version, with the version, and nobody is asked to re-sign", async () => {
    const a = await recordImplicitAcceptance(db() as never, { userId: USERS.b1, request: req });
    expect(a).toEqual({ recorded: true, version: "1.0" });
    const row = db().table("tc_acceptances")[0]!;
    expect(row).toMatchObject({ auth_user_id: USERS.b1, version: "1.0", kind: "implicit_continued_use", ip_address: "203.0.113.7" });
    expect(row.accepted_at).toBeTruthy();
    expect((await recordImplicitAcceptance(db() as never, { userId: USERS.b1, request: req })).recorded).toBe(false);
    expect(db().table("tc_acceptances")).toHaveLength(1);
    expect(db().table("audit_log").some((x) => x.action_type === "tc.implicit_acceptance")).toBe(true);
  });

  it("a revision binds only from its effective date: before it, use accepts the old version; after it, the new one", async () => {
    const r = await publish({ effectiveDate: day(14) });
    await recordImplicitAcceptance(db() as never, { userId: USERS.b1, request: req });
    expect(db().table("tc_acceptances").map((a) => a.version)).toEqual(["1.0"]);
    const later = new Date(Date.now() + 15 * 86_400_000);
    expect(await recordImplicitAcceptance(db() as never, { userId: USERS.b1, request: req, now: later })).toEqual({ recorded: true, version: "1.1" });
    expect(db().table("tc_acceptances").map((a) => a.version).sort()).toEqual(["1.0", "1.1"]);
    expect(db().table("tc_acceptances").find((a) => a.version === "1.1")!.tc_version_id).toBe(r.version.id);
    expect(inForceVersion(await listVersions(db() as never), day(14))!.version).toBe("1.1");
  });

  it("is recorded when a signed-in person simply uses the site", async () => {
    as(USERS.b2);
    expect((await recordTermsContinuedUse()).recorded).toBe(true);
    expect(db().table("tc_acceptances")[0]).toMatchObject({ auth_user_id: USERS.b2, version: "1.0" });
  });
});

describe("account settings: the version you are bound by, and the history", () => {
  it("shows the version in force, the upcoming one, your acceptances and every version", async () => {
    await recordImplicitAcceptance(db() as never, { userId: USERS.b1, request: { ip: null, userAgent: null } });
    await publish({ effectiveDate: day(14) });
    as(USERS.b1);
    const s = await getMyTermsStatus();
    expect(s.boundBy).toMatchObject({ version: "1.0" });
    expect(s.boundBy!.acceptedAt).toBeTruthy();
    expect(s.upcoming).toMatchObject({ version: "1.1", effectiveDate: day(14) });
    expect(s.acceptances.map((a) => a.version)).toEqual(["1.0"]);
    expect(s.history.map((h) => h.version)).toEqual(["1.1", "1.0"]);
    expect(s.history[0]).toMatchObject({ isMaterial: true, previousVersion: "1.0" });
    expect(s.history[0]!.notifiedAt).toBeTruthy();
    // After the effective date the new version is the one you are bound by.
    const after = await myTermsStatus(db() as never, { userId: USERS.b1, now: new Date(Date.now() + 15 * 86_400_000) });
    expect(after.boundBy).toMatchObject({ version: "1.1" });
    expect(after.upcoming).toBeNull();
  });

  it("the public page shows the version in force, flags an upcoming one, and every old version stays readable", async () => {
    await publish({ effectiveDate: day(14) });
    const now = await publicTerms(db() as never, {});
    expect(now.shown.version).toBe("1.0");
    expect(now.upcoming).toMatchObject({ version: "1.1" });
    const later = await publicTerms(db() as never, { now: new Date(Date.now() + 15 * 86_400_000) });
    expect(later.shown.version).toBe("1.1");
    expect((await publicTerms(db() as never, { version: "1.0", now: new Date(Date.now() + 15 * 86_400_000) })).shown.body).toBe(TERMS_TEXT);
  });
});

describe("PRA and OA revisions are not Terms changes", () => {
  it("publishing the Terms never touches an executed document", async () => {
    db().seed("signed_documents", [{ id: "sd1", buyer_account_id: IDS.b1, document_type: "PRA", document_version: "v2", document_hash: "h", signed_name: "Alice One" }]);
    db().seed("executed_document_texts", [{ document_hash: "h", document_type: "PRA", document_version: "v2", body: "EXECUTED TEXT" }]);
    const before = JSON.stringify([db().table("signed_documents"), db().table("executed_document_texts")]);
    await publish();
    expect(JSON.stringify([db().table("signed_documents"), db().table("executed_document_texts")])).toBe(before);
  });

  it("only the Terms code can send a Terms notice: a PRA or OA revision has no path to it", () => {
    for (const f of ["src/lib/legal-documents.ts", "src/lib/entity-genesis-stage2.server.ts", "src/lib/member-steps.server.ts", "src/lib/document-access.server.ts"]) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/tc\.server|tc_update|sendTcNotices/);
    }
    expect(readFileSync("src/lib/tc.server.ts", "utf8")).toContain('type: "tc_update"');
  });

  it("the migration states it: the agreements keep their own versions and apply only to later documents", () => {
    expect(readFileSync("tc-versions.sql", "utf8")).toMatch(/apply only to documents made after it|applies only to documents made after it/);
  });
});

describe("the screens exist and are linked", () => {
  it("/terms, the comparison, admin publishing and account settings", () => {
    expect(readFileSync("src/routes/terms-changes.tsx", "utf8")).toContain('createFileRoute("/terms-changes")');
    expect(readFileSync("src/routes/admin.terms.tsx", "utf8")).toContain("Publish and notify everyone");
    expect(readFileSync("src/routes/admin.tsx", "utf8")).toContain('"/admin/terms"');
    const acct = readFileSync("src/routes/account.settings.tsx", "utf8");
    expect(acct).toContain("You are bound by");
    expect(acct).toContain("History");
    expect(readFileSync("src/components/NavBar.tsx", "utf8")).toContain('to="/account/settings"');
    expect(readFileSync("src/routes/__root.tsx", "utf8")).toContain("<TermsContinuedUse />");
  });
});
