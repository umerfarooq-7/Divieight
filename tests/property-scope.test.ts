/**
 * One Buyer Account holding shares in TWO properties: everything — DD
 * documents, acknowledgments, reports, authorizations, funding — stays inside
 * its own property. Runs the real server handlers against the fake DB.
 */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import {
  acknowledgeAsMember,
  getAgentDiligenceTasks,
  getBuyerDiligence,
  listPropertyDiligence,
  placeDiligenceDocument,
} from "@/lib/due-diligence.functions";
import { listAgentReports, listBuyerReports } from "@/lib/reports.functions";
import { deliverReport } from "@/lib/reports.server";
import {
  createAuthorizationRequest,
  diligenceGateStatus,
  listAgentAuthorizations,
  listBuyerAuthorizations,
} from "@/lib/authorization.functions";
import { listBuyerEarnestMoney } from "@/lib/earnest-money.functions";
import { getBuyerActionItems } from "@/lib/buyer-actions.functions";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const A = IDS.property;
const B = "prop-2";

/** B1 holds a share in A (fixture) and in B; B3 holds only B, tethered to RA2. */
function seedTwoProperties() {
  seedPod(db());
  db().seed("properties", [
    { id: B, address: "77 Second St", city: "Casper", state: "WY", zip: "82601", seller_id: IDS.seller, listing_status: "forming" },
  ]);
  db().seed("pod_reservations", [
    { id: "res-b1-B", property_id: B, buyer_account_id: IDS.b1, shares_reserved: 1, status: "reserved" },
    { id: "res-b3-B", property_id: B, buyer_account_id: IDS.b3, shares_reserved: 1, status: "reserved" },
  ]);
  db().table("buyer_accounts").find((b) => b.id === IDS.b3)!.tethered_resident_agent_id = IDS.ra2;
}

async function placeDoc(propertyId: string, title: string, supersedesId: string | null = null) {
  as(USERS.admin);
  return placeDiligenceDocument({
    data: { propertyId, documentTitle: title, category: "hoa", fileUrl: `dd/${title}.pdf`, contentHash: `h-${title}`, supersedesId },
  });
}

const deliver = (propertyId: string, title: string, supersedesReportId: string | null = null) =>
  deliverReport(db(), USERS.admin, {
    propertyId,
    reportType: "inspection",
    title,
    fileUrl: `r/${title}.pdf`,
    contentHash: `rh-${title}`,
    supersedesReportId,
  });

const memberAck = (documentId: string, contentHash: string, accountMemberId: string) => ({
  data: { documentId, contentHash, accountMemberId, signedName: "X", secondaryVerificationMethod: "typed_initials" },
});

describe("property scoping — one buyer, two properties", () => {
  it("(1) a document and report placed in A never appear in B", async () => {
    seedTwoProperties();
    await placeDoc(A, "hoa-A");
    await deliver(A, "inspection-A");

    as(USERS.b1);
    const ddB = await getBuyerDiligence({ data: { propertyId: B } });
    expect(ddB.allowed).toBe(true);
    expect(ddB.states).toEqual([]);
    const ddA = await getBuyerDiligence({ data: { propertyId: A } });
    expect(ddA.states.map((s) => s.document.document_title).sort()).toEqual(["hoa-A", "inspection-A"]);

    expect((await listBuyerReports({ data: { propertyId: B } })).reports).toEqual([]);
    const all = await listBuyerReports();
    expect(all.reports.map((r) => [r.title, r.property_id])).toEqual([["inspection-A", A]]);
  });

  it("(2) acknowledging in A leaves B's acknowledgments and gate untouched", async () => {
    seedTwoProperties();
    const a = await placeDoc(A, "hoa-A");
    await placeDoc(B, "hoa-B");
    expect((await diligenceGateStatus(db(), B, IDS.b1)).clear).toBe(false);

    as(USERS.b1);
    await acknowledgeAsMember(memberAck(a.id!, "h-hoa-A", IDS.b1m1));
    await acknowledgeAsMember(memberAck(a.id!, "h-hoa-A", IDS.b1m2));

    const ddB = await getBuyerDiligence({ data: { propertyId: B } });
    expect(ddB.states.every((s) => s.memberAcked.length === 0)).toBe(true);
    expect((await diligenceGateStatus(db(), B, IDS.b1)).blocker).toBe("both");
    expect(db().table("due_diligence_acknowledgments").every((x) => x.property_id === A)).toBe(true);
  });

  it("(3) an authorization queued for A is not listed under B, and B's action list stays empty", async () => {
    seedTwoProperties();
    as(USERS.admin);
    await createAuthorizationRequest({
      data: { propertyId: A, buyerAccountId: IDS.b1, actionType: "offer_tender", headline: "Offer A", terms: {}, commissionExpected: false },
    });
    as(USERS.b1);
    expect((await listBuyerAuthorizations({ data: { propertyId: B } })).rows).toEqual([]);
    expect((await listBuyerAuthorizations({ data: { propertyId: A } })).rows).toHaveLength(1);
    const actions = (await getBuyerActionItems()).actions;
    expect(actions.map((x) => x.propertyId)).toEqual([A]);
  });

  it("(4) an agent connected only through B sees nothing from A", async () => {
    seedTwoProperties();
    await placeDoc(A, "hoa-A");
    await placeDoc(B, "hoa-B");
    await deliver(A, "inspection-A");
    as(USERS.admin);
    await createAuthorizationRequest({
      data: { propertyId: A, buyerAccountId: IDS.b1, actionType: "offer_tender", headline: "Offer A", terms: {}, commissionExpected: false },
    });

    as(USERS.ra2);
    const tasks = (await getAgentDiligenceTasks()).tasks;
    expect(new Set(tasks.map((t) => t.propertyId))).toEqual(new Set([B]));
    expect((await listAgentReports()).rows).toEqual([]);
    expect((await listAgentAuthorizations()).rows).toEqual([]);
  });

  it("(5) admin sees each property's documents under that property only", async () => {
    seedTwoProperties();
    await placeDoc(A, "hoa-A");
    await placeDoc(B, "hoa-B");
    as(USERS.admin);
    const a = await listPropertyDiligence({ data: { propertyId: A } });
    const b = await listPropertyDiligence({ data: { propertyId: B } });
    expect(a.documents.map((d) => d.document_title)).toEqual(["hoa-A"]);
    expect(b.documents.map((d) => d.document_title)).toEqual(["hoa-B"]);
  });

  it("a buyer not in a property can neither read nor acknowledge its documents", async () => {
    seedTwoProperties();
    const a = await placeDoc(A, "hoa-A");
    as(USERS.b3); // holds only B
    const r = await getBuyerDiligence({ data: { propertyId: A } });
    expect(r).toMatchObject({ allowed: false, reason: "not_connected", states: [] });
    const ack = await acknowledgeAsMember(memberAck(a.id!, "h-hoa-A", IDS.b3m1));
    expect(ack.ok).toBe(false);
    expect(db().table("due_diligence_acknowledgments")).toHaveLength(0);
  });

  it("an upload on B can't supersede a document or report of A; missing property is refused", async () => {
    seedTwoProperties();
    const a = await placeDoc(A, "hoa-A");
    const cross = await placeDoc(B, "hoa-B", a.id!);
    expect(cross).toMatchObject({ ok: false, error: expect.stringContaining("different property") });
    expect(db().table("due_diligence_inventory").find((d) => d.id === a.id)!.superseded_by ?? null).toBeNull();

    as(USERS.admin);
    expect(await placeDiligenceDocument({ data: { documentTitle: "x", category: "hoa", fileUrl: "x", contentHash: "x" } as never })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Missing property"),
    });

    await deliver(A, "inspection-A");
    const reportA = db().table("property_reports")[0]!;
    await expect(deliver(B, "inspection-B", reportA.id)).rejects.toThrow("different property");
  });

  it("funding obligations are scoped to the requested property", async () => {
    seedTwoProperties();
    db().seed("earnest_money_obligations", [
      { buyer_account_id: IDS.b1, property_id: A, amount: 100, shares: 1, status: "pending", funding_deadline: "2026-12-01T00:00:00Z" },
      { buyer_account_id: IDS.b1, property_id: B, amount: 200, shares: 1, status: "pending", funding_deadline: "2026-12-02T00:00:00Z" },
    ]);
    as(USERS.b1);
    const rows = (await listBuyerEarnestMoney({ data: { propertyId: B } })).rows;
    expect(rows.map((r) => r.obligation.property_id)).toEqual([B]);
    expect((await listBuyerEarnestMoney()).rows).toHaveLength(2);
  });

  it("a re-tethered buyer's requests leave the previous agent's list", async () => {
    seedTwoProperties();
    as(USERS.admin);
    await createAuthorizationRequest({
      data: { propertyId: A, buyerAccountId: IDS.b1, actionType: "offer_tender", headline: "Offer A", terms: {}, commissionExpected: false },
    });
    db().table("pods")[0]!.hla_status = "declined"; // RA is not HLA here; isolate the tether rule
    as(USERS.ra);
    expect((await listAgentAuthorizations()).rows).toHaveLength(1);
    db().table("buyer_accounts").find((b) => b.id === IDS.b1)!.tethered_resident_agent_id = IDS.ra2;
    expect((await listAgentAuthorizations()).rows).toHaveLength(0);
  });
});
