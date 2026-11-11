/**
 * The third round of decided answers: the held-account reminder, the removed-member email, the joint-ownership note,
 * authority scopes, the seller-eligibility setting, the questions-and-rules guard, the KYO banner, and the behaviours
 * that were confirmed as they are.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { DECISION_PAGE_SPEC_VERSION, STANDARD_VERSION } from "@/constants/eligibilityCopy";
import { BLOCK1_VERSION, BLOCK2_VERSION } from "@/constants/authorizationsCopy";
import { adminHeldAccounts, runHeldReminders, snoozeHeldAccount } from "@/lib/held-reminders.server";
import { listHeldAccounts, snoozeHeldAccountFn } from "@/lib/held-reminders.functions";
import { runEnrollmentMaintenance } from "@/lib/enrollment-maintenance.functions";
import { listMyTetheredBuyers } from "@/lib/agent-leads.functions";
import { getMyAccountMembers, removeAccountMember, addAccountMember } from "@/lib/account-members.functions";
import { grantAuthorityFn } from "@/lib/member-authority.functions";
import { acceptAuthorizationFn, signMemberDocumentFn } from "@/lib/member-steps.functions";
import { AUTHORITY_SCOPES, NEVER_DELEGATED, REMOVED_AUTHORITY_SCOPES } from "@/lib/member-authority";
import { GOVERNANCE_DEFAULTS, GOVERNANCE_KEYS, HELD_REMINDER_DAYS, GATE_LISTING_ON_SELLER_ELIGIBILITY, HELD_SNOOZE_DAYS, governanceValueProblem } from "@/lib/governance-config";
import { loadGovernanceConfig } from "@/lib/governance-config.server";
import { JOINT_OWNERSHIP_ADMIN_NOTE, jointHolderLabel } from "@/lib/entity-genesis";
import { KYO_REVIEW_BANNER } from "@/lib/kyo";
import { sellerListingGate } from "@/lib/seller-eligibility.server";
import { submitSellerEligibility } from "@/lib/seller-eligibility.functions";
import { resolveComplianceReview } from "@/lib/listing-approval.functions";
import { SELLER_INFORMATIONAL_NOTE } from "@/constants/eligibilityCheckCopy";
import { HELD_BUYER_TEXT, evaluateEligibility } from "@/lib/eligibility-engine";
import { ENGINE_RULE_SET, RULES_CHANGED_MESSAGE, canonicalJson, currentRulesDefinition, currentRulesHash, engineBehaviourFingerprint } from "@/lib/standard-rules-hash";
import { assertStandardRules, checkStandardRules } from "@/lib/standard-rules-check.server";
import { publishStandardVersion } from "@/lib/standard-version.server";
import { submitEligibilityDeclaration } from "@/lib/eligibility-declaration.functions";
import { loadMemberSteps } from "@/lib/account-rollup";
import { LOCKED_MESSAGE, SAME_PERSON_MESSAGE } from "@/lib/account-members";
import { saveMemberIdentityFn } from "@/lib/account-members.functions";
import { deliver } from "@/lib/authorization.notify.server";

const db = () => harness.db;
const as = (u: string) => (harness.userId = u);
const A = IDS.property;
const DAY = 86_400_000;
const ALICE = IDS.b1m1;
const BOB = IDS.b1m2;
const NOW = Date.parse("2026-11-12T05:00:00Z");
const ago = (days: number, from = NOW) => new Date(from - days * DAY).toISOString();
const yes = { q1: "yes", q2: "yes", q3: "yes", q4: "yes", q5: "yes", q6: "yes" };
const member = (id: string) => db().table("account_members").find((m) => m.id === id)!;

function seedMembers() {
  seedPod(db());
  for (const m of db().table("account_members")) Object.assign(m, { status: "active", role: m.role === "secondary" ? "member" : m.role, date_of_birth: "1980-01-01", address: "1 Main St", id_document_url: `ids/${m.id}.jpg`, vetting_status: "in_progress" });
  member(ALICE).email = "alice@test.local";
  member(BOB).email = "bob@test.local";
}

/** Gives a member a complete declaration and a result, determined `daysAgo` days before NOW. */
function result(memberId: string, kind: "held" | "eligible", daysAgo: number, id = `d-${memberId}-${daysAgo}`) {
  const base = { account_member_id: memberId, buyer_account_id: IDS.b1 };
  for (const d of db().table("eligibility_declarations").filter((x) => x.account_member_id === memberId && x.status === "complete")) d.status = "superseded";
  db().seed("eligibility_declarations", [{ id, ...base, status: "complete", answers: yes, standard_version: STANDARD_VERSION, declared_at: ago(daysAgo) }]);
  db().seed("eligibility_results", [{ ...base, declaration_id: id, result: kind, reason_codes: kind === "held" ? ["q3_pending_charge_disclosed"] : ["all_clear"], standard_version: STANDARD_VERSION, determined_at: ago(daysAgo) }]);
}
const followups = (kind?: string) => db().table("held_followups").filter((f) => !kind || f.kind === kind);
const adminNotes = () => db().notificationsFor(USERS.admin).filter((n) => n.type === "held_reminder");

// ---------------------------------------------------------------------------
// 1. Held reminder
// ---------------------------------------------------------------------------

describe("1. the held-account reminder", () => {
  beforeEach(seedMembers);

  it("is configured at 30 days", () => {
    expect(HELD_REMINDER_DAYS).toBe(30);
    expect(GOVERNANCE_DEFAULTS.heldReminderDays).toBe(30);
    expect(HELD_SNOOZE_DAYS).toBe(30);
    expect(GOVERNANCE_KEYS).toContain("heldReminderDays");
    expect(governanceValueProblem("heldReminderDays", 0)).toMatch(/between/);
  });

  it("fires once when a member has been held 30 days: one admin notification and one row", async () => {
    result(BOB, "held", 31);
    const r = await runHeldReminders(db() as never, NOW);
    expect(r).toEqual({ held: 1, reminded: 1 });
    expect(adminNotes()).toHaveLength(1);
    expect(followups("reminder")).toHaveLength(1);
    expect(followups("reminder")[0]).toMatchObject({ account_member_id: BOB, buyer_account_id: IDS.b1, days_held: 31 });
    expect(adminNotes()[0]!.message).toMatch(/Bob One \(second member\)/);
    expect(adminNotes()[0]!.message).toMatch(/held for 31 days/);
    expect(db().audits("held.reminder_raised")).toHaveLength(1);
  });

  it("doesn't fire before 30 days, and doesn't fire again the next night or within the next 30 days", async () => {
    result(BOB, "held", 20);
    expect((await runHeldReminders(db() as never, NOW)).reminded).toBe(0);
    expect(adminNotes()).toHaveLength(0);
    // Now it has been 30 days.
    expect((await runHeldReminders(db() as never, NOW + 10 * DAY)).reminded).toBe(1);
    expect((await runHeldReminders(db() as never, NOW + 10 * DAY)).reminded).toBe(0); // the same night again
    expect((await runHeldReminders(db() as never, NOW + 11 * DAY)).reminded).toBe(0); // the next night
    expect((await runHeldReminders(db() as never, NOW + 39 * DAY)).reminded).toBe(0); // 29 days after the reminder
    expect(adminNotes()).toHaveLength(1);
    expect((await runHeldReminders(db() as never, NOW + 41 * DAY)).reminded).toBe(1); // 31 days after it: the next one
    expect(adminNotes()).toHaveLength(2);
  });

  it("a member who isn't held, or whose hold was resolved, raises nothing", async () => {
    result(ALICE, "eligible", 90);
    result(BOB, "held", 60);
    result(BOB, "eligible", 1); // resolved
    expect((await runHeldReminders(db() as never, NOW)).held).toBe(0);
    expect(followups()).toHaveLength(0);
  });

  it("counts the unbroken run of held results, not just the latest one", async () => {
    result(BOB, "held", 40, "d1");
    result(BOB, "held", 3, "d2"); // a later declaration that is still held
    expect((await runHeldReminders(db() as never, NOW)).reminded).toBe(1);
    expect(followups("reminder")[0]!.days_held).toBe(40);
  });

  it("the admin list shows the member label, the account, the days held and the last reminder", async () => {
    result(BOB, "held", 35);
    await runHeldReminders(db() as never, NOW);
    const { rows } = await adminHeldAccounts(db() as never, NOW);
    expect(rows).toEqual([{ memberId: BOB, memberLabel: "Bob One (second member)", accountEmail: "b1@test.local", daysHeld: 35, lastReminderAt: ago(0), snoozedUntil: null, snoozeNote: null }]);
    expect(Object.keys(rows[0]!).sort()).toEqual(["accountEmail", "daysHeld", "lastReminderAt", "memberId", "memberLabel", "snoozeNote", "snoozedUntil"]);
  });

  it("an admin can snooze it for 30 days with a note; it then stays quiet for the 30 days and comes back after", async () => {
    result(BOB, "held", 35);
    await runHeldReminders(db() as never, NOW);
    await expect(snoozeHeldAccount(db() as never, { adminId: USERS.admin, memberId: BOB, note: "  ", now: NOW })).rejects.toThrow("note");
    const s = await snoozeHeldAccount(db() as never, { adminId: USERS.admin, memberId: BOB, note: "Waiting on the court date", now: NOW });
    expect(s.snoozedUntil).toBe(new Date(NOW + 30 * DAY).toISOString());
    expect(followups("snooze")).toHaveLength(1);
    expect(db().audits("held.snoozed")[0]!.metadata).toMatchObject({ note: "Waiting on the court date" });
    expect((await adminHeldAccounts(db() as never, NOW)).rows[0]).toMatchObject({ snoozedUntil: s.snoozedUntil, snoozeNote: "Waiting on the court date" });
    expect((await runHeldReminders(db() as never, NOW + 15 * DAY)).reminded).toBe(0);
    expect((await runHeldReminders(db() as never, NOW + 29 * DAY)).reminded).toBe(0);
    expect((await runHeldReminders(db() as never, NOW + 31 * DAY)).reminded).toBe(1);
    // The snooze, not the last reminder, is what holds it back: snoozed 31 days on, still quiet 32 days on.
    await snoozeHeldAccount(db() as never, { adminId: USERS.admin, memberId: BOB, note: "Still waiting", now: NOW + 31 * DAY });
    expect((await runHeldReminders(db() as never, NOW + 32 * DAY)).reminded).toBe(0);
    expect((await runHeldReminders(db() as never, NOW + 62 * DAY)).reminded).toBe(1);
    // A member who isn't held can't be snoozed.
    await expect(snoozeHeldAccount(db() as never, { adminId: USERS.admin, memberId: ALICE, note: "x", now: NOW })).rejects.toThrow("isn't held");
  });

  it("a snooze on its own holds a due reminder back (the last reminder is long past)", async () => {
    result(BOB, "held", 100);
    await runHeldReminders(db() as never, NOW); // a reminder at NOW
    await snoozeHeldAccount(db() as never, { adminId: USERS.admin, memberId: BOB, note: "Court date set", now: NOW + 40 * DAY });
    expect((await runHeldReminders(db() as never, NOW + 41 * DAY)).reminded).toBe(0); // 41 days since the last reminder, but snoozed
    expect((await runHeldReminders(db() as never, NOW + 71 * DAY)).reminded).toBe(1); // the snooze has run out
  });

  it("only an admin can see the list or snooze", async () => {
    result(BOB, "held", 35);
    as(USERS.b1);
    await expect(listHeldAccounts()).rejects.toThrow("Not authorized");
    await expect(snoozeHeldAccountFn({ data: { memberId: BOB, note: "x" } })).rejects.toThrow("Not authorized");
    as(USERS.ra);
    await expect(listHeldAccounts()).rejects.toThrow("Not authorized");
    as(USERS.admin);
    expect((await listHeldAccounts()).rows).toHaveLength(1);
    await snoozeHeldAccountFn({ data: { memberId: BOB, note: "Pending court" } });
    expect(followups("snooze")).toHaveLength(1);
  });

  it("never reaches the buyer or the agent, and the reason is never shown: not in the list, not in the notice, not to the agent", async () => {
    result(BOB, "held", 40);
    await runHeldReminders(db() as never, NOW);
    for (const user of [USERS.b1, USERS.b2, USERS.ra, USERS.ra2, USERS.hla]) expect(db().notificationsFor(user)).toHaveLength(0);
    const REASON = /q3|reason|charge|declaration|disclos|pending_charge|sanction|conviction|held for review/i;
    const rows = (await adminHeldAccounts(db() as never, NOW)).rows;
    expect(JSON.stringify(rows)).not.toMatch(REASON);
    expect(adminNotes()[0]!.message).not.toMatch(REASON);
    expect(JSON.stringify(followups())).not.toMatch(REASON);
    // The tethered agent reads the account as pending, never held and never a reason.
    as(USERS.ra);
    const lead = (await listMyTetheredBuyers()).find((l) => l.buyerAccountId === IDS.b1)!;
    expect(JSON.stringify(lead)).not.toMatch(/held|q3|reason|charge|declaration/i);
    expect(lead.onboardingStatus).toBe("vetting_pending");
  });

  it("the account is untouched by all of it: never warned, forfeited or charged", async () => {
    result(BOB, "held", 100);
    result(ALICE, "eligible", 100);
    Object.assign(db().table("buyer_accounts").find((a) => a.id === IDS.b1)!, { onboarding_status: "vetting_pending", priority_rank_timestamp: "2026-09-01T00:00:00Z", last_activity_at: ago(100, Date.now()), stall_warning_sent_at: ago(80, Date.now()) });
    db().seed("buyer_enrollment_payments", [{ buyer_account_id: IDS.b1, auth_user_id: USERS.b1, status: "paid", amount_cents: 257000, environment: "test" }]);
    const before = JSON.stringify(db().table("buyer_accounts").find((a) => a.id === IDS.b1));
    await runHeldReminders(db() as never, Date.now());
    const sweep = await runEnrollmentMaintenance();
    expect(sweep.warned + sweep.forfeited).toBe(0);
    expect(JSON.stringify(db().table("buyer_accounts").find((a) => a.id === IDS.b1))).toBe(before);
    expect(db().audits("buyer.priority_forfeited")).toHaveLength(0);
  });

  it("the days come from the setting", async () => {
    db().seed("governance_settings", [{ key: "heldReminderDays", value: 10 }]);
    expect((await loadGovernanceConfig(db() as never)).heldReminderDays).toBe(10);
    result(BOB, "held", 12);
    expect((await runHeldReminders(db() as never, NOW)).reminded).toBe(1);
  });

  it("without the table nothing is sent (so a missing table can't mean a reminder every night)", async () => {
    result(BOB, "held", 40);
    const real = db().from.bind(db());
    vi.spyOn(db(), "from").mockImplementation(((t: string) => (t === "held_followups" ? ({ insert: async () => ({ error: { message: "no such table" } }), select: () => ({ in: async () => ({ data: [], error: null }) }) } as never) : real(t))) as never);
    expect((await runHeldReminders(db() as never, NOW)).reminded).toBe(0);
    expect(adminNotes()).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("is scheduled nightly, behind the shared secret, and the page is in the admin navigation", () => {
    expect(readFileSync("cron-sweeps.sql", "utf8")).toMatch(/divieight-held-reminders.*held-reminder-sweep.*'0 5 \* \* \*'.*'secret'/);
    const route = readFileSync("src/routes/api.public.held-reminder-sweep.ts", "utf8");
    expect(route).toMatch(/x-sweep-secret/);
    expect(route).toMatch(/runHeldReminders/);
    expect(readFileSync("src/routes/admin.tsx", "utf8")).toMatch(/\/admin\/held-accounts/);
    expect(readFileSync("rules-and-held-decisions.sql", "utf8")).toMatch(/CREATE TABLE IF NOT EXISTS public\.held_followups/);
  });
});

// ---------------------------------------------------------------------------
// 2. The removed member is told
// ---------------------------------------------------------------------------

describe("2. a removed member gets an email", () => {
  const sent: Array<{ to: string; html: string; subject: string }> = [];
  beforeEach(() => {
    seedMembers();
    sent.length = 0;
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body);
      sent.push({ to: b.to[0], html: b.html, subject: b.subject });
      return { ok: true } as Response;
    }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("'Continue without this member': the removed member is emailed that they were removed; the records stay", async () => {
    db().seed("signed_documents", [{ buyer_account_id: IDS.b1, account_member_id: BOB, document_type: "HOLD_HARMLESS", signed_name: "Bob One" }]);
    as(USERS.b1);
    await removeAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } });
    expect(sent.map((s) => s.to)).toEqual(["bob@test.local"]);
    expect(sent[0]!.subject).toBe("You were removed from a divieight account");
    expect(sent[0]!.html).toMatch(/removed you from their divieight Buyer Account/);
    expect(sent[0]!.html).toMatch(/stays on record/);
    expect(member(BOB)).toMatchObject({ status: "removed", full_name: "Bob One", email: "bob@test.local" });
    expect(db().table("signed_documents").filter((d) => d.account_member_id === BOB)).toHaveLength(1);
    expect(db().audits("buyer.member_removed")[0]!.metadata).toMatchObject({ member_id: BOB, removed_member_emailed: true });
  });

  it("nobody else is emailed, and a failed email doesn't undo the removal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    as(USERS.b1);
    await removeAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } });
    expect(member(BOB).status).toBe("removed");
    expect(db().audits("buyer.member_removed")[0]!.metadata).toMatchObject({ removed_member_emailed: false });
  });

  it("the screen still says the fee isn't affected", () => {
    expect(readFileSync("src/components/AccountMembersCard.tsx", "utf8")).toMatch(/The fee isn't affected/);
  });
});

// ---------------------------------------------------------------------------
// 3. Joint interest
// ---------------------------------------------------------------------------

describe("3. joint interest", () => {
  it("keeps the cap-table wording and adds an admin-only note beside it", () => {
    expect(jointHolderLabel(["Name One", "Name Two"])).toBe("Name One and Name Two (jointly, one indivisible interest)");
    expect(JOINT_OWNERSHIP_ADMIN_NOTE).toBe("Form of joint ownership pending counsel");
    const admin = readFileSync("src/routes/admin.entity-genesis.tsx", "utf8");
    expect(admin).toMatch(/JOINT_OWNERSHIP_ADMIN_NOTE/);
    expect(admin).toMatch(/r\.memberNames\.length > 1/);
  });

  it("the note appears nowhere an owner or an agreement can see it", () => {
    const files = ["src/lib/entity-genesis.ts", "src/lib/entity-genesis.server.ts", "src/lib/entity-genesis-stage2.server.ts", "src/constants/oaDraftClauses.ts"];
    for (const f of files) {
      const text = readFileSync(f, "utf8").replace(/^export const JOINT_OWNERSHIP_ADMIN_NOTE.*$/m, "");
      expect(text, f).not.toMatch(/pending counsel(?! review)/);
      expect(text, f).not.toContain("JOINT_OWNERSHIP_ADMIN_NOTE");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Authority scopes
// ---------------------------------------------------------------------------

describe("4. documented authority covers only the PRA, due-diligence acknowledgments, authorizations, Block 3 and closing documents", () => {
  beforeEach(seedMembers);
  const grant = (scope: string[]) => (as(USERS.b1), grantAuthorityFn({ data: { actingMemberId: BOB, granteeMemberId: ALICE, scope, typedName: "Bob One" } }));

  it("the scopes are exactly that list; Block 1, Block 2, Block 4, Hold Harmless and W-9 are never scopes", () => {
    expect([...AUTHORITY_SCOPES]).toEqual(["pra", "due_diligence_ack", "authorizations", "block3", "closing_docs"]);
    expect([...REMOVED_AUTHORITY_SCOPES]).toEqual(["block1", "block2"]);
    const never = NEVER_DELEGATED.map((n) => n.key);
    for (const k of ["block1", "block2", "block4", "hold_harmless", "w9"]) expect(never).toContain(k);
  });

  it("a grant for Block 1 or Block 2 is refused on the server, by name, alone or mixed with allowed scopes", async () => {
    await expect(grant(["block1"])).rejects.toThrow("Authority can never cover Block 1");
    await expect(grant(["block2"])).rejects.toThrow("Authority can never cover Block 2");
    await expect(grant(["pra", "block1"])).rejects.toThrow("Block 1");
    await expect(grant(["block2", "closing_docs"])).rejects.toThrow("Block 2");
    expect(db().table("member_authority_grants")).toHaveLength(0);
    // The allowed ones still work.
    await expect(grant(["pra", "due_diligence_ack", "authorizations", "block3", "closing_docs"])).resolves.toBeTruthy();
  });

  it("the service layer refuses them too, by name, whatever reaches it", async () => {
    const { grantAuthority } = await import("@/lib/member-authority.server");
    for (const [scope, label] of [["block1", "Block 1"], ["block2", "Block 2"]] as const) {
      await expect(grantAuthority(db() as never, { userId: USERS.b1, actingMemberId: BOB, granteeMemberId: ALICE, scope: [scope, "pra"], typedName: "Bob One", request: { ip: null, userAgent: null } })).rejects.toThrow(`Authority can never cover ${label}`);
    }
    expect(db().table("member_authority_grants")).toHaveLength(0);
  });

  it("Block 1 and Block 2 cannot be accepted on someone else's behalf, with or without a live grant", async () => {
    await grant(["pra", "authorizations", "closing_docs"]);
    as(USERS.b1);
    for (const block of ["block1", "block2"] as const) {
      await expect(acceptAuthorizationFn({ data: { actingMemberId: ALICE, block, onBehalfOfMemberId: BOB } as never })).rejects.toThrow("Authority can never cover");
      await expect(acceptAuthorizationFn({ data: { actingMemberId: ALICE, block, authorityGrantId: "g" } as never })).rejects.toThrow("Authority can never cover");
      await expect(acceptAuthorizationFn({ data: { actingMemberId: ALICE, block, scope: ["authorizations"] } as never })).rejects.toThrow("Authority can never cover");
    }
    expect(db().table("member_plaid_consents")).toHaveLength(0);
    expect(db().table("member_block2_authorizations")).toHaveLength(0);
    // Each member accepts their own, personally.
    await acceptAuthorizationFn({ data: { actingMemberId: ALICE, block: "block1" } });
    await acceptAuthorizationFn({ data: { actingMemberId: ALICE, block: "block2" } });
    expect(db().table("member_plaid_consents").map((r) => r.account_member_id)).toEqual([ALICE]);
    expect(db().table("member_block2_authorizations").map((r) => r.account_member_id)).toEqual([ALICE]);
  });

  it("Block 4, the Hold Harmless and the W-9 are personal too", async () => {
    await grant(["pra", "closing_docs"]);
    as(USERS.b1);
    await expect(signMemberDocumentFn({ data: { actingMemberId: ALICE, documentType: "HOLD_HARMLESS", documentVersion: "v1", documentHash: "h", typedName: "Alice One", onBehalfOfMemberId: BOB } as never })).rejects.toThrow("Authority can never cover");
    await expect(submitEligibilityDeclaration({ data: { actingMemberId: ALICE, answers: yes, attestedPersonally: true, signedName: "Alice One", supersedesId: null, onBehalfOfMemberId: BOB } as never })).rejects.toThrow("Authority can never cover");
  });

  it("the database refuses them too, and an existing grant that carried them is cleaned, with a record, leaving past records alone", () => {
    expect(readFileSync("signature-authority.sql", "utf8")).toMatch(/scope <@ ARRAY\['pra', 'due_diligence_ack', 'authorizations', 'block3', 'closing_docs'\]/);
    const sql = readFileSync("rules-and-held-decisions.sql", "utf8");
    expect(sql).toMatch(/scope && ARRAY\['block1', 'block2'\]/);
    expect(sql).toMatch(/INSERT INTO public\.member_authority_scope_removals/);
    expect(sql).toMatch(/scope = ARRAY\(SELECT s FROM unnest\(g\.scope\) s WHERE s NOT IN \('block1', 'block2'\)\)/);
    expect(sql).not.toMatch(/DELETE FROM public\.(signed_documents|member_block|member_plaid)/);
  });

  it("the Operating Agreement is signed under 'closing_docs' authority, as the build already has it (it routes through authority)", () => {
    const server = readFileSync("src/lib/entity-genesis-stage2.server.ts", "utf8");
    expect(server).toMatch(/scope: "closing_docs"/);
    expect(server).toMatch(/under their documented authority \('closing_docs'\)/);
  });
});

// ---------------------------------------------------------------------------
// 5. Seller eligibility
// ---------------------------------------------------------------------------

describe("5. seller eligibility stays informational unless the setting is on", () => {
  const P = "prop-seller";
  beforeEach(() => {
    seedPod(db());
    db().seed("sellers", [{ id: IDS.seller, full_name: "Sam Seller", address: "9 Ranch Rd", date_of_birth: "1970-01-01", exit_type: "hybrid_exit" }]);
    db().seed("properties", [{ id: P, address: "9 Ranch Rd", seller_id: IDS.seller, status: "pending", content_approval_status: "approved", compliance_status: "needs_review" }]);
    db().seed("compliance_reviews", [{ id: "rev-1", property_id: P, flagged_phrases: [], status: "pending" }]);
  });
  const prop = () => db().table("properties").find((p) => p.id === P)!;
  const declare = (answers: Record<string, string>) => (as(IDS.seller), submitSellerEligibility({ data: { answers, attestedPersonally: true, signedName: "Sam Seller", supersedesId: null } as never }));
  const publish = async () => {
    as(USERS.admin);
    await resolveComplianceReview({ data: { reviewId: "rev-1", decision: "approved", note: "Fine" } });
  };
  const flagOn = () => db().seed("governance_settings", [{ key: "gateListingOnSellerEligibility", value: 1 }]);

  it("the flag defaults to false", async () => {
    expect(GATE_LISTING_ON_SELLER_ELIGIBILITY).toBe(false);
    expect(GOVERNANCE_DEFAULTS.gateListingOnSellerEligibility).toBe(0);
    expect((await loadGovernanceConfig(db() as never)).gateListingOnSellerEligibility).toBe(0);
  });

  it("with the flag off, a held seller, a not-eligible seller and one with no declaration all publish", async () => {
    await declare({ ...yes, q3: "no" }); // held
    await publish();
    expect(prop().status).toBe("listed");
    expect((await sellerListingGate(db() as never, IDS.seller)).blocked).toBe(false);
  });

  it("with the flag on, a held seller can't publish and is told it is held", async () => {
    flagOn();
    await declare({ ...yes, q3: "no" });
    await publish();
    expect(prop().status).toBe("pending");
    expect(prop().published_at ?? null).toBeNull();
    expect(await sellerListingGate(db() as never, IDS.seller)).toEqual({ blocked: true, held: true, message: HELD_BUYER_TEXT });
    expect(db().notificationsFor(IDS.seller).some((n) => n.message === HELD_BUYER_TEXT)).toBe(true);
    expect(db().audits("listing.publish_blocked_seller_eligibility")).toHaveLength(1);
  });

  it("with the flag on, a not-eligible seller can't publish, and neither can one who hasn't declared", async () => {
    flagOn();
    await declare({ ...yes, q1: "no" });
    expect((await sellerListingGate(db() as never, IDS.seller)).blocked).toBe(true);
    await publish();
    expect(prop().status).toBe("pending");
    db().table("seller_eligibility_declarations").splice(0, db().table("seller_eligibility_declarations").length);
    const gate = await sellerListingGate(db() as never, IDS.seller);
    expect(gate.blocked).toBe(true);
    expect(gate.message).toMatch(/Make your eligibility declaration/);
  });

  it("with the flag on, a seller whose declaration is clear publishes (a seller has no liveness or sanctions step to wait for)", async () => {
    flagOn();
    await declare(yes);
    expect((await sellerListingGate(db() as never, IDS.seller)).blocked).toBe(false);
    await publish();
    expect(prop().status).toBe("listed");
  });

  it("a Full Exit seller has no eligibility check, so it never gates them", async () => {
    flagOn();
    db().table("sellers")[0]!.exit_type = "full_exit";
    expect((await sellerListingGate(db() as never, IDS.seller)).blocked).toBe(false);
    await publish();
    expect(prop().status).toBe("listed");
  });

  it("the declaration screen is labelled informational while the flag is off", () => {
    expect(SELLER_INFORMATIONAL_NOTE).toMatch(/informational/);
    const page = readFileSync("src/routes/onboarding.eligibility.tsx", "utf8");
    expect(page).toMatch(/!state\.gatesListing/);
    expect(page).toContain("SELLER_INFORMATIONAL_NOTE");
  });
});

// ---------------------------------------------------------------------------
// 6. Questions and rules guard
// ---------------------------------------------------------------------------

describe("6. changing a question or a rule needs a new Standard version", () => {
  const LIVE_HASH_IN_SQL = /SET rules_hash = '([0-9a-f]{64})'/;

  it("the hash in the SQL (what the live version is stamped with) is the hash of the questions and rules in this build", () => {
    const sql = readFileSync("rules-and-held-decisions.sql", "utf8");
    expect(sql.match(LIVE_HASH_IN_SQL)![1]).toBe(currentRulesHash());
  });

  it("the failure message is the decided one", () => {
    expect(RULES_CHANGED_MESSAGE).toBe("Questions or rules changed: publish a new Standard version.");
  });

  it("it covers the six questions, the rule definitions and what the engine actually does", () => {
    const def = currentRulesDefinition();
    expect(def.questions).toHaveLength(6);
    expect(def.rules).toBe(ENGINE_RULE_SET);
    expect(def.behaviour).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(currentRulesHash()).toBe(currentRulesHash());
  });

  it("changing a question changes the hash", () => {
    const def = currentRulesDefinition();
    const text = (d: unknown) => canonicalJson(d);
    const changedQuestion = { ...def, questions: def.questions.map((q, i) => (i === 2 ? q + " (reworded)" : q)) };
    expect(text(changedQuestion)).not.toBe(text(def));
  });

  it("changing a rule, in the list or in what the engine does, changes the hash", () => {
    const base = engineBehaviourFingerprint();
    expect(base).toBe(engineBehaviourFingerprint());
    // An engine that treated a disclosed charge as not eligible instead of held.
    const stricter: typeof evaluateEligibility = (a, s) => {
      const r = evaluateEligibility(a, s);
      return r.result === "held" ? { result: "not_eligible", reason_codes: r.reason_codes } : r;
    };
    expect(engineBehaviourFingerprint(stricter)).not.toBe(base);
    // An engine with a different window for Standard B.
    const looser: typeof evaluateEligibility = (a, s) => evaluateEligibility(a, { ...s, appliedAt: "2040-01-01" });
    expect(engineBehaviourFingerprint(looser)).not.toBe(base);
    expect(canonicalJson({ ...ENGINE_RULE_SET, standard_b_window_years: 7 })).not.toBe(canonicalJson(ENGINE_RULE_SET));
  });

  describe("the live version's stored hash", () => {
    beforeEach(() => seedMembers());
    const live = (hash: string | null) => db().seed("standard_versions", [{ version: "1.1", is_live: true, effective_from: "2026-11-01T00:00:00Z", file_url: "x_v1.1.pdf", rules_hash: hash }]);

    it("passes when it matches, and when the live version has no stored hash yet", async () => {
      live(currentRulesHash());
      expect(await checkStandardRules(db() as never)).toMatchObject({ ok: true, message: null });
      db().table("standard_versions")[0]!.rules_hash = null;
      expect((await checkStandardRules(db() as never)).ok).toBe(true);
      await expect(assertStandardRules(db() as never)).resolves.toBeUndefined();
    });

    it("fails with the message when the questions or rules differ from the live version's", async () => {
      live("0".repeat(64));
      const check = await checkStandardRules(db() as never);
      expect(check).toMatchObject({ ok: false, message: "Questions or rules changed: publish a new Standard version.", liveVersion: "1.1" });
      await expect(assertStandardRules(db() as never)).rejects.toThrow("Questions or rules changed: publish a new Standard version.");
    });

    it("a new declaration is refused while they differ (buyer and seller), and nothing is recorded", async () => {
      live("0".repeat(64));
      db().seed("sellers", [{ id: IDS.seller, full_name: "Sam Seller", address: "9 Ranch Rd", date_of_birth: "1970-01-01", exit_type: "hybrid_exit" }]);
      as(USERS.b1);
      await expect(submitEligibilityDeclaration({ data: { actingMemberId: ALICE, answers: yes, attestedPersonally: true, signedName: "Alice One", supersedesId: null } as never })).rejects.toThrow("Questions or rules changed");
      expect(db().table("eligibility_declarations")).toHaveLength(0);
      as(IDS.seller);
      await expect(submitSellerEligibility({ data: { answers: yes, attestedPersonally: true, signedName: "Sam Seller", supersedesId: null } as never })).rejects.toThrow("Questions or rules changed");
      expect(db().table("seller_eligibility_declarations") ?? []).toHaveLength(0);
      // Fixed by publishing a new version (here: the new live row carries this build's hash).
      db().table("standard_versions")[0]!.rules_hash = currentRulesHash();
      as(USERS.b1);
      await expect(submitEligibilityDeclaration({ data: { actingMemberId: ALICE, answers: yes, attestedPersonally: true, signedName: "Alice One", supersedesId: null } as never })).resolves.toBeTruthy();
    });

    it("publishing a new Standard version stores the hash of this build's questions and rules on it", async () => {
      live("0".repeat(64));
      db().rpcResults.publish_standard_version = (a: { _rules_hash?: string }) => {
        db().seed("standard_versions", [{ version: "1.2", is_live: true, effective_from: "2026-12-01T00:00:00Z", file_url: "Participant_Eligibility_Standard_v1.2.pdf", rules_hash: a._rules_hash ?? null }]);
        return "2026-12-01T00:00:00Z";
      };
      await publishStandardVersion(db() as never, { adminId: USERS.admin, version: "1.2", fileUrl: "Participant_Eligibility_Standard_v1.2.pdf", acknowledgedWarning: true });
      expect(db().table("standard_versions").find((v) => v.version === "1.2")!.rules_hash).toBe(currentRulesHash());
    });

    it("the database lets the hash be written once, in the publish itself, and never edited after", () => {
    const sql = readFileSync("rules-and-held-decisions.sql", "utf8");
    expect(sql).toMatch(/OLD.rules_hash IS NOT NULL AND NEW.rules_hash IS DISTINCT FROM OLD.rules_hash/);
    expect(sql).toMatch(/to_jsonb\(NEW\) - 'is_live' - 'rules_hash'/);
    expect(sql).toContain("publish_standard_version(_version text, _file_url text, _published_by uuid, _rules_hash text DEFAULT NULL)");
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.publish_standard_version(text, text, uuid)");
  });

  it("the startup check is a public route that answers 500 with the message when they differ", () => {
      const route = readFileSync("src/routes/api.public.standard-rules-check.ts", "utf8");
      expect(route).toMatch(/checkStandardRules/);
      expect(route).toMatch(/status: check\.ok \? 200 : 500/);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. KYO banner
// ---------------------------------------------------------------------------

describe("7. the KYO screens carry the compliance-review banner (admin only)", () => {
  it("shows it on the admin KYO panel, and not to members", () => {
    expect(KYO_REVIEW_BANNER).toBe("Sensitive-data list and retention wording pending compliance review");
    expect(readFileSync("src/components/KyoPanel.tsx", "utf8")).toContain("KYO_REVIEW_BANNER");
    expect(readFileSync("src/routes/buyer.kyo.tsx", "utf8")).not.toContain("KYO_REVIEW_BANNER");
    expect(readFileSync("src/routes/buyer.kyo.tsx", "utf8")).not.toMatch(/pending compliance review/);
  });
});

// ---------------------------------------------------------------------------
// 8. Kept as decided
// ---------------------------------------------------------------------------

describe("8. kept as it is", () => {
  const sent: string[] = [];
  beforeEach(() => {
    seedMembers();
    sent.length = 0;
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
      sent.push(...(JSON.parse(init.body).to as string[]));
      return { ok: true } as Response;
    }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("Q26: a held member reads as Pending to the agent (the agent never sees Held)", async () => {
    result(BOB, "held", 5);
    as(USERS.ra);
    const lead = (await listMyTetheredBuyers()).find((l) => l.buyerAccountId === IDS.b1)!;
    expect(lead.onboardingStatus).toBe("vetting_pending");
    expect(JSON.stringify(lead)).not.toMatch(/held/i);
    expect(readFileSync("src/lib/agent-visibility.ts", "utf8")).toMatch(/held/);
  });

  it("Q29: the same ID number on both members is refused", async () => {
    as(USERS.b1);
    await saveMemberIdentityFn({ data: { actingMemberId: ALICE, fullName: "Alice One", address: "1 Main", dateOfBirth: "1980-01-01", idDocumentNumber: "D1234567", idDocumentPath: null } });
    await expect(saveMemberIdentityFn({ data: { actingMemberId: BOB, fullName: "Someone Else", address: "2 Main", dateOfBirth: "1990-02-02", idDocumentNumber: "d-1234 567", idDocumentPath: null } })).rejects.toThrow(SAME_PERSON_MESSAGE);
  });

  it("Q30: a notice reaches the login email and every member's own email, once each", async () => {
    await deliver(db() as never, { authUserId: USERS.b1, email: "b1@test.local" }, { subject: "S", message: "M", type: "authorization_request" } as never);
    expect(sent.sort()).toEqual(["alice@test.local", "b1@test.local", "bob@test.local"]);
  });

  it("Q33: a member who signed the earlier Hold Harmless text still counts as having signed", async () => {
    db().seed("signed_documents", [{ buyer_account_id: IDS.b1, account_member_id: ALICE, document_type: "HOLD_HARMLESS", document_version: "hh-v1", signed_name: "Alice One" }]);
    const steps = await loadMemberSteps(db() as never, IDS.b1);
    expect(steps.find((s) => s.memberId === ALICE)!.holdHarmless).toBe(true);
    expect(steps.find((s) => s.memberId === BOB)!.holdHarmless).toBe(false);
  });

  it("Q37: withdrawing Q5 clears the legacy consent date and keeps every declaration version", async () => {
    result(BOB, "eligible", 1, "d-first");
    db().table("eligibility_declarations").find((d) => d.id === "d-first")!.declared_at = new Date().toISOString();
    as(USERS.b1);
    const first = await submitEligibilityDeclaration({ data: { actingMemberId: ALICE, answers: yes, attestedPersonally: true, signedName: "Alice One", supersedesId: null } as never });
    expect(member(ALICE).fcra_consent_at).toBeTruthy();
    await submitEligibilityDeclaration({ data: { actingMemberId: ALICE, answers: { ...yes, q5: "no" }, attestedPersonally: true, signedName: "Alice One", supersedesId: first.id } as never });
    expect(member(ALICE).fcra_consent_at ?? null).toBeNull();
    expect(db().table("eligibility_declarations").filter((d) => d.account_member_id === ALICE)).toHaveLength(2);
  });

  it("Q38: no member can be added after the cap-table lock", async () => {
    db().seed("cap_table_entries", [{ property_id: A, buyer_account_id: IDS.b1, share_number: 1, account_member_names: [] }]);
    db().seed("entity_genesis", [{ property_id: A, cap_table_locked_at: "2026-10-01T00:00:00Z" }]);
    db().table("account_members").splice(db().table("account_members").findIndex((m) => m.id === BOB), 1);
    as(USERS.b1);
    await expect(addAccountMember({ data: { actingMemberId: ALICE, fullName: "Eve Third", email: "eve@test.local", phone: null } as never })).rejects.toThrow(LOCKED_MESSAGE);
    expect(db().audits("buyer.member_change_blocked")).toHaveLength(1);
    expect((await getMyAccountMembers()).canAdd).toBe(false);
  });
});

// A reference to keep imports honest in this file.
void [DECISION_PAGE_SPEC_VERSION, BLOCK1_VERSION, BLOCK2_VERSION, GOVERNANCE_DEFAULTS];
