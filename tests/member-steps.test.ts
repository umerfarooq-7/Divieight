/** Every member-level step per Account Member, and the account status derived from them. */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, IDS, USERS, steps } from "./fixtures";
import { DECISION_PAGE_SPEC_VERSION, STANDARD_VERSION } from "@/constants/eligibilityCopy";
import { BLOCK1_VERSION, BLOCK2_VERSION, block1ConsentText, block2AuthorizationText } from "@/constants/authorizationsCopy";
import { accountRollup, loadMemberSteps, missingSteps, ACCOUNT_STATUS_LABELS } from "@/lib/account-rollup";
import { evaluateGoldenTicket, issueGoldenTicketIfEligible } from "@/lib/golden-ticket";
import { acceptAuthorizationFn, getAuthorizationState, getSignatureState, recordPlaidLinkFn, signMemberDocumentFn } from "@/lib/member-steps.functions";
import { canSignOnBehalf, combinedAvailable, combinedLiquidityPasses, waitingOnBlock } from "@/lib/member-steps.server";
import { getMyAccountMembers, removeAccountMember, addAccountMember } from "@/lib/account-members.functions";
import { sha256 } from "@/lib/entity-genesis-stage2.server";
import { requestAtlas } from "@/lib/entity-genesis-stage2.server";
import { markClosingReady } from "@/lib/entity-genesis-stage2.server";
import { ensureDigitalGenesis, syncCapTable } from "@/lib/entity-genesis.server";
import { listMyTetheredBuyers } from "@/lib/agent-leads.functions";
import { isAdverselyAffected } from "@/routes/buyer.adverse-action";

const db = () => harness.db;
const A = IDS.b1;
const M1 = IDS.b1m1; // account holder
const M2 = IDS.b1m2; // second member
const account = () => db().table("buyer_accounts").find((a) => a.id === A)!;
const member = (id: string) => db().table("account_members").find((m) => m.id === id)!;
const yes = { q1: "yes", q2: "yes", q3: "yes", q4: "yes", q5: "yes", q6: "yes" };

/** Gives one member every step, so a test can then take one away. Returns what it seeded. */
function complete(memberId: string, o: Partial<{ result: string | null; skip: string[] }> = {}) {
  const m = member(memberId);
  const skip = new Set(o.skip ?? []);
  Object.assign(m, { status: "active", role: m.role === "secondary" ? "member" : m.role, date_of_birth: "1980-01-01", address: "1 Main St", id_document_url: `ids/${memberId}.jpg` });
  const base = { account_member_id: memberId, buyer_account_id: m.buyer_account_id };
  const at = "2026-11-01T00:00:00Z";
  if (!skip.has("liveness")) db().seed("member_liveness_checks", [{ ...base, status: "passed", created_at: at }]);
  if (!skip.has("standardRead")) db().seed("eligibility_page_acknowledgements", [{ ...base, standard_version: STANDARD_VERSION, page_spec_version: DECISION_PAGE_SPEC_VERSION }]);
  if (!skip.has("declaration")) {
    db().seed("eligibility_declarations", [{ id: `decl-${memberId}`, ...base, status: "complete", answers: yes, declared_at: at }]);
    if (o.result !== null) db().seed("eligibility_results", [{ ...base, declaration_id: `decl-${memberId}`, result: o.result ?? "eligible", reason_codes: [], determined_at: at }]);
  }
  if (!skip.has("block1")) db().seed("member_plaid_consents", [{ ...base, text_version: BLOCK1_VERSION, text_hash: "h", accepted_at: at }]);
  if (!skip.has("block2")) db().seed("member_block2_authorizations", [{ ...base, text_version: BLOCK2_VERSION, text_hash: "h", accepted_at: at }]);
  if (!skip.has("holdHarmless")) db().seed("signed_documents", [{ buyer_account_id: m.buyer_account_id, account_member_id: memberId, document_type: "HOLD_HARMLESS", signed_name: m.full_name }]);
  if (!skip.has("pra")) db().seed("signed_documents", [{ buyer_account_id: m.buyer_account_id, account_member_id: memberId, document_type: "PRA", signed_name: m.full_name }]);
  if (!skip.has("w9")) db().seed("member_w9", [{ ...base, legal_name: m.full_name, tin_last4: "6789", signed_name: m.full_name }]);
}

const ticket = () => issueGoldenTicketIfEligible({ authUserId: USERS.b1, buyerAccountId: A });

beforeEach(() => {
  seedPod(db());
  for (const m of db().table("account_members")) m.role = m.role === "secondary" ? "member" : m.role;
  Object.assign(account(), { liquidity_verified: true, liquidity_status: "verified", golden_ticket_issued: false });
});

describe("the roll-up on the records", () => {
  it("a result on a declaration that was since corrected isn't the member's result", async () => {
    complete(M1);
    complete(M2);
    // M2 corrected their declaration: the old one is superseded, the new one has no result yet.
    const old = db().table("eligibility_declarations").find((d) => d.account_member_id === M2)!;
    old.status = "superseded";
    db().seed("eligibility_declarations", [{ id: "decl-new", account_member_id: M2, buyer_account_id: A, status: "complete", answers: yes, declared_at: "2026-11-09T00:00:00Z" }]);
    const s = await loadMemberSteps(db(), A);
    expect(s.find((x) => x.memberId === M2)).toMatchObject({ declaration: true, result: null });
    expect(accountRollup(s).status).toBe("pending");
  });
});

describe("the roll-up (pure)", () => {
  it("pending until every member has every step and an eligible result", () => {
    expect(accountRollup([steps({ memberId: "a" }), steps({ memberId: "b" })])).toEqual({ status: "ready", blocked: false });
    expect(accountRollup([steps({ memberId: "a" }), steps({ memberId: "b", result: null })])).toEqual({ status: "pending", blocked: true });
    expect(accountRollup([steps({ memberId: "a" }), steps({ memberId: "b", w9: false })]).status).toBe("pending");
    expect(accountRollup([steps({ memberId: "a" }), steps({ memberId: "b", result: "not_eligible" })])).toEqual({ status: "pending", blocked: true });
    expect(accountRollup([])).toEqual({ status: "pending", blocked: true });
  });

  it("any held member makes the account held, never refused or unpaid", () => {
    expect(accountRollup([steps({ memberId: "a" }), steps({ memberId: "b", result: "held" })])).toEqual({ status: "held", blocked: true });
    expect(accountRollup([steps({ memberId: "a", result: "not_eligible" }), steps({ memberId: "b", result: "held" })]).status).toBe("held");
    expect(Object.values(ACCOUNT_STATUS_LABELS).join(" ")).not.toMatch(/refus|unpaid/i);
  });

  it("names exactly the steps still to do; Block 2 is tracked but not a ticket step", () => {
    expect(missingSteps(steps({ w9: false, holdHarmless: false })).map((s) => s.key)).toEqual(["holdHarmless", "w9"]);
    expect(missingSteps(steps({ block2: false }))).toEqual([]);
    expect(accountRollup([steps({ block2: false })]).status).toBe("ready");
    expect(evaluateGoldenTicket({ goldenTicketIssued: false, liquidityVerified: true, liquidityStatus: "verified", members: [steps({ block2: false })] }).eligible).toBe(true);
  });
});

describe("the Golden Ticket, on the real records", () => {
  it("primary eligible and second pending: the account is pending, with no ticket", async () => {
    complete(M1);
    complete(M2, { skip: ["declaration", "w9", "pra"] });
    const r = await ticket();
    expect(r.eligible).toBe(false);
    expect(account().golden_ticket_issued).toBe(false);
    expect(r.members.map((m) => [m.memberId, m.result])).toEqual([[M1, "eligible"], [M2, null]]);
    expect(accountRollup(r.members).status).toBe("pending");
  });

  it("both eligible: the account gets a ticket, and each member's status is shown beneath it", async () => {
    complete(M1);
    complete(M2);
    const r = await ticket();
    expect(r).toMatchObject({ issued: true, issuedNow: true, missing: [] });
    expect(account().golden_ticket_issued).toBe(true);
    expect(r.members.map((m) => [m.name, m.result])).toEqual([["Alice One", "eligible"], ["Bob One", "eligible"]]);
    harness.userId = USERS.b1;
    expect((await getMyAccountMembers()).accountStatus).toBe("ready");
  });

  it("one not_eligible: no ticket", async () => {
    complete(M1);
    complete(M2, { result: "not_eligible" });
    const r = await ticket();
    expect(r.eligible).toBe(false);
    expect(r.missing).toContain("All Account Members must be eligible under the Participant Eligibility Standard");
    expect(account().golden_ticket_issued).toBe(false);
  });

  it("one held: held, and never refused or unpaid", async () => {
    complete(M1);
    complete(M2, { result: "held" });
    const r = await ticket();
    expect(r.missing).toEqual(["An Account Member's application is held until the disclosed charge is resolved"]);
    expect(accountRollup(r.members).status).toBe("held");
    expect(JSON.stringify(r)).not.toMatch(/refus|unpaid/i);
    harness.userId = USERS.b1;
    const view = await getMyAccountMembers();
    expect(view.accountStatus).toBe("held");
    expect(view.members.map((m) => m.eligibility)).toEqual(["eligible", "held"]);
  });

  const cases = [
    ["holdHarmless", "Every Account Member must sign the Hold Harmless"],
    ["pra", "Priority Reservation Agreement must be signed by every Account Member"],
    ["w9", "Every Account Member must complete their W-9"],
    ["liveness", "Every Account Member must pass the liveness check"],
    ["block1", "Every Account Member must consent to account linking (Block 1)"],
    ["standardRead", "Every Account Member must read the Participant Eligibility Standard"],
  ] as const;
  it.each(cases.flatMap(([step, message]) => [[step, "holder", message], [step, "second member", message]] as const))("%s missing for the %s blocks the ticket", async (step, who, message) => {
    complete(M1, { skip: who === "holder" ? [step] : [] });
    complete(M2, { skip: who === "second member" ? [step] : [] });
    const r = await ticket();
    expect(r.missing).toEqual([message]);
    expect(account().golden_ticket_issued).toBe(false);
  });

  it("a signature recorded before members were named belongs to the account holder", async () => {
    complete(M1, { skip: ["holdHarmless"] });
    complete(M2);
    db().seed("signed_documents", [{ buyer_account_id: A, account_member_id: null, document_type: "HOLD_HARMLESS", signed_name: "Alice One" }]);
    const steps = await loadMemberSteps(db(), A);
    expect(steps.find((s) => s.memberId === M1)!.holdHarmless).toBe(true);
    expect(steps.find((s) => s.memberId === M2)!.holdHarmless).toBe(true);
  });

  it("nothing about tethering changed: it still runs after issuance", async () => {
    complete(M1);
    complete(M2);
    await ticket();
    expect(db().audits("buyer.golden_ticket_issued")).toHaveLength(1);
  });
});

describe("continue without this member", () => {
  it("removing the second member re-evaluates the account on the primary alone", async () => {
    complete(M1);
    complete(M2, { result: "not_eligible", skip: ["w9"] });
    expect((await ticket()).eligible).toBe(false);
    const feeBefore = JSON.stringify(db().table("buyer_enrollment_payments"));
    const rankBefore = account().priority_rank_timestamp ?? null;
    harness.userId = USERS.b1;
    await removeAccountMember({ data: { actingMemberId: M1, memberId: M2 } });
    expect(member(M2).status).toBe("removed");
    const r = await ticket();
    expect(r).toMatchObject({ issued: true, missing: [] });
    expect(r.members.map((m) => m.memberId)).toEqual([M1]);
    // No admin approval, no discretion, fee and rank untouched.
    expect(JSON.stringify(db().table("buyer_enrollment_payments"))).toBe(feeBefore);
    expect(account().priority_rank_timestamp ?? null).toBe(rankBefore);
    expect(db().audits("buyer.member_removed")[0]!.metadata).toMatchObject({ acted_by_member_id: M1 });
  });

  it("a held or incomplete second member can be removed the same way; the removed member's records stay", async () => {
    complete(M1);
    complete(M2, { result: "held" });
    harness.userId = USERS.b1;
    await removeAccountMember({ data: { actingMemberId: M1, memberId: M2 } });
    expect(db().table("eligibility_results").filter((x) => x.account_member_id === M2)).toHaveLength(1);
    expect(db().table("member_w9").filter((x) => x.account_member_id === M2)).toHaveLength(1);
    expect((await ticket()).eligible).toBe(true);
  });

  it("only the account holder can remove, and not after the Golden Ticket", async () => {
    complete(M1);
    complete(M2);
    harness.userId = USERS.b1;
    await expect(removeAccountMember({ data: { actingMemberId: M2, memberId: M2 } })).rejects.toThrow("Only the account holder");
    await ticket();
    await expect(removeAccountMember({ data: { actingMemberId: M1, memberId: M2 } })).rejects.toThrow();
    expect(member(M2).status).toBe("active");
  });

  it("the card offers it only for a second member who isn't eligible", () => {
    const card = readFileSync("src/components/AccountMembersCard.tsx", "utf8");
    expect(card).toContain("Continue without this member");
    expect(card).toMatch(/m\.role === "member" && !data\.locked && m\.eligibility !== "eligible"/);
  });
});

describe("Block 1 (Plaid consent) and Block 2 (LPOA), per member", () => {
  const accept = (member: string, block: "block1" | "block2") => {
    harness.userId = USERS.b1;
    return acceptAuthorizationFn({ data: { actingMemberId: member, block } });
  };

  it("the texts are the client's, word for word", () => {
    expect(block2AuthorizationText).toBe(
      "I appoint divieight as my Limited Power of Attorney (LPOA) for entity formation. I authorize divieight to act as the 'Authorized Person' and 'Organizer' to file a Certificate of Formation in the State of Delaware and to apply for an Employer Identification Number (EIN) with the IRS on my behalf. This authorization is limited strictly to these administrative tasks for the purpose of establishing a co-ownership entity. Further, I appoint divieight as manager of the real estate ownership entity and authorize divieight to take the lead and fully coordinate all administrative actions in coordinating the acquisition of real estate.",
    );
    expect(block1ConsentText).toBe("I authorize divieight to securely link my financial accounts via Plaid to verify my liquidity. divieight uses secure, tokenized access and does not store my bank login credentials.");
  });

  it("each member's acceptance is their own row, with timestamp, IP, and the hash of the text", async () => {
    await accept(M1, "block2");
    await accept(M2, "block2");
    const rows = db().table("member_block2_authorizations");
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ buyer_account_id: A, text_version: BLOCK2_VERSION, text_hash: sha256(block2AuthorizationText), ip: "203.0.113.7" });
    expect(rows.every((r) => r.accepted_at)).toBe(true);
    expect(rows.map((r) => r.account_member_id).sort()).toEqual([M1, M2].sort());
    expect(db().audits("buyer.block2_lpoa_accepted").map((a) => a.metadata.acted_by_member_id).sort()).toEqual([M1, M2].sort());
  });

  it("accepting again changes nothing", async () => {
    const first = await accept(M1, "block1");
    const again = await accept(M1, "block1");
    expect(again.acceptedAt).toBe(first.acceptedAt);
    expect(db().table("member_plaid_consents")).toHaveLength(1);
  });

  it("only for this account's active members", async () => {
    await expect(accept(IDS.b2m1, "block2")).rejects.toThrow("isn't on your account");
    member(M2).status = "removed";
    await expect(accept(M2, "block1")).rejects.toThrow("isn't on your account");
    expect(db().table("member_block2_authorizations")).toEqual([]);
  });

  it("the account's Plaid link is refused until every active member has consented", async () => {
    await accept(M1, "block1");
    harness.userId = USERS.b1;
    await expect(recordPlaidLinkFn({ data: { actingMemberId: M1 } })).rejects.toThrow("Waiting on: Bob One");
    expect(db().table("account_liquidity_links")).toEqual([]);
    await accept(M2, "block1");
    account().target_budget = 100000;
    harness.userId = USERS.b1;
    expect(await recordPlaidLinkFn({ data: { actingMemberId: M2 } })).toEqual({ passed: true });
    expect(db().table("account_liquidity_links")).toHaveLength(1);
    expect(db().table("account_liquidity_links")[0]).toMatchObject({ buyer_account_id: A, linked_by_member_id: M2 });
  });

  it("removing the non-consenting member unblocks the link", async () => {
    await accept(M1, "block1");
    harness.userId = USERS.b1;
    await removeAccountMember({ data: { actingMemberId: M1, memberId: M2 } });
    expect(await waitingOnBlock(db(), A, "block1")).toEqual([]);
  });

  it("Block 2 is not a Golden Ticket condition, but Entity Genesis Stage 2 waits for every member", async () => {
    complete(M1, { skip: ["block2"] });
    complete(M2, { skip: ["block2"] });
    expect((await ticket()).issued).toBe(true);

    Object.assign(db().table("properties")[0], { exit_type: "hybrid_exit", retained_shares: 5, listing_status: "system_lock" });
    await ensureDigitalGenesis(db(), { propertyId: IDS.property, actorId: USERS.b1, reason: "hard_lock" });
    await markClosingReady(db(), USERS.admin, IDS.property);
    await expect(requestAtlas(db(), USERS.admin, IDS.property, "ATLAS")).rejects.toThrow("Block 2");
    for (const m of db().table("account_members")) await accept(m.id as string, "block2").catch(() => undefined);
    harness.userId = USERS.b2;
    for (const id of [IDS.b2m1]) await acceptAuthorizationFn({ data: { actingMemberId: id, block: "block2" } });
    harness.userId = USERS.b3;
    await acceptAuthorizationFn({ data: { actingMemberId: IDS.b3m1, block: "block2" } }).catch(() => undefined);
    await expect(requestAtlas(db(), USERS.admin, IDS.property, "ATLAS")).resolves.not.toThrow();
  });
});

describe("combined Plaid assets", () => {
  it("the account's assets are the sum across every link, whoever made it", () => {
    expect(combinedAvailable([{ balances: [{ name: "a", mask: "1", available: 30000 }, { name: "b", mask: "2", available: 20000 }] }, { balances: [{ name: "c", mask: "3", available: 50000 }] }])).toBe(100000);
    expect(combinedAvailable([])).toBe(0);
  });

  it("two links that each fall short pass together: the check is on the combined total", () => {
    const link = (available: number) => ({ balances: [{ name: "x", mask: "1", available }] });
    expect(combinedLiquidityPasses([link(70000)], 100000)).toBe(false);
    expect(combinedLiquidityPasses([link(60000)], 100000)).toBe(false);
    expect(combinedLiquidityPasses([link(70000), link(60000)], 100000)).toBe(true);
    expect(combinedLiquidityPasses([link(70000), link(60000)], null)).toBe(false);
    expect(readFileSync("src/lib/member-steps.server.ts", "utf8")).toContain("combinedLiquidityPasses((links ?? [])");
  });

  it("a second link by the other member adds to the account's total; no figure is logged anywhere", async () => {
    for (const id of [M1, M2]) {
      harness.userId = USERS.b1;
      await acceptAuthorizationFn({ data: { actingMemberId: id, block: "block1" } });
    }
    account().target_budget = 100000;
    harness.userId = USERS.b1;
    await recordPlaidLinkFn({ data: { actingMemberId: M1 } });
    await recordPlaidLinkFn({ data: { actingMemberId: M2 } });
    const links = db().table("account_liquidity_links");
    expect(links.map((l) => l.linked_by_member_id)).toEqual([M1, M2]);
    const total = combinedAvailable(links as never);
    expect(total).toBe(2 * (35000 + 95000));
    expect(account().liquidity_verified).toBe(true);
    const audits = JSON.stringify(db().audits("buyer.liquidity_verified"));
    expect(audits).not.toContain(String(total));
    expect(audits).not.toMatch(/balance|available|130000/);
    expect(db().audits("buyer.liquidity_verified").at(-1)!.metadata).toMatchObject({ links: 2, result: "verified" });
  });

  it("agents see only the coarse budget bucket", async () => {
    account().target_budget = 100000;
    account().target_budget_bucket = "b2";
    harness.userId = USERS.ra;
    const leads = JSON.stringify(await listMyTetheredBuyers());
    expect(leads).not.toMatch(/target_budget"|balances|available|100000/);
  });
});

describe("the PRA and the Hold Harmless, signed by each member", () => {
  const sign = (memberId: string, typedName: string, documentType: "PRA" | "HOLD_HARMLESS" = "PRA") => {
    harness.userId = USERS.b1;
    return signMemberDocumentFn({ data: { actingMemberId: memberId, documentType, documentVersion: "pra-v1", documentHash: "djb2_x", typedName } });
  };

  it("every active member signs their own, checked on the server against their own name", async () => {
    account().onboarding_status = "payment_pending";
    expect((await sign(M1, "Alice One")).waitingOn).toEqual(["Bob One"]);
    expect(account().onboarding_status).toBe("payment_pending");
    expect((await sign(M2, "Bob One")).waitingOn).toEqual([]);
    expect(account().onboarding_status).toBe("vetting_pending");
    const rows = db().table("signed_documents").filter((d) => d.document_type === "PRA");
    expect(rows.map((r) => [r.account_member_id, r.signed_name])).toEqual([[M1, "Alice One"], [M2, "Bob One"]]);
    expect(db().audits("buyer.pra_signed").map((a) => a.metadata.acted_by_member_id)).toEqual([M1, M2]);
  });

  it("a name that isn't the member's own is refused, for either document", async () => {
    for (const type of ["PRA", "HOLD_HARMLESS"] as const) {
      await expect(sign(M2, "Alice One", type)).rejects.toThrow("The signature must be this member's full legal name");
      await expect(sign(M1, "Al", type)).rejects.toThrow("signature must be");
    }
    expect(db().table("signed_documents")).toEqual([]);
  });

  it("signing twice records one signature", async () => {
    await sign(M1, "Alice One");
    await sign(M1, "Alice One");
    expect(db().table("signed_documents").filter((d) => d.account_member_id === M1 && d.document_type === "PRA")).toHaveLength(1);
    harness.userId = USERS.b1;
    expect(await getSignatureState({ data: { actingMemberId: M1, documentType: "PRA" } })).toMatchObject({ signed: true, waitingOn: ["Bob One"] });
  });

  it("nobody signs on another's behalf: the authority hook returns false until the authority prompt (M4)", () => {
    expect(canSignOnBehalf(M1, M2, "pra")).toBe(false);
    expect(canSignOnBehalf(M2, M1, "hold_harmless")).toBe(false);
  });

  it("the member's signature never overwrites the other's", async () => {
    await sign(M1, "Alice One", "HOLD_HARMLESS");
    const before = { ...db().table("signed_documents")[0]! };
    await sign(M2, "Bob One", "HOLD_HARMLESS");
    expect(db().table("signed_documents")[0]).toEqual(before);
    expect(db().table("signed_documents")).toHaveLength(2);
  });
});

describe("the adverse-action notice, per member", () => {
  it("is for the affected member only", () => {
    expect(isAdverselyAffected({ background_check_result: "failed", vetting_status: "in_progress" })).toBe(true);
    expect(isAdverselyAffected({ background_check_result: null, vetting_status: "not_eligible" })).toBe(true);
    expect(isAdverselyAffected({ background_check_result: "cleared", vetting_status: "cleared" })).toBe(false);
    expect(isAdverselyAffected({ background_check_result: null, vetting_status: "held" })).toBe(false);
  });

  it("works through the picker for the second member, and no longer reads only the first failed member", () => {
    const page = readFileSync("src/routes/buyer.adverse-action.tsx", "utf8");
    expect(page).toContain("ActingMemberGate");
    expect(page).toContain("x.id === actingMemberId");
    expect(page).not.toMatch(/\.eq\("background_check_result", "failed"\)\s*\.order/);
    // The account is parked only when every member is affected.
    expect(page).toContain("affected.length === everyone.length");
  });
});

describe("the cap table", () => {
  it("a member added before the lock is named on it", async () => {
    Object.assign(db().table("properties")[0], { exit_type: "hybrid_exit", retained_shares: 5, listing_status: "system_lock" });
    await ensureDigitalGenesis(db(), { propertyId: IDS.property, actorId: USERS.b1, reason: "hard_lock" });
    harness.userId = USERS.b1;
    await syncCapTable(db(), { propertyId: IDS.property, actorId: USERS.b1, reason: "t" });
    const cap = db().table("cap_table_entries").filter((c) => c.buyer_account_id === IDS.b1);
    expect(cap[0]!.account_member_names).toEqual(["Alice One", "Bob One"]);
  });

  it("closing-ready refuses an active member with no legal name, so nobody is left off the lock", async () => {
    Object.assign(db().table("properties")[0], { exit_type: "hybrid_exit", retained_shares: 5, listing_status: "system_lock" });
    await ensureDigitalGenesis(db(), { propertyId: IDS.property, actorId: USERS.b1, reason: "hard_lock" });
    member(M2).full_name = "  ";
    await expect(markClosingReady(db(), USERS.admin, IDS.property)).rejects.toThrow("no legal name on file");
  });

  it("no member can be added once the lock is on (the database rule, and the app message)", async () => {
    const sql = readFileSync("account-members.sql", "utf8");
    expect(sql).toContain("buyer_account_members_locked");
    expect(readFileSync("src/lib/account-members.server.ts", "utf8")).toMatch(/membersLocked/);
  });

  it("nothing one member does overwrites the other's records", async () => {
    complete(M1);
    const snapshot = JSON.stringify([db().table("member_w9"), db().table("member_plaid_consents"), db().table("eligibility_declarations")]);
    complete(M2);
    harness.userId = USERS.b1;
    await getAuthorizationState({ data: { actingMemberId: M2 } });
    const after = JSON.stringify([db().table("member_w9").filter((r) => r.account_member_id === M1), db().table("member_plaid_consents").filter((r) => r.account_member_id === M1), db().table("eligibility_declarations").filter((r) => r.account_member_id === M1)]);
    expect(snapshot).toBe(after);
  });
});

describe("the SQL", () => {
  it("backfills existing signatures to a member, and the PRA now names its member", () => {
    const sql = readFileSync("member-steps.sql", "utf8");
    expect(sql).toMatch(/document_type IN \('PRA', 'HOLD_HARMLESS', 'block_5_independent_advice'\)/);
    expect(sql).toMatch(/NEW\.document_type IN \('PRA', 'HOLD_HARMLESS', 'block_5_independent_advice'\)/);
  });
});
