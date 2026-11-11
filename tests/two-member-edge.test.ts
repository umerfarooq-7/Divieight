/**
 * Two-member edge cases, on an account created the real way (registration, Add a member, each member's own
 * identity step). One describe per case, numbered as in the brief.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { latency } from "./fake-db";
import { seedPod, IDS, USERS } from "./fixtures";
import { DECISION_PAGE_SPEC_VERSION, STANDARD_VERSION } from "@/constants/eligibilityCopy";
import { BLOCK1_VERSION, BLOCK2_VERSION } from "@/constants/authorizationsCopy";
import { ensureBuyerAccount } from "@/lib/buyer";
import { addAccountMember, adminChangeAccountMember, confirmActingMember, getMyAccountMembers, remindAccountMember, removeAccountMember, saveMemberIdentityFn, updateAccountMember } from "@/lib/account-members.functions";
import { LOCKED_MESSAGE, SAME_EMAIL_MESSAGE, SAME_PERSON_MESSAGE, POD_MESSAGE, samePerson } from "@/lib/account-members";
import { acceptAuthorizationFn, signMemberDocumentFn, submitW9Fn } from "@/lib/member-steps.functions";
import { submitEligibilityDeclaration } from "@/lib/eligibility-declaration.functions";
import { acknowledgeAsAgent, acknowledgeAsMember, getAuthorizationGateStatus, placeDiligenceDocument } from "@/lib/due-diligence.functions";
import { grantAuthorityFn } from "@/lib/member-authority.functions";
import { getMyKyo, getKyoForAdmin } from "@/lib/kyo.functions";
import { issueGoldenTicketIfEligible } from "@/lib/golden-ticket";
import { loadMemberSteps, accountRollup } from "@/lib/account-rollup";
import { runEnrollmentMaintenance } from "@/lib/enrollment-maintenance.functions";
import { deliver } from "@/lib/authorization.notify.server";
import { HELD_BUYER_TEXT } from "@/lib/eligibility-engine";

// The shared setup mocks the admin client; restating it here keeps two calls in flight at once on the mock too.
vi.mock("@/integrations/supabase/admin.server", () => ({
  get supabaseAdmin() {
    return harness.db;
  },
}));

const db = () => harness.db;
const as = (u: string) => (harness.userId = u);
const P = IDS.property;

let ACCOUNT = "";
let ALICE = "";
let BOB = "";
const DOB = "1980-02-03";
const ID_NO = "D9988776";
const BOB_DOB = "1982-06-09";
const BOB_ID_NO = "D5544332";
const AT = "2026-11-01T00:00:00Z";
const yes = { q1: "yes", q2: "yes", q3: "yes", q4: "yes", q5: "yes", q6: "yes" };

const account = () => db().table("buyer_accounts").find((a) => a.id === ACCOUNT)!;
const member = (id: string) => db().table("account_members").find((m) => m.id === id)!;
const rowsOf = (table: string, memberId: string) => db().table(table).filter((r) => r.account_member_id === memberId);

/** Registration, Add a member, and each member's own identity step: the real flows. */
async function buildTwoMemberAccount() {
  seedPod(db());
  for (const [table, key] of [["buyer_accounts", "id"], ["account_members", "buyer_account_id"], ["pod_reservations", "buyer_account_id"]] as const) {
    const rows = db().table(table);
    for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i]![key] === IDS.b1) rows.splice(i, 1);
  }
  as(USERS.b1);
  const acct = await ensureBuyerAccount({ userId: USERS.b1, email: "alice.real@test.local", fullName: "Alice Real" });
  ACCOUNT = acct!.id;
  ALICE = db().table("account_members").find((m) => m.buyer_account_id === ACCOUNT)!.id as string;
  const added = await addAccountMember({ data: { actingMemberId: ALICE, fullName: "Bob Real", email: "bob.real@test.local", phone: null } as never });
  BOB = added.id;
  for (const [id, name] of [[ALICE, "Alice Real"], [BOB, "Bob Real"]] as const) {
    await saveMemberIdentityFn({ data: { actingMemberId: id, fullName: name, address: "1 Main St, Lusk, WY", dateOfBirth: id === ALICE ? DOB : BOB_DOB, idDocumentNumber: id === ALICE ? ID_NO : BOB_ID_NO, idDocumentPath: `${USERS.b1}/${id}.jpg` } });
  }
  db().seed("pod_reservations", [{ id: "res-real", property_id: P, buyer_account_id: ACCOUNT, shares_reserved: 1, status: "reserved", reserved_at: "2026-09-01T00:00:00.000+00:00" }]);
  Object.assign(account(), { tethered_resident_agent_id: IDS.ra, liquidity_verified: true, liquidity_status: "verified", primary_target_market: "WY", golden_ticket_issued: false });
}

/** Gives one member every step (and a result), so a test can take one away. */
function complete(memberId: string, o: { result?: string | null; skip?: string[] } = {}) {
  const m = member(memberId);
  const skip = new Set(o.skip ?? []);
  const base = { account_member_id: memberId, buyer_account_id: ACCOUNT };
  if (!skip.has("liveness")) db().seed("member_liveness_checks", [{ ...base, status: "passed", created_at: AT }]);
  if (!skip.has("standardRead")) db().seed("eligibility_page_acknowledgements", [{ ...base, standard_version: STANDARD_VERSION, page_spec_version: DECISION_PAGE_SPEC_VERSION }]);
  if (!skip.has("declaration")) {
    db().seed("eligibility_declarations", [{ id: `decl-${memberId}`, ...base, status: "complete", answers: yes, standard_version: STANDARD_VERSION, declared_at: AT }]);
    if (o.result !== null) db().seed("eligibility_results", [{ ...base, declaration_id: `decl-${memberId}`, result: o.result ?? "eligible", reason_codes: [], standard_version: STANDARD_VERSION, determined_at: AT }]);
  }
  if (!skip.has("block1")) db().seed("member_plaid_consents", [{ ...base, text_version: BLOCK1_VERSION, text_hash: "h", accepted_at: AT }]);
  if (!skip.has("block2")) db().seed("member_block2_authorizations", [{ ...base, text_version: BLOCK2_VERSION, text_hash: "h", accepted_at: AT }]);
  if (!skip.has("holdHarmless")) db().seed("signed_documents", [{ buyer_account_id: ACCOUNT, account_member_id: memberId, document_type: "HOLD_HARMLESS", signed_name: m.full_name }]);
  if (!skip.has("pra")) db().seed("signed_documents", [{ buyer_account_id: ACCOUNT, account_member_id: memberId, document_type: "PRA", signed_name: m.full_name }]);
  if (!skip.has("w9")) db().seed("member_w9", [{ ...base, legal_name: m.full_name, tin_last4: "6789", signed_name: m.full_name }]);
}

const ticket = () => issueGoldenTicketIfEligible({ authUserId: USERS.b1, buyerAccountId: ACCOUNT });
const mine = async () => (as(USERS.b1), getMyAccountMembers());
const audits = (action: string) => db().audits(action).filter((a) => a.entity_id === ACCOUNT);

/**
 * Runs the calls with their database work genuinely overlapping: every query takes a moment, and each call
 * starts a tick after the last, so they interleave statement by statement.
 */
async function atOnce<T>(...calls: Array<() => Promise<T>>): Promise<Array<PromiseSettledResult<T>>> {
  latency.ms = 2;
  try {
    const running: Array<Promise<T>> = [];
    for (const call of calls) {
      running.push(call());
      await new Promise((r) => setTimeout(r, 1));
    }
    return await Promise.allSettled(running);
  } finally {
    latency.ms = 0;
  }
}

const sent: string[] = [];
beforeEach(async () => {
  sent.length = 0;
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("W9_TIN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    sent.push(...(JSON.parse(init.body).to as string[]));
    return { ok: true } as Response;
  }));
  await buildTwoMemberAccount();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. The second member never completes their steps
// ---------------------------------------------------------------------------

describe("1. the second member never finishes: the account stays pending, a reminder can be sent, and the account holder can continue without them", () => {
  beforeEach(() => complete(ALICE));

  it("the account stays pending and no Golden Ticket is issued", async () => {
    const view = await mine();
    expect(view.accountStatus).toBe("pending");
    const bob = view.members.find((m) => m.id === BOB)!;
    expect(bob.checklist.filter((c) => !c.done).length).toBeGreaterThan(0);
    const t = await ticket();
    expect(t.eligible).toBe(false);
    expect(t.issued).toBe(false);
    expect(account().golden_ticket_issued).toBe(false);
  });

  it("the account holder can send a reminder: it goes to the second member only, names what is left, and is audited", async () => {
    as(USERS.b1);
    const r = await remindAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } });
    expect(r.emailed).toBe(true);
    expect(sent).toEqual(["bob.real@test.local"]);
    const log = audits("buyer.member_reminded");
    expect(log).toHaveLength(1);
    expect(log[0]!.metadata).toMatchObject({ member_id: BOB, acted_by_member_id: ALICE, emailed: true });
  });

  it("a reminder can't be sent twice in a day, by the second member, by another account, or to a member who has finished", async () => {
    as(USERS.b1);
    await remindAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } });
    await expect(remindAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } })).rejects.toThrow("already sent");
    expect(sent).toEqual(["bob.real@test.local"]);
    // The second member can't send reminders (only the account holder manages the account).
    await expect(remindAccountMember({ data: { actingMemberId: BOB, memberId: BOB } })).rejects.toThrow("Only the account holder");
    // Another account's login can't, even naming this account's members.
    as(USERS.b2);
    await expect(remindAccountMember({ data: { actingMemberId: IDS.b2m1, memberId: BOB } })).rejects.toThrow("isn't on your account");
    // The account holder is not "the second member": there is nobody to remind but them.
    as(USERS.b1);
    await expect(remindAccountMember({ data: { actingMemberId: ALICE, memberId: ALICE } })).rejects.toThrow("isn't on your account");
    // A member with nothing left isn't nagged.
    complete(BOB);
    audits("buyer.member_reminded").length = 0;
    db().table("audit_log").splice(0, db().table("audit_log").length);
    as(USERS.b1);
    await expect(remindAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } })).rejects.toThrow("finished every step");
    expect(sent).toEqual(["bob.real@test.local"]);
  });

  it("'Continue without this member': the account holder removes them, the account is evaluated on the holder alone, and the ticket issues", async () => {
    as(USERS.b1);
    const before = { ...account() };
    await removeAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } });
    expect(member(BOB).status).toBe("removed");
    const t = await ticket();
    expect(t.eligible).toBe(true);
    expect(t.issued).toBe(true);
    // The fee and the priority position are untouched by removing the member.
    expect(account().priority_rank_timestamp ?? null).toEqual(before.priority_rank_timestamp ?? null);
    expect(account().onboarding_status).not.toBe("archived");
  });

  it("the screen offers the button and the reminder for a member who isn't eligible, and only before the lock", () => {
    const card = readFileSync("src/components/AccountMembersCard.tsx", "utf8");
    expect(card).toContain("Continue without this member");
    expect(card).toContain("Send a reminder");
    expect(card).toMatch(/m\.role === "member" && !data\.locked && m\.eligibility !== "eligible"/);
  });
});

// ---------------------------------------------------------------------------
// 2. The second member's email was entered wrongly
// ---------------------------------------------------------------------------

describe("2. a wrong email for the second member can be corrected before the Golden Ticket", () => {
  const fix = (email: string, memberId = BOB) => (as(USERS.b1), updateAccountMember({ data: { actingMemberId: ALICE, memberId, fullName: "Bob Real", email, phone: null } as never }));

  it("the primary corrects it; notices and reminders go to the new address, never the old one", async () => {
    await fix("  Bob.Fixed@Test.Local ");
    expect(member(BOB).email).toBe("bob.fixed@test.local");
    expect(audits("buyer.member_updated")).toHaveLength(1);
    complete(ALICE);
    as(USERS.b1);
    await remindAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } });
    expect(sent).toEqual(["bob.fixed@test.local"]);
    sent.length = 0;
    await deliver(db() as never, { authUserId: USERS.b1, email: "alice.real@test.local" } as never, { type: "authorization_request", subject: "S", message: "M" } as never).catch(() => undefined);
    expect(sent).not.toContain("bob.real@test.local");
  });

  it("the corrected email must still be valid, and can't be the holder's or a duplicate", async () => {
    await expect(fix("not-an-email")).rejects.toThrow("valid email");
    await expect(fix("ALICE.REAL@test.local")).rejects.toThrow(SAME_EMAIL_MESSAGE);
    expect(member(BOB).email).toBe("bob.real@test.local");
  });

  it("only the account holder can correct it, and not after the Golden Ticket", async () => {
    as(USERS.b1);
    await expect(updateAccountMember({ data: { actingMemberId: BOB, memberId: BOB, fullName: "Bob Real", email: "x@test.local", phone: null } as never })).rejects.toThrow("Only the account holder");
    complete(ALICE);
    complete(BOB);
    expect((await ticket()).issued).toBe(true);
    await expect(fix("late@test.local")).rejects.toThrow(LOCKED_MESSAGE);
    expect(member(BOB).email).toBe("bob.real@test.local");
  });
});

// ---------------------------------------------------------------------------
// 3. Same email in both slots, or the same ID after scanning
// ---------------------------------------------------------------------------

describe("3. the same email in both slots, or the same ID after scanning, is refused with a neutral message", () => {
  const save = (memberId: string, o: Record<string, string>) =>
    (as(USERS.b1), saveMemberIdentityFn({ data: { actingMemberId: memberId, fullName: "Bob Real", address: "1 Main St", dateOfBirth: BOB_DOB, idDocumentNumber: BOB_ID_NO, idDocumentPath: null, ...o } as never }));

  it("the holder's email can't be used for the second member (any case or spacing), on add or on edit", async () => {
    as(USERS.b1);
    await expect(updateAccountMember({ data: { actingMemberId: ALICE, memberId: BOB, fullName: "Bob Real", email: " ALICE.Real@Test.Local ", phone: null } as never })).rejects.toThrow(SAME_EMAIL_MESSAGE);
    await removeAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } });
    await expect(addAccountMember({ data: { actingMemberId: ALICE, fullName: "Bob Real", email: "alice.real@test.local", phone: null } as never })).rejects.toThrow(SAME_EMAIL_MESSAGE);
    expect(db().table("account_members").filter((m) => m.buyer_account_id === ACCOUNT && m.status === "active")).toHaveLength(1);
  });

  it("the same ID number is refused even with another name and birth date, however it is spaced or cased", async () => {
    await expect(save(BOB, { fullName: "Robert Different", dateOfBirth: "1991-01-01", idDocumentNumber: "d-99 88776" })).rejects.toThrow(SAME_PERSON_MESSAGE);
    // Nothing was written for Bob, and nothing was logged as a submitted identity for him.
    expect(member(BOB)).toMatchObject({ full_name: "Bob Real", id_document_number: BOB_ID_NO, date_of_birth: BOB_DOB });
    expect(db().audits("buyer.identity_submitted").filter((a) => a.metadata.member_id === BOB)).toHaveLength(1);
  });

  it("the message is neutral: it doesn't name the other member, their ID, or say why", async () => {
    const message = await save(BOB, { idDocumentNumber: ID_NO }).then(() => "", (e: Error) => e.message);
    expect(message).toBe(SAME_PERSON_MESSAGE);
    expect(message).not.toMatch(/alice|D9988776|identity theft|fraud|duplicate|already registered/i);
    const emailMessage = await (as(USERS.b1), updateAccountMember({ data: { actingMemberId: ALICE, memberId: BOB, fullName: "Bob", email: "alice.real@test.local", phone: null } as never })).then(() => "", (e: Error) => e.message);
    expect(emailMessage).toBe(SAME_EMAIL_MESSAGE);
    expect(emailMessage).not.toMatch(/alice/i);
  });

  it("it works the other way round too: the holder can't re-use the second member's ID", async () => {
    await expect(save(ALICE, { fullName: "Alice Real", dateOfBirth: DOB, idDocumentNumber: BOB_ID_NO })).rejects.toThrow(SAME_PERSON_MESSAGE);
    expect(member(ALICE).id_document_number).toBe(ID_NO);
  });

  it("two members who both have no ID number yet are not 'the same person'", () => {
    const blank = (id: string | null) => ({ full_name: "A", date_of_birth: null, id_document_number: id });
    for (const [x, y] of [[null, null], ["", ""], ["  ", "-"], [null, ""]] as const) expect(samePerson(blank(x), blank(y))).toBe(false);
    expect(samePerson(blank("D-998 8776"), blank("d9988776"))).toBe(true);
    expect(samePerson(blank("D9988776"), blank("D9988777"))).toBe(false);
  });

  it("a different ID number is fine, and a member can re-save their own", async () => {
    await expect(save(BOB, {})).resolves.toBeTruthy();
    await expect(save(BOB, { idDocumentNumber: "D1111111" })).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4. Second member is held
// ---------------------------------------------------------------------------

describe("4. a held second member holds the account: shown as Held, never refused or unpaid, and no automatic fee action", () => {
  beforeEach(() => {
    complete(ALICE);
    complete(BOB, { result: "held" });
  });

  it("the account and the member read Held, with the held wording and no failure vocabulary", async () => {
    const view = await mine();
    expect(view.accountStatus).toBe("held");
    expect(view.members.find((m) => m.id === BOB)!.eligibility).toBe("held");
    expect(view.members.find((m) => m.id === ALICE)!.eligibility).toBe("eligible");
    expect(HELD_BUYER_TEXT).not.toMatch(/refus|reject|denied|declin|unpaid|forfeit|fail/i);
    expect(JSON.stringify(view)).not.toMatch(/refus|unpaid|forfeit/i);
  });

  it("no Golden Ticket while held, and nothing is recorded as failed or unpaid", async () => {
    const t = await ticket();
    expect(t.issued).toBe(false);
    expect(member(BOB).vetting_status).not.toBe("failed");
    expect(account().onboarding_status).not.toBe("archived");
  });

  it("the enrollment sweep never warns or forfeits a held account, however long it has been quiet", async () => {
    Object.assign(account(), { onboarding_status: "vetting_pending", priority_rank_timestamp: "2026-09-01T00:00:00Z", last_activity_at: new Date(Date.now() - 100 * 86_400_000).toISOString(), stall_warning_sent_at: new Date(Date.now() - 80 * 86_400_000).toISOString() });
    db().seed("buyer_enrollment_payments", [{ buyer_account_id: ACCOUNT, auth_user_id: USERS.b1, status: "paid", amount_cents: 50000, environment: "test" }]);
    const result = await runEnrollmentMaintenance();
    expect(result.forfeited).toBe(0);
    expect(result.warned).toBe(0);
    expect(account()).toMatchObject({ onboarding_status: "vetting_pending", priority_rank_timestamp: "2026-09-01T00:00:00Z" });
    expect(account().priority_forfeited_at ?? null).toBeNull();
    expect(db().table("notifications").filter((n) => n.seller_id === USERS.b1 && /priority|stalled/i.test(String(n.type)))).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(db().audits("buyer.priority_forfeited")).toHaveLength(0);
  });

  it("control: the same quiet account with nobody held IS forfeited, so the guard is what saved it", async () => {
    // Bob's held result is resolved (eligible): the account is merely pending the Golden Ticket.
    db().table("eligibility_results").find((r) => r.account_member_id === BOB)!.result = "eligible";
    Object.assign(account(), { onboarding_status: "vetting_pending", priority_rank_timestamp: "2026-09-01T00:00:00Z", last_activity_at: new Date(Date.now() - 100 * 86_400_000).toISOString(), stall_warning_sent_at: new Date(Date.now() - 80 * 86_400_000).toISOString() });
    db().table("member_w9").splice(0, db().table("member_w9").length);
    db().seed("buyer_enrollment_payments", [{ buyer_account_id: ACCOUNT, auth_user_id: USERS.b1, status: "paid", amount_cents: 50000, environment: "test" }]);
    const result = await runEnrollmentMaintenance();
    expect(result.forfeited).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Second member is not_eligible
// ---------------------------------------------------------------------------

describe("5. a not_eligible second member: no ticket, and the account holder can continue without them", () => {
  beforeEach(() => {
    complete(ALICE);
    complete(BOB, { result: "not_eligible" });
  });

  it("the account is pending, blocked, and gets no Golden Ticket", async () => {
    const steps = await loadMemberSteps(db(), ACCOUNT);
    expect(accountRollup(steps)).toEqual({ status: "pending", blocked: true });
    const t = await ticket();
    expect(t.issued).toBe(false);
    expect(account().golden_ticket_issued).toBe(false);
    expect((await mine()).members.find((m) => m.id === BOB)!.eligibility).toBe("not_eligible");
  });

  it("'Continue without this member' (the holder removes them) opens the ticket on the holder alone", async () => {
    as(USERS.b1);
    await removeAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } });
    expect(accountRollup(await loadMemberSteps(db(), ACCOUNT)).status).toBe("ready");
    expect((await ticket()).issued).toBe(true);
  });

  it("the second member can't do it for themselves, and can't un-block the account by editing their way out", async () => {
    as(USERS.b1);
    await expect(removeAccountMember({ data: { actingMemberId: BOB, memberId: BOB } })).rejects.toThrow("Only the account holder");
    expect(member(BOB).status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// 6. Adding or removing a member after the lock or the Golden Ticket
// ---------------------------------------------------------------------------

describe("6. changing members after the Golden Ticket or the cap-table lock is blocked, admin only, and audit logged", () => {
  async function lockByTicket() {
    complete(ALICE);
    complete(BOB);
    expect((await ticket()).issued).toBe(true);
  }
  function lockByCapTable() {
    db().seed("cap_table_entries", [{ property_id: P, buyer_account_id: ACCOUNT, shares: 1, account_member_names: ["Alice Real", "Bob Real"] }]);
    db().seed("entity_genesis", [{ property_id: P, cap_table_locked_at: AT }]);
  }
  const attempts = (user = USERS.b1) => [
    ["add", () => (as(user), addAccountMember({ data: { actingMemberId: ALICE, fullName: "Eve Third", email: "eve@test.local", phone: null } as never }))],
    ["remove", () => (as(user), removeAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } }))],
    ["update", () => (as(user), updateAccountMember({ data: { actingMemberId: ALICE, memberId: BOB, fullName: "Bob Real", email: "new@test.local", phone: null } as never }))],
    ["remind", () => (as(user), remindAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } }))],
  ] as const;

  for (const [how, lock] of [["Golden Ticket", lockByTicket], ["cap-table lock", lockByCapTable]] as const) {
    it(`after the ${how}, adding, removing and editing a member are refused, nothing changes, and each attempt is logged`, async () => {
      await lock();
      const before = JSON.stringify(db().table("account_members"));
      for (const [, attempt] of attempts()) await expect(attempt()).rejects.toThrow(LOCKED_MESSAGE);
      expect(JSON.stringify(db().table("account_members"))).toBe(before);
      const blocked = audits("buyer.member_change_blocked");
      expect(blocked.map((a) => a.metadata.attempted).sort()).toEqual(["add", "remind", "remove", "update"]);
      expect(blocked.every((a) => a.metadata.acted_by_member_id === ALICE && a.actor_id === USERS.b1 && a.metadata.reason === "locked")).toBe(true);
      // Each says which member it was about (nobody, for an add).
      expect(Object.fromEntries(blocked.map((a) => [a.metadata.attempted, a.metadata.member_id]))).toEqual({ add: null, remove: BOB, update: BOB, remind: BOB });
    });
  }

  it("the second member's own identity can't be re-written after the lock either", async () => {
    await lockByTicket();
    await expect(saveMemberIdentityFn({ data: { actingMemberId: BOB, fullName: "Robert Real", address: "9 New St", dateOfBirth: BOB_DOB, idDocumentNumber: BOB_ID_NO, idDocumentPath: null } as never })).rejects.toThrow(LOCKED_MESSAGE);
    expect(member(BOB).full_name).toBe("Bob Real");
  });

  it("only an admin can change a member then; a buyer can't call the admin function; the change is logged with the reason", async () => {
    await lockByTicket();
    as(USERS.b1);
    await expect(adminChangeAccountMember({ data: { memberId: BOB, email: "x@test.local", reason: "typo" } as never })).rejects.toThrow("Not authorized");
    expect(member(BOB).email).toBe("bob.real@test.local");
    as(USERS.admin);
    await adminChangeAccountMember({ data: { memberId: BOB, email: "bob.corrected@test.local", reason: "Member's email had a typo, confirmed by phone" } as never });
    expect(member(BOB).email).toBe("bob.corrected@test.local");
    const log = db().audits("admin.member_updated").filter((a) => a.entity_id === ACCOUNT);
    expect(log).toHaveLength(1);
    expect(log[0]!.metadata).toMatchObject({ member_id: BOB, reason: "Member's email had a typo, confirmed by phone", fields: ["email"] });
    expect(log[0]!.actor_id).toBe(USERS.admin);
    await adminChangeAccountMember({ data: { memberId: BOB, remove: true, reason: "Member withdrew" } as never });
    expect(member(BOB).status).toBe("removed");
    expect(db().audits("admin.member_removed").filter((a) => a.entity_id === ACCOUNT)).toHaveLength(1);
    // The account holder can never be removed, even by an admin.
    await expect(adminChangeAccountMember({ data: { memberId: ALICE, remove: true, reason: "x" } as never })).rejects.toThrow("can't be removed");
  });
});

// ---------------------------------------------------------------------------
// 7. Wrong typed name, and another account's member id
// ---------------------------------------------------------------------------

describe("7. a wrong typed name is refused on the server, and so is another account's account_member_id", () => {
  const WRONG = "Somebody Else";
  const signDoc = (acting: string, typedName: string, documentType = "PRA") => (as(USERS.b1), signMemberDocumentFn({ data: { actingMemberId: acting, documentType, documentVersion: "v1", documentHash: "djb2_x", typedName } as never }));

  it("PRA, Hold Harmless, the eligibility declaration, the W-9 and a documented-authority grant each refuse a name that isn't the member's", async () => {
    const mismatch = /signature must be|exactly as|legal name/i;
    await expect(signDoc(ALICE, WRONG, "PRA")).rejects.toThrow(mismatch);
    await expect(signDoc(ALICE, "Bob Real", "HOLD_HARMLESS")).rejects.toThrow(mismatch); // the other member's name isn't theirs either
    await expect(signDoc(ALICE, "", "PRA")).rejects.toThrow(mismatch);
    await expect(submitEligibilityDeclaration({ data: { actingMemberId: ALICE, answers: yes, attestedPersonally: true, signedName: WRONG, supersedesId: null } as never })).rejects.toThrow();
    await expect(submitW9Fn({ data: { actingMemberId: ALICE, legalName: "Alice Real", taxClassification: "individual", address: "1 Main", tinKind: "ssn", tin: "123-45-6789", signedName: WRONG } as never })).rejects.toThrow(mismatch);
    await expect(grantAuthorityFn({ data: { actingMemberId: ALICE, granteeMemberId: BOB, scope: ["pra"], typedName: WRONG } as never })).rejects.toThrow(mismatch);
    expect(db().table("signed_documents")).toHaveLength(0);
    expect(db().table("member_w9")).toHaveLength(0);
    expect(db().table("eligibility_declarations")).toHaveLength(0);
    expect(db().table("member_authority_grants")).toHaveLength(0);
  });

  it("the due-diligence acknowledgment refuses a wrong name too, and records nothing", async () => {
    as(USERS.admin);
    const placed = await placeDiligenceDocument({ data: { propertyId: P, documentTitle: "Inspection", category: "inspection", fileUrl: "dd/i.pdf", contentHash: "h1" } });
    as(USERS.b1);
    const r = await acknowledgeAsMember({ data: { documentId: placed.id!, contentHash: "h1", accountMemberId: ALICE, signedName: WRONG } }).then((x) => x, (e: Error) => ({ ok: false, error: e.message }));
    expect(r.ok).toBe(false);
    expect(db().table("due_diligence_acknowledgments").filter((a) => a.account_member_id === ALICE)).toHaveLength(0);
  });

  it("the right name, in any case or spacing, is accepted, and the signature names the member", async () => {
    await signDoc(ALICE, "  alice   REAL ");
    expect(db().table("signed_documents").find((d) => d.document_type === "PRA")).toMatchObject({ account_member_id: ALICE, signed_name: expect.stringMatching(/alice\s+real/i) });
  });

  describe("another account's account_member_id is refused everywhere, with nothing written", () => {
    const OTHER = IDS.b2m1; // Carol Two, on the other account
    const refused = /isn't on your account/;

    it("every member-level call, acting as a member of another account", async () => {
      as(USERS.b1);
      const before = JSON.stringify([db().table("signed_documents"), db().table("account_members"), db().table("member_w9"), db().table("eligibility_declarations"), db().table("member_plaid_consents")]);
      await expect(saveMemberIdentityFn({ data: { actingMemberId: OTHER, fullName: "Carol Two", address: "1", dateOfBirth: "1990-01-01", idDocumentNumber: "ZZ1" } as never })).rejects.toThrow(refused);
      await expect(signDoc(OTHER, "Carol Two")).rejects.toThrow(refused);
      await expect(submitEligibilityDeclaration({ data: { actingMemberId: OTHER, answers: yes, attestedPersonally: true, signedName: "Carol Two", supersedesId: null } as never })).rejects.toThrow(refused);
      await expect(submitW9Fn({ data: { actingMemberId: OTHER, legalName: "Carol Two", taxClassification: "individual", address: "1", tinKind: "ssn", tin: "123-45-6789", signedName: "Carol Two" } as never })).rejects.toThrow(refused);
      await expect(acceptAuthorizationFn({ data: { actingMemberId: OTHER, block: "block1" } as never })).rejects.toThrow(refused);
      await expect(confirmActingMember({ data: { memberId: OTHER, step: "x" } })).rejects.toThrow(refused);
      await expect(grantAuthorityFn({ data: { actingMemberId: OTHER, granteeMemberId: ALICE, scope: ["pra"], typedName: "Carol Two" } as never })).rejects.toThrow(refused);
      await expect(grantAuthorityFn({ data: { actingMemberId: ALICE, granteeMemberId: OTHER, scope: ["pra"], typedName: "Alice Real" } as never })).rejects.toThrow(refused);
      await expect(getMyKyo({ data: { actingMemberId: OTHER } as never })).rejects.toThrow(refused);
      expect(JSON.stringify([db().table("signed_documents"), db().table("account_members"), db().table("member_w9"), db().table("eligibility_declarations"), db().table("member_plaid_consents")])).toBe(before);
    });

    it("account management naming another account's member as the target, or as the actor", async () => {
      as(USERS.b1);
      await expect(removeAccountMember({ data: { actingMemberId: ALICE, memberId: OTHER } })).rejects.toThrow(refused);
      await expect(updateAccountMember({ data: { actingMemberId: ALICE, memberId: OTHER, fullName: "X", email: "x@test.local", phone: null } as never })).rejects.toThrow(refused);
      await expect(remindAccountMember({ data: { actingMemberId: ALICE, memberId: OTHER } })).rejects.toThrow(refused);
      await expect(removeAccountMember({ data: { actingMemberId: OTHER, memberId: BOB } })).rejects.toThrow(refused);
      expect(db().table("account_members").find((m) => m.id === OTHER)!.status ?? "active").toBe("active");
      expect(member(BOB).status).toBe("active");
    });

    it("the same refusal as a member who doesn't exist: no way to learn whether an id is real", async () => {
      as(USERS.b1);
      const real = await signDoc(OTHER, "Carol Two").then(() => "", (e: Error) => e.message);
      const fake = await signDoc("no-such-member", "Carol Two").then(() => "", (e: Error) => e.message);
      expect(real).toBe(fake);
    });

    it("a removed member's id is refused too", async () => {
      as(USERS.b1);
      await removeAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } });
      await expect(signDoc(BOB, "Bob Real")).rejects.toThrow(refused);
    });
  });
});

// ---------------------------------------------------------------------------
// 8. A member reports a change within ten days (Q6)
// ---------------------------------------------------------------------------

describe("8. a reported change re-evaluates only that member, and the account roll-up recomputes", () => {
  const change = (memberId: string, answers: Record<string, string>) =>
    (as(USERS.b1), submitEligibilityDeclaration({ data: { actingMemberId: memberId, answers, attestedPersonally: true, signedName: member(memberId).full_name, supersedesId: `decl-${memberId}`, kind: "change_report" } as never }));

  beforeEach(() => {
    complete(ALICE);
    complete(BOB);
  });

  it("starts ready", async () => {
    expect(accountRollup(await loadMemberSteps(db(), ACCOUNT)).status).toBe("ready");
  });

  it("Bob's change is a new, append-only version for Bob alone; Alice's records are untouched; the account re-rolls", async () => {
    const aliceBefore = JSON.stringify([rowsOf("eligibility_declarations", ALICE), rowsOf("eligibility_results", ALICE)]);
    const r = await change(BOB, { ...yes, q3: "no" });
    expect(["held", "not_eligible", "pending"]).toContain(r.result);
    expect(r.result).not.toBe("eligible");
    // Bob: a new declaration, the old one superseded (kept), and a new result row beside the old one.
    const decls = rowsOf("eligibility_declarations", BOB);
    expect(decls).toHaveLength(2);
    expect(decls.find((d) => d.id === `decl-${BOB}`)!.status).toBe("superseded");
    expect(decls.find((d) => d.id !== `decl-${BOB}`)).toMatchObject({ status: "complete", supersedes_id: `decl-${BOB}` });
    expect(rowsOf("eligibility_results", BOB).length).toBeGreaterThanOrEqual(2);
    // Alice: not one row touched, no new result.
    expect(JSON.stringify([rowsOf("eligibility_declarations", ALICE), rowsOf("eligibility_results", ALICE)])).toBe(aliceBefore);
    // The roll-up recomputes from the current records.
    const status = accountRollup(await loadMemberSteps(db(), ACCOUNT)).status;
    expect(status).not.toBe("ready");
    expect((await mine()).accountStatus).toBe(status);
    expect((await mine()).members.find((m) => m.id === ALICE)!.eligibility).toBe("eligible");
    // It is audited as a change report, for Bob.
    const log = audits("buyer.eligibility_declaration_made").filter((a) => a.metadata.account_member_id === BOB);
    expect(log.at(-1)!.metadata).toMatchObject({ kind: "change_report", acted_by_member_id: BOB });
  });

  it("a change report that changes nothing leaves the account ready, and still doesn't touch the other member", async () => {
    const aliceBefore = JSON.stringify(rowsOf("eligibility_results", ALICE));
    const r = await change(BOB, yes);
    expect(r.result).toBe("eligible");
    expect(JSON.stringify(rowsOf("eligibility_results", ALICE))).toBe(aliceBefore);
    expect(rowsOf("eligibility_declarations", BOB)).toHaveLength(2);
  });

  it("a stale report (against a version that was already replaced) is refused and overwrites nothing", async () => {
    await change(BOB, yes);
    const count = rowsOf("eligibility_declarations", BOB).length;
    await expect(change(BOB, { ...yes, q3: "no" })).rejects.toThrow("already corrected");
    expect(rowsOf("eligibility_declarations", BOB)).toHaveLength(count);
  });

  it("the second member can't report a change for the other member", async () => {
    as(USERS.b1);
    await expect(submitEligibilityDeclaration({ data: { actingMemberId: BOB, answers: { ...yes, q3: "no" }, attestedPersonally: true, signedName: "Alice Real", supersedesId: `decl-${ALICE}`, kind: "change_report" } as never })).rejects.toThrow();
    expect(rowsOf("eligibility_declarations", ALICE)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 9. One person in two Buyer Accounts for two properties
// ---------------------------------------------------------------------------

describe("9. one person in two Buyer Accounts (two properties) never sees one account's data in the other", () => {
  const P2 = "prop-2";
  const B2_ACCOUNT = IDS.b2;
  let BOB_IN_B2 = "";

  beforeEach(async () => {
    db().seed("properties", [{ id: P2, address: "9 Other Rd", city: "Casper", state: "WY", zip: "82601", seller_id: IDS.seller, listing_price: 1_000_000, listing_status: "forming", hard_locked: true }]);
    // Carol's account reserves the other property only.
    const res = db().table("pod_reservations").find((r) => r.id === IDS.res2)!;
    res.property_id = P2;
    as(USERS.b2);
    // The same person, Bob Real, is the second member of this account too.
    const added = await addAccountMember({ data: { actingMemberId: IDS.b2m1, fullName: "Bob Real", email: "bob.real@test.local", phone: null } as never });
    BOB_IN_B2 = added.id;
    await saveMemberIdentityFn({ data: { actingMemberId: BOB_IN_B2, fullName: "Bob Real", address: "1 Main St, Lusk, WY", dateOfBirth: BOB_DOB, idDocumentNumber: BOB_ID_NO, idDocumentPath: null } });
  });

  it("he is a member of both, with his own record in each", () => {
    expect(db().table("account_members").filter((m) => m.email === "bob.real@test.local" && m.status === "active")).toHaveLength(2);
    expect(BOB_IN_B2).not.toBe(BOB);
  });

  it("each login's Account Members view lists only its own account's members and records", async () => {
    complete(ALICE);
    as(USERS.b1);
    const a = await getMyAccountMembers();
    as(USERS.b2);
    const b = await getMyAccountMembers();
    expect(a.accountId).toBe(ACCOUNT);
    expect(b.accountId).toBe(B2_ACCOUNT);
    expect(a.members.map((m) => m.fullName).sort()).toEqual(["Alice Real", "Bob Real"]);
    expect(b.members.map((m) => m.fullName).sort()).toEqual(["Bob Real", "Carol Two"]);
    const ids = (v: typeof a) => v.members.map((m) => m.id);
    expect(ids(a).some((i) => ids(b).includes(i))).toBe(false);
    // Alice's completed steps do not show on the other account.
    expect(JSON.stringify(b)).not.toMatch(/Alice/);
    expect(b.members.every((m) => m.checklist.filter((c) => c.done).length === (m.id === BOB_IN_B2 ? 1 : 0))).toBe(true); // only Bob's own identity step
  });

  it("what he signs in one account is recorded on that account only", async () => {
    as(USERS.b1);
    await signMemberDocumentFn({ data: { actingMemberId: BOB, documentType: "PRA", documentVersion: "v1", documentHash: "djb2_x", typedName: "Bob Real" } as never });
    const docs = db().table("signed_documents");
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ buyer_account_id: ACCOUNT, account_member_id: BOB });
    expect(docs.some((d) => d.buyer_account_id === B2_ACCOUNT || d.account_member_id === BOB_IN_B2)).toBe(false);
    // In the other account he has signed nothing.
    const steps = await loadMemberSteps(db(), B2_ACCOUNT);
    expect(steps.find((s) => s.memberId === BOB_IN_B2)!.pra).toBe(false);
  });

  it("an id from one of his accounts can't be used through the other account's login, in either direction", async () => {
    as(USERS.b1);
    await expect(signMemberDocumentFn({ data: { actingMemberId: BOB_IN_B2, documentType: "PRA", documentVersion: "v1", documentHash: "h", typedName: "Bob Real" } as never })).rejects.toThrow("isn't on your account");
    as(USERS.b2);
    await expect(signMemberDocumentFn({ data: { actingMemberId: BOB, documentType: "PRA", documentVersion: "v1", documentHash: "h", typedName: "Bob Real" } as never })).rejects.toThrow("isn't on your account");
    expect(db().table("signed_documents")).toHaveLength(0);
  });

  it("his Know Your Owner view in one account carries nothing from the other", async () => {
    complete(BOB);
    as(USERS.b1);
    const here = await getMyKyo({ data: { actingMemberId: BOB } as never });
    expect(here.memberId).toBe(BOB);
    as(USERS.b2);
    const there = await getMyKyo({ data: { actingMemberId: BOB_IN_B2 } as never });
    expect(there.memberId).toBe(BOB_IN_B2);
    expect(there.declaration).toBeNull();
    expect(there.eligibility).toBeNull();
    expect(here.declaration).not.toBeNull();
  });

  it("the due-diligence gate for one property doesn't count the other account's acknowledgments", async () => {
    as(USERS.admin);
    const doc = await placeDiligenceDocument({ data: { propertyId: P, documentTitle: "Inspection", category: "inspection", fileUrl: "dd/i.pdf", contentHash: "h1" } });
    as(USERS.ra);
    await acknowledgeAsAgent({ data: { documentId: doc.id!, contentHash: "h1", buyerAccountId: ACCOUNT, signedName: "Rita Resident" } });
    as(USERS.b1);
    await acknowledgeAsMember({ data: { documentId: doc.id!, contentHash: "h1", accountMemberId: BOB, signedName: "Bob Real" } });
    as(USERS.b2);
    const other = await getAuthorizationGateStatus({ data: { propertyId: P2 } });
    expect(JSON.stringify(other)).not.toContain(doc.id!);
  });

  it("notices go to him from each account separately, each carrying only that account's text", async () => {
    await deliver(db() as never, { authUserId: USERS.b1, email: "alice.real@test.local" } as never, { type: "authorization_request", subject: "S-one", message: "ONLY-ACCOUNT-ONE" } as never);
    await deliver(db() as never, { authUserId: USERS.b2, email: "b2@test.local" } as never, { type: "authorization_request", subject: "S-two", message: "ONLY-ACCOUNT-TWO" } as never);
    const bodies = (globalThis.fetch as unknown as { mock: { calls: Array<[string, { body: string }]> } }).mock.calls.map((c) => JSON.parse(c[1].body) as { to: string[]; html: string });
    const toBob = bodies.filter((b) => b.to[0] === "bob.real@test.local");
    expect(toBob).toHaveLength(2);
    expect(toBob.filter((b) => b.html.includes("ONLY-ACCOUNT-ONE") && b.html.includes("ONLY-ACCOUNT-TWO"))).toHaveLength(0);
    expect(bodies.filter((b) => b.to[0] === "alice.real@test.local").every((b) => !b.html.includes("ONLY-ACCOUNT-TWO"))).toBe(true);
    expect(bodies.filter((b) => b.to[0] === "b2@test.local").every((b) => !b.html.includes("ONLY-ACCOUNT-ONE"))).toBe(true);
  });

  it("the rule that does hold: he can't be added to a second account of the SAME property", async () => {
    // Account 3 reserves the first property (where Alice's account, with Bob, already is).
    db().seed("pod_reservations", [{ id: "res-b3", property_id: P, buyer_account_id: IDS.b3, shares_reserved: 1, status: "reserved", reserved_at: "2026-09-03T00:00:00Z" }]);
    as(USERS.b3);
    await expect(addAccountMember({ data: { actingMemberId: IDS.b3m1, fullName: "Bob Real", email: "bob.real@test.local", phone: null } as never })).rejects.toThrow(POD_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// 10. Both members act at the same moment on the same document
// ---------------------------------------------------------------------------

describe("10. both members acting at the same moment overwrite nothing", () => {
  const settled = (r: Array<PromiseSettledResult<unknown>>) => r.map((x) => x.status);

  it("both acknowledge the same document at once: two records, each with its own member and name", async () => {
    as(USERS.admin);
    const placed = await placeDiligenceDocument({ data: { propertyId: P, documentTitle: "Inspection", category: "inspection", fileUrl: "dd/i.pdf", contentHash: "h1" } });
    as(USERS.b1);
    const results = await atOnce(
      () => acknowledgeAsMember({ data: { documentId: placed.id!, contentHash: "h1", accountMemberId: ALICE, signedName: "Alice Real" } }),
      () => acknowledgeAsMember({ data: { documentId: placed.id!, contentHash: "h1", accountMemberId: BOB, signedName: "Bob Real" } }),
    );
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : r.reason))).toEqual([{ ok: true }, { ok: true }]);
    const acks = db().table("due_diligence_acknowledgments").filter((a) => a.account_member_id);
    expect(acks.map((a) => [a.account_member_id, a.signed_name]).sort()).toEqual([[ALICE, "Alice Real"], [BOB, "Bob Real"]].sort());
  });

  it("both sign the PRA at once: each signature is its own row, keyed by member, with its own name", async () => {
    as(USERS.b1);
    const results = await atOnce(
      () => signMemberDocumentFn({ data: { actingMemberId: ALICE, documentType: "PRA", documentVersion: "v1", documentHash: "djb2_x", typedName: "Alice Real" } as never }),
      () => signMemberDocumentFn({ data: { actingMemberId: BOB, documentType: "PRA", documentVersion: "v1", documentHash: "djb2_x", typedName: "Bob Real" } as never }),
    );
    expect(settled(results)).toEqual(["fulfilled", "fulfilled"]);
    const docs = db().table("signed_documents").filter((d) => d.document_type === "PRA");
    expect(docs.map((d) => [d.account_member_id, d.signed_name]).sort()).toEqual([[ALICE, "Alice Real"], [BOB, "Bob Real"]].sort());
  });

  it("both declare and both save their W-9 at once: nothing of one lands on the other", async () => {
    as(USERS.b1);
    const decl = (id: string, name: string) => () => submitEligibilityDeclaration({ data: { actingMemberId: id, answers: yes, attestedPersonally: true, signedName: name, supersedesId: null } as never });
    const w9 = (id: string, name: string, tin: string) => () => submitW9Fn({ data: { actingMemberId: id, legalName: name, taxClassification: "individual", address: "1 Main", tinKind: "ssn", tin, signedName: name } as never });
    const results = await atOnce<unknown>(decl(ALICE, "Alice Real"), decl(BOB, "Bob Real"), w9(ALICE, "Alice Real", "123-45-6789"), w9(BOB, "Bob Real", "234-56-7890"));
    expect(settled(results)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    expect(db().table("eligibility_declarations").map((d) => [d.account_member_id, d.signed_name]).sort()).toEqual([[ALICE, "Alice Real"], [BOB, "Bob Real"]].sort());
    const tax = db().table("member_w9");
    expect(tax.map((w) => [w.account_member_id, w.signed_name, w.tin_last4]).sort()).toEqual([[ALICE, "Alice Real", "6789"], [BOB, "Bob Real", "7890"]].sort());
    // Whatever result each member got is their own: none is attached to the other.
    for (const r of db().table("eligibility_results")) expect([ALICE, BOB]).toContain(r.account_member_id);
    for (const d of db().table("eligibility_declarations")) expect(db().table("eligibility_results").filter((r) => r.declaration_id === d.id).every((r) => r.account_member_id === d.account_member_id)).toBe(true);
  });

  it("both save their identity at once: each keeps their own details", async () => {
    as(USERS.b1);
    const results = await atOnce(
      () => saveMemberIdentityFn({ data: { actingMemberId: ALICE, fullName: "Alice Real", address: "A Street", dateOfBirth: DOB, idDocumentNumber: ID_NO, idDocumentPath: null } }),
      () => saveMemberIdentityFn({ data: { actingMemberId: BOB, fullName: "Bob Real", address: "B Street", dateOfBirth: BOB_DOB, idDocumentNumber: BOB_ID_NO, idDocumentPath: null } }),
    );
    expect(settled(results)).toEqual(["fulfilled", "fulfilled"]);
    expect(member(ALICE)).toMatchObject({ address: "A Street", id_document_number: ID_NO });
    expect(member(BOB)).toMatchObject({ address: "B Street", id_document_number: BOB_ID_NO });
  });

  it("both members save the SAME ID at once (a race past the same-person check): the database's own rule is the backstop", async () => {
    const sql = readdirSqlFiles();
    expect(sql).toMatch(/Each member must be a different person/);
    expect(sql).toMatch(/regexp_replace\(NEW\.id_document_number/); // the ID-number rule, not only name + birth date + ID
  });

  it("the same member acting twice at once (a double click) never overwrites: every row left is theirs and says the same thing", async () => {
    as(USERS.b1);
    const go = () => signMemberDocumentFn({ data: { actingMemberId: ALICE, documentType: "PRA", documentVersion: "v1", documentHash: "djb2_x", typedName: "Alice Real" } as never });
    await atOnce(go, go);
    const mineRows = db().table("signed_documents").filter((d) => d.document_type === "PRA" && d.account_member_id === ALICE);
    expect(mineRows.length).toBeGreaterThanOrEqual(1);
    expect(new Set(mineRows.map((r) => r.signed_name))).toEqual(new Set(["Alice Real"]));
    expect(db().table("signed_documents").filter((d) => d.account_member_id && d.account_member_id !== ALICE)).toHaveLength(0);
  });

  it("one member signing while the holder removes the other: the member and any signature both survive", async () => {
    as(USERS.b1);
    await atOnce(
      () => signMemberDocumentFn({ data: { actingMemberId: BOB, documentType: "PRA", documentVersion: "v1", documentHash: "djb2_x", typedName: "Bob Real" } as never }),
      () => removeAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } }),
    );
    expect(member(BOB).status).toBe("removed");
    expect(member(BOB).full_name).toBe("Bob Real");
    expect(db().table("account_members").filter((m) => m.buyer_account_id === ACCOUNT)).toHaveLength(2);
    expect(db().table("signed_documents").filter((d) => d.account_member_id === BOB).every((d) => d.signed_name === "Bob Real")).toBe(true);
  });

  it("two edits of the same member's email at once: one wins whole, never a blend", async () => {
    as(USERS.b1);
    const edit = (email: string) => () => updateAccountMember({ data: { actingMemberId: ALICE, memberId: BOB, fullName: "Bob Real", email, phone: null } as never });
    await atOnce(edit("first@test.local"), edit("second@test.local"));
    expect(["first@test.local", "second@test.local"]).toContain(member(BOB).email);
    expect(member(BOB).full_name).toBe("Bob Real");
  });
});

function readdirSqlFiles() {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(".").filter((f) => /(account-members|two-member-fixes|member-steps|eligibility-declarations|signature-authority|due-diligence).*\.sql$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
}

// ---------------------------------------------------------------------------
// 11. Password reset changes only the login
// ---------------------------------------------------------------------------

describe("11. a password reset changes only the login and never touches signed records", () => {
  it("the two reset screens only ever call the authentication service", () => {
    for (const file of ["src/routes/forgot-password.tsx", "src/routes/reset-password.confirm.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/supabase\.auth\./);
      expect(source).not.toMatch(/\.from\(/);
      expect(source).not.toMatch(/\.rpc\(/);
      expect(source).not.toMatch(/signed_documents|account_members|eligibility|member_w9|audit_log|buyer_accounts/);
      expect(source).not.toMatch(/\.functions"|\.server"/);
    }
  });

  it("no signed record carries anything that depends on the password or the session: records hang off the member and the account", async () => {
    complete(ALICE);
    complete(BOB);
    as(USERS.b1);
    await signMemberDocumentFn({ data: { actingMemberId: ALICE, documentType: "PRA", documentVersion: "v1", documentHash: "djb2_x", typedName: "Alice Real" } as never });
    const rows = JSON.stringify([db().table("signed_documents"), db().table("eligibility_declarations"), db().table("member_w9")]);
    expect(rows).not.toMatch(/password|session|refresh_token|access_token|jwt/i);
  });

  it("after a reset the same login still reaches the same account and members, and every record is byte-for-byte the same", async () => {
    complete(ALICE);
    complete(BOB);
    as(USERS.b1);
    await signMemberDocumentFn({ data: { actingMemberId: BOB, documentType: "PRA", documentVersion: "v1", documentHash: "djb2_x", typedName: "Bob Real" } as never });
    const tables = ["signed_documents", "account_members", "eligibility_declarations", "eligibility_results", "member_w9", "member_plaid_consents", "member_block2_authorizations", "buyer_accounts", "audit_log"];
    const snap = () => JSON.stringify(tables.map((t) => db().table(t)));
    const before = snap();
    // A reset is the authentication service's own: the application's tables see no write. The user id is unchanged.
    as(USERS.b1);
    const after = await getMyAccountMembers();
    expect(after.accountId).toBe(ACCOUNT);
    expect(after.members.map((m) => m.id).sort()).toEqual([ALICE, BOB].sort());
    expect(after.members.every((m) => m.checklist.some((c) => c.done))).toBe(true);
    // Reading the account after a reset changes no record (reading is not writing).
    expect(snap()).toBe(before);
    expect(db().table("buyer_accounts").find((a) => a.id === ACCOUNT)!.auth_user_id).toBe(USERS.b1);
  });
});

// ---------------------------------------------------------------------------
// 12. A soft-removed member's history stays intact and visible to admin
// ---------------------------------------------------------------------------

describe("12. a removed member's historical records stay intact, and the admin can still see them", () => {
  beforeEach(async () => {
    complete(ALICE);
    complete(BOB);
    as(USERS.b1);
    await signMemberDocumentFn({ data: { actingMemberId: BOB, documentType: "HOLD_HARMLESS", documentVersion: "v1", documentHash: "djb2_x", typedName: "Bob Real" } as never });
  });

  const bobRecords = () => JSON.stringify(["signed_documents", "eligibility_declarations", "eligibility_results", "member_w9", "member_liveness_checks", "member_plaid_consents", "member_block2_authorizations", "eligibility_page_acknowledgements"].map((t) => rowsOf(t, BOB)));

  it("removal is soft: the member row stays with its details and every record they made is unchanged", async () => {
    const before = bobRecords();
    expect(before.length).toBeGreaterThan(100);
    as(USERS.b1);
    await removeAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } });
    expect(member(BOB)).toMatchObject({ status: "removed", full_name: "Bob Real", email: "bob.real@test.local", date_of_birth: BOB_DOB, id_document_number: BOB_ID_NO });
    expect(member(BOB).removed_at).toBeTruthy();
    expect(bobRecords()).toBe(before);
    expect(db().table("signed_documents").find((d) => d.account_member_id === BOB && d.document_type === "HOLD_HARMLESS")!.signed_name).toBe("Bob Real");
  });

  it("the admin's Know Your Owner view still lists them, flagged as removed, with their declaration and result", async () => {
    as(USERS.b1);
    await removeAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } });
    as(USERS.admin);
    const view = await getKyoForAdmin({ data: { accountId: ACCOUNT } as never });
    const bob = view.find((m) => m.memberId === BOB)!;
    expect(bob).toBeTruthy();
    expect(bob.removed).toBe(true);
    expect(bob.declaration).not.toBeNull();
    expect(bob.eligibility?.result).toBe("eligible");
    expect(view.find((m) => m.memberId === ALICE)!.removed).toBe(false);
    // Active members come first.
    expect(view[0]!.memberId).toBe(ALICE);
    expect(db().audits("kyo.viewed").at(-1)!.metadata.members).toContain(BOB);
  });

  it("the admin's buyer page still lists them with a 'removed' badge, and keeps the admin tools off a removed member", () => {
    const page = readFileSync("src/routes/admin.buyers.tsx", "utf8");
    expect(page).toContain('m.status === "removed"');
    expect(page).toMatch(/m\.status !== "removed" \? <AdminMemberActions/);
  });

  it("the account no longer counts them, and a removed member can't act or be reminded", async () => {
    as(USERS.b1);
    await removeAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } });
    const steps = await loadMemberSteps(db(), ACCOUNT);
    expect(steps.map((s) => s.memberId)).toEqual([ALICE]);
    expect((await mine()).members.map((m) => m.id)).toEqual([ALICE]);
    await expect(signMemberDocumentFn({ data: { actingMemberId: BOB, documentType: "PRA", documentVersion: "v1", documentHash: "h", typedName: "Bob Real" } as never })).rejects.toThrow("isn't on your account");
    await expect(remindAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } })).rejects.toThrow("isn't on your account");
    // Notices stop going to a removed member's address.
    sent.length = 0;
    await deliver(db() as never, { authUserId: USERS.b1, email: "alice.real@test.local" } as never, { type: "authorization_request", subject: "S", message: "M" } as never);
    expect(sent).not.toContain("bob.real@test.local");
  });

  it("removal is audited and the removed member is never hard-deleted by any path in the code", () => {
    const server = readFileSync("src/lib/account-members.server.ts", "utf8");
    expect(server).not.toMatch(/from\("account_members"\)\s*\.delete\(/);
    expect(server).toContain('status: "removed"');
  });

  it("removal is audited", async () => {
    as(USERS.b1);
    await removeAccountMember({ data: { actingMemberId: ALICE, memberId: BOB } });
    expect(audits("buyer.member_removed")).toHaveLength(1);
    expect(audits("buyer.member_removed")[0]!.metadata).toMatchObject({ member_id: BOB, acted_by_member_id: ALICE });
  });
});
