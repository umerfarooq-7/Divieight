/**
 * Buyer dashboard "Needs your action" + per-reservation progress. Read-only
 * summary built from the DD gate, authorization stage, funding obligations and
 * Operating Agreement signatures.
 */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS, hoursFromNow } from "./fixtures";
import { createAuthorizationRequest, respondToAuthorization } from "@/lib/authorization.functions";
import { getBuyerActionItems } from "@/lib/buyer-actions.functions";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;

async function queueOffer(commissionExpected = false) {
  as(USERS.admin);
  const { id } = await createAuthorizationRequest({
    data: { propertyId: IDS.property, buyerAccountId: IDS.b1, actionType: "offer_tender", headline: "Offer", terms: {}, commissionExpected },
  });
  return id;
}

const confirm = (requestId: string, accountMemberId: string) => ({
  data: { requestId, accountMemberId, decision: "confirmed" as const, signedName: "X", secondaryVerificationMethod: "typed_initials" },
});

async function mine() {
  as(USERS.b1);
  return getBuyerActionItems();
}

function placeDoc() {
  db().seed("due_diligence_inventory", [
    { id: "doc-1", property_id: IDS.property, document_title: "HOA", category: "hoa", file_url: "dd/hoa.pdf", content_hash: "h1", placed_at: new Date().toISOString(), required: true, superseded_by: null },
  ]);
}
function ack(role: "account_member" | "resident_agent", who: string) {
  db().seed("due_diligence_acknowledgments", [
    {
      document_id: "doc-1",
      property_id: IDS.property,
      buyer_account_id: IDS.b1,
      actor_role: role,
      account_member_id: role === "account_member" ? who : null,
      agent_id: role === "resident_agent" ? who : null,
      content_hash: "h1",
      acknowledged_at: new Date().toISOString(),
    },
  ]);
}

describe("buyer dashboard — needs your action", () => {
  it("is empty with nothing outstanding; progress starts at due diligence", async () => {
    seedPod(db());
    const r = await mine();
    expect(r.actions).toEqual([]);
    expect(r.progress[IDS.property]!.map((s) => s.state)).toEqual(["current", "todo", "todo", "todo", "todo", "todo"]);
  });

  it("lists a pending authorization until every member of the account has confirmed", async () => {
    seedPod(db());
    const id = await queueOffer();
    expect((await mine()).actions).toEqual([expect.objectContaining({ kind: "authorization", requestId: id })]);
    as(USERS.b1);
    await respondToAuthorization(confirm(id, IDS.b1m1));
    expect((await mine()).actions).toHaveLength(1); // second member still to confirm
    await respondToAuthorization(confirm(id, IDS.b1m2));
    const after = await mine();
    expect(after.actions).toEqual([]);
    expect(after.progress[IDS.property]!.find((s) => s.key === "offer")!.state).toBe("done");
  });

  it("does not list an authorization that is only waiting on the HLA's proposal", async () => {
    seedPod(db());
    const id = await queueOffer(true);
    as(USERS.b1);
    await respondToAuthorization(confirm(id, IDS.b1m1));
    await respondToAuthorization(confirm(id, IDS.b1m2));
    expect((await mine()).actions).toEqual([]);
  });

  it("due diligence comes first and hides the authorizations it blocks", async () => {
    seedPod(db());
    await queueOffer();
    placeDoc();
    expect((await mine()).actions.map((a) => a.kind)).toEqual(["due_diligence"]);
    ack("account_member", IDS.b1m1);
    ack("account_member", IDS.b1m2);
    // Buyer side done; only the agent is outstanding — nothing for the buyer on DD.
    expect((await mine()).actions.map((a) => a.kind)).toEqual(["authorization"]);
    ack("resident_agent", IDS.ra);
    const r = await mine();
    expect(r.progress[IDS.property]![0]!.state).toBe("done");
  });

  it("lists open funding obligations, overdue first, and marks funding done when paid", async () => {
    seedPod(db());
    db().seed("earnest_money_obligations", [
      { buyer_account_id: IDS.b1, property_id: IDS.property, amount: 12500, shares: 1, status: "pending", funding_deadline: hoursFromNow(48) },
    ]);
    db().seed("closing_funds_obligations", [
      { buyer_account_id: IDS.b1, property_id: IDS.property, amount: 90000, shares: 1, status: "late", funding_deadline: hoursFromNow(-2) },
    ]);
    const r = await mine();
    expect(r.actions.map((a) => [a.kind, a.overdue])).toEqual([
      ["closing_funds", true],
      ["earnest_money", false],
    ]);
    expect(r.actions[1]!.title).toBe("Fund $12,500.00 earnest money");

    db().table("earnest_money_obligations")[0]!.status = "funded";
    const after = await mine();
    expect(after.actions.map((a) => a.kind)).toEqual(["closing_funds"]);
    expect(after.progress[IDS.property]!.find((s) => s.key === "earnest_money")!.state).toBe("done");
  });

  it("asks for Operating Agreement signatures from this account's unsigned members only", async () => {
    seedPod(db());
    db().seed("entity_genesis", [{ id: "eg-1", property_id: IDS.property, final_oa_status: "awaiting_signatures", final_oa_hash: "oa-h" }]);
    db().seed("operating_agreement_signatures", [{ entity_genesis_id: "eg-1", account_member_id: IDS.b1m1, document_hash: "oa-h", signed_at: new Date().toISOString() }]);
    const r = await mine();
    expect(r.actions).toEqual([expect.objectContaining({ kind: "operating_agreement", detail: "1 member of your account still to sign." })]);
  });

  it("after closing everything is done and nothing is asked", async () => {
    seedPod(db());
    db().table("properties")[0]!.listing_status = "active";
    placeDoc();
    const r = await mine();
    expect(r.actions).toEqual([]);
    expect(r.progress[IDS.property]!.every((s) => s.state === "done")).toBe(true);
  });

  it("another buyer's items never appear", async () => {
    seedPod(db());
    as(USERS.admin);
    await createAuthorizationRequest({
      data: { propertyId: IDS.property, buyerAccountId: IDS.b2, actionType: "offer_tender", headline: "Offer", terms: {}, commissionExpected: false },
    });
    expect((await mine()).actions).toEqual([]);
  });
});
