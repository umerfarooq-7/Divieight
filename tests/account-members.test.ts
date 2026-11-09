/** Second Account Member: the limits, who may act, the lock, soft removal, and identity. The database rules run on Postgres too. */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import {
  addAccountMember,
  adminChangeAccountMember,
  confirmActingMember,
  getMyAccountMembers,
  removeAccountMember,
  saveMemberIdentityFn,
  updateAccountMember,
} from "@/lib/account-members.functions";
import { eligibilityOf, samePerson } from "@/lib/account-members";
import { issueGoldenTicketIfEligible } from "@/lib/golden-ticket";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const B3 = IDS.b3; // one member: Dan Three
const B3M = IDS.b3m1;

function seed() {
  seedPod(db());
  for (const m of db().table("account_members")) m.role = m.role === "secondary" ? "member" : m.role;
}
const members = (account: string) => db().table("account_members").filter((m) => m.buyer_account_id === account);
const active = (account: string) => members(account).filter((m) => m.status === "active");
const add = (o: Record<string, unknown> = {}) => {
  as(USERS.b3);
  return addAccountMember({ data: { actingMemberId: B3M, fullName: "Eve Three", email: "eve@test.local", phone: null, ...o } as never });
};

describe("adding the second member", () => {
  it("creates a 'member' row with name, email and phone, and no login", async () => {
    seed();
    const { id } = await add({ phone: "555-0100" });
    expect(members(B3).find((m) => m.id === id)).toMatchObject({ role: "member", status: "active", full_name: "Eve Three", email: "eve@test.local", phone: "555-0100" });
    expect(db().table("buyer_accounts")).toHaveLength(3);
    expect(db().audits("buyer.member_added")[0]!.metadata).toMatchObject({ acted_by_member_id: B3M, ip_address: "203.0.113.7" });
  });

  it("refuses a third active member", async () => {
    seed();
    await add();
    await expect(add({ email: "third@test.local" })).rejects.toThrow("at most two");
    expect(active(B3)).toHaveLength(2);
  });

  it("refuses the account holder's email, or the same email twice, ignoring case", async () => {
    seed();
    await expect(add({ email: "B3@TEST.local" })).rejects.toThrow("own email");
    expect(active(B3)).toHaveLength(1);
    const { id } = await add();
    as(USERS.b3);
    await expect(updateAccountMember({ data: { actingMemberId: B3M, memberId: id, fullName: "Eve", email: "b3@test.local" } as never })).rejects.toThrow("own email");
  });

  it("checks the email", async () => {
    seed();
    await expect(add({ email: "not-an-email" })).rejects.toThrow("valid email");
    await expect(add({ fullName: " " })).rejects.toThrow("full name");
  });

  it("only the account holder adds, edits or removes; the second member can't", async () => {
    seed();
    const { id } = await add();
    as(USERS.b3);
    await expect(addAccountMember({ data: { actingMemberId: id, fullName: "X", email: "x@test.local" } as never })).rejects.toThrow("account holder");
    await expect(removeAccountMember({ data: { actingMemberId: id, memberId: id } })).rejects.toThrow("account holder");
  });

  it("a member id from another account is refused everywhere", async () => {
    seed();
    as(USERS.b3);
    await expect(addAccountMember({ data: { actingMemberId: IDS.b2m1, fullName: "X", email: "x@test.local" } as never })).rejects.toThrow("isn't on your account");
    await expect(confirmActingMember({ data: { memberId: IDS.b2m1, step: "Identity" } })).rejects.toThrow("isn't on your account");
    await expect(saveMemberIdentityFn({ data: { actingMemberId: IDS.b2m1, fullName: "Carol Two", address: "1 St", dateOfBirth: "1990-01-01", idDocumentNumber: "X1" } })).rejects.toThrow("isn't on your account");
    await expect(removeAccountMember({ data: { actingMemberId: B3M, memberId: IDS.b1m2 } })).rejects.toThrow("isn't on your account");
    expect(members(IDS.b1).every((m) => m.status === "active")).toBe(true);
  });

  it("one person can't be in two accounts of the same pod", async () => {
    seed();
    db().seed("pod_reservations", [
      { property_id: "p-shared", buyer_account_id: B3, status: "reserved", shares_reserved: 1 },
      { property_id: "p-shared", buyer_account_id: IDS.b2, status: "reserved", shares_reserved: 1 },
    ]);
    db().table("account_members").find((m) => m.id === IDS.b2m1)!.email = "eve@test.local";
    await expect(add()).rejects.toThrow("same pod");
    db().table("pod_reservations").find((r) => r.buyer_account_id === IDS.b2 && r.property_id === "p-shared")!.property_id = "p-other";
    expect((await add()).id).toBeTruthy();
  });
});

describe("editing and removing", () => {
  it("edits the second member", async () => {
    seed();
    const { id } = await add();
    as(USERS.b3);
    await updateAccountMember({ data: { actingMemberId: B3M, memberId: id, fullName: "Eve T. Three", email: "eve2@test.local", phone: "1" } as never });
    expect(members(B3).find((m) => m.id === id)).toMatchObject({ full_name: "Eve T. Three", email: "eve2@test.local", phone: "1" });
  });

  it("removal is soft: the row and its records stay, and a new second member can be added", async () => {
    seed();
    const { id } = await add();
    db().seed("signed_documents", [{ buyer_account_id: B3, account_member_id: id, document_type: "HOLD_HARMLESS", signed_name: "Eve Three" }]);
    as(USERS.b3);
    await removeAccountMember({ data: { actingMemberId: B3M, memberId: id } });
    const row = members(B3).find((m) => m.id === id)!;
    expect(row.status).toBe("removed");
    expect(row.removed_at).toBeTruthy();
    expect(db().table("signed_documents").filter((d) => d.account_member_id === id)).toHaveLength(1);
    await expect(removeAccountMember({ data: { actingMemberId: B3M, memberId: id } })).rejects.toThrow("isn't on your account");
    await add({ email: "frank@test.local", fullName: "Frank" });
    expect(active(B3)).toHaveLength(2);
    expect(members(B3)).toHaveLength(3);
  });

  it("the account holder can't be removed through this", async () => {
    seed();
    as(USERS.b3);
    await expect(removeAccountMember({ data: { actingMemberId: B3M, memberId: B3M } })).rejects.toThrow("isn't on your account");
  });

  it("after the Golden Ticket nothing changes except through an admin, with a reason and an audit row", async () => {
    seed();
    const { id } = await add();
    db().table("buyer_accounts").find((b) => b.id === B3)!.golden_ticket_issued = true;
    as(USERS.b3);
    await expect(add({ email: "z@test.local" })).rejects.toThrow("Golden Ticket");
    await expect(updateAccountMember({ data: { actingMemberId: B3M, memberId: id, fullName: "X", email: "x@test.local" } as never })).rejects.toThrow("Golden Ticket");
    await expect(removeAccountMember({ data: { actingMemberId: B3M, memberId: id } })).rejects.toThrow("Golden Ticket");
    expect((await getMyAccountMembers()).locked).toBe(true);
    await expect(adminChangeAccountMember({ data: { memberId: id, remove: true, reason: "x" } })).rejects.toThrow("Not authorized");
    as(USERS.admin);
    await expect(adminChangeAccountMember({ data: { memberId: id, remove: true, reason: " " } })).rejects.toThrow("reason");
    await adminChangeAccountMember({ data: { memberId: id, remove: true, reason: "Asked by both members" } });
    expect(members(B3).find((m) => m.id === id)!.status).toBe("removed");
    expect(db().audits("admin.member_removed")[0]!.metadata).toMatchObject({ reason: "Asked by both members", member_id: id });
    await expect(adminChangeAccountMember({ data: { memberId: B3M, remove: true, reason: "x" } })).rejects.toThrow("account holder");
  });

  it("a locked cap table locks members too", async () => {
    seed();
    db().seed("cap_table_entries", [{ property_id: "p-lock", share_number: 1, holder_type: "buyer_account", buyer_account_id: B3 }]);
    db().seed("entity_genesis", [{ property_id: "p-lock", cap_table_locked_at: new Date().toISOString() }]);
    await expect(add()).rejects.toThrow("Golden Ticket");
  });
});

describe("identity per member", () => {
  const save = (memberId: string, o: Record<string, unknown> = {}) => {
    as(USERS.b3);
    return saveMemberIdentityFn({ data: { actingMemberId: memberId, fullName: "Dan Three", address: "1 Main St", dateOfBirth: "1980-01-02", idDocumentNumber: "D123 456", ...o } as never });
  };

  it("saves to the acting member only, and says who is still to go", async () => {
    seed();
    const { id } = await add();
    expect(await save(B3M)).toEqual({ pending: ["Eve Three"] });
    expect(members(B3).find((m) => m.id === B3M)).toMatchObject({ date_of_birth: "1980-01-02", id_document_number: "D123456", vetting_status: "identity_submitted" });
    expect(members(B3).find((m) => m.id === id)!.date_of_birth ?? null).toBeNull();
    expect(await save(id, { fullName: "Eve Three", dateOfBirth: "1985-05-05", idDocumentNumber: "E9" })).toEqual({ pending: [] });
    expect(db().audits("buyer.identity_submitted").map((a) => a.metadata.acted_by_member_id)).toEqual([B3M, id]);
  });

  it("refuses the same name, date of birth and ID number for both, with a neutral message", async () => {
    seed();
    const { id } = await add();
    await save(B3M);
    await expect(save(id, { fullName: " dan three ", idDocumentNumber: "d123456" })).rejects.toThrow("Each member must be a different person");
    expect(await save(id, { fullName: "Dan Three", idDocumentNumber: "OTHER" })).toEqual({ pending: [] });
  });

  it("a removed member can't act", async () => {
    seed();
    const { id } = await add();
    as(USERS.b3);
    await removeAccountMember({ data: { actingMemberId: B3M, memberId: id } });
    await expect(save(id)).rejects.toThrow("isn't on your account");
    await expect(confirmActingMember({ data: { memberId: id, step: "Vetting" } })).rejects.toThrow("isn't on your account");
  });

  it("choosing who is acting is audited with IP and browser", async () => {
    seed();
    as(USERS.b3);
    await confirmActingMember({ data: { memberId: B3M, step: "Vetting" } });
    expect(db().audits("buyer.member_acting")[0]!.metadata).toMatchObject({ acted_by_member_id: B3M, step: "Vetting", ip_address: "203.0.113.7" });
  });
});

describe("the Account Members card", () => {
  it("lists active members, the holder first, with progress and a status", async () => {
    seed();
    const { id } = await add();
    db().table("account_members").find((m) => m.id === B3M)!.vetting_status = "cleared";
    db().seed("signed_documents", [{ buyer_account_id: B3, account_member_id: null, document_type: "HOLD_HARMLESS", signed_name: "Dan Three" }]);
    as(USERS.b3);
    const view = await getMyAccountMembers();
    expect(view).toMatchObject({ accountId: B3, locked: false, canAdd: false });
    expect(view.members.map((m) => [m.id, m.role, m.eligibility])).toEqual([
      [B3M, "primary", "eligible"],
      [id, "member", "pending"],
    ]);
    expect(view.members[0]!.checklist.find((c) => c.key === "hold_harmless")!.done).toBe(true);
    expect(view.members[1]!.checklist.every((c) => !c.done)).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/id_document|date_of_birth|D123/);
  });

  it("status labels", () => {
    expect(eligibilityOf("cleared")).toBe("eligible");
    expect(eligibilityOf("flagged_needs_review")).toBe("held");
    expect(eligibilityOf("verification_pending")).toBe("held");
    expect(eligibilityOf("failed")).toBe("not_eligible");
    expect(eligibilityOf("identity_submitted")).toBe("pending");
    expect(samePerson({ full_name: "A", date_of_birth: "1", id_document_number: null }, { full_name: "A", date_of_birth: "1", id_document_number: null })).toBe(false);
  });

  it("a single-member account works as before, and the Golden Ticket ignores removed members", async () => {
    seed();
    const view = await (as(USERS.b3), getMyAccountMembers());
    expect(view.members).toHaveLength(1);
    expect(view.canAdd).toBe(true);
    const { id } = await add();
    as(USERS.b3);
    await removeAccountMember({ data: { actingMemberId: B3M, memberId: id } });
    db().table("account_members").find((m) => m.id === B3M)!.vetting_status = "cleared";
    db().seed("signed_documents", [{ buyer_account_id: B3, document_type: "PRA", signed_name: "Dan Three" }]);
    const gt = await issueGoldenTicketIfEligible({ authUserId: USERS.b3, buyerAccountId: B3 });
    expect(gt.missing).not.toContain("All Account Members must clear vetting");
  });
});
