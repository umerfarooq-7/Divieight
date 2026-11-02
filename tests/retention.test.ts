/** Retention Lock: enforcement, hardship, unanimous consent, scoping and the audit trail. */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import {
  decideRetentionException,
  getOwnerRetention,
  listRetentionExceptionsForAdmin,
  requestRetentionException,
  withdrawRetentionException,
} from "@/lib/retention.functions";
import { assertShareListable, settleVoteExceptions, shareLock } from "@/lib/retention.server";
import { cancelVoteAsAdmin, castVoteBallot, closeVoteAsAdmin, getVoteForOwner } from "@/lib/votes.functions";
import { isOwnRetentionDocPath, lockDaysRemaining } from "@/lib/retention";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const A = IDS.property;
const B = "prop-2";
const DAY = 86_400_000;
const LOCK_END = new Date(Date.now() + 200 * DAY).toISOString();

/** A: B1 (share 1), B2 (share 2), retained seller (share 3). B: B3 (share 1). */
function seed() {
  seedPod(db());
  db().seed("properties", [{ id: B, address: "77 Second St", city: "Casper", state: "WY", zip: "82601", seller_id: "seller-2" }]);
  const cap = (property_id: string, share_number: number, holder: Record<string, unknown>) =>
    db().seed("cap_table_entries", [
      {
        property_id,
        share_number,
        buyer_account_id: null,
        seller_id: null,
        retention_lock_started_at: "2026-10-01T00:00:00.000Z",
        retention_lock_expires_at: LOCK_END,
        ...holder,
      },
    ]);
  cap(A, 1, { holder_type: "buyer_account", buyer_account_id: IDS.b1 });
  cap(A, 2, { holder_type: "buyer_account", buyer_account_id: IDS.b2 });
  cap(A, 3, { holder_type: "retained_seller", seller_id: IDS.seller });
  cap(B, 1, { holder_type: "buyer_account", buyer_account_id: IDS.b3 });
  // One member on B1 so a ballot doesn't need account consensus here.
  const members = db().table("account_members");
  members.splice(0, members.length, ...members.filter((m) => m.id !== IDS.b1m2));
}

const request = (user: string, exceptionType: "hardship" | "unanimous_consent", shareNumber: number, extra: Record<string, unknown> = {}, propertyId = A) => {
  as(user);
  return requestRetentionException({ data: { propertyId, shareNumber, exceptionType, reason: "Family medical costs", ...extra } });
};
const listable = (userId: string, shareNumber: number, propertyId = A) => assertShareListable(db(), { userId, propertyId, shareNumber });
const decide = (exceptionId: string, decision: "approved" | "rejected", note = "Reviewed") => {
  as(USERS.admin);
  return decideRetentionException({ data: { exceptionId, decision, note } });
};
const row = (id: string) => db().table("retention_exceptions").find((e) => e.id === id)!;
const castAll = async (voteId: string, overrides: Record<string, string> = {}) => {
  for (const user of [USERS.b1, USERS.b2, IDS.seller]) {
    as(user);
    const r = await castVoteBallot({ data: { propertyId: A, voteId, choice: overrides[user] ?? "Yes" } });
    expect(r.error).toBeUndefined();
  }
};
const closeVote = (voteId: string) => {
  as(USERS.admin);
  return closeVoteAsAdmin({ data: { voteId } });
};

describe("enforcement", () => {
  it("rejects listing a locked share on the server, with the unlock date, and audits the attempt", async () => {
    seed();
    await expect(listable(USERS.b1, 1)).rejects.toThrow(/Share #1 is under the 12-month Retention Lock until .*\d{4}/);
    expect(db().audits("retention_lock.listing_blocked")).toHaveLength(1);
  });

  it("a share past its lock date can be listed", async () => {
    seed();
    db().table("cap_table_entries").find((c) => c.property_id === A && c.share_number === 1)!.retention_lock_expires_at = new Date(Date.now() - DAY).toISOString();
    await expect(listable(USERS.b1, 1)).resolves.toBeUndefined();
  });

  it("nobody can list a share they don't hold, even an unlocked one", async () => {
    seed();
    db().table("cap_table_entries").find((c) => c.property_id === A && c.share_number === 1)!.retention_lock_expires_at = new Date(Date.now() - DAY).toISOString();
    await expect(listable(USERS.b2, 1)).rejects.toThrow("You don't hold that share.");
    await expect(listable(USERS.b3, 1)).rejects.toThrow("You don't hold that share.");
  });

  it("a retained seller's share follows the same lock", async () => {
    seed();
    await expect(listable(IDS.seller, 3)).rejects.toThrow(/Share #3 is under the 12-month Retention Lock/);
    const { id } = await request(IDS.seller, "hardship", 3);
    await decide(id!, "approved");
    await expect(listable(IDS.seller, 3)).resolves.toBeUndefined();
  });

  it("an approved exception doesn't pass to whoever holds the share next", async () => {
    seed();
    const { id } = await request(USERS.b1, "hardship", 1);
    await decide(id!, "approved");
    expect(await shareLock(db(), A, 1)).toMatchObject({ locked: false });
    db().table("cap_table_entries").find((c) => c.property_id === A && c.share_number === 1)!.buyer_account_id = IDS.b2;
    expect(await shareLock(db(), A, 1)).toMatchObject({ locked: true });
  });

  it("stays locked for another owner's share when one is approved", async () => {
    seed();
    const { id } = await request(USERS.b1, "hardship", 1);
    await decide(id!, "approved");
    await expect(listable(USERS.b2, 2)).rejects.toThrow(/Retention Lock/);
  });
});

describe("hardship", () => {
  it("approved by admin allows listing, with a note, audit and notifications both ways", async () => {
    seed();
    const { id, error } = await request(USERS.b1, "hardship", 1);
    expect(error).toBeUndefined();
    expect(db().notificationsFor(USERS.admin).map((n) => n.type)).toContain("retention");
    await expect(listable(USERS.b1, 1)).rejects.toThrow();

    await decide(id!, "approved", "Documents check out");
    expect(row(id!)).toMatchObject({ status: "approved", decided_by: USERS.admin, decision_note: "Documents check out" });
    await expect(listable(USERS.b1, 1)).resolves.toBeUndefined();
    expect(db().audits("retention_exception.requested")).toHaveLength(1);
    expect(db().audits("retention_exception.approved")).toHaveLength(1);
    expect(db().notificationsFor(USERS.b1).filter((n) => n.type === "retention")).toHaveLength(2);
  });

  it("rejected leaves the share locked and the owner can ask again", async () => {
    seed();
    const { id } = await request(USERS.b1, "hardship", 1);
    await decide(id!, "rejected", "Not a hardship");
    await expect(listable(USERS.b1, 1)).rejects.toThrow();
    expect((await request(USERS.b1, "hardship", 1)).error).toBeUndefined();
  });

  it("only an admin can decide, and only once", async () => {
    seed();
    const { id } = await request(USERS.b1, "hardship", 1);
    as(USERS.b1);
    await expect(decideRetentionException({ data: { exceptionId: id!, decision: "approved", note: "me" } })).rejects.toThrow("Not authorized");
    await decide(id!, "rejected");
    await expect(decide(id!, "approved")).rejects.toThrow("already been decided");
    expect(row(id!).status).toBe("rejected");
  });

  it("a decision needs a note", async () => {
    seed();
    const { id } = await request(USERS.b1, "hardship", 1);
    await expect(decide(id!, "approved", "   ")).rejects.toThrow("Missing decision note");
  });
});

describe("requests", () => {
  it("are refused for someone else's share, an unlocked share, or a second open request", async () => {
    seed();
    expect((await request(USERS.b1, "hardship", 2)).error).toBe("You don't hold that share.");
    expect((await request(USERS.b3, "hardship", 1)).error).toMatch(/ownership/);
    await request(USERS.b1, "hardship", 1);
    expect((await request(USERS.b1, "unanimous_consent", 1)).error).toMatch(/already has a request/);
    db().table("cap_table_entries").find((c) => c.property_id === A && c.share_number === 2)!.retention_lock_expires_at = new Date(Date.now() - DAY).toISOString();
    expect((await request(USERS.b2, "hardship", 2)).error).toMatch(/isn't under the Retention Lock/);
  });

  it("accept a document only from the requester's own folder for this property", async () => {
    seed();
    const own = `${USERS.b1}/${A}/retention-abc.pdf`;
    for (const bad of [`${USERS.b2}/${A}/retention-abc.pdf`, `${USERS.b1}/${B}/retention-abc.pdf`, `${USERS.b1}/${A}/retention-x/../../oa.pdf`, `${USERS.b1}/${A}/oa.pdf`]) {
      expect((await request(USERS.b1, "hardship", 1, { supportingDocUrl: bad })).error).toMatch(/couldn't be attached/);
    }
    const { id } = await request(USERS.b1, "hardship", 1, { supportingDocUrl: own });
    expect(row(id!).supporting_doc_url).toBe(own);
    as(USERS.admin);
    const { rows } = await listRetentionExceptionsForAdmin();
    expect(rows[0]!.documentUrl).toBe(`https://signed.test/${own}`);
  });

  it("only the requester can withdraw, and a withdrawn request stays locked", async () => {
    seed();
    const { id } = await request(USERS.b1, "hardship", 1);
    as(USERS.b2);
    expect((await withdrawRetentionException({ data: { exceptionId: id! } })).error).toMatch(/isn't available/);
    as(USERS.b1);
    expect((await withdrawRetentionException({ data: { exceptionId: id! } })).error).toBeUndefined();
    expect(row(id!).status).toBe("withdrawn");
    await expect(listable(USERS.b1, 1)).rejects.toThrow();
    expect(db().audits("retention_exception.withdrawn")).toHaveLength(1);
  });
});

describe("unanimous consent", () => {
  it("opens a normal unanimous vote with the agreed title, and every holder is told", async () => {
    seed();
    const { voteId } = await request(USERS.b1, "unanimous_consent", 1);
    const vote = db().table("votes").find((v) => v.id === voteId)!;
    expect(vote).toMatchObject({ vote_type: "unanimous", title: "Retention Lock release: share #1", status: "open", property_id: A });
    expect(db().audits("retention_exception.vote_opened")).toHaveLength(1);
    expect(db().audits("vote.created")[0]!.actor_type).toBe("buyer");
    for (const user of [USERS.b2, IDS.seller]) expect(db().notificationsFor(user).map((n) => n.type)).toContain("vote");
    as(USERS.b2);
    expect((await getVoteForOwner({ data: { propertyId: A, voteId: voteId! } }))?.vote.voteType).toBe("unanimous");
  });

  it("a passed vote auto-approves and the share can be listed", async () => {
    seed();
    const { id, voteId } = await request(USERS.b1, "unanimous_consent", 1);
    await expect(listable(USERS.b1, 1)).rejects.toThrow();
    await castAll(voteId!);
    await closeVote(voteId!);
    expect(row(id!)).toMatchObject({ status: "approved", decided_by: null });
    await expect(listable(USERS.b1, 1)).resolves.toBeUndefined();
    expect(db().audits("retention_exception.approved")[0]!.actor_type).toBe("system");
    expect(db().notificationsFor(USERS.admin).filter((n) => /released/i.test(n.message))).toHaveLength(1);
  });

  it("one No, or one missing ballot, rejects and the share stays locked", async () => {
    seed();
    const first = await request(USERS.b1, "unanimous_consent", 1);
    await castAll(first.voteId!, { [IDS.seller]: "No" });
    await closeVote(first.voteId!);
    expect(row(first.id!).status).toBe("rejected");
    await expect(listable(USERS.b1, 1)).rejects.toThrow();

    const second = await request(USERS.b1, "unanimous_consent", 1);
    as(USERS.b1);
    await castVoteBallot({ data: { propertyId: A, voteId: second.voteId!, choice: "Yes" } });
    await closeVote(second.voteId!);
    expect(row(second.id!).status).toBe("rejected");
  });

  it("an overdue vote is settled by the sweep and by the listing check", async () => {
    seed();
    const swept = await request(USERS.b1, "unanimous_consent", 1);
    await castAll(swept.voteId!);
    db().table("votes").find((v) => v.id === swept.voteId)!.closes_at = new Date(Date.now() - 1000).toISOString();
    expect(await settleVoteExceptions(db())).toBe(1);
    expect(row(swept.id!).status).toBe("approved");

    const checked = await request(USERS.b2, "unanimous_consent", 2);
    await castAll(checked.voteId!);
    db().table("votes").find((v) => v.id === checked.voteId)!.closes_at = new Date(Date.now() - 1000).toISOString();
    await expect(listable(USERS.b2, 2)).resolves.toBeUndefined();
  });

  it("a vote closed before the request was updated is still applied, once", async () => {
    seed();
    const { id, voteId } = await request(USERS.b1, "unanimous_consent", 1);
    await castAll(voteId!);
    await closeVote(voteId!);
    row(id!).status = "pending"; // as if the process stopped right after the vote closed
    await settleVoteExceptions(db());
    expect(row(id!).status).toBe("approved");
    await settleVoteExceptions(db());
    await closeVote(voteId!);
    expect(db().audits("retention_exception.approved")).toHaveLength(2);
  });

  it("a cancelled vote rejects the request; withdrawing cancels the vote", async () => {
    seed();
    const cancelled = await request(USERS.b1, "unanimous_consent", 1);
    as(USERS.admin);
    await cancelVoteAsAdmin({ data: { voteId: cancelled.voteId! } });
    expect(row(cancelled.id!)).toMatchObject({ status: "rejected", decision_note: "The vote was cancelled." });

    const withdrawn = await request(USERS.b1, "unanimous_consent", 1);
    as(USERS.b1);
    await withdrawRetentionException({ data: { exceptionId: withdrawn.id! } });
    expect(row(withdrawn.id!).status).toBe("withdrawn");
    expect(db().table("votes").find((v) => v.id === withdrawn.voteId)!.status).toBe("cancelled");
  });

  it("an admin can't short-circuit a unanimous request", async () => {
    seed();
    const { id } = await request(USERS.b1, "unanimous_consent", 1);
    await expect(decide(id!, "approved")).rejects.toThrow("decided by its vote");
    expect(row(id!).status).toBe("pending");
  });

  it("an ordinary vote closing with the same title changes nothing", async () => {
    seed();
    const { id } = await request(USERS.b1, "unanimous_consent", 1);
    db().seed("votes", [{ id: "other", property_id: A, title: "Retention Lock release: share #1", vote_type: "ordinary", options: ["Yes", "No"], status: "open", opens_at: new Date(0).toISOString(), closes_at: new Date(Date.now() + DAY).toISOString() }]);
    await closeVote("other");
    expect(row(id!).status).toBe("pending");
  });
});

describe("scoping", () => {
  it("an owner of A can't see B's requests, and sees only their own shares", async () => {
    seed();
    await request(USERS.b3, "hardship", 1, {}, B);
    await request(USERS.b2, "hardship", 2);

    as(USERS.b1);
    expect(await getOwnerRetention({ data: { propertyId: B } })).toEqual({ allowed: false, shares: [] });
    const mine = await getOwnerRetention({ data: { propertyId: A } });
    expect(mine.shares.map((s) => s.shareNumber)).toEqual([1]);
    expect(mine.shares[0]!.requests).toEqual([]);
    expect(mine.shares[0]).toMatchObject({ locked: true, canRequest: true, daysRemaining: 200 });
  });

  it("a share's next holder doesn't see the previous holder's requests", async () => {
    seed();
    await request(USERS.b1, "hardship", 1);
    db().table("cap_table_entries").find((c) => c.property_id === A && c.share_number === 1)!.buyer_account_id = IDS.b2;
    as(USERS.b2);
    const { shares } = await getOwnerRetention({ data: { propertyId: A } });
    expect(shares.find((s) => s.shareNumber === 1)!.requests).toEqual([]);
  });

  it("the admin list is admin only", async () => {
    seed();
    as(USERS.b1);
    await expect(listRetentionExceptionsForAdmin()).rejects.toThrow("Not authorized");
  });

  it("the owner page shows a pending request and blocks another", async () => {
    seed();
    await request(USERS.b1, "hardship", 1);
    as(USERS.b1);
    const { shares } = await getOwnerRetention({ data: { propertyId: A } });
    expect(shares[0]).toMatchObject({ canRequest: false, locked: true });
    expect(shares[0]!.requests[0]).toMatchObject({ status: "pending", exceptionType: "hardship" });
  });
});

describe("helpers", () => {
  it("days remaining rounds up and never goes negative", () => {
    const now = Date.UTC(2027, 0, 1);
    expect(lockDaysRemaining(new Date(now + DAY / 2).toISOString(), now)).toBe(1);
    expect(lockDaysRemaining(new Date(now - DAY).toISOString(), now)).toBe(0);
  });

  it("the document rule accepts only a direct child of the owner's folder", () => {
    expect(isOwnRetentionDocPath("u/p/retention-a.pdf", "u", "p")).toBe(true);
    expect(isOwnRetentionDocPath("u/p/retention-", "u", "p")).toBe(false);
    expect(isOwnRetentionDocPath("v/p/retention-a.pdf", "u", "p")).toBe(false);
  });
});
