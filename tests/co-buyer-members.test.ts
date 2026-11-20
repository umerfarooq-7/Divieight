import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { isCoBuyer } from "@/lib/account-members";
import { accountOwn, accountRollup, type MemberSteps } from "@/lib/account-rollup";
import { checkInviteInput, CO_BUYER_MESSAGES } from "@/lib/co-buyer-members";

vi.mock("@/lib/authorization.notify.server", () => ({ sendEmail: vi.fn(async () => true) }));

const { inviteCoBuyer, claimCoBuyerInvite, removeCoBuyer, coBuyerChoice, attachCoBuyerToReservation, coBuyerSelf, sharesOfCoBuyer } = await import("@/lib/co-buyer-members.server");
const { accountFor } = await import("@/lib/account-members.server");
const { membersForProperty, buyerAccountByLogin } = await import("@/lib/property-members.server");

const HOLDER = "u-holder";
const COBUYER = "u-co";
let db: FakeDb;
let accountId: string;
let primaryId: string;

function seed() {
  db = new FakeDb();
  accountId = "acct-1";
  db.table("buyer_accounts").push({ id: accountId, auth_user_id: HOLDER, email: "holder@example.com", onboarding_status: "not_started" });
  primaryId = "m-primary";
  db.table("account_members").push({ id: primaryId, buyer_account_id: accountId, role: "primary", status: "active", full_name: "Holly Holder", email: "holder@example.com" });
}

/** The token is only in the email; read it back from what was sent (the hash is stored). */
async function inviteAndToken(name = "Casey Co", email = "casey@example.com") {
  const { sendEmail } = await import("@/lib/authorization.notify.server");
  (sendEmail as any).mockClear();
  await inviteCoBuyer(db as never, { userId: HOLDER, name, email });
  const link = (sendEmail as any).mock.calls[0][3] as string;
  return decodeURIComponent(new URL(link, "https://x.test").searchParams.get("token")!);
}

beforeEach(seed);

describe("inviting a co-buyer", () => {
  it("adds a limited member with an invitation, and keeps only a hash of the token", async () => {
    const token = await inviteAndToken();
    const m = db.table("account_members").find((x) => x.email === "casey@example.com")!;
    expect(m.role).toBe("member");
    expect(m.invite_token_hash).toBeTruthy();
    expect(m.invite_token_hash).not.toBe(token);
    expect(isCoBuyer(m)).toBe(true);
  });

  it("allows one co-buyer only, and not the holder's own email", async () => {
    await inviteAndToken();
    await expect(inviteCoBuyer(db as never, { userId: HOLDER, name: "Other Person", email: "other@example.com" })).rejects.toThrow(CO_BUYER_MESSAGES.haveOne);
    seed();
    await expect(inviteCoBuyer(db as never, { userId: HOLDER, name: "Holly Again", email: "HOLDER@example.com" })).rejects.toThrow(CO_BUYER_MESSAGES.self);
  });

  it("refuses an email that already has a buyer account", async () => {
    db.table("buyer_accounts").push({ id: "acct-2", auth_user_id: "u-x", email: "taken@example.com" });
    await expect(inviteCoBuyer(db as never, { userId: HOLDER, name: "Taken Person", email: "taken@example.com" })).rejects.toThrow(CO_BUYER_MESSAGES.hasAccount);
  });

  it("checks the name and email", () => {
    expect(() => checkInviteInput({ name: "A", email: "a@b.co" })).toThrow();
    expect(() => checkInviteInput({ name: "Alex Doe", email: "nope" })).toThrow();
    expect(checkInviteInput({ name: " Alex Doe ", email: " ALEX@B.CO " })).toEqual({ name: "Alex Doe", email: "alex@b.co" });
  });
});

describe("claiming the invitation", () => {
  it("links the login, clears the token, and the invitation can't be used twice", async () => {
    const token = await inviteAndToken();
    await claimCoBuyerInvite(db as never, { userId: COBUYER, email: "Casey@Example.com", token });
    const m = db.table("account_members").find((x) => x.email === "casey@example.com")!;
    expect(m.auth_user_id).toBe(COBUYER);
    expect(m.invite_token_hash).toBeNull();
    expect(isCoBuyer(m)).toBe(true);
    await expect(claimCoBuyerInvite(db as never, { userId: "u-other", email: "casey@example.com", token })).rejects.toThrow(CO_BUYER_MESSAGES.notFound);
  });

  it("is refused for a different email, or for someone who already has a buyer account", async () => {
    const token = await inviteAndToken();
    await expect(claimCoBuyerInvite(db as never, { userId: COBUYER, email: "mallory@example.com", token })).rejects.toThrow(CO_BUYER_MESSAGES.wrongEmail);
    db.table("buyer_accounts").push({ id: "acct-9", auth_user_id: COBUYER, email: "casey@example.com" });
    await expect(claimCoBuyerInvite(db as never, { userId: COBUYER, email: "casey@example.com", token })).rejects.toThrow(CO_BUYER_MESSAGES.hasAccount);
  });
});

describe("the co-buyer's login", () => {
  async function joined() {
    const token = await inviteAndToken();
    await claimCoBuyerInvite(db as never, { userId: COBUYER, email: "casey@example.com", token });
  }

  it("reaches the holder's account as a member, and cannot invite or remove anyone", async () => {
    await joined();
    const a = await accountFor(db as never, COBUYER);
    expect(a.id).toBe(accountId);
    expect(a.viaMemberId).toBeTruthy();
    await expect(inviteCoBuyer(db as never, { userId: COBUYER, name: "Third Person", email: "third@example.com" })).rejects.toThrow();
    await expect(removeCoBuyer(db as never, { userId: COBUYER })).rejects.toThrow(CO_BUYER_MESSAGES.onlyHolder);
  });

  it("server lookups by login find the account for the holder and the co-buyer alike", async () => {
    await joined();
    expect((await buyerAccountByLogin<{ id: string }>(db as never, HOLDER, "id"))?.id).toBe(accountId);
    expect((await buyerAccountByLogin<{ id: string }>(db as never, COBUYER, "id"))?.id).toBe(accountId);
    expect(await buyerAccountByLogin(db as never, "nobody", "id")).toBeNull();
  });

  it("their portal shows their own steps and the holder's name", async () => {
    await joined();
    const self = await coBuyerSelf(db as never, { userId: COBUYER });
    expect(self?.holderName).toBe("Holly Holder");
    expect(self?.feePaid).toBe(false);
    expect(self?.shares).toEqual([]);
    expect(await coBuyerSelf(db as never, { userId: HOLDER })).toBeNull();
  });
});

describe("shares bought together", () => {
  const PROPERTY = "prop-1";
  const RES = "res-1";

  function reservation() {
    db.table("pod_reservations").push({ id: RES, property_id: PROPERTY, buyer_account_id: accountId, status: "reserved" });
    db.table("properties").push({ id: PROPERTY, address: "1 Main St", city: "Austin", state: "TX" });
  }

  it("the reserve screen can't offer a co-buyer who hasn't joined", async () => {
    await inviteAndToken();
    const choice = await coBuyerChoice(db as never, { accountId });
    expect(choice?.available).toBe(false);
    expect(await coBuyerChoice(db as never, { accountId: "acct-none" })).toBeNull();
  });

  it("attaches the co-buyer to one share, and only that property counts them as a member", async () => {
    const token = await inviteAndToken();
    await claimCoBuyerInvite(db as never, { userId: COBUYER, email: "casey@example.com", token });
    reservation();

    // Before: only the holder is on the property.
    expect((await membersForProperty(db as never, accountId, PROPERTY)).map((m) => m.role)).toEqual(["primary"]);

    const r = await attachCoBuyerToReservation(db as never, { userId: HOLDER, reservationId: RES });
    expect(r.name).toBe("Casey Co");

    const there = await membersForProperty(db as never, accountId, PROPERTY);
    expect(there.map((m) => m.full_name).sort()).toEqual(["Casey Co", "Holly Holder"]);
    // Another property, and the no-property view, never include the co-buyer.
    expect((await membersForProperty(db as never, accountId, "prop-2")).map((m) => m.role)).toEqual(["primary"]);
    expect((await membersForProperty(db as never, accountId, null)).map((m) => m.role)).toEqual(["primary"]);

    expect((await sharesOfCoBuyer(db as never, there.find((m) => m.role === "member")!.id)).map((s) => s.propertyId)).toEqual([PROPERTY]);
    const self = await coBuyerSelf(db as never, { userId: COBUYER });
    expect(self?.shares.map((s) => s.address)).toEqual(["1 Main St, Austin, TX"]);
  });

  it("only the holder can attach, only on their own reserved share, and not after the cap table is locked", async () => {
    const token = await inviteAndToken();
    await claimCoBuyerInvite(db as never, { userId: COBUYER, email: "casey@example.com", token });
    reservation();
    await expect(attachCoBuyerToReservation(db as never, { userId: COBUYER, reservationId: RES })).rejects.toThrow(CO_BUYER_MESSAGES.onlyHolder);
    db.table("pod_reservations").push({ id: "res-other", property_id: PROPERTY, buyer_account_id: "acct-other", status: "reserved" });
    await expect(attachCoBuyerToReservation(db as never, { userId: HOLDER, reservationId: "res-other" })).rejects.toThrow(CO_BUYER_MESSAGES.notYours);
    db.table("entity_genesis").push({ property_id: PROPERTY, cap_table_locked_at: new Date().toISOString() });
    await expect(attachCoBuyerToReservation(db as never, { userId: HOLDER, reservationId: RES })).rejects.toThrow(CO_BUYER_MESSAGES.locked);
  });

  it("the co-buyer can't be removed while on a share", async () => {
    const token = await inviteAndToken();
    await claimCoBuyerInvite(db as never, { userId: COBUYER, email: "casey@example.com", token });
    reservation();
    await attachCoBuyerToReservation(db as never, { userId: HOLDER, reservationId: RES });
    await expect(removeCoBuyer(db as never, { userId: HOLDER })).rejects.toThrow(CO_BUYER_MESSAGES.onShares);
  });
});

describe("the account's own status ignores the co-buyer", () => {
  const steps = (over: Partial<MemberSteps>): MemberSteps =>
    ({ memberId: "x", name: "x", role: "primary", coBuyer: false, idScan: true, liveness: true, standardRead: true, declaration: true, block1: true, block2: true, holdHarmless: true, w9: true, pra: true, result: "eligible", ...over }) as MemberSteps;

  it("a co-buyer who has done nothing does not hold the account back", () => {
    const all = [steps({}), steps({ memberId: "c", role: "member", coBuyer: true, idScan: false, liveness: false, result: null as never })];
    expect(accountOwn(all)).toHaveLength(1);
    expect(accountRollup(all).status).toBe("ready");
  });

  it("a co-buyer who is held does not make the account held either", () => {
    const all = [steps({}), steps({ memberId: "c", role: "member", coBuyer: true, result: "held" })];
    expect(accountRollup(all).status).toBe("ready");
  });
});

describe("the fee is per person and the main account does not pay for the co-buyer", () => {
  it("counts only non-co-buyer members for the account's fee", () => {
    const roster = [
      { role: "primary", auth_user_id: null, invite_token_hash: null },
      { role: "member", auth_user_id: "u", invite_token_hash: null },
    ];
    expect(roster.filter((m) => !isCoBuyer(m))).toHaveLength(1);
  });
});

describe("the co-buyer's own steps, end to end", () => {
  it("saves identity with a photo and a W-9 even after the main account's Golden Ticket, and the portal shows both done", async () => {
    process.env.W9_TIN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const { saveMemberIdentity } = await import("@/lib/account-members.server");
    const { submitW9 } = await import("@/lib/w9.server");
    db.table("buyer_accounts")[0].golden_ticket_issued = true;
    const token = await inviteAndToken();
    await claimCoBuyerInvite(db as never, { userId: COBUYER, email: "casey@example.com", token });
    const memberId = db.table("account_members").find((m) => m.email === "casey@example.com")!.id;
    const request = { ip: "1.1.1.1", userAgent: "test" } as never;

    let self = await coBuyerSelf(db as never, { userId: COBUYER });
    expect(self?.identityDone).toBe(false);

    await saveMemberIdentity(db as never, { userId: COBUYER, actingMemberId: memberId, fullName: "Casey Co", address: "9 Oak St", dateOfBirth: "1990-02-03", idDocumentNumber: "D1234567", idDocumentPath: `${COBUYER}/buyer-license-1.jpg`, request } as never);
    self = await coBuyerSelf(db as never, { userId: COBUYER });
    expect(self?.identityDone).toBe(true);
    expect(self?.w9Done).toBe(false);

    await submitW9(db as never, { userId: COBUYER, actingMemberId: memberId, legalName: "Casey Co", taxClassification: "individual", address: "9 Oak St", tinKind: "ssn", tin: "123-45-6789", signedName: "Casey Co", request } as never);
    self = await coBuyerSelf(db as never, { userId: COBUYER });
    expect(self?.w9Done).toBe(true);
    // Their steps never change the main account's own members.
    expect((await membersForProperty(db as never, accountId, null)).map((m) => m.role)).toEqual(["primary"]);
  });
});

describe("whose signature a login may give", () => {
  it("a co-buyer signs only as themselves, and the holder never signs as the co-buyer", async () => {
    const { assertMayActAs } = await import("@/lib/property-members.server");
    const token = await inviteAndToken();
    await claimCoBuyerInvite(db as never, { userId: COBUYER, email: "casey@example.com", token });
    const coId = db.table("account_members").find((m) => m.email === "casey@example.com")!.id;
    await expect(assertMayActAs(db as never, HOLDER, primaryId)).resolves.toBeUndefined();
    await expect(assertMayActAs(db as never, COBUYER, coId)).resolves.toBeUndefined();
    await expect(assertMayActAs(db as never, COBUYER, primaryId)).rejects.toThrow("only sign for yourself");
    await expect(assertMayActAs(db as never, HOLDER, coId)).rejects.toThrow("only sign for yourself");
  });
});

describe("the co-buyer does not hold the account's own steps", () => {
  async function joinedWithShare() {
    const token = await inviteAndToken();
    await claimCoBuyerInvite(db as never, { userId: COBUYER, email: "casey@example.com", token });
    return db.table("account_members").find((m) => m.email === "casey@example.com")!.id as string;
  }

  it("the holder's member list leaves the co-buyer out; the co-buyer sees only themselves", async () => {
    const { myAccountMembers } = await import("@/lib/account-members.server");
    await joinedWithShare();
    expect((await myAccountMembers(db as never, HOLDER)).members.map((m) => m.fullName)).toEqual(["Holly Holder"]);
    const mine = await myAccountMembers(db as never, COBUYER);
    expect(mine.members.map((m) => m.fullName)).toEqual(["Casey Co"]);
    expect(mine.members[0].coBuyer).toBe(true);
    // Their own checklist is the full one, for them.
    expect(mine.members[0].checklist.map((c) => c.key)).toContain("hold_harmless");
  });

  it("nobody waits on the co-buyer for the agreement or the consents; Block 2 waits for them only once they are on a share", async () => {
    const { waitingOnSignature, waitingOnBlock, block2MissingFor } = await import("@/lib/member-steps.server");
    await joinedWithShare();
    expect(await waitingOnSignature(db as never, accountId, "PRA")).toEqual(["Holly Holder"]);
    expect(await waitingOnBlock(db as never, accountId, "block1")).toEqual(["Holly Holder"]);
    expect(await block2MissingFor(db as never, [accountId])).toEqual(["Holly Holder"]);
    db.table("reservation_co_members").push({ reservation_id: "r1", property_id: "p1", buyer_account_id: accountId, account_member_id: db.table("account_members").find((m) => m.email === "casey@example.com")!.id });
    expect((await block2MissingFor(db as never, [accountId])).sort()).toEqual(["Casey Co", "Holly Holder"]);
  });

  it("the independent-advice notice is recorded for the co-buyer alone, and read back by the server", async () => {
    const memberId = await joinedWithShare();
    const { acceptAdviceNotice, adviceNoticeState, accountRowForLogin } = await import("@/lib/co-buyer-members.server");
    expect((await adviceNoticeState(db as never, { userId: COBUYER, actingMemberId: memberId })).accepted).toBe(false);
    await acceptAdviceNotice(db as never, { userId: COBUYER, actingMemberId: memberId, documentHash: "h", documentVersion: "v1", ip: null });
    await acceptAdviceNotice(db as never, { userId: COBUYER, actingMemberId: memberId, documentHash: "h", documentVersion: "v1", ip: null });
    expect(db.table("signed_documents").filter((d) => d.document_type === "block_5_independent_advice")).toHaveLength(1);
    expect((await adviceNoticeState(db as never, { userId: COBUYER, actingMemberId: memberId })).accepted).toBe(true);
    // The holder's login can't record it for the co-buyer.
    await expect(acceptAdviceNotice(db as never, { userId: HOLDER, actingMemberId: memberId, documentHash: "h", documentVersion: "v1", ip: null })).rejects.toThrow();
    const row = await accountRowForLogin(db as never, { userId: COBUYER });
    expect(row?.coBuyer).toBe(true);
    expect(row?.id).toBe(accountId);
    expect((await accountRowForLogin(db as never, { userId: HOLDER }))?.coBuyer).toBe(false);
  });
});
