/**
 * Prompt 16 — Disbursement Check (standalone, Zero-Error gate).
 * Prompt 17 — Property Records Vault + post-closing Co-owner access.
 */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { IDS, USERS } from "./fixtures";
import { seedClosing, PER_SHARE } from "./closing-fixture";
import { generateAndTransmit, latestSourceOfTruth } from "@/lib/settlement.server";
import { simulateMilestone } from "@/lib/title-escrow.server";
import { runDisbursementCheck, enterTitleFigures } from "@/lib/disbursement-check.server";
import { startClosingSaga } from "@/lib/closing-saga.server";
import { saveTitleFigures, runDisbursementCheckNow } from "@/lib/disbursement-check.functions";
import { getMyOwnership, listMyPropertyRecords } from "@/lib/ownership.functions";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const HLA_TOTAL = 3 * 117_188;

async function withSot() {
  await seedClosing();
  const r = await generateAndTransmit(db(), USERS.admin, IDS.property);
  if (r.status !== "transmitted") throw new Error("SoT not generated");
  return (await latestSourceOfTruth(db(), IDS.property))!.structured.payees;
}

const exact = (payees: Array<{ brokerId: string; amountCents: number }>, bump: Record<string, number> = {}) =>
  payees.map((p) => ({ payeeReference: p.brokerId, amount: (p.amountCents + (bump[p.brokerId] ?? 0)) / 100 }));

describe("Prompt 16 — runDisbursementCheck", () => {
  it("PASSES when every line matches to the cent, and records the evidence", async () => {
    const payees = await withSot();
    await enterTitleFigures(db(), USERS.admin, IDS.property, exact(payees), "from settlement statement");
    const r = await runDisbursementCheck(db(), IDS.property, { triggeredBy: "test" });
    expect(r.status).toBe("pass");
    expect(r.titleSource).toBe("manual_entry");
    expect(r.lines.every((l) => l.match && l.deltaCents === 0)).toBe(true);
    expect(r.platformTotalCents).toBe(3 * PER_SHARE);
    expect(r.titleTotalCents).toBe(3 * PER_SHARE);
    expect(r.report).toMatch(/^DISBURSEMENT CHECK — PASSED/);

    const row = db().table("disbursement_checks")[0]!;
    expect(row).toMatchObject({ status: "pass", title_source: "manual_entry", source_of_truth_hash: r.sourceOfTruthHash, triggered_by: "test" });
    const ev = db().audits("disbursement_check.passed")[0].metadata;
    expect(ev.lines).toHaveLength(2);
    expect(ev.lines[0]).toMatchObject({ platformCents: expect.any(Number), titleCents: expect.any(Number), match: true });
  });

  it("FAILS on a single one-cent difference and says exactly where and by how much", async () => {
    const payees = await withSot();
    await enterTitleFigures(db(), USERS.admin, IDS.property, exact(payees, { "broker-2": 1 }), null);
    const r = await runDisbursementCheck(db(), IDS.property);
    expect(r.status).toBe("fail");
    const bad = r.lines.filter((l) => !l.match);
    expect(bad).toEqual([
      expect.objectContaining({ brokerId: "broker-2", brokerage: "Summit Realty", platformCents: HLA_TOTAL, titleCents: HLA_TOTAL + 1, deltaCents: 1, kind: "amount_mismatch" }),
    ]);
    expect(r.differences.map((d) => d.kind)).toEqual(["amount_mismatch", "total_mismatch"]);
    expect(r.report).toContain("Summit Realty [broker-2] — platform $3,515.64 · title $3,515.65 · MISMATCH +$0.01");
    expect(r.report).toContain("The wire must not proceed");
    expect(db().audits("disbursement_check.failed")).toHaveLength(1);
  });

  it("catches missing and unexpected payees, and the absence of any title figures", async () => {
    const payees = await withSot();
    let r = await runDisbursementCheck(db(), IDS.property);
    expect(r.status).toBe("fail");
    expect(r.differences[0]!.kind).toBe("no_title_figures");

    await enterTitleFigures(db(), USERS.admin, IDS.property, [...exact(payees).slice(1), { payeeReference: "broker-x", amount: 10 }], null);
    r = await runDisbursementCheck(db(), IDS.property);
    expect(r.lines.map((l) => l.kind).sort()).toEqual(["match", "missing_in_title", "unexpected_in_title"]);
  });

  it("uses whichever title report is newer — the funded webhook or a manual entry", async () => {
    const payees = await withSot();
    await enterTitleFigures(db(), USERS.admin, IDS.property, exact(payees, { "broker-2": 1 }), null);
    // A later webhook with exact figures supersedes the older manual entry.
    db().seed("title_escrow_orders", [{ property_id: IDS.property, provider: "qualia", external_order_id: "Q-1", bundle_payload: {} }]);
    db().tables.set("title_escrow_orders", db().table("title_escrow_orders").slice(-1));
    const { QualiaAdapter } = await import("@/lib/title-adapters/qualia");
    const body = new QualiaAdapter().simulateWebhook("Q-1", "funded_and_recorded", { commissionDisbursements: exact(payees) });
    db().seed("title_escrow_events", [{ property_id: IDS.property, milestone: "funded_and_recorded", raw_payload: JSON.parse(body), received_at: new Date(Date.now() + 1000).toISOString() }]);
    expect((await runDisbursementCheck(db(), IDS.property)).titleSource).toBe("webhook");
    expect((await runDisbursementCheck(db(), IDS.property)).status).toBe("pass");
  });

  it("every run is logged; admin endpoints are admin-only", async () => {
    const payees = await withSot();
    as(USERS.admin);
    await saveTitleFigures({ data: { propertyId: IDS.property, figures: exact(payees) } });
    await runDisbursementCheckNow({ data: { propertyId: IDS.property } });
    await runDisbursementCheckNow({ data: { propertyId: IDS.property } });
    expect(db().audits("disbursement_check.passed")).toHaveLength(2);
    expect(db().audits("disbursement_check.title_figures_entered")).toHaveLength(1);
    as(USERS.hla);
    await expect(runDisbursementCheckNow({ data: { propertyId: IDS.property } })).rejects.toThrow("Not authorized");
  });

  it("wired into the saga: a 1¢ mismatch halts it with the full report; manual reconciliation + resume completes it", async () => {
    const payees = await withSot();
    db().seed("sellers", [{ id: IDS.seller, email: "seller@test.local" }]);
    const r = await simulateMilestone(db(), USERS.admin, IDS.property, "funded_and_recorded", {
      commissionDisbursements: exact(payees, { [IDS.broker]: 1 }),
    });
    expect(r.status === "processed" && r.closingSaga).toBe("failed");
    const failure = db().table("saga_failures")[0]!;
    expect(failure.failed_step).toBe("3_disbursement_check");
    expect(failure.error_detail).toContain("MISMATCH +$0.01");
    expect(failure.error_detail).toContain("Lusk Homes");

    // Operations reconcile with title and enter the corrected numbers; resume.
    await new Promise((res) => setTimeout(res, 5));
    await enterTitleFigures(db(), USERS.admin, IDS.property, exact(payees), "Corrected after call with escrow officer");
    const resumed = await startClosingSaga(db(), IDS.property, { resume: true, retryDelayMs: 0 });
    expect(resumed.status).toBe("completed");
    expect(db().table("disbursement_checks").map((c) => c.status)).toEqual(["fail", "pass"]);
  });
});

describe("Prompt 17 — Records Vault and Co-owner access", () => {
  async function closeTheDeal() {
    const payees = await withSot();
    db().seed("sellers", [{ id: IDS.seller, email: "seller@test.local" }]);
    const g = db().table("entity_genesis")[0]!;
    // Prompt 9's Stage 2 outputs, as that flow stores them.
    db().seed("property_records_vault", [
      { property_id: IDS.property, entity_genesis_id: g.id, document_type: "certificate_of_formation", title: "Certificate of Formation", file_url: "eg/cert.pdf", stored_at: "2026-10-01T00:00:00.000Z" },
      { property_id: IDS.property, entity_genesis_id: g.id, document_type: "ein_confirmation", title: "IRS EIN confirmation", file_url: "eg/cp575.pdf", stored_at: "2026-10-02T00:00:00.000Z" },
      { property_id: IDS.property, entity_genesis_id: g.id, document_type: "executed_operating_agreement", title: "Executed OA", file_url: "eg/oa.md", stored_at: "2026-10-03T00:00:00.000Z" },
    ]);
    const r = await simulateMilestone(db(), USERS.admin, IDS.property, "funded_and_recorded", { commissionDisbursements: exact(payees) });
    if (!(r.status === "processed" && r.closingSaga === "completed")) throw new Error("closing failed");
  }

  it("every closing document ends up in the vault", async () => {
    await closeTheDeal();
    expect(db().table("property_records_vault").map((v) => v.document_type).sort()).toEqual(
      ["certificate_of_formation", "closing_statement", "ein_confirmation", "executed_operating_agreement", "recorded_deed", "source_of_truth_cda"].sort(),
    );
  });

  it("a co-owner sees the full set, ordered, with links; outsiders see nothing", async () => {
    await closeTheDeal();
    as(USERS.b1);
    const own = await getMyOwnership();
    expect(own).toMatchObject({ isCoOwner: true, properties: [{ propertyId: IDS.property, shares: 1 }] });
    const { properties } = await listMyPropertyRecords();
    expect(properties[0]!.documents.map((d) => d.documentType)).toEqual([
      "recorded_deed",
      "closing_statement",
      "executed_operating_agreement",
      "certificate_of_formation",
      "ein_confirmation",
      "source_of_truth_cda",
    ]);
    expect(properties[0]!.documents.every((d) => d.url)).toBe(true);
    expect(properties[0]!.llcName).toBe("D8 Independence Lusk, LLC");

    as(USERS.b3);
    expect((await listMyPropertyRecords()).properties).toEqual([]);
    expect((await getMyOwnership()).isCoOwner).toBe(false);
  });

  it("before closing, a buyer is not yet a co-owner and has no vault access", async () => {
    await withSot();
    as(USERS.b1);
    expect(await getMyOwnership()).toEqual({ isCoOwner: false, properties: [] });
    expect((await listMyPropertyRecords()).properties).toEqual([]);
  });

  it("a revoked Digital Key removes vault access", async () => {
    await closeTheDeal();
    db().table("co_owner_digital_keys").find((k) => k.buyer_account_id === IDS.b1)!.status = "revoked";
    as(USERS.b1);
    expect((await listMyPropertyRecords()).properties).toEqual([]);
  });
});
