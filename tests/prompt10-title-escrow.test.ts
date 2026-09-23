/**
 * Prompt 10 — Title/Escrow Real-Time Handshake + Title Certainty Monitor
 * (simulated Qualia).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { harness } from "./setup";
import { seedPod, IDS, USERS, hoursFromNow } from "./fixtures";
import { QualiaAdapter } from "@/lib/title-adapters/qualia";
import { getTitleAdapter } from "@/lib/title-adapters";
import { ingestTitleWebhook, simulateMilestone, buildClosingBundle } from "@/lib/title-escrow.server";
import {
  sendTitleClosingBundle,
  simulateTitleMilestone,
  resolveTitleDiscrepancy,
  getTitleStatusFor,
  listAgentTitleStatuses,
  listTitleEscrowAdmin,
} from "@/lib/title-escrow.functions";
import { issueEarnestObligations, markObligationFunded } from "@/lib/earnest-money.server";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const order = () => db().table("title_escrow_orders")[0]!;

afterEach(() => {
  delete process.env.QUALIA_WEBHOOK_SECRET;
  delete process.env.QUALIA_API_URL;
  delete process.env.QUALIA_API_TOKEN;
  vi.unstubAllGlobals();
});

function seed() {
  seedPod(db());
  db().seed("sellers", [{ id: IDS.seller, email: "seller@test.local", full_name: "Sam Seller" }]);
}

function accept() {
  db().seed("authorization_requests", [
    { property_id: IDS.property, buyer_account_id: IDS.b1, action_type: "final_repa_acceptance", status: "authorized", headline: "x", deadline_at: hoursFromNow(1), consequence_text: "x" },
  ]);
}

async function openOrder() {
  accept();
  as(USERS.admin);
  return sendTitleClosingBundle({ data: { propertyId: IDS.property } });
}

const fire = (milestone: any, extra: Record<string, unknown> = {}) => {
  as(USERS.admin);
  return simulateTitleMilestone({ data: { propertyId: IDS.property, milestone, ...extra } });
};

describe("QualiaAdapter (simulated)", () => {
  it("builds the real GraphQL CreateOrder request but doesn't send it without credentials", async () => {
    seed();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const bundle = await buildClosingBundle(db(), IDS.property, null);
    const r = await new QualiaAdapter().openOrder(bundle);
    expect(r.simulated).toBe(true);
    expect(r.externalOrderId).toMatch(/^SIM-QUALIA-/);
    expect(fetchSpy).not.toHaveBeenCalled();
    const req = r.request as { query: string; variables: { input: any } };
    expect(req.query).toContain("mutation CreateOrder");
    expect(req.variables.input.buyers.map((b: any) => [b.externalReference, b.ownershipShares])).toEqual([
      [IDS.b1, 1],
      [IDS.b2, 2],
    ]);
  });

  it("calls Qualia's GraphQL endpoint once credentials exist", async () => {
    seed();
    process.env.QUALIA_API_URL = "https://api.qualia.test/graphql";
    process.env.QUALIA_API_TOKEN = "tok";
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ data: { createOrder: { order: { id: "QL-42", status: "OPEN" } } } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const r = await new QualiaAdapter().openOrder(await buildClosingBundle(db(), IDS.property, null));
    expect(r).toMatchObject({ externalOrderId: "QL-42", simulated: false });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("verifies HMAC signatures and round-trips simulated bodies through the real parser", async () => {
    const a = new QualiaAdapter();
    const body = a.simulateWebhook("QL-1", "closing_scheduled", { closingDate: "2026-11-02" });
    expect(await a.verifyWebhook(body, new Headers())).toBe(false); // no secret configured
    process.env.QUALIA_WEBHOOK_SECRET = "whsec";
    const good = new Headers({ "x-qualia-signature": createHmac("sha256", "whsec").update(body).digest("hex") });
    expect(await a.verifyWebhook(body, good)).toBe(true);
    expect(await a.verifyWebhook(body + " ", good)).toBe(false);
    expect(a.parseWebhook(body)).toMatchObject({ milestone: "closing_scheduled", externalOrderId: "QL-1", closingDate: "2026-11-02" });
  });

  it("is resolved through the adapter registry (SoftPro slots in later)", () => {
    expect(getTitleAdapter("qualia").provider).toBe("qualia");
    expect(() => getTitleAdapter("softpro")).toThrow("No title/escrow adapter");
  });
});

describe("Closing Bundle", () => {
  it("requires offer acceptance (or a recorded manual reason) and logs the exact request", async () => {
    seed();
    as(USERS.admin);
    await expect(sendTitleClosingBundle({ data: { propertyId: IDS.property } })).rejects.toThrow("hasn't been accepted");
    const r = await openOrder();
    expect(r.simulated).toBe(true);
    expect(order().bundle_payload).toMatchObject({
      propertyId: IDS.property,
      seller: { sellerId: IDS.seller, retainedShares: 0 },
    });
    const sent = db().audits("title.closing_bundle_sent")[0].metadata;
    expect(sent.trigger).toBe("offer_acceptance_authorized");
    expect(sent.request.query).toContain("CreateOrder");
    await expect(sendTitleClosingBundle({ data: { propertyId: IDS.property } })).rejects.toThrow("already open");
  });

  it("manual override is allowed with a reason, and recorded", async () => {
    seed();
    as(USERS.admin);
    await sendTitleClosingBundle({ data: { propertyId: IDS.property, manualOverrideReason: "Seller accepted by phone; REPA in escrow" } });
    expect(db().audits("title.closing_bundle_sent")[0].metadata.manual_override_reason).toMatch(/phone/);
  });
});

describe("Milestone webhooks → every dashboard", () => {
  it("runs all five milestones in sequence and keeps one status everyone reads", async () => {
    seed();
    await openOrder();
    for (const m of ["order_opened", "title_report_ready", "earnest_money_deposited", "closing_scheduled", "funded_and_recorded"])
      expect((await fire(m, m === "closing_scheduled" ? { closingDate: "2026-11-02" } : {})).status).toBe("processed");

    expect(db().table("title_escrow_events").map((e) => e.milestone)).toEqual([
      "order_opened",
      "title_report_ready",
      "earnest_money_deposited",
      "closing_scheduled",
      "funded_and_recorded",
    ]);
    expect(order().status).toBe("completed");
    expect(db().table("properties")[0].anticipated_closing_date).toBe("2026-11-02");
    expect(db().audits("title.milestone_received")).toHaveLength(5);

    // Buyers, their Resident Agent, the HLA and the seller all got every update.
    for (const u of [USERS.b1, USERS.b2, USERS.ra, USERS.hla, IDS.seller])
      expect(db().notificationsFor(u).filter((n) => n.type === "title")).toHaveLength(5);
    expect(db().notificationsFor(USERS.b3)).toHaveLength(0);
  });

  it("title_report_ready places the Title Commitment in the DD Inventory as a Required governing document", async () => {
    seed();
    await openOrder();
    await fire("order_opened");
    await fire("title_report_ready");
    const dd = db().table("due_diligence_inventory");
    expect(dd).toHaveLength(1);
    expect(dd[0]).toMatchObject({ category: "title_commitment", required: true, is_governing_instrument: true });
    expect(dd[0].file_url).toContain(order().external_order_id);
    expect(db().audits("diligence.document_placed")[0].metadata.source).toBe("title_escrow_webhook");
  });

  it("status visibility follows the pod: members, agents, HLA (by pod), seller — not outsiders", async () => {
    seed();
    await openOrder();
    await fire("order_opened");
    as(USERS.b2);
    expect((await getTitleStatusFor({ data: { propertyId: IDS.property } }))?.milestones[0]?.receivedAt).toBeTruthy();
    as(IDS.seller);
    expect(await getTitleStatusFor({ data: { propertyId: IDS.property } })).not.toBeNull();
    as(USERS.hla);
    expect(await getTitleStatusFor({ data: { podId: db().table("pods")[0].id } })).not.toBeNull();
    as(USERS.b3);
    expect(await getTitleStatusFor({ data: { propertyId: IDS.property } })).toBeNull();
    as(USERS.ra);
    expect((await listAgentTitleStatuses()).rows).toHaveLength(1);
  });
});

describe("Zero-Error earnest-money cross-check", () => {
  async function withEarnest() {
    seed();
    await issueEarnestObligations(db(), USERS.admin, {
      propertyId: IDS.property,
      totalAmount: 9000,
      fundingDeadline: hoursFromNow(48),
      escrowCompany: "First American",
      escrowAccountDetails: "x",
    });
    const b1 = db().table("earnest_money_obligations").find((o) => o.buyer_account_id === IDS.b1)!;
    await markObligationFunded(db(), USERS.admin, { obligationId: b1.id });
    await openOrder();
    await fire("order_opened");
    await fire("title_report_ready");
  }
  const kinds = () => db().table("title_escrow_discrepancies").map((d) => d.kind).sort();

  it("matching reports raise nothing", async () => {
    await withEarnest();
    const r = await fire("earnest_money_deposited", { depositScenario: "match_platform" });
    expect(r).toMatchObject({ status: "processed", discrepancies: 0 });
  });

  it("title says everyone deposited, platform shows B2 unfunded → flagged for admin", async () => {
    await withEarnest();
    const r = await fire("earnest_money_deposited", { depositScenario: "all_obligations" });
    expect(r).toMatchObject({ discrepancies: 1 });
    expect(kinds()).toEqual(["title_deposited_platform_unfunded"]);
    expect(db().table("title_escrow_discrepancies")[0].buyer_account_id).toBe(IDS.b2);
    expect(db().notificationsFor(USERS.admin).some((n) => n.type === "title_discrepancy")).toBe(true);
    // Nothing is auto-corrected.
    expect(db().table("earnest_money_obligations").find((o) => o.buyer_account_id === IDS.b2)!.status).toBe("pending");
  });

  it("platform shows B1 funded but title reports no deposit → flagged", async () => {
    await withEarnest();
    await fire("earnest_money_deposited", { depositScenario: "none" });
    expect(kinds()).toEqual(["platform_funded_title_missing"]);
  });

  it("amount and completeness mismatches are flagged; admin resolves with a note", async () => {
    await withEarnest();
    as(USERS.admin);
    await simulateMilestone(db(), USERS.admin, IDS.property, "earnest_money_deposited", {
      deposits: [{ buyerAccountId: IDS.b1, amount: 2999 }],
      allDepositsComplete: true,
    });
    expect(kinds()).toEqual(["amount_mismatch", "title_complete_platform_incomplete"]);
    const d = db().table("title_escrow_discrepancies")[0]!;
    await resolveTitleDiscrepancy({ data: { discrepancyId: d.id, note: "Escrow corrected ledger" } });
    expect(db().table("title_escrow_discrepancies")[0].status).toBe("resolved");
    expect(db().audits("title.discrepancy_resolved")).toHaveLength(1);
    const view = await listTitleEscrowAdmin();
    expect(view.discrepancies.filter((x) => x.status === "open")).toHaveLength(1);
  });

  it("funding reported while disbursement preconditions are unmet is flagged", async () => {
    seed();
    await openOrder();
    for (const m of ["order_opened", "title_report_ready", "earnest_money_deposited", "closing_scheduled"])
      await fire(m, { closingDate: "2026-11-02" });
    const r = await fire("funded_and_recorded");
    expect(r).toMatchObject({ discrepancies: 1 });
    expect(kinds()).toContain("funded_with_open_preconditions");
  });
});

describe("real webhook endpoint path", () => {
  it("rejects unsigned deliveries, ignores redeliveries and unknown orders", async () => {
    seed();
    await openOrder();
    process.env.QUALIA_WEBHOOK_SECRET = "whsec";
    const a = new QualiaAdapter();
    const body = a.simulateWebhook(order().external_order_id, "order_opened", {});
    const signed = new Headers(await a.signForSimulation(body));

    expect((await ingestTitleWebhook(db(), "qualia", body, new Headers())).status).toBe("unauthorized");
    expect((await ingestTitleWebhook(db(), "qualia", body, signed)).status).toBe("processed");
    expect((await ingestTitleWebhook(db(), "qualia", body, signed)).status).toBe("duplicate");
    expect(db().table("title_escrow_events")).toHaveLength(1);

    const stray = a.simulateWebhook("QL-UNKNOWN", "order_opened", {});
    expect((await ingestTitleWebhook(db(), "qualia", stray, new Headers(await a.signForSimulation(stray)))).status).toBe("unknown_order");
    expect(db().audits("title.webhook_unknown_order")).toHaveLength(1);
  });

  it("out-of-order milestones are accepted but flagged in the audit trail", async () => {
    seed();
    await openOrder();
    await fire("closing_scheduled", { closingDate: "2026-11-02" });
    expect(db().audits("title.milestone_received")[0].metadata.out_of_order).toBe(true);
  });
});
