/** Owner voting: weights, consensus, windows, scoping, tally and the audit trail. */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS, hoursFromNow } from "./fixtures";
import {
  cancelVoteAsAdmin,
  castVoteBallot,
  closeVoteAsAdmin,
  createVoteAsAdmin,
  getVoteForOwner,
  listVotesForAdmin,
  listVotesForOwner,
  openVoteAsAdmin,
  recordVotePosition,
} from "@/lib/votes.functions";
import { nameInitials, tallyVote } from "@/lib/votes";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const A = IDS.property;
const B = "prop-2";

/** A: B1 (2 members, shares 1-2), B2 (1 member, shares 3-5), seller (6-8). B: B3. */
function seed() {
  seedPod(db());
  db().seed("properties", [{ id: B, address: "77 Second St", city: "Casper", state: "WY", zip: "82601", seller_id: "seller-2" }]);
  const cap = (property_id: string, share_number: number, holder: Record<string, unknown>) =>
    db().seed("cap_table_entries", [{ property_id, share_number, buyer_account_id: null, seller_id: null, ...holder }]);
  for (const n of [1, 2]) cap(A, n, { holder_type: "buyer_account", buyer_account_id: IDS.b1 });
  for (const n of [3, 4, 5]) cap(A, n, { holder_type: "buyer_account", buyer_account_id: IDS.b2 });
  for (const n of [6, 7, 8]) cap(A, n, { holder_type: "retained_seller", seller_id: IDS.seller });
  cap(B, 1, { holder_type: "buyer_account", buyer_account_id: IDS.b3 });
}

async function newVote(propertyId = A, voteType: "ordinary" | "major" | "unanimous" = "ordinary", open = true) {
  as(USERS.admin);
  const { id } = await createVoteAsAdmin({
    data: { propertyId, title: "Replace the roof", voteType, opensAt: hoursFromNow(-1), closesAt: hoursFromNow(24) },
  });
  if (open) await openVoteAsAdmin({ data: { voteId: id } });
  return id;
}

const cast = (voteId: string, user: string, choice: string, propertyId = A) => {
  as(user);
  return castVoteBallot({ data: { propertyId, voteId, choice } });
};
const position = (voteId: string, accountMemberId: string, value: string, initials: string) => {
  as(USERS.b1);
  return recordVotePosition({ data: { propertyId: A, voteId, accountMemberId, position: value, initials } });
};
const agreeB1 = async (voteId: string, value: string) => {
  await position(voteId, IDS.b1m1, value, "AO");
  await position(voteId, IDS.b1m2, value, "BO");
};
const voteRow = (id: string) => db().table("votes").find((v) => v.id === id)!;
const summary = (id: string) => voteRow(id).result_summary;

describe("weights", () => {
  it("come from the cap table: 2 shares is weight 2, 3 shares weight 3", async () => {
    seed();
    const id = await newVote();
    as(USERS.b1);
    const mine = await getVoteForOwner({ data: { propertyId: A, voteId: id } });
    expect(mine).toMatchObject({ myWeight: 2, myShareNumbers: [1, 2] });
    expect((await listVotesForOwner({ data: { propertyId: A } })).votes[0]).toMatchObject({ myWeight: 2, myChoice: null });
    as(IDS.seller);
    expect(await getVoteForOwner({ data: { propertyId: A, voteId: id } })).toMatchObject({ myWeight: 3, myShareNumbers: [6, 7, 8] });
  });

  it("the tally uses the cap table at close", async () => {
    seed();
    const id = await newVote();
    await cast(id, USERS.b2, "Yes");
    db().table("cap_table_entries").find((c) => c.share_number === 3)!.buyer_account_id = IDS.b1;
    as(USERS.admin);
    await closeVoteAsAdmin({ data: { voteId: id } });
    expect(summary(id).tally[0]).toEqual({ choice: "Yes", shares: 2 });
  });
});

describe("multi-member consensus", () => {
  it("blocks casting until every member records the same position", async () => {
    seed();
    const id = await newVote();
    expect((await cast(id, USERS.b1, "Yes")).error).toContain("Alice One, Bob One");

    await position(id, IDS.b1m1, "Yes", "AO");
    expect((await cast(id, USERS.b1, "Yes")).error).toContain("Waiting for Bob One");
    as(USERS.b1);
    expect((await getVoteForOwner({ data: { propertyId: A, voteId: id } }))!.consensus.state).toBe("pending");

    await position(id, IDS.b1m2, "No", "BO");
    expect((await cast(id, USERS.b1, "Yes")).error).toBe("Your account members disagree — reach consensus to cast.");
    expect(db().table("vote_ballots")).toEqual([]);

    await position(id, IDS.b1m2, "Yes", "BO");
    expect((await cast(id, USERS.b1, "No")).error).toContain("agreed position");
    expect(await cast(id, USERS.b1, "Yes")).toEqual({ changed: false });
    expect(db().table("vote_ballots")[0]).toMatchObject({ holder_key: IDS.b1, choice: "Yes", share_numbers: [1, 2] });
  });

  it("a position needs that member's initials, and only for this account's members", async () => {
    seed();
    const id = await newVote();
    expect((await position(id, IDS.b1m1, "Yes", "XX")).error).toContain("initials");
    expect((await position(id, IDS.b2m1, "Yes", "CT")).error).toContain("isn't on your account");
    expect((await position(id, IDS.b1m1, "Maybe", "AO")).error).toContain("options");
    expect(db().table("vote_member_positions")).toEqual([]);
  });

  it("single-member accounts and retained sellers cast directly", async () => {
    seed();
    const id = await newVote();
    expect(await cast(id, USERS.b2, "No")).toEqual({ changed: false });
    expect(await cast(id, IDS.seller, "Yes")).toEqual({ changed: false });
    expect(db().table("vote_ballots").find((b) => b.choice === "Yes")!.holder_key).toBe(`seller:${IDS.seller}`);
  });

  it("an earlier ballot stands until the account agrees on a new one", async () => {
    seed();
    const id = await newVote();
    await agreeB1(id, "Yes");
    await cast(id, USERS.b1, "Yes");
    await position(id, IDS.b1m1, "No", "AO");
    expect((await cast(id, USERS.b1, "No")).error).toContain("disagree");
    expect(db().table("vote_ballots")[0]!.choice).toBe("Yes");
    await position(id, IDS.b1m2, "No", "BO");
    expect(await cast(id, USERS.b1, "No")).toEqual({ changed: true });
  });
});

describe("scoping", () => {
  it("an owner of A can't see or vote in B's votes, and drafts stay hidden", async () => {
    seed();
    const b = await newVote(B);
    const draft = await newVote(A, "ordinary", false);
    as(USERS.b1);
    expect(await listVotesForOwner({ data: { propertyId: B } })).toEqual({ allowed: false, votes: [] });
    expect(await getVoteForOwner({ data: { propertyId: B, voteId: b } })).toBeNull();
    expect(await getVoteForOwner({ data: { propertyId: A, voteId: b } })).toBeNull(); // B's vote via A's URL
    expect((await cast(b, USERS.b1, "Yes", A)).error).toContain("isn't available");
    expect((await cast(b, USERS.b2, "Yes", B)).error).toContain("isn't available");
    as(USERS.b1);
    expect(await getVoteForOwner({ data: { propertyId: A, voteId: draft } })).toBeNull();
    expect((await listVotesForOwner({ data: { propertyId: A } })).votes).toEqual([]);
    expect((await cast(draft, USERS.b2, "Yes")).error).toContain("isn't available");
    expect(db().table("vote_ballots")).toEqual([]);
  });

  it("voting isn't gated by a Digital Key or property status (Rev 48)", async () => {
    seed();
    const id = await newVote();
    db().seed("co_owner_digital_keys", [{ property_id: A, holder_type: "buyer_account", buyer_account_id: IDS.b2, shares: 3, status: "revoked" }]);
    db().table("properties").find((p) => p.id === A)!.listing_status = "forming";
    expect(await cast(id, USERS.b2, "Yes")).toEqual({ changed: false });
  });

  it("only admins can create, open, close or cancel", async () => {
    seed();
    const id = await newVote();
    as(USERS.b1);
    await expect(createVoteAsAdmin({ data: { propertyId: A, title: "x", voteType: "ordinary", opensAt: hoursFromNow(1), closesAt: hoursFromNow(2) } })).rejects.toThrow("Not authorized");
    await expect(openVoteAsAdmin({ data: { voteId: id } })).rejects.toThrow("Not authorized");
    await expect(closeVoteAsAdmin({ data: { voteId: id } })).rejects.toThrow("Not authorized");
    await expect(cancelVoteAsAdmin({ data: { voteId: id } })).rejects.toThrow("Not authorized");
    await expect(listVotesForAdmin({ data: { propertyId: A } })).rejects.toThrow("Not authorized");
  });
});

describe("window", () => {
  it("rejects a ballot after close, and can't change one either", async () => {
    seed();
    const id = await newVote();
    await cast(id, USERS.b2, "Yes");
    as(USERS.admin);
    await closeVoteAsAdmin({ data: { voteId: id } });
    expect((await cast(id, USERS.b2, "No")).error).toBe("This vote is not open.");
    expect((await cast(id, IDS.seller, "No")).error).toBe("This vote is not open.");
    expect(db().table("vote_ballots").map((b) => b.choice)).toEqual(["Yes"]);
  });

  it("rejects before it opens and after its closing time, and closes itself on the next read", async () => {
    seed();
    const id = await newVote();
    voteRow(id).opens_at = hoursFromNow(2);
    expect((await cast(id, USERS.b2, "Yes")).error).toBe("This vote hasn't opened yet.");
    voteRow(id).opens_at = hoursFromNow(-5);
    voteRow(id).closes_at = hoursFromNow(-1);
    expect((await cast(id, USERS.b2, "Yes")).error).toBe("This vote has closed.");

    as(USERS.b2);
    const { votes } = await listVotesForOwner({ data: { propertyId: A } });
    expect(votes[0]!.status).toBe("closed");
    expect(summary(id)).toBeTruthy();
    expect(db().audits("vote.closed")).toHaveLength(1);
    await listVotesForOwner({ data: { propertyId: A } });
    expect(db().audits("vote.closed")).toHaveLength(1);
  });

  it("a ballot can change before close", async () => {
    seed();
    const id = await newVote();
    await cast(id, USERS.b2, "Yes");
    expect(await cast(id, USERS.b2, "No")).toEqual({ changed: true });
    expect(db().table("vote_ballots")).toHaveLength(1);
    expect(db().table("vote_ballots")[0]!.choice).toBe("No");
  });

  it("cancelled votes take no ballots and have no result", async () => {
    seed();
    const id = await newVote();
    as(USERS.admin);
    await cancelVoteAsAdmin({ data: { voteId: id } });
    expect((await cast(id, USERS.b2, "Yes")).error).toBe("This vote is not open.");
    as(USERS.admin);
    await closeVoteAsAdmin({ data: { voteId: id } });
    expect(voteRow(id).status).toBe("cancelled");
    expect(summary(id) ?? null).toBeNull();
  });
});

describe("results", () => {
  const issued8 = (voteType: "ordinary" | "major" | "unanimous", yes: number) =>
    tallyVote({ voteType, options: ["Yes", "No", "Abstain"], issuedShares: 8, ballots: [{ choice: "Yes", weight: yes }] });

  it("applies the placeholder thresholds to all issued shares", () => {
    expect(issued8("ordinary", 4).passed).toBe(false);
    expect(issued8("ordinary", 5).passed).toBe(true);
    expect(issued8("major", 5).passed).toBe(false);
    expect(issued8("major", 6).passed).toBe(true);
    expect(issued8("unanimous", 7).passed).toBe(false);
    expect(issued8("unanimous", 8).passed).toBe(true);
    expect(issued8("major", 6).thresholdsArePlaceholder).toBe(true);
    expect(tallyVote({ voteType: "unanimous", options: ["Yes", "No"], issuedShares: 0, ballots: [] }).passed).toBe(false);
  });

  it("tallies by share weight, reports participation, and shows results to owners after close", async () => {
    seed();
    const id = await newVote();
    await agreeB1(id, "Yes");
    await cast(id, USERS.b1, "Yes");
    await cast(id, USERS.b2, "Yes");
    await cast(id, IDS.seller, "No");
    as(USERS.b2);
    expect((await getVoteForOwner({ data: { propertyId: A, voteId: id } }))!.result).toBeNull();
    as(USERS.admin);
    await closeVoteAsAdmin({ data: { voteId: id } });
    expect(summary(id)).toMatchObject({
      tally: [{ choice: "Yes", shares: 5 }, { choice: "No", shares: 3 }, { choice: "Abstain", shares: 0 }],
      votedShares: 8,
      totalShares: 8,
      issuedShares: 8,
      requiredShares: 5,
      passed: true,
    });
    as(USERS.b1);
    const result = (await getVoteForOwner({ data: { propertyId: A, voteId: id } }))!.result;
    expect(result!.passed).toBe(true);
    expect(JSON.stringify(result)).not.toContain(IDS.b2); // no per-holder breakdown
  });

  it("closing twice doesn't re-tally", async () => {
    seed();
    const id = await newVote();
    await cast(id, USERS.b2, "Yes");
    as(USERS.admin);
    await closeVoteAsAdmin({ data: { voteId: id } });
    const first = summary(id);
    await closeVoteAsAdmin({ data: { voteId: id } });
    expect(summary(id)).toBe(first);
    expect(db().audits("vote.closed")).toHaveLength(1);
  });
});

describe("audit vault", () => {
  it("logs create, open, position, cast, change and close with actor, property, vote, holder and weight", async () => {
    seed();
    const id = await newVote();
    await agreeB1(id, "Yes");
    await cast(id, USERS.b1, "Yes");
    await cast(id, USERS.b2, "Yes");
    await cast(id, USERS.b2, "No");
    as(USERS.admin);
    await closeVoteAsAdmin({ data: { voteId: id } });

    expect(db().audits("vote.created")).toHaveLength(1);
    expect(db().audits("vote.opened")).toHaveLength(1);
    expect(db().audits("vote.member_position_recorded")).toHaveLength(2);
    expect(db().audits("vote.ballot_changed")).toHaveLength(1);
    expect(db().audits("vote.closed")).toHaveLength(1);
    const castRow = db().audits("vote.ballot_cast").find((a) => a.metadata.holder_key === IDS.b1)!;
    expect(castRow).toMatchObject({ actor_id: USERS.b1, entity_id: id, entity_type: "vote" });
    expect(castRow.metadata).toMatchObject({ property_id: A, vote_id: id, holder_key: IDS.b1, weight: 2 });
    expect(castRow.metadata.at).toBeTruthy();
  });

  it("opening tells every holder once", async () => {
    seed();
    await newVote();
    for (const user of [USERS.b1, USERS.b2, IDS.seller]) expect(db().notificationsFor(user).at(-1)!.message).toContain("A vote is open");
    expect(db().notificationsFor(USERS.b3)).toEqual([]);
  });
});

describe("initials", () => {
  it("follow the same rule as the existing verification step", () => {
    expect(nameInitials("Alice One")).toBe("AO");
    expect(nameInitials("Jane")).toBe("JA");
    expect(nameInitials("Jane A. Sample")).toBe("JAS");
  });
});
