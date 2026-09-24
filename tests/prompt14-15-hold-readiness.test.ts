/**
 * Prompt 14 — Broker Closing Hold wired into the closing flow.
 * Prompt 15 — Closing Readiness dashboard (read-only).
 */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { IDS, USERS, hoursFromNow } from "./fixtures";
import { seedClosing } from "./closing-fixture";
import { generateAndTransmit, latestSourceOfTruth } from "@/lib/settlement.server";
import { simulateMilestone } from "@/lib/title-escrow.server";
import { startClosingSaga } from "@/lib/closing-saga.server";
import { listClosingReadiness } from "@/lib/closing-readiness.functions";
import { closingReadiness } from "@/lib/closing-readiness.server";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const pod = () => db().table("pods")[0]!;
const HOLD_REASON = "Unresolved lien on Schedule B-II";

function placeHold() {
  Object.assign(pod(), {
    closing_hold_active: true,
    closing_hold_reason: HOLD_REASON,
    closing_hold_placed_by: "broker-2",
    closing_hold_placed_at: "2026-09-24T10:00:00.000Z",
  });
}

async function funded() {
  const sot = await latestSourceOfTruth(db(), IDS.property);
  return simulateMilestone(db(), USERS.admin, IDS.property, "funded_and_recorded", {
    commissionDisbursements: sot!.structured.payees.map((p) => ({ payeeReference: p.brokerId, amount: p.amountCents / 100 })),
  });
}

describe("Prompt 14 — checkpoint 1: Source of Truth generation", () => {
  it("is blocked with the hold's reason and who can lift it; the HLA's Broker of Record is told once", async () => {
    await seedClosing();
    placeHold();
    const r = await generateAndTransmit(db(), USERS.admin, IDS.property);
    expect(r.status).toBe("blocked");
    const hold = r.status === "blocked" ? r.blockers.find((b) => b.code === "closing_hold_active")! : null;
    expect(hold!.message).toContain(HOLD_REASON);
    expect(hold!.message).toContain("Only Summit Realty can lift it"); // HLA's brokerage
    expect(db().audits("closing_hold.blocked")[0].metadata.checkpoint).toBe("source_of_truth_generation");

    const toLifter = () => db().notificationsFor("u-broker2").filter((n) => n.type === "closing_hold");
    expect(toLifter()).toHaveLength(1);
    expect(toLifter()[0]!.message).toContain(HOLD_REASON);
    expect(db().notificationsFor(USERS.admin).some((n) => n.type === "closing_hold")).toBe(true);

    await generateAndTransmit(db(), USERS.admin, IDS.property);
    expect(toLifter()).toHaveLength(1); // no re-notification for the same hold
    expect(db().table("settlement_documents")).toHaveLength(0);
  });
});

describe("Prompt 14 — checkpoint 2: the Closing Ping Saga", () => {
  it("a hold present when the saga starts stops Step 1 immediately with a clear reason", async () => {
    await seedClosing();
    await generateAndTransmit(db(), USERS.admin, IDS.property);
    placeHold();
    const r = await startClosingSaga(db(), IDS.property, { retryDelayMs: 0 });
    expect(r).toMatchObject({ status: "failed", failedStep: "1_verify_source_of_truth" });
    const step1 = db().table("saga_step_executions").find((s) => s.step_name === "1_verify_source_of_truth")!;
    expect(step1.attempts).toBe(1); // a hold isn't transient — no pointless retries
    const f = db().table("saga_failures")[0]!;
    expect(f.error_detail).toMatch(/Closing hold active — reason: "Unresolved lien on Schedule B-II"/);
    expect(db().table("commission_ledger")).toHaveLength(0);
  });

  it("RACE: a hold placed while the saga is mid-execution halts it at the next step, cleanly", async () => {
    await seedClosing();
    await generateAndTransmit(db(), USERS.admin, IDS.property);
    // The broker places the hold at the exact moment step 2 is writing.
    const orig = db().from.bind(db());
    let armed = true;
    (db() as any).from = (t: string) => {
      const q = orig(t);
      if (t === "commission_ledger" && armed) {
        armed = false;
        placeHold();
      }
      return q;
    };
    const r = await funded();
    expect(r.closingSaga).toBe("failed");

    const steps = Object.fromEntries(db().table("saga_step_executions").map((s) => [s.step_name, s]));
    expect(steps["1_verify_source_of_truth"].status).toBe("succeeded");
    expect(steps["2_unlock_commissions"].status).toBe("succeeded");
    expect(steps["3_disbursement_check"]).toMatchObject({ status: "failed", attempts: 1 });
    expect(steps["4_activate_governance"]).toBeUndefined();
    expect(db().table("disbursement_checks")).toHaveLength(0); // step 3's own work never ran
    expect(db().table("properties")[0].listing_status).not.toBe("active");
    expect(db().table("notifications").filter((n) => n.type === "deal_closed")).toHaveLength(0);

    const f = db().table("saga_failures")[0]!;
    expect(f.failed_step).toBe("3_disbursement_check");
    expect(f.error_detail).toContain("Closing hold active");
    expect(f.error_detail).toContain(HOLD_REASON);
    expect(db().audits("closing_hold.blocked")[0].metadata.checkpoint).toBe("3_disbursement_check");

    // The broker lifts it; an admin resumes; steps 1–2 are not repeated.
    pod().closing_hold_active = false;
    const resumed = await startClosingSaga(db(), IDS.property, { resume: true, retryDelayMs: 0 });
    expect(resumed).toMatchObject({ status: "completed", skippedSteps: ["1_verify_source_of_truth", "2_unlock_commissions"] });
    expect(db().table("commission_ledger")).toHaveLength(8);
  });
});

describe("Prompt 15 — Closing Readiness", () => {
  async function fullyReady() {
    await seedClosing();
    for (const [terms, obligations] of [
      ["earnest_money_terms", "earnest_money_obligations"],
      ["closing_funds_terms", "closing_funds_obligations"],
    ] as const) {
      db().seed(terms, [{ property_id: IDS.property, total_amount: 9000, funding_deadline: hoursFromNow(48) }]);
      db().seed(obligations, [
        { property_id: IDS.property, buyer_account_id: IDS.b1, amount: 3000, status: "funded", funding_deadline: hoursFromNow(48) },
        { property_id: IDS.property, buyer_account_id: IDS.b2, amount: 6000, status: "funded", funding_deadline: hoursFromNow(48) },
      ]);
    }
  }
  const item = (r: Awaited<ReturnType<typeof closingReadiness>>, key: string) => r.items.find((i) => i.key === key)!;

  it("a fully prepared pod is all green", async () => {
    await fullyReady();
    const r = await closingReadiness(db(), IDS.property);
    expect(r.items.map((i) => [i.key, i.ok])).toEqual([
      ["due_diligence", true],
      ["authorizations", true],
      ["earnest_money", true],
      ["closing_funds", true],
      ["insurance", true],
      ["entity_stage2", true],
      ["closing_hold", true],
      ["agent_holds", true],
    ]);
    expect(r).toMatchObject({ ready: true, blocking: 0, pod: { retained: 5, reserved: 3, total: 8 } });
  });

  it("each gate turns red with specifics and a link to fix it", async () => {
    await fullyReady();
    db().seed("due_diligence_inventory", [
      { id: "doc-x", property_id: IDS.property, document_title: "Inspection", category: "inspection", file_url: "x", content_hash: "h", required: true },
    ]);
    db().seed("authorization_requests", [
      { property_id: IDS.property, buyer_account_id: IDS.b2, action_type: "contingency_waiver", status: "pending", headline: "Waive appraisal", deadline_at: hoursFromNow(5), consequence_text: "x" },
    ]);
    db().table("earnest_money_obligations")[1].status = "late";
    db().table("insurance_policies")[0].status = "lapsed";
    db().table("entity_genesis")[0].tin_match_result = "not_found";
    placeHold();
    db().table("agents").find((a) => a.id === IDS.ra2)!.eo_lapsed = true;
    db().table("agents").find((a) => a.id === IDS.ra2)!.transactions_held = true;

    const r = await closingReadiness(db(), IDS.property);
    expect(r.ready).toBe(false);
    expect(item(r, "due_diligence")).toMatchObject({ ok: false, link: `/admin/properties/${IDS.property}/due-diligence` });
    expect(item(r, "due_diligence").details.join()).toContain("b1@test.local");
    expect(item(r, "authorizations").details).toEqual(["Pending: Waive appraisal (contingency waiver) — b2@test.local"]);
    expect(item(r, "earnest_money")).toMatchObject({ ok: false, summary: "1 of 2 not funded" });
    expect(item(r, "closing_funds").ok).toBe(true);
    expect(item(r, "insurance").ok).toBe(false);
    expect(item(r, "entity_stage2").summary).toContain("TIN match not_found");
    expect(item(r, "closing_hold").summary).toContain(HOLD_REASON);
    expect(item(r, "agent_holds").details).toEqual(["Rory Resident — transactions held: E&O coverage lapsed"]);
    expect(r.blocking).toBe(7);
  });

  it("shows a dual-agency conflict", async () => {
    await fullyReady();
    db().table("properties")[0].listing_agent_id = IDS.ra;
    const r = await closingReadiness(db(), IDS.property);
    expect(item(r, "dual_agency")).toMatchObject({ ok: false });
  });

  it("is strictly read-only — no writes anywhere, even with blockers present", async () => {
    await fullyReady();
    placeHold();
    db().table("properties")[0].listing_agent_id = IDS.ra; // would log a compliance alert via verifyPodDualAgency
    // Reads create empty tables in the in-memory stand-in; only rows count.
    const snapshot = () =>
      JSON.stringify([...db().tables.entries()].filter(([, rows]) => rows.length > 0).sort(([a], [b]) => a.localeCompare(b)));
    const before = snapshot();
    as(USERS.admin);
    const { properties } = await listClosingReadiness();
    expect(properties).toHaveLength(1);
    expect(snapshot()).toBe(before);
    expect(db().audits("compliance.")).toHaveLength(0);
  });

  it("admin only", async () => {
    await fullyReady();
    as(USERS.hla);
    await expect(listClosingReadiness()).rejects.toThrow("Not authorized");
  });
});
