/**
 * Prompt 3 + 4 — Buyer-Authorization Workflow with itemized commission
 * authorization and the Manager's Restraint. Exercises the real server
 * handlers end-to-end against the in-memory database.
 */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import {
  createAuthorizationRequest,
  proposeCommissionItem,
  respondToAuthorization,
  respondToCommissionItem,
  getBuyerAuthorization,
  listBuyerAuthorizations,
  listAdminAuthorizations,
} from "@/lib/authorization.functions";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;

async function queueOffer(buyerAccountId = IDS.b1, commissionExpected?: boolean) {
  as(USERS.admin);
  const { id } = await createAuthorizationRequest({
    data: {
      propertyId: IDS.property,
      buyerAccountId,
      actionType: "offer_tender",
      headline: "Tender offer at $2.45M",
      terms: { Price: "$2,450,000", Closing: "45 days" },
      commissionExpected,
    },
  });
  return id;
}

async function propose(requestId: string, ratePercent = 2.5, fundingSource = "proceeds_at_closing") {
  as(USERS.hla);
  return proposeCommissionItem({
    data: { requestId, ratePercent, fundingSource: fundingSource as any, provisionText: "Buyer-side 2.5%" },
  });
}

function member(requestId: string, accountMemberId: string, decision: "confirmed" | "declined") {
  return {
    data: {
      requestId,
      accountMemberId,
      decision,
      signedName: "Initials",
      secondaryVerificationMethod: "typed_initials",
      ipAddress: "6.6.6.6", // browser-reported value; server must not trust it
      deviceFingerprint: "fp",
    },
  };
}

const status = (id: string) => db().table("authorization_requests").find((r) => r.id === id)!.status;
const item = (id: string) => db().table("authorization_commission_items").find((r) => r.request_id === id)!;

describe("Prompt 4 — itemized commission authorization", () => {
  it("only the admin can queue a request; buyer and tethered agent are both notified", async () => {
    seedPod(db());
    as(USERS.b1);
    await expect(
      createAuthorizationRequest({
        data: { propertyId: IDS.property, buyerAccountId: IDS.b1, actionType: "offer_tender", headline: "x", terms: {} },
      }),
    ).rejects.toThrow("Not authorized");

    const id = await queueOffer();
    expect(status(id)).toBe("pending");
    expect(db().notificationsFor(USERS.b1)).toHaveLength(1);
    expect(db().notificationsFor(USERS.ra)).toHaveLength(1);
    expect(db().audits("authorization.requested")).toHaveLength(1);
  });

  it("only the pod's Heavy Lifting Agent may propose the provision (not the Resident Agent)", async () => {
    seedPod(db());
    const id = await queueOffer();
    as(USERS.ra);
    await expect(
      proposeCommissionItem({ data: { requestId: id, ratePercent: 2.5, fundingSource: "proceeds_at_closing", provisionText: "" } }),
    ).rejects.toThrow("Only the pod's Heavy Lifting Agent");
    as(USERS.admin); // the Manager can't originate it either
    await expect(
      proposeCommissionItem({ data: { requestId: id, ratePercent: 2.5, fundingSource: "proceeds_at_closing", provisionText: "" } }),
    ).rejects.toThrow("Not authorized");
  });

  it("computes the per-1/8th-share amount as % and $ (2.5% of $312,500 = $7,812.50)", async () => {
    seedPod(db());
    const id = await queueOffer();
    await propose(id, 2.5);
    const it0 = item(id);
    expect(it0.share_price_cents).toBe(31_250_000);
    expect(it0.per_share_amount_cents).toBe(781_250);
    expect(it0.status).toBe("proposed");
    expect(it0.instrument_hash).toMatch(/^djb2_/);
  });

  it("authorizing the instrument alone does NOT tender it while the commission item is outstanding", async () => {
    seedPod(db());
    const id = await queueOffer();
    await propose(id);
    as(USERS.b1);
    await respondToAuthorization(member(id, IDS.b1m1, "confirmed"));
    const r = await respondToAuthorization(member(id, IDS.b1m2, "confirmed"));
    expect(r.commissionPending).toBe(true);
    expect(r.disposition).toBeNull();
    expect(status(id)).toBe("pending");
  });

  it("both members authorize the commission separately → item authorized, instrument resolves", async () => {
    seedPod(db());
    const id = await queueOffer();
    await propose(id);
    as(USERS.b1);
    await respondToAuthorization(member(id, IDS.b1m1, "confirmed"));
    await respondToAuthorization(member(id, IDS.b1m2, "confirmed"));

    const first = await respondToCommissionItem(member(id, IDS.b1m1, "confirmed"));
    expect(first.itemStatus).toBe("proposed");
    expect(first.outstanding).toBe(1);
    expect(status(id)).toBe("pending");

    const second = await respondToCommissionItem(member(id, IDS.b1m2, "confirmed"));
    expect(second.itemStatus).toBe("authorized");
    expect(item(id).status).toBe("authorized");
    expect(status(id)).toBe("authorized");

    // Audit Vault: its own record type with text, hash, server-observed IP.
    const recs = db().audits("authorization.commission_authorized");
    expect(recs).toHaveLength(2);
    for (const a of recs) {
      expect(a.metadata.record_type).toBe("itemized_commission_authorization");
      expect(a.metadata.presented_text).toContain("$7,812.50");
      expect(a.metadata.presented_text).toContain("Section 7.5");
      expect(a.metadata.instrument_hash).toBe(item(id).instrument_hash);
      expect(a.metadata.ip_address).toBe(harness.ip);
    }
    const stored = db().table("authorization_commission_responses");
    expect(stored.every((s) => s.ip_address === harness.ip && s.presented_text.length > 0)).toBe(true);
  });

  it("commission authorized first, instrument second → still resolves authorized", async () => {
    seedPod(db());
    const id = await queueOffer();
    await propose(id);
    as(USERS.b1);
    await respondToCommissionItem(member(id, IDS.b1m1, "confirmed"));
    await respondToCommissionItem(member(id, IDS.b1m2, "confirmed"));
    expect(status(id)).toBe("pending");
    await respondToAuthorization(member(id, IDS.b1m1, "confirmed"));
    const r = await respondToAuthorization(member(id, IDS.b1m2, "confirmed"));
    expect(r.disposition).toBe("authorized");
    expect(status(id)).toBe("authorized");
  });

  it("declining the commission: instrument not tendered, routed to RA + HLA, explicitly NOT a Default", async () => {
    seedPod(db());
    const id = await queueOffer();
    await propose(id);
    as(USERS.b1);
    await respondToAuthorization(member(id, IDS.b1m1, "confirmed"));
    await respondToAuthorization(member(id, IDS.b1m2, "confirmed"));
    const r = await respondToCommissionItem(member(id, IDS.b1m1, "declined"));

    expect(r.itemStatus).toBe("declined");
    expect(item(id).status).toBe("declined");
    expect(status(id)).toBe("pending"); // never tendered
    const toRa = db().notificationsFor(USERS.ra).map((n) => n.message).join("\n");
    const toHla = db().notificationsFor(USERS.hla).map((n) => n.message).join("\n");
    expect(toRa).toContain("NOT a Default");
    expect(toHla).toContain("will not be tendered");
    expect(db().audits("authorization.commission_declined")[0].metadata.is_default_under_pra_section_8).toBe(false);
  });

  it("HLA revision reopens the item and clears prior member acts; new hash", async () => {
    seedPod(db());
    const id = await queueOffer();
    await propose(id, 2.5);
    const firstHash = item(id).instrument_hash;
    as(USERS.b1);
    await respondToCommissionItem(member(id, IDS.b1m1, "declined"));
    await propose(id, 2.0, "member_at_closing");
    expect(item(id).status).toBe("proposed");
    expect(item(id).instrument_hash).not.toBe(firstHash);
    expect(item(id).per_share_amount_cents).toBe(625_000);
    expect(db().table("authorization_commission_responses")).toHaveLength(0);
    // The superseded act survives in the audit log.
    expect(db().audits("authorization.commission_declined")).toHaveLength(1);
  });

  it("any instrument decline resolves the request as declined", async () => {
    seedPod(db());
    const id = await queueOffer(IDS.b1, false);
    as(USERS.b1);
    const r = await respondToAuthorization(member(id, IDS.b1m1, "declined"));
    expect(r.disposition).toBe("declined");
    expect(status(id)).toBe("declined");
    await expect(respondToAuthorization(member(id, IDS.b1m2, "confirmed"))).rejects.toThrow("already resolved");
  });

  it("a member can answer for the other only with documented authority", async () => {
    seedPod(db());
    const id = await queueOffer(IDS.b1, false);
    as(USERS.b1);
    await expect(
      respondToAuthorization({ data: { ...member(id, IDS.b1m1, "confirmed").data, onBehalfOfMemberId: IDS.b1m2 } }),
    ).rejects.toThrow("Documented authority");
    const r = await respondToAuthorization({
      data: { ...member(id, IDS.b1m1, "confirmed").data, onBehalfOfMemberId: IDS.b1m2, authorityBasis: "POA 2026-01" },
    });
    expect(r.disposition).toBe("authorized");
  });

  it("another buyer can't read or answer someone else's request", async () => {
    seedPod(db());
    const id = await queueOffer(IDS.b1);
    as(USERS.b2);
    const view = await getBuyerAuthorization({ data: { id } });
    expect(view.allowed).toBe(false);
    expect(view.request).toBeNull();
    await expect(respondToAuthorization(member(id, IDS.b2m1, "confirmed"))).rejects.toThrow("Not authorized");
  });

  it("timeout never auto-grants (escalation sweep leaves request pending)", async () => {
    seedPod(db());
    const id = await queueOffer();
    db().table("authorization_requests")[0].deadline_at = new Date(Date.now() - 3600_000).toISOString();
    const { runAuthorizationEscalationSweep } = await import("@/lib/authorization.server");
    await runAuthorizationEscalationSweep();
    expect(status(id)).toBe("pending");
  });
});

describe("Commission-bearing instruments can't tender before the HLA's provision", () => {
  it("offers default to commission_expected and the HLA is asked to propose", async () => {
    seedPod(db());
    const id = await queueOffer();
    expect(db().table("authorization_requests").find((r) => r.id === id)!.commission_expected).toBe(true);
    expect(db().notificationsFor(USERS.hla).at(-1)!.message).toContain("propose it");
  });

  it("members authorizing the instrument BEFORE any proposal does not tender it", async () => {
    seedPod(db());
    const id = await queueOffer();
    as(USERS.b1);
    await respondToAuthorization(member(id, IDS.b1m1, "confirmed"));
    const r = await respondToAuthorization(member(id, IDS.b1m2, "confirmed"));
    expect(r.disposition).toBeNull();
    expect(r.commissionPending).toBe(true);
    expect(status(id)).toBe("pending");

    // HLA can still propose (request is pending), and once both members
    // authorize the provision the instrument resolves.
    await propose(id);
    as(USERS.b1);
    await respondToCommissionItem(member(id, IDS.b1m1, "confirmed"));
    await respondToCommissionItem(member(id, IDS.b1m2, "confirmed"));
    expect(status(id)).toBe("authorized");
  });

  it("admin can mark an instrument as having no commission provision (e.g. contingency waiver)", async () => {
    seedPod(db());
    as(USERS.admin);
    const { id } = await createAuthorizationRequest({
      data: { propertyId: IDS.property, buyerAccountId: IDS.b1, actionType: "contingency_waiver", headline: "Waive inspection", terms: {} },
    });
    expect(db().table("authorization_requests").find((r) => r.id === id)!.commission_expected).toBeUndefined();
    as(USERS.b1);
    await respondToAuthorization(member(id, IDS.b1m1, "confirmed"));
    const r = await respondToAuthorization(member(id, IDS.b1m2, "confirmed"));
    expect(r.disposition).toBe("authorized");
  });
});

describe("What a pending request is waiting on (buyer label, admin warning)", () => {
  const stage = async (id: string) => {
    as(USERS.b1);
    return (await listBuyerAuthorizations()).rows.find((r) => r.id === id)!.pendingStage;
  };

  it("moves from members → HLA proposal → commission authorization", async () => {
    seedPod(db());
    const id = await queueOffer();
    expect(await stage(id)).toBe("members");
    await respondToAuthorization(member(id, IDS.b1m1, "confirmed"));
    expect(await stage(id)).toBe("members");
    await respondToAuthorization(member(id, IDS.b1m2, "confirmed"));
    expect(await stage(id)).toBe("hla_proposal");
    await propose(id);
    expect(await stage(id)).toBe("commission_members");
  });

  it("flags a commission-bearing request queued before any HLA has accepted", async () => {
    seedPod(db());
    db().table("pods")[0]!.hla_status = "invited";
    as(USERS.admin);
    const { hlaMissing } = await createAuthorizationRequest({
      data: { propertyId: IDS.property, buyerAccountId: IDS.b1, actionType: "offer_tender", headline: "Offer", terms: {} },
    });
    expect(hlaMissing).toBe(true);
    expect((await listAdminAuthorizations()).rows[0]!.hlaMissing).toBe(true);

    db().table("pods")[0]!.hla_status = "accepted";
    expect((await listAdminAuthorizations()).rows[0]!.hlaMissing).toBe(false);
  });
});

describe("Prompt 2 gate as Prompt 3/4 precondition", () => {
  function placeRequiredDoc(hash = "hash-v1") {
    db().seed("due_diligence_inventory", [
      {
        id: "doc-1",
        property_id: IDS.property,
        document_title: "Operating Agreement",
        category: "operating_agreement",
        file_url: "dd/oa.pdf",
        content_hash: hash,
        placed_at: new Date().toISOString(),
        required: true,
        superseded_by: null,
        is_governing_instrument: true,
      },
    ]);
  }
  function ack(role: "account_member" | "resident_agent", who: string, hash = "hash-v1") {
    db().seed("due_diligence_acknowledgments", [
      {
        document_id: "doc-1",
        property_id: IDS.property,
        buyer_account_id: IDS.b1,
        actor_role: role,
        account_member_id: role === "account_member" ? who : null,
        agent_id: role === "resident_agent" ? who : null,
        content_hash: hash,
        acknowledged_at: new Date().toISOString(),
      },
    ]);
  }

  it("outstanding required acknowledgments block both the screen and the commission act", async () => {
    seedPod(db());
    const id = await queueOffer();
    await propose(id);
    placeRequiredDoc();
    as(USERS.b1);
    const view = await getBuyerAuthorization({ data: { id } });
    expect(view.allowed).toBe(false);
    expect(view.gateBlockedPropertyId).toBe(IDS.property);
    expect(view.gateBlocker).toBe("both");
    await expect(respondToCommissionItem(member(id, IDS.b1m1, "confirmed"))).rejects.toThrow("due-diligence");
  });

  it("clears once both members AND the tethered agent acknowledge the current hash", async () => {
    seedPod(db());
    const id = await queueOffer();
    placeRequiredDoc();
    ack("account_member", IDS.b1m1);
    ack("account_member", IDS.b1m2);
    as(USERS.b1);
    expect((await getBuyerAuthorization({ data: { id } })).gateBlocker).toBe("agent");
    ack("resident_agent", IDS.ra);
    expect((await getBuyerAuthorization({ data: { id } })).allowed).toBe(true);
  });

  it("an amended document (new hash) makes prior acknowledgments non-current", async () => {
    seedPod(db());
    const id = await queueOffer();
    placeRequiredDoc();
    ack("account_member", IDS.b1m1);
    ack("account_member", IDS.b1m2);
    ack("resident_agent", IDS.ra);
    db().table("due_diligence_inventory")[0].content_hash = "hash-v2";
    as(USERS.b1);
    const view = await getBuyerAuthorization({ data: { id } });
    expect(view.allowed).toBe(false);
    expect(db().table("due_diligence_acknowledgments")).toHaveLength(3); // preserved
  });

  it("after re-tethering, the previous agent's acknowledgment no longer counts", async () => {
    seedPod(db());
    const id = await queueOffer();
    placeRequiredDoc();
    ack("account_member", IDS.b1m1);
    ack("account_member", IDS.b1m2);
    ack("resident_agent", IDS.ra);
    db().table("buyer_accounts").find((b) => b.id === IDS.b1)!.tethered_resident_agent_id = IDS.ra2;
    as(USERS.b1);
    expect((await getBuyerAuthorization({ data: { id } })).gateBlocker).toBe("agent");
  });
});

describe("Manager's Restraint — copy never attributes the provision to the Manager", () => {
  it("every notification in a full propose/decline cycle attributes the proposal to the HLA", async () => {
    seedPod(db());
    const id = await queueOffer();
    await propose(id);
    as(USERS.b1);
    await respondToCommissionItem(member(id, IDS.b1m1, "declined"));
    const all = db().table("notifications").map((n) => n.message).join("\n");
    expect(all).not.toMatch(/divieight (recommends|proposes|suggests|sets)|manager (recommends|proposes)|we recommend/i);
    const proposal = db().notificationsFor(USERS.b1).find((n) => /commission/i.test(n.message))!;
    expect(proposal.message).toContain("Heavy Lifting Agent has proposed");
  });
});
