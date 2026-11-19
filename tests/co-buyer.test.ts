/** Co-buyers: two buyers, each with their own account, linked by invitation. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import {
  acceptCoBuyerInvite,
  cancelCoBuyerInvite,
  declineCoBuyerInvite,
  inviteCoBuyer,
  myCoBuyer,
  previewCoBuyerInvite,
  removeCoBuyer,
  resendCoBuyerInvite,
} from "@/lib/co-buyer.server";

const sent: Array<{ to: string; subject: string; body: string; link: string | null }> = [];
vi.mock("@/lib/authorization.notify.server", () => ({
  sendEmail: vi.fn(async (to: string, subject: string, body: string, link: string | null) => {
    sent.push({ to, subject, body, link });
    return true;
  }),
}));

const db = () => harness.db;
const links = () => db().table("co_buyer_links");
const tokenOf = (mail: { link: string | null }) => decodeURIComponent((mail.link ?? "").split("co_buyer=")[1] ?? "");

beforeEach(() => {
  sent.length = 0;
  seedPod(db());
  for (const m of db().table("account_members")) m.status = "active";
});

// b3 (Dan Three) invites b2 (Carol Two, who already has an account) or a brand-new address.
const inviteFromB3 = (over: { name?: string; email?: string } = {}) => inviteCoBuyer(db(), { userId: USERS.b3, name: "Carol Two", email: "b2@test.local", ...over });

describe("inviting a co-buyer", () => {
  it("saves the link with only a hash of the token, sends the email, and records it", async () => {
    const r = await inviteFromB3({ email: "New.Person@Test.local" });
    expect(r.emailed).toBe(true);
    const row = links().find((l) => l.id === r.id)!;
    expect(row).toMatchObject({ inviter_account_id: IDS.b3, invitee_email: "new.person@test.local", invitee_name: "Carol Two", status: "invited" });
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("new.person@test.local");
    expect(sent[0]!.link).toContain("/buyer/register?co_buyer=");
    expect(JSON.stringify(row)).not.toContain(tokenOf(sent[0]!));
    expect(db().audits("buyer.co_buyer_invited")[0]!.metadata).toMatchObject({ link_id: r.id, invitee_email: "new.person@test.local", invitee_has_account: false });
  });

  it("refuses your own address, a bad address, and a missing name", async () => {
    await expect(inviteFromB3({ email: "B3@test.local" })).rejects.toThrow("someone else's email");
    await expect(inviteFromB3({ email: "not-an-email" })).rejects.toThrow("valid email");
    await expect(inviteFromB3({ name: " " })).rejects.toThrow("full name");
    expect(links()).toHaveLength(0);
  });

  it("one open invitation or link at a time", async () => {
    await inviteFromB3();
    await expect(inviteFromB3({ email: "other@test.local" })).rejects.toThrow("already have a co-buyer");
    expect(links()).toHaveLength(1);
  });

  it("refuses someone who is already linked to another buyer", async () => {
    await inviteFromB3();
    await acceptCoBuyerInvite(db(), { userId: USERS.b2, linkId: links()[0]!.id });
    await expect(inviteCoBuyer(db(), { userId: USERS.b1, name: "Carol", email: "b2@test.local" })).rejects.toThrow("already linked to another buyer");
  });

  it("an account that is somebody's co-buyer cannot invite its own", async () => {
    await inviteFromB3();
    await acceptCoBuyerInvite(db(), { userId: USERS.b2, linkId: links()[0]!.id });
    await expect(inviteCoBuyer(db(), { userId: USERS.b2, name: "Someone", email: "x@test.local" })).rejects.toThrow("already linked to another buyer");
  });
});

describe("accepting, declining and withdrawing", () => {
  it("the invited person accepts from their dashboard: the link goes active and the inviter is told", async () => {
    const { id } = await inviteFromB3();
    const r = await acceptCoBuyerInvite(db(), { userId: USERS.b2, linkId: id });
    expect(r.inviterName).toBe("Dan Three");
    expect(links().find((l) => l.id === id)).toMatchObject({ status: "active", invitee_account_id: IDS.b2 });
    expect(links().find((l) => l.id === id)!.accepted_at).toBeTruthy();
    expect(db().table("notifications").some((n) => n.seller_id === USERS.b3 && n.type === "co_buyer")).toBe(true);
    expect(db().audits("buyer.co_buyer_accepted")).toHaveLength(1);
  });

  it("a new person accepts by signing up from the email link (the token)", async () => {
    // Carol's account is created after she was invited at a new address.
    await inviteFromB3({ email: "late@test.local" });
    db().table("buyer_accounts").find((a) => a.id === IDS.b2)!.email = "late@test.local";
    const r = await acceptCoBuyerInvite(db(), { userId: USERS.b2, token: tokenOf(sent[0]!) });
    expect(r.inviterName).toBe("Dan Three");
    expect(links()[0]).toMatchObject({ status: "active", invitee_account_id: IDS.b2 });
  });

  it("refuses an invitation that was sent to a different address", async () => {
    const { id } = await inviteFromB3();
    await expect(acceptCoBuyerInvite(db(), { userId: USERS.b1, linkId: id })).rejects.toThrow("different email address");
    expect(links()[0]!.status).toBe("invited");
  });

  it("the inviter cannot accept their own invitation, and a wrong token finds nothing", async () => {
    const { id } = await inviteFromB3();
    await expect(acceptCoBuyerInvite(db(), { userId: USERS.b3, linkId: id })).rejects.toThrow("isn't yours");
    await expect(acceptCoBuyerInvite(db(), { userId: USERS.b2, token: "x".repeat(40) })).rejects.toThrow("can't be found");
  });

  it("an invitation can be answered once", async () => {
    const { id } = await inviteFromB3();
    await acceptCoBuyerInvite(db(), { userId: USERS.b2, linkId: id });
    await expect(acceptCoBuyerInvite(db(), { userId: USERS.b2, linkId: id })).rejects.toThrow("can't be found");
  });

  it("declining ends it, tells the inviter, and they can invite someone else", async () => {
    const { id } = await inviteFromB3();
    await declineCoBuyerInvite(db(), { userId: USERS.b2, linkId: id });
    expect(links()[0]).toMatchObject({ status: "declined" });
    expect(db().table("notifications").some((n) => n.seller_id === USERS.b3 && /declined/i.test(String(n.message)))).toBe(true);
    await expect(inviteFromB3({ email: "someone@test.local" })).resolves.toMatchObject({ emailed: true });
  });

  it("only the person it was sent to can decline it", async () => {
    const { id } = await inviteFromB3();
    await expect(declineCoBuyerInvite(db(), { userId: USERS.b1, linkId: id })).rejects.toThrow("isn't yours");
  });

  it("the inviter can withdraw an unanswered invitation", async () => {
    await inviteFromB3();
    await cancelCoBuyerInvite(db(), { userId: USERS.b3 });
    expect(links()[0]!.status).toBe("revoked");
    await expect(cancelCoBuyerInvite(db(), { userId: USERS.b3 })).rejects.toThrow("can't be found");
  });
});

describe("sending it again", () => {
  it("waits a minute, then sends a fresh link and the old one stops working", async () => {
    await inviteFromB3({ email: "again@test.local" });
    const first = tokenOf(sent[0]!);
    links()[0]!.invited_at = new Date().toISOString(); // the database stamps this on insert
    await expect(resendCoBuyerInvite(db(), { userId: USERS.b3 })).rejects.toThrow("a moment ago");
    links()[0]!.invited_at = new Date(Date.now() - 5 * 60_000).toISOString();
    await resendCoBuyerInvite(db(), { userId: USERS.b3 });
    expect(sent).toHaveLength(2);
    const second = tokenOf(sent[1]!);
    expect(second).not.toBe(first);
    expect(await previewCoBuyerInvite(db(), { token: first })).toBeNull();
    expect(await previewCoBuyerInvite(db(), { token: second })).toMatchObject({ inviterName: "Dan Three", inviteeEmail: "again@test.local" });
  });
});

describe("the dashboard card", () => {
  it("shows the invitation addressed to your email, then the active link with how far they are", async () => {
    const { id } = await inviteFromB3();
    const before = await myCoBuyer(db(), { userId: USERS.b2 });
    expect(before.link).toBeNull();
    expect(before.incoming).toEqual([expect.objectContaining({ id, inviterName: "Dan Three" })]);

    await acceptCoBuyerInvite(db(), { userId: USERS.b2, linkId: id });
    const mine = await myCoBuyer(db(), { userId: USERS.b2 });
    expect(mine.incoming).toEqual([]);
    expect(mine.link).toMatchObject({ role: "invitee", status: "active", partnerName: "Dan Three", partnerProgress: "onboarding" });
    db().table("buyer_accounts").find((a) => a.id === IDS.b3)!.golden_ticket_issued = true;
    expect((await myCoBuyer(db(), { userId: USERS.b2 })).link?.partnerProgress).toBe("ready");
    expect((await myCoBuyer(db(), { userId: USERS.b3 })).link).toMatchObject({ role: "inviter", status: "active", partnerName: "Carol Two" });
  });

  it("shows nothing about the other buyer beyond a name, email and progress", async () => {
    const { id } = await inviteFromB3();
    await acceptCoBuyerInvite(db(), { userId: USERS.b2, linkId: id });
    const view = JSON.stringify(await myCoBuyer(db(), { userId: USERS.b2 }));
    expect(view).not.toMatch(/token|liquidity|vetting|date_of_birth|id_document/);
  });
});

describe("ending the link", () => {
  it("either side can end it; the other is told; the accounts are untouched", async () => {
    const { id } = await inviteFromB3();
    await acceptCoBuyerInvite(db(), { userId: USERS.b2, linkId: id });
    const accountsBefore = JSON.stringify(db().table("buyer_accounts"));
    await removeCoBuyer(db(), { userId: USERS.b2 });
    expect(links()[0]).toMatchObject({ status: "revoked" });
    expect(db().table("notifications").some((n) => n.seller_id === USERS.b3 && /ended/i.test(String(n.message)))).toBe(true);
    expect(JSON.stringify(db().table("buyer_accounts"))).toBe(accountsBefore);
    await expect(removeCoBuyer(db(), { userId: USERS.b2 })).rejects.toThrow("can't be found");
    // Free to link again.
    await expect(inviteFromB3()).resolves.toMatchObject({ emailed: true });
  });
});
