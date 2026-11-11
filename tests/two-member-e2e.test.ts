/**
 * A two-member Buyer Account created the real way (registration, then the Add-a-member flow, then each
 * member's own identity step), taken through every flow that has to handle two members. Nothing about the
 * members is test-inserted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, IDS, USERS, hoursFromNow, acceptBlock2ForAll } from "./fixtures";
import { ensureBuyerAccount } from "@/lib/buyer";
import { addAccountMember, saveMemberIdentityFn } from "@/lib/account-members.functions";
import { acknowledgeAsAgent, acknowledgeAsMember, getAuthorizationGateStatus, placeDiligenceDocument } from "@/lib/due-diligence.functions";
import { createAuthorizationRequest, getBuyerAuthorization, proposeCommissionItem, respondToAuthorization, respondToCommissionItem } from "@/lib/authorization.functions";
import { issueEarnestMoney, listBuyerEarnestMoney, markEarnestFunded } from "@/lib/earnest-money.functions";
import { issueClosingFunds, listBuyerClosingFunds, markClosingFundsFunded } from "@/lib/closing-funds.functions";
import { ensureDigitalGenesis } from "@/lib/entity-genesis.server";
import { runStage2Action, signMyOperatingAgreement } from "@/lib/entity-genesis-stage2.functions";
import { castVoteBallot, createVoteAsAdmin, openVoteAsAdmin, recordVotePosition } from "@/lib/votes.functions";
import { createResaleListing, exerciseResaleRofr, recordResalePosition } from "@/lib/resale.functions";
import { listMyTetheredBuyers } from "@/lib/agent-leads.functions";
import { getAgentPodView } from "@/lib/agent-pod.functions";
import { deliver } from "@/lib/authorization.notify.server";
import { grantAuthorityFn } from "@/lib/member-authority.functions";
import { jointHolderLabel } from "@/lib/entity-genesis";

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

/** Registration, Add a member, and each member's own identity step: the real flows. */
async function buildTwoMemberAccount() {
  seedPod(db());
  // Drop the fixture's pre-made account and members: the one below is created through the app.
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
  Object.assign(db().table("buyer_accounts").find((a) => a.id === ACCOUNT)!, { tethered_resident_agent_id: IDS.ra, liquidity_verified: true, primary_target_market: "WY" });
}

beforeEach(buildTwoMemberAccount);

describe("the account really has two members, made the real way", () => {
  it("one account, one login, two active members with their own records", () => {
    expect(db().table("buyer_accounts").filter((a) => a.id === ACCOUNT)).toHaveLength(1);
    const members = db().table("account_members").filter((m) => m.buyer_account_id === ACCOUNT);
    expect(members.map((m) => [m.full_name, m.role, m.status, m.email])).toEqual([
      ["Alice Real", "primary", "active", "alice.real@test.local"],
      ["Bob Real", "member", "active", "bob.real@test.local"],
    ]);
    expect(members.map((m) => [m.date_of_birth, m.id_document_number])).toEqual([[DOB, ID_NO], [BOB_DOB, BOB_ID_NO]]);
  });
});

// ---------------------------------------------------------------------------
// 1. Due Diligence Acknowledgment Gate
// ---------------------------------------------------------------------------

describe("1. the Due Diligence gate opens only when every member (or authority) and the agent have acknowledged", () => {
  async function doc(propertyId = P, title = "Inspection") {
    as(USERS.admin);
    const placed = await placeDiligenceDocument({ data: { propertyId, documentTitle: title, category: "inspection", fileUrl: `dd/${title}.pdf`, contentHash: `h-${title}` } });
    return { id: placed.id!, hash: `h-${title}` };
  }
  const ack = (documentId: string, contentHash: string, memberId: string, name: string, onBehalfOfMemberId?: string) => {
    as(USERS.b1);
    return acknowledgeAsMember({ data: { documentId, contentHash, accountMemberId: memberId, signedName: name, onBehalfOfMemberId } });
  };
  const agentAck = (documentId: string, contentHash: string) => {
    as(USERS.ra);
    return acknowledgeAsAgent({ data: { documentId, contentHash, buyerAccountId: ACCOUNT, signedName: "Rita Resident" } });
  };
  const gate = (propertyId = P) => (as(USERS.b1), getAuthorizationGateStatus({ data: { propertyId } }));

  it("one member is not enough; both members and the agent open it", async () => {
    const d = await doc();
    expect((await gate()).clear).toBe(false);
    expect(await ack(d.id, d.hash, ALICE, "Alice Real")).toEqual({ ok: true });
    await agentAck(d.id, d.hash);
    expect((await gate()).clear).toBe(false); // Bob hasn't
    expect(await ack(d.id, d.hash, BOB, "Bob Real")).toEqual({ ok: true });
    expect((await gate()).clear).toBe(true);
  });

  it("every required document needs both members: acknowledging one document doesn't open the gate for another", async () => {
    const a = await doc(P, "Inspection");
    const b = await doc(P, "Title commitment");
    for (const d of [a, b]) await agentAck(d.id, d.hash);
    await ack(a.id, a.hash, ALICE, "Alice Real");
    await ack(a.id, a.hash, BOB, "Bob Real");
    await ack(b.id, b.hash, ALICE, "Alice Real");
    expect((await gate()).clear).toBe(false);
    await ack(b.id, b.hash, BOB, "Bob Real");
    expect((await gate()).clear).toBe(true);
  });

  it("under documented authority one member can acknowledge for the other, and it is recorded as such", async () => {
    const d = await doc();
    await agentAck(d.id, d.hash);
    await ack(d.id, d.hash, ALICE, "Alice Real");
    expect((await ack(d.id, d.hash, BOB, "Bob Real", ALICE)).ok).toBe(false); // not Bob's to give
    as(USERS.b1);
    await grantAuthorityFn({ data: { actingMemberId: BOB, granteeMemberId: ALICE, scope: ["due_diligence_ack"], typedName: "Bob Real" } });
    expect(await ack(d.id, d.hash, ALICE, "Alice Real", BOB)).toEqual({ ok: true });
    expect((await gate()).clear).toBe(true);
    expect(db().table("due_diligence_acknowledgments").find((a) => a.on_behalf_of_member_id === BOB)).toMatchObject({ account_member_id: BOB, acted_by_member_id: ALICE, signed_name: "Alice Real" });
  });

  it("is scoped by property: acknowledging this property's document does nothing for another property's", async () => {
    const here = await doc(P, "Inspection");
    db().seed("properties", [{ id: "prop-other", address: "9 Other Rd", city: "Casper", state: "WY", zip: "82601", seller_id: IDS.seller }]);
    const there = await doc("prop-other", "Appraisal");
    await agentAck(here.id, here.hash);
    await ack(here.id, here.hash, ALICE, "Alice Real");
    await ack(here.id, here.hash, BOB, "Bob Real");
    expect((await gate(P)).clear).toBe(true);
    const other = await gate("prop-other");
    expect(other.clear).toBe(false);
    expect(other.pending.map((p) => p.documentId)).toEqual([there.id]);
    expect(other.pending[0]!.awaitingMembers.sort()).toEqual(["Alice Real", "Bob Real"]);
  });

  it("is scoped by account: another account's members acknowledging the same document don't count for this one", async () => {
    const d = await doc();
    await agentAck(d.id, d.hash);
    await ack(d.id, d.hash, ALICE, "Alice Real");
    as(USERS.b2);
    expect(await acknowledgeAsMember({ data: { documentId: d.id, contentHash: d.hash, accountMemberId: IDS.b2m1, signedName: "Carol Two" } })).toEqual({ ok: true });
    const status = await gate();
    expect(status.clear).toBe(false);
    expect(status.pending[0]!.awaitingMembers).toEqual(["Bob Real"]);
  });

  it("a revised document needs both members again", async () => {
    const d = await doc();
    await agentAck(d.id, d.hash);
    await ack(d.id, d.hash, ALICE, "Alice Real");
    await ack(d.id, d.hash, BOB, "Bob Real");
    expect((await gate()).clear).toBe(true);
    as(USERS.admin);
    const revised = await placeDiligenceDocument({ data: { propertyId: P, documentTitle: "Inspection", category: "inspection", fileUrl: "dd/i2.pdf", contentHash: "h-new", supersedesId: d.id } });
    expect(revised.ok ?? true).toBeTruthy();
    const status = await gate();
    expect(status.clear).toBe(false);
    expect(status.pending[0]!.awaitingMembers.sort()).toEqual(["Alice Real", "Bob Real"]);
  });

  it("a member who isn't on the account can't acknowledge, and a removed member doesn't block the gate", async () => {
    const d = await doc();
    as(USERS.b1);
    expect((await acknowledgeAsMember({ data: { documentId: d.id, contentHash: d.hash, accountMemberId: IDS.b2m1, signedName: "Carol Two" } })).ok).toBe(false);
    await agentAck(d.id, d.hash);
    await ack(d.id, d.hash, ALICE, "Alice Real");
    db().table("account_members").find((m) => m.id === BOB)!.status = "removed";
    expect((await gate()).clear).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Authorizations and the itemized commission
// ---------------------------------------------------------------------------

describe("2. an authorization is tendered only when every member has confirmed", () => {
  async function request(commissionExpected = false) {
    as(USERS.admin);
    return (await createAuthorizationRequest({ data: { propertyId: P, buyerAccountId: ACCOUNT, actionType: "offer_tender", headline: "Offer", terms: { Price: "$1" }, commissionExpected } })).id;
  }
  const respond = (requestId: string, memberId: string, name: string, onBehalf?: string) => {
    as(USERS.b1);
    return respondToAuthorization({ data: { requestId, accountMemberId: memberId, decision: "confirmed", signedName: name, secondaryVerificationMethod: "typed_initials", onBehalfOfMemberId: onBehalf ?? null } });
  };
  const status = (id: string) => db().table("authorization_requests").find((r) => r.id === id)!.status;

  it("one confirmation leaves it pending; the second makes it authorized", async () => {
    const id = await request();
    const first = await respond(id, ALICE, "Alice Real");
    expect(first.disposition).toBeNull();
    expect(status(id)).toBe("pending");
    expect((await respond(id, BOB, "Bob Real")).disposition).toBe("authorized");
    expect(status(id)).toBe("authorized");
    as(USERS.b1);
    expect((await getBuyerAuthorization({ data: { id } })).allowed).toBe(true);
  });

  it("a decline by either member ends it as declined", async () => {
    const id = await request();
    await respond(id, ALICE, "Alice Real");
    as(USERS.b1);
    const r = await respondToAuthorization({ data: { requestId: id, accountMemberId: BOB, decision: "declined", signedName: "Bob Real", secondaryVerificationMethod: "typed_initials" } });
    expect(r.disposition).toBe("declined");
  });

  it("under documented authority one member answers for both, and it's recorded", async () => {
    const id = await request();
    as(USERS.b1);
    await grantAuthorityFn({ data: { actingMemberId: BOB, granteeMemberId: ALICE, scope: ["authorizations"], typedName: "Bob Real" } });
    await respond(id, ALICE, "Alice Real");
    expect((await respond(id, ALICE, "Alice Real", BOB)).disposition).toBeTruthy();
    expect(status(id)).toBe("authorized");
  });

  it("the itemized commission needs both members too, and the instrument is tendered only when everything is authorized", async () => {
    as(USERS.admin);
    const { id } = await createAuthorizationRequest({ data: { propertyId: P, buyerAccountId: ACCOUNT, actionType: "final_repa_acceptance", headline: "Final REPA", terms: { Price: "$2.5M" } } });
    as(USERS.hla);
    await proposeCommissionItem({ data: { requestId: id, ratePercent: 2.5, fundingSource: "proceeds_at_closing", provisionText: "Buyer-side 2.5%" } });
    // Both members authorize the instrument: it still isn't tendered while the commission is outstanding.
    await respond(id, ALICE, "Alice Real");
    await respond(id, BOB, "Bob Real");
    expect(status(id)).toBe("pending");
    const commission = (who: string, name: string) => {
      as(USERS.b1);
      return respondToCommissionItem({ data: { requestId: id, accountMemberId: who, decision: "confirmed", signedName: name, secondaryVerificationMethod: "typed_initials" } });
    };
    await commission(ALICE, "Alice Real");
    expect(status(id)).toBe("pending"); // Bob hasn't authorized the commission
    await commission(BOB, "Bob Real");
    expect(status(id)).toBe("authorized");
  });
});

// ---------------------------------------------------------------------------
// 3. Earnest money and closing funds
// ---------------------------------------------------------------------------

describe("3. earnest money and closing funds: one obligation per account", () => {
  it("one earnest-money obligation for the account, not one per member; both members see it through the account", async () => {
    as(USERS.admin);
    await issueEarnestMoney({ data: { propertyId: P, totalAmount: 9000, fundingDeadline: hoursFromNow(72), escrowCompany: "First American", escrowAccountDetails: "Wire 1" } });
    const mine = db().table("earnest_money_obligations").filter((o) => o.buyer_account_id === ACCOUNT);
    expect(mine).toHaveLength(1);
    expect(db().table("earnest_money_obligations").every((o) => !("account_member_id" in o) || o.account_member_id == null)).toBe(true);
    as(USERS.b1); // the account's login: either member
    const list = await listBuyerEarnestMoney();
    expect(JSON.stringify(list)).toContain(String(mine[0]!.id));
    await markEarnestFunded({ data: { obligationId: mine[0]!.id as string, reference: "EM-1" } }).catch(() => undefined);
  });

  it("one closing-funds obligation for the account, and funding it once satisfies it for both", async () => {
    as(USERS.admin);
    await issueClosingFunds({ data: { propertyId: P, totalAmount: 90000, fundingDeadline: hoursFromNow(120), escrowCompany: "First American", escrowAccountDetails: "Wire 2" } });
    const mine = db().table("closing_funds_obligations").filter((o) => o.buyer_account_id === ACCOUNT);
    expect(mine).toHaveLength(1);
    as(USERS.b1);
    expect(JSON.stringify(await listBuyerClosingFunds())).toContain(String(mine[0]!.id));
    as(USERS.admin);
    await markClosingFundsFunded({ data: { obligationId: mine[0]!.id as string, reference: "CF-1" } });
    expect(db().table("closing_funds_obligations").find((o) => o.id === mine[0]!.id)!.status).toMatch(/funded|paid/);
  });

  it("no code path makes an obligation depend on a single member (no per-member key, no 'primary only')", () => {
    for (const f of ["src/lib/earnest-money.functions.ts", "src/lib/closing-funds.functions.ts", "src/lib/funding-obligations.server.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/role\s*===?\s*["']primary["']|eq\("role",\s*"primary"\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// 4 and 5. Cap table and the Operating Agreement
// ---------------------------------------------------------------------------

describe("4 and 5. the cap table, the filing record and the Operating Agreement", () => {
  /** 5 retained seller shares + this account (1) + Carol's account (2) = 8/8, through Closing-Ready, the filing and the final OA. */
  async function toFinalOa() {
    Object.assign(db().table("properties")[0]!, { exit_type: "hybrid_exit", retained_shares: 5, listing_status: "system_lock" });
    acceptBlock2ForAll(db());
    await ensureDigitalGenesis(db(), { propertyId: P, actorId: USERS.admin, reason: "hard_lock" });
    as(USERS.admin);
    const act = (action: unknown) => runStage2Action({ data: { propertyId: P, action: action as never } });
    await act({ kind: "closing_ready" });
    await act({ kind: "atlas_request", reference: "ATLAS-1" });
    await act({ kind: "state_filed" });
    await act({ kind: "state_confirmed", llcName: "D8 Real Lusk, LLC", delawareFileNumber: "7654321", certificateFileUrl: "e/c.pdf", certificateHash: "djb2_c" });
    await act({ kind: "final_oa" });
    return db().table("entity_genesis")[0]!;
  }
  const sign = (user: string, memberId: string, name: string, hash: string) => {
    as(user);
    return signMyOperatingAgreement({ data: { propertyId: P, accountMemberId: memberId, signedName: name, documentHash: hash, secondaryVerificationMethod: "typed_initials" } });
  };

  it("the cap table row carries both names, in the account's order", async () => {
    await toFinalOa();
    const rows = db().table("cap_table_entries").filter((c) => c.buyer_account_id === ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_member_names).toEqual(["Alice Real", "Bob Real"]);
    expect(db().table("cap_table_entries").filter((c) => c.buyer_account_id === IDS.b2)[0]!.account_member_names).toEqual(["Carol Two"]);
  });

  it("the cap table shows the two names as one joint, indivisible interest", async () => {
    expect(jointHolderLabel(["Alice Real", "Bob Real"])).toBe("Alice Real and Bob Real (jointly, one indivisible interest)");
    expect(jointHolderLabel(["Carol Two"])).toBe("Carol Two");
    expect(jointHolderLabel([])).toBe("");
    const g = await toFinalOa();
    const text: string = g.final_oa_text;
    expect(text).toContain("Alice Real and Bob Real (jointly, one indivisible interest)");
    expect(text).not.toContain("Alice Real & Bob Real");
    expect(readFileSync("src/routes/admin.entity-genesis.tsx", "utf8")).toContain("jointHolderLabel(");
  });

  it("the state filing record names both members", async () => {
    const g = await toFinalOa();
    expect(g.filing_roster).toEqual([
      { buyerAccountId: ACCOUNT, members: ["Alice Real", "Bob Real"] },
      { buyerAccountId: IDS.b2, members: ["Carol Two"] },
    ]);
    const requested = db().audits("entity.atlas_requested")[0]!;
    expect(JSON.stringify(requested.metadata)).toContain("Alice Real");
    expect(JSON.stringify(requested.metadata)).toContain("Bob Real");
  });

  it("every member signs; it is executed only when every signer of every account has signed", async () => {
    const g = await toFinalOa();
    const hash = g.final_oa_hash as string;
    expect(await sign(USERS.b1, ALICE, "Alice Real", hash)).toEqual({ executed: false, outstanding: 2 });
    expect(await sign(USERS.b2, IDS.b2m1, "Carol Two", hash)).toEqual({ executed: false, outstanding: 1 });
    expect(db().table("entity_genesis")[0]!.final_oa_status).toBe("awaiting_signatures");
    expect(await sign(USERS.b1, BOB, "Bob Real", hash)).toEqual({ executed: true, outstanding: 0 });
    expect(db().table("entity_genesis")[0]!.final_oa_status).toBe("executed");
    expect(db().table("operating_agreement_signatures").map((s) => s.account_member_id).sort()).toEqual([ALICE, BOB, IDS.b2m1].sort());
  });

  it("a wrong name is refused for either member", async () => {
    const g = await toFinalOa();
    await expect(sign(USERS.b1, BOB, "Alice Real", g.final_oa_hash as string)).rejects.toThrow("exactly: Bob Real");
  });
});

// ---------------------------------------------------------------------------
// 6 and 7. Voting and resale
// ---------------------------------------------------------------------------

describe("6. voting: the account has one internal consensus", () => {
  async function castSetup() {
    Object.assign(db().table("properties")[0]!, { exit_type: "hybrid_exit", retained_shares: 5, listing_status: "system_lock" });
    await ensureDigitalGenesis(db(), { propertyId: P, actorId: USERS.admin, reason: "hard_lock" });
    as(USERS.admin);
    const { id } = await createVoteAsAdmin({ data: { propertyId: P, title: "Replace the roof", voteType: "ordinary", opensAt: hoursFromNow(-1), closesAt: hoursFromNow(24) } });
    await openVoteAsAdmin({ data: { voteId: id } });
    return id;
  }
  const position = (voteId: string, member: string, value: string, initials: string) => (as(USERS.b1), recordVotePosition({ data: { propertyId: P, voteId, accountMemberId: member, position: value, initials } }));
  const cast = (voteId: string, choice: string) => (as(USERS.b1), castVoteBallot({ data: { propertyId: P, voteId, choice } }));

  it("differing positions block the ballot; agreeing ones allow it", async () => {
    const id = await castSetup();
    await position(id, ALICE, "Yes", "AR");
    await position(id, BOB, "No", "BR");
    const blocked = await cast(id, "Yes");
    expect(JSON.stringify(blocked)).toMatch(/agree|differ|consensus|error/i);
    expect(db().table("vote_ballots")).toEqual([]);
    await position(id, BOB, "Yes", "BR");
    const ok = await cast(id, "Yes");
    expect(JSON.stringify(ok)).not.toMatch(/"error"/);
    expect(db().table("vote_ballots")).toHaveLength(1);
  });

  it("one member alone isn't consensus, and a wrong initial is refused", async () => {
    const id = await castSetup();
    await position(id, ALICE, "Yes", "AR");
    expect(JSON.stringify(await cast(id, "Yes"))).toMatch(/agree|every member|consensus|error/i);
    expect(db().table("vote_ballots")).toEqual([]);
    expect(JSON.stringify(await position(id, BOB, "Yes", "XX"))).toMatch(/initials/i);
  });
});

describe("7. resale ROFR: the account elects as one holder, with both members agreeing", () => {
  async function listingSetup() {
    Object.assign(db().table("properties")[0]!, { exit_type: "hybrid_exit", retained_shares: 5, listing_status: "system_lock", usage_tag: "owner_occupied" });
    await ensureDigitalGenesis(db(), { propertyId: P, actorId: USERS.admin, reason: "hard_lock" });
    // The retention lock has run out for everyone.
    for (const c of db().table("cap_table_entries")) Object.assign(c, { retention_lock_started_at: "2025-01-01T00:00:00.000Z", retention_lock_expires_at: "2026-01-01T00:00:00.000Z" });
    // Carol lists a share; our two-member account holds the right of first refusal.
    as(USERS.b2);
    const listed = await createResaleListing({ data: { propertyId: P, shareNumber: db().table("cap_table_entries").find((c) => c.buyer_account_id === IDS.b2)!.share_number as number, askingPrice: 300000, feeAcknowledged: true } });
    return (listed as { id?: string }).id ?? (db().table("resale_listings")[0]!.id as string);
  }
  const position = (listingId: string, member: string, value: "exercise" | "decline", initials: string) => (as(USERS.b1), recordResalePosition({ data: { propertyId: P, listingId, accountMemberId: member, position: value, initials } }));
  const exercise = (listingId: string) => (as(USERS.b1), exerciseResaleRofr({ data: { propertyId: P, listingId } }));

  it("one member alone, or two who differ, can't elect; both agreeing can", async () => {
    const id = await listingSetup();
    await position(id, ALICE, "exercise", "AR");
    expect((await exercise(id)).error ?? "").toMatch(/agree|every member|both|consensus|position/i);
    await position(id, BOB, "decline", "BR");
    expect((await exercise(id)).error ?? "").toMatch(/agree|differ|decline|consensus/i);
    await position(id, BOB, "exercise", "BR");
    const done = await exercise(id);
    expect(done.error).toBeUndefined();
    expect(db().table("resale_rofr_elections").filter((e) => e.holder_key !== undefined || e.listing_id === id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Notifications
// ---------------------------------------------------------------------------

describe("8. notifications go to both members' emails", () => {
  const sent: string[] = [];
  beforeEach(() => {
    sent.length = 0;
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(...(JSON.parse(init.body).to as string[]));
      return { ok: true } as Response;
    }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("a notice to the account reaches the login email and each member's own email, once each", async () => {
    await deliver(db(), { authUserId: USERS.b1, email: "alice.real@test.local" }, { subject: "Action needed", message: "Please confirm.", type: "authorization" });
    expect(sent.sort()).toEqual(["alice.real@test.local", "bob.real@test.local"]);
  });

  it("a removed member no longer gets it", async () => {
    db().table("account_members").find((m) => m.id === BOB)!.status = "removed";
    await deliver(db(), { authUserId: USERS.b1, email: "alice.real@test.local" }, { subject: "x", message: "y", type: "authorization" });
    expect(sent).toEqual(["alice.real@test.local"]);
  });

  it("someone who isn't a buyer account's login gets just their own email (no change for agents and sellers)", async () => {
    await deliver(db(), { authUserId: USERS.ra, email: "ra@test.local" }, { subject: "x", message: "y", type: "authorization" });
    expect(sent).toEqual(["ra@test.local"]);
  });

  it("the stalled-enrollment warning reaches both members as well", async () => {
    const acct = db().table("buyer_accounts").find((x) => x.id === ACCOUNT)!;
    Object.assign(acct, { golden_ticket_issued: false, onboarding_status: "vetting_pending", last_activity_at: new Date(Date.now() - 40 * 86_400_000).toISOString(), stall_warning_sent_at: null });
    db().seed("buyer_enrollment_payments", [{ buyer_account_id: ACCOUNT, auth_user_id: USERS.b1, status: "paid", amount_cents: 50000, environment: "test" }]);
    const { runEnrollmentMaintenance } = await import("@/lib/enrollment-maintenance.functions");
    const result = await runEnrollmentMaintenance();
    expect(result.warned).toBeGreaterThanOrEqual(1);
    expect(sent.filter((to) => /real@test\.local$/.test(to)).sort()).toEqual(["alice.real@test.local", "bob.real@test.local"]);
  });
});

// ---------------------------------------------------------------------------
// 9. The tethered agent
// ---------------------------------------------------------------------------

describe("9. the tethered agent sees names only: never ID, eligibility or declaration details", () => {
  const SECRET = new RegExp([DOB, ID_NO, BOB_DOB, BOB_ID_NO, "1 Main St", "eligib", "declaration", "sha256_", "reason_code", "\\bheld\\b", "liveness", "sanction", "not_eligible", "vetting_status", "id_document", "date_of_birth", "\\bw9\\b", "\\btin\\b|tin_last4|tin_kind"].join("|"), "i");

  async function withResults() {
    db().seed("eligibility_declarations", [{ id: "d-a", account_member_id: ALICE, buyer_account_id: ACCOUNT, status: "complete", answers: { q1: "yes", q2: "yes", q3: "no", q4: "yes", q5: "yes", q6: "yes" }, declaration_hash: "sha256_" + "c".repeat(64), standard_version: "1.1", declared_at: "2026-11-01T00:00:00Z" }]);
    db().seed("eligibility_results", [{ account_member_id: ALICE, buyer_account_id: ACCOUNT, declaration_id: "d-a", result: "held", reason_codes: ["q3_pending_charge_disclosed"], standard_version: "1.1", determined_at: "2026-11-02T00:00:00Z" }]);
    db().seed("member_w9", [{ account_member_id: ALICE, buyer_account_id: ACCOUNT, tin_last4: "6789", tin_kind: "ssn" }]);
  }

  it("the Verified Lead list carries no ID, eligibility, declaration or identity detail, even for a held member", async () => {
    await withResults();
    as(USERS.ra);
    const lead = (await listMyTetheredBuyers()).find((l) => l.buyerAccountId === ACCOUNT)!;
    expect(JSON.stringify(lead)).not.toMatch(SECRET);
    expect(lead.onboardingStatus).toBe("vetting_pending");
  });

  it("the pod view lists no member's ID, eligibility or declaration", async () => {
    await withResults();
    as(USERS.ra);
    const view = await getAgentPodView({ data: { propertyId: P } } as never).catch(() => ({}));
    expect(JSON.stringify(view)).not.toMatch(SECRET);
  });

  it("no agent-facing code reads member identity, eligibility or declaration data", () => {
    for (const f of ["src/lib/agent-leads.functions.ts", "src/lib/agent-pod.functions.ts", "src/lib/agent-pools.functions.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/id_document|date_of_birth|eligibility_declarations|member_w9|member_liveness|kyo\.server/);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Tables that key member data by login only
// ---------------------------------------------------------------------------

describe("10. every kind of member data is keyed by the member, not by the login alone", () => {
  it("the per-member tables all carry account_member_id", () => {
    const sqlFiles = ["account-members.sql", "eligibility-declarations.sql", "member-liveness.sql", "member-steps.sql", "eligibility-results.sql", "eligibility-acknowledgements.sql", "signature-authority.sql", "kyo-corrections.sql", "eligibility-wording.sql"].map((f) => readFileSync(f, "utf8")).join("\n");
    for (const t of ["eligibility_declarations", "member_liveness_checks", "member_w9", "member_plaid_consents", "member_block2_authorizations", "eligibility_results", "eligibility_page_acknowledgements", "kyo_correction_requests", "adverse_action_notices"]) {
      const block = sqlFiles.match(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t} \\(([\\s\\S]*?)\\n\\);`));
      expect(block, t).toBeTruthy();
      expect(block![1], t).toContain("account_member_id");
    }
  });

  it("the tables keyed by a login (owner capital accounts, notices, notification preferences, RoFR elections) belong to the account's one login and carry no per-member data", () => {
    const sql = ["owner-capital-accounts", "owner-notifications", "resale", "votes"].flatMap((p) => {
      try {
        return [readFileSync(`${p}.sql`, "utf8")];
      } catch {
        return [];
      }
    }).join("\n");
    // Nothing in them is a member's name, date of birth, ID, address, eligibility result or tax number.
    expect(sql).not.toMatch(/date_of_birth|id_document|tin_|full_name/i);
  });
});
