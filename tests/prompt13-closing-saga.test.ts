/**
 * Prompt 13 — Closing Ping Saga (on the Prompt 12 orchestrator).
 */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { IDS, USERS } from "./fixtures";
import { seedClosing, PER_SHARE } from "./closing-fixture";
import { generateAndTransmit, latestSourceOfTruth } from "@/lib/settlement.server";
import { simulateMilestone } from "@/lib/title-escrow.server";
import { startClosingSaga, CLOSING_SAGA_TYPE } from "@/lib/closing-saga.server";
import { listMyCommissions, resumeClosingSaga, listClosingSagas } from "@/lib/closing-saga.functions";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const RECORDED_AT = "2026-10-16T15:00:00.000Z";

async function readyToClose() {
  await seedClosing();
  const r = await generateAndTransmit(db(), USERS.admin, IDS.property);
  if (r.status !== "transmitted") throw new Error(`SoT not generated: ${JSON.stringify(r)}`);
  db().seed("sellers", [{ id: IDS.seller, email: "seller@test.local" }]);
}

/** The title company's funded webhook carrying its final commission figures. */
async function titleFunds(varianceCents = 0) {
  const sot = await latestSourceOfTruth(db(), IDS.property);
  return simulateMilestone(db(), USERS.admin, IDS.property, "funded_and_recorded", {
    commissionDisbursements: sot!.structured.payees.map((p, i) => ({
      payeeReference: p.brokerId,
      amount: (p.amountCents + (i === 0 ? varianceCents : 0)) / 100,
    })),
    recording: { instrumentNumber: "2026-000123", recordedAt: RECORDED_AT },
  });
}

const stepRows = () => Object.fromEntries(db().table("saga_step_executions").map((s) => [s.step_name, s]));
const dealClosed = () => db().table("notifications").filter((n) => n.type === "deal_closed");

describe("happy path — triggered by the funded_and_recorded webhook", () => {
  it("runs all seven steps once and closes the deal", async () => {
    await readyToClose();
    const r = await titleFunds();
    expect(r).toMatchObject({ status: "processed", closingSaga: "completed" });

    const steps = stepRows();
    expect(Object.keys(steps)).toEqual([
      "1_verify_source_of_truth",
      "2_unlock_commissions",
      "3_disbursement_check",
      "4_activate_governance",
      "5_recordation_ping",
      "6_deal_closed_notifications",
      "7_records_vault",
    ]);
    expect(Object.values(steps).every((s: any) => s.status === "succeeded" && s.attempts === 1)).toBe(true);

    // 2. Commissions unlocked (instruction status only) and on each agent's dashboard.
    const ledger = db().table("commission_ledger");
    expect(ledger).toHaveLength(8);
    expect(ledger.every((l) => l.status === "closed_payable_by_title")).toBe(true);
    as(USERS.hla);
    const hla = await listMyCommissions();
    expect(hla.rows.reduce((s, r) => s + r.net_cents, 0)).toBe(3 * 117_188);
    expect(hla.rows[0]!.brokerageName).toBe("Summit Realty");

    // 3. Disbursement Check passed to the cent.
    expect(db().table("disbursement_checks")[0]).toMatchObject({ status: "pass", platform_total_cents: 3 * PER_SHARE, title_total_cents: 3 * PER_SHARE });

    // 4. Property active, governance on, a Digital Key per co-owner (2 buyers + retained seller).
    expect(db().table("properties")[0].listing_status).toBe("active");
    expect(db().table("pods")[0].governance_status).toBe("active");
    expect(db().table("co_owner_digital_keys").map((k) => [k.holder_type, k.shares]).sort()).toEqual([
      ["buyer_account", 1],
      ["buyer_account", 2],
      ["retained_seller", 5],
    ]);

    // 5. Recorded; the 12-month Retention Lock runs from the recording date for every share.
    expect(db().table("properties")[0]).toMatchObject({ deed_recorded_at: RECORDED_AT, deed_recording_reference: "2026-000123" });
    const cap = db().table("cap_table_entries");
    expect(cap).toHaveLength(8);
    expect(cap.every((c) => c.retention_lock_started_at === RECORDED_AT && c.retention_lock_expires_at.startsWith("2027-10-16"))).toBe(true);

    // 6. Deal Closed to co-owners, seller, every involved agent and their brokers — once each.
    const to = dealClosed().map((n) => n.seller_id).sort();
    expect(to).toEqual([USERS.b1, USERS.b2, USERS.ra, USERS.ra2, USERS.hla, IDS.seller, USERS.broker, "u-broker2"].sort());

    // 7. Deed + Closing Statement in the Records Vault.
    const vault = db().table("property_records_vault").map((v) => v.document_type);
    expect(vault).toEqual(expect.arrayContaining(["recorded_deed", "closing_statement"]));

    // Every transition audited.
    expect(db().audits("closing_saga.saga_started")).toHaveLength(1);
    expect(db().audits("closing_saga.step_succeeded")).toHaveLength(7);
    expect(db().audits("closing_saga.saga_completed")).toHaveLength(1);
  });

  it("a redelivered/duplicate trigger changes nothing", async () => {
    await readyToClose();
    await titleFunds();
    const before = { notes: dealClosed().length, ledger: db().table("commission_ledger").length, keys: db().table("co_owner_digital_keys").length };
    const again = await startClosingSaga(db(), IDS.property, { retryDelayMs: 0 });
    expect(again.status).toBe("already_completed");
    expect(dealClosed()).toHaveLength(before.notes);
    expect(db().table("commission_ledger")).toHaveLength(before.ledger);
    expect(db().table("co_owner_digital_keys")).toHaveLength(before.keys);
  });
});

describe("Disbursement Check halts on a one-cent difference", () => {
  it("stops at step 3, dead-letters, and nothing after it happens", async () => {
    await readyToClose();
    const r = await titleFunds(1);
    expect(r).toMatchObject({ status: "processed", closingSaga: "failed" });

    const steps = stepRows();
    expect(steps["3_disbursement_check"]).toMatchObject({ status: "failed", attempts: 1 });
    expect(steps["4_activate_governance"]).toBeUndefined();
    const check = db().table("disbursement_checks")[0]!;
    expect(check.status).toBe("fail");
    expect(check.differences).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "amount_mismatch", deltaCents: 1 }), expect.objectContaining({ kind: "total_mismatch" })]),
    );
    expect(db().table("saga_failures")[0]).toMatchObject({ saga_type: CLOSING_SAGA_TYPE, saga_key: IDS.property, failed_step: "3_disbursement_check" });
    expect(db().table("properties")[0].listing_status).not.toBe("active");
    expect(db().table("co_owner_digital_keys")).toHaveLength(0);
    expect(dealClosed()).toHaveLength(0);
    expect(db().audits("closing_saga.saga_dead_lettered")).toHaveLength(1);
  });

  it("after title corrects its figures, a manual resume skips steps 1–2 and finishes", async () => {
    await readyToClose();
    await titleFunds(1);
    // Title re-sends corrected figures; the plain trigger refuses a dead-lettered saga…
    const retrigger = await titleFunds(0);
    expect(retrigger.closingSaga).toBe("needs_manual_intervention");
    // …until an admin resumes it.
    as(USERS.admin);
    const r = await resumeClosingSaga({ data: { propertyId: IDS.property } });
    expect(r).toMatchObject({ status: "completed", skippedSteps: ["1_verify_source_of_truth", "2_unlock_commissions"] });
    expect(stepRows()["1_verify_source_of_truth"].attempts).toBe(1);
    expect(stepRows()["3_disbursement_check"]).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(db().table("commission_ledger")).toHaveLength(8);
    expect(db().table("saga_failures")[0].resolved_at).toBeTruthy();
    expect(dealClosed()).toHaveLength(8);
    expect(db().audits("closing_saga.saga_resumed")).toHaveLength(1);
  });
});

describe("step 1 re-checks gates instead of trusting the earlier check", () => {
  it("an insurance lapse after the Source of Truth blocks the closing", async () => {
    await readyToClose();
    db().table("insurance_policies")[0].status = "lapsed";
    const r = await startClosingSaga(db(), IDS.property, { retryDelayMs: 0 });
    expect(r).toMatchObject({ status: "failed", failedStep: "1_verify_source_of_truth" });
    expect(r.status === "failed" && r.error).toMatch(/insurance_not_bound/);
    expect(stepRows()["1_verify_source_of_truth"].attempts).toBe(2);
    expect(db().table("commission_ledger")).toHaveLength(0);
    expect(db().audits("closing_saga.step_retry")).toHaveLength(1);
  });

  it("a stale Source of Truth (commission changed since) blocks the closing", async () => {
    await readyToClose();
    db().table("authorization_commission_items")[0].per_share_amount_cents = 800_000;
    const r = await startClosingSaga(db(), IDS.property, { retryDelayMs: 0 });
    expect(r.status === "failed" && r.error).toMatch(/stale/);
  });
});

describe("a failure at step 5 never re-runs steps 1–4", () => {
  it("step 5 outage → dead letter → resume skips 1–4 and completes", async () => {
    await readyToClose();
    // Record the funded event without auto-starting the saga, then inject a DB outage on step 5.
    const orig = db().from.bind(db());
    let outage = true;
    (db() as any).from = (t: string) => {
      const q = orig(t);
      if (t === "cap_table_entries") {
        const update = q.update.bind(q);
        q.update = (patch: Record<string, unknown>) => {
          if (outage && "retention_lock_started_at" in patch) throw new Error("Simulated database outage");
          return update(patch);
        };
      }
      return q;
    };
    const r = await titleFunds(0);
    expect(r.closingSaga).toBe("failed");
    expect(stepRows()["5_recordation_ping"]).toMatchObject({ status: "failed", attempts: 3 });
    const activatedAt = db().table("pods")[0].governance_activated_at;
    expect(db().table("co_owner_digital_keys")).toHaveLength(3);

    outage = false;
    const resumed = await startClosingSaga(db(), IDS.property, { resume: true, retryDelayMs: 0 });
    expect(resumed).toMatchObject({
      status: "completed",
      skippedSteps: ["1_verify_source_of_truth", "2_unlock_commissions", "3_disbursement_check", "4_activate_governance"],
      executedSteps: ["5_recordation_ping", "6_deal_closed_notifications", "7_records_vault"],
    });
    expect(db().table("pods")[0].governance_activated_at).toBe(activatedAt);
    expect(db().table("co_owner_digital_keys")).toHaveLength(3);
    expect(db().table("disbursement_checks")).toHaveLength(1);
  });
});

describe("Deal Closed is exactly-once even if the step crashes mid-send", () => {
  it("a crash while notifying the 3rd recipient retries that one without repeating the first two", async () => {
    await readyToClose();
    const orig = db().from.bind(db());
    let dealClosedInserts = 0;
    let crashed = false;
    (db() as any).from = (t: string) => {
      const q = orig(t);
      if (t === "notifications") {
        const insert = q.insert.bind(q);
        q.insert = (row: Record<string, unknown>) => {
          if (row.type === "deal_closed" && ++dealClosedInserts === 3 && !crashed) {
            crashed = true;
            throw new Error("Simulated crash mid-send");
          }
          return insert(row);
        };
      }
      return q;
    };
    const r = await titleFunds(0);
    expect(r.closingSaga).toBe("completed");
    expect(stepRows()["6_deal_closed_notifications"]).toMatchObject({ status: "succeeded", attempts: 2 });
    const perRecipient = new Map<string, number>();
    for (const n of dealClosed()) perRecipient.set(n.seller_id, (perRecipient.get(n.seller_id) ?? 0) + 1);
    expect(perRecipient.size).toBe(8);
    expect([...perRecipient.values()].every((c) => c === 1)).toBe(true);
  });
});

describe("admin monitor", () => {
  it("shows steps, the last Disbursement Check and the open failure", async () => {
    await readyToClose();
    await titleFunds(5);
    as(USERS.admin);
    const { sagas } = await listClosingSagas();
    expect(sagas[0]).toMatchObject({ status: "failed", openFailure: { failed_step: "3_disbursement_check" } });
    expect(sagas[0]!.lastCheck?.status).toBe("fail");
    as(USERS.b1);
    await expect(listClosingSagas()).rejects.toThrow("Not authorized");
  });
});
