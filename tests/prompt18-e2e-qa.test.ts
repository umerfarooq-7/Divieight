/**
 * Prompt 18 — End-to-end QA of the Month 4 Transaction & Legal module.
 *
 * One pod walks the whole path through the real server functions — no
 * shortcuts: DD placement + parallel acknowledgments, Buyer-Authorization with
 * itemized commission, earnest money, title milestones, Entity Genesis Stage 2
 * with executed OA, closing funds, insurance, Closing Readiness, Source of
 * Truth, and the Closing Ping Saga — then checks the audit trail.
 * (Gate-by-gate, failure-path and resilience checks live in the per-prompt
 * suites; this file adds the cross-cutting ones.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { harness } from "./setup";
import { seedPod, IDS, USERS, hoursFromNow } from "./fixtures";
import { ensureDigitalGenesis } from "@/lib/entity-genesis.server";
import { placeDiligenceDocument, acknowledgeAsMember, acknowledgeAsAgent } from "@/lib/due-diligence.functions";
import { INDEPENDENT_REVIEW_NOTICE } from "@/lib/due-diligence";
import {
  createAuthorizationRequest,
  proposeCommissionItem,
  respondToAuthorization,
  respondToCommissionItem,
} from "@/lib/authorization.functions";
import { issueEarnestMoney, markEarnestFunded } from "@/lib/earnest-money.functions";
import { issueClosingFunds, markClosingFundsFunded } from "@/lib/closing-funds.functions";
import { recordInsurancePolicy, bindInsurancePolicy } from "@/lib/insurance.functions";
import { runStage2Action, signMyOperatingAgreement } from "@/lib/entity-genesis-stage2.functions";
import { sendTitleClosingBundle, simulateTitleMilestone } from "@/lib/title-escrow.functions";
import { generateSourceOfTruth } from "@/lib/settlement.functions";
import { listClosingReadiness } from "@/lib/closing-readiness.functions";
import { getMyOwnership, listMyPropertyRecords } from "@/lib/ownership.functions";
import { listMyCommissions } from "@/lib/closing-saga.functions";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const P = IDS.property;
const CLOSING = "2026-10-15";

function seedWorld() {
  seedPod(db());
  Object.assign(db().table("properties")[0], {
    exit_type: "hybrid_exit",
    retained_shares: 5,
    usage_tag: "owner_occupied",
    anticipated_closing_date: CLOSING,
    listing_agent_id: null,
  });
  db().table("agents").find((a) => a.id === IDS.hla)!.broker_id = "broker-2";
  db().seed("brokers", [{ id: "broker-2", auth_user_id: "u-broker2", brokerage_name: "Summit Realty", license_number: "BR-2", tax_form_verified: true }]);
  Object.assign(db().table("brokers").find((b) => b.id === IDS.broker)!, { brokerage_name: "Lusk Homes", license_number: "BR-1", tax_form_verified: true });
  db().seed("sellers", [{ id: IDS.seller, email: "seller@test.local" }]);
  db().seed("pending_referral_agreements", [
    { buyer_account_id: IDS.b2, non_resident_agent_id: IDS.ra2, resident_agent_id: IDS.ra, referring_agent_role: "non_resident", status: "executed" },
  ]);
  db().seed("coverage_requirements", [
    {
      version: 1,
      is_active: true,
      is_placeholder: true,
      rules: [{ min_replacement_cost: 0, max_replacement_cost: null, declared_use: "personal_use", min_dwelling_coverage: 2_500_000, min_liability_coverage: 500_000 }],
    },
  ]);
}

const MEMBERS: Array<[string, string, string]> = [
  [USERS.b1, IDS.b1m1, "Alice One"],
  [USERS.b1, IDS.b1m2, "Bob One"],
  [USERS.b2, IDS.b2m1, "Carol Two"],
];

async function acknowledgeEverything(docId: string) {
  const doc = db().table("due_diligence_inventory").find((d) => d.id === docId)!;
  for (const [user, memberId, name] of MEMBERS) {
    as(user);
    const r = await acknowledgeAsMember({
      data: { documentId: docId, contentHash: doc.content_hash, accountMemberId: memberId, signedName: name, noticeShownAt: new Date().toISOString() },
    });
    expect(r).toEqual({ ok: true });
  }
  as(USERS.ra);
  for (const buyerAccountId of [IDS.b1, IDS.b2]) {
    const r = await acknowledgeAsAgent({ data: { documentId: docId, contentHash: doc.content_hash, buyerAccountId, signedName: "Rita Resident" } });
    expect(r).toEqual({ ok: true });
  }
}

async function authorizeWithCommission(buyerAccountId: string, members: Array<[string, string]>, user: string) {
  as(USERS.admin);
  const { id } = await createAuthorizationRequest({
    data: { propertyId: P, buyerAccountId, actionType: "final_repa_acceptance", headline: "Final REPA at $2.5M", terms: { Price: "$2,500,000" } },
  });
  as(USERS.hla);
  await proposeCommissionItem({ data: { requestId: id, ratePercent: 2.5, fundingSource: "proceeds_at_closing", provisionText: "Buyer-side 2.5%" } });
  as(user);
  for (const [memberId, name] of members) {
    const base = { requestId: id, accountMemberId: memberId, decision: "confirmed" as const, signedName: name, secondaryVerificationMethod: "typed_initials" };
    await respondToAuthorization({ data: base });
    await respondToCommissionItem({ data: base });
  }
  return id;
}

describe("1. Full happy path, end to end", () => {
  it("a 5-retained + 3-share pod goes from diligence to an activated, vaulted closing", async () => {
    seedWorld();
    await ensureDigitalGenesis(db(), { propertyId: P, actorId: USERS.b1, reason: "hard_lock" });

    // Prompt 2 + 6 — Required documents; governing ones carry the Independent-Review Notice.
    as(USERS.admin);
    const oa = await placeDiligenceDocument({ data: { propertyId: P, documentTitle: "Operating Agreement (draft)", category: "operating_agreement", fileUrl: "dd/oa.pdf", contentHash: "h-oa" } });
    const insp = await placeDiligenceDocument({ data: { propertyId: P, documentTitle: "Home inspection", category: "inspection", fileUrl: "dd/insp.pdf", contentHash: "h-insp" } });
    await acknowledgeEverything(oa.id!);
    await acknowledgeEverything(insp.id!);

    // Prompts 3 + 4 — accepted final REPA with itemized commission, both accounts.
    const reqB1 = await authorizeWithCommission(IDS.b1, [[IDS.b1m1, "Alice One"], [IDS.b1m2, "Bob One"]], USERS.b1);
    await authorizeWithCommission(IDS.b2, [[IDS.b2m1, "Carol Two"]], USERS.b2);
    expect(db().table("authorization_requests").find((r) => r.id === reqB1)!.status).toBe("authorized");

    // Prompt 5 — earnest money issued and funded.
    as(USERS.admin);
    await issueEarnestMoney({ data: { propertyId: P, totalAmount: 9000, fundingDeadline: hoursFromNow(72), escrowCompany: "First American", escrowAccountDetails: "Wire 000123" } });
    for (const o of db().table("earnest_money_obligations")) await markEarnestFunded({ data: { obligationId: o.id, reference: "EM" } });

    // Prompt 10 — title order and milestones; the Title Commitment auto-lands in DD.
    await sendTitleClosingBundle({ data: { propertyId: P } });
    await simulateTitleMilestone({ data: { propertyId: P, milestone: "order_opened" } });
    await simulateTitleMilestone({ data: { propertyId: P, milestone: "title_report_ready" } });
    const commitment = db().table("due_diligence_inventory").find((d) => d.category === "title_commitment")!;
    expect(commitment.is_governing_instrument).toBe(true);
    await acknowledgeEverything(commitment.id);
    as(USERS.admin);
    const dep = await simulateTitleMilestone({ data: { propertyId: P, milestone: "earnest_money_deposited", depositScenario: "match_platform" } });
    expect(dep).toMatchObject({ status: "processed", discrepancies: 0 });

    // Prompt 9 — Stage 2 through TIN match and a fully executed OA.
    await runStage2Action({ data: { propertyId: P, action: { kind: "closing_ready" } } });
    await runStage2Action({ data: { propertyId: P, action: { kind: "atlas_request", reference: "ATLAS-1" } } });
    await runStage2Action({ data: { propertyId: P, action: { kind: "state_filed" } } });
    await runStage2Action({ data: { propertyId: P, action: { kind: "state_confirmed", llcName: "D8 Independence Lusk, LLC", delawareFileNumber: "7654321", certificateFileUrl: "eg/cert.pdf" } } });
    await runStage2Action({ data: { propertyId: P, action: { kind: "ein", ein: "12-3456789", confirmationFileUrl: "eg/cp575.pdf" } } });
    await runStage2Action({ data: { propertyId: P, action: { kind: "tin_match", result: "match" } } });
    await runStage2Action({ data: { propertyId: P, action: { kind: "final_oa" } } });
    const hash = db().table("entity_genesis")[0]!.final_oa_hash;
    for (const [user, memberId, name] of MEMBERS) {
      as(user);
      await signMyOperatingAgreement({ data: { propertyId: P, accountMemberId: memberId, signedName: name, documentHash: hash, secondaryVerificationMethod: "typed_initials" } });
    }
    expect(db().table("entity_genesis")[0]!.final_oa_status).toBe("executed");

    // Prompts 7 + 8 — closing funds funded, insurance bound.
    as(USERS.admin);
    await issueClosingFunds({ data: { propertyId: P, totalAmount: 1_800_000, fundingDeadline: hoursFromNow(240), escrowCompany: "First American", escrowAccountDetails: "Wire 000123" } });
    for (const o of db().table("closing_funds_obligations")) await markClosingFundsFunded({ data: { obligationId: o.id } });
    const pol = await recordInsurancePolicy({
      data: { propertyId: P, carrierName: "Chubb", policyNumber: "HO-1", coverageAmount: 2_600_000, liabilityCoverage: 500_000, premium: 9800, effectiveDate: "2026-10-01", renewsAt: "2027-10-01", replacementCost: 2_400_000, method: "default" },
    });
    await bindInsurancePolicy({ data: { policyId: pol.id } });
    await simulateTitleMilestone({ data: { propertyId: P, milestone: "closing_scheduled", closingDate: CLOSING } });

    // Prompt 15 — every gate green.
    const { properties } = await listClosingReadiness();
    expect(properties[0]!.items.filter((i) => !i.ok).map((i) => `${i.key}: ${i.summary}`)).toEqual([]);

    // Prompt 11 — Source of Truth generated and transmitted.
    const sot = await generateSourceOfTruth({ data: { propertyId: P } });
    expect(sot.status).toBe("transmitted");

    // Prompts 10 → 13 → 16 → 17 — funded and recorded fires the Closing Ping Saga.
    const funded = await simulateTitleMilestone({ data: { propertyId: P, milestone: "funded_and_recorded" } });
    expect(funded).toMatchObject({ status: "processed", closingSaga: "completed" });
    expect(db().table("disbursement_checks").at(-1)!.status).toBe("pass");
    expect(db().table("properties")[0]).toMatchObject({ listing_status: "active" });
    expect(db().table("pods")[0].governance_status).toBe("active");
    expect(db().table("co_owner_digital_keys")).toHaveLength(3);
    expect(db().table("property_records_vault").map((v) => v.document_type).sort()).toEqual(
      ["certificate_of_formation", "closing_statement", "ein_confirmation", "executed_operating_agreement", "recorded_deed", "source_of_truth_cda"].sort(),
    );

    as(USERS.b2);
    expect((await getMyOwnership()).properties[0]).toMatchObject({ shares: 2 });
    expect((await listMyPropertyRecords()).properties[0]!.documents).toHaveLength(6);
    as(USERS.ra2);
    const ra2 = await listMyCommissions();
    expect(ra2.rows.map((r) => r.role)).toEqual(["referring_agent", "referring_agent"]);

    // 6. The Independent-Review Notice was recorded on governing instruments only.
    const acks = db().table("due_diligence_acknowledgments");
    const noticeFor = (docId: string) => acks.filter((a) => a.document_id === docId).map((a) => a.independent_review_notice_text);
    expect(new Set(noticeFor(oa.id!))).toEqual(new Set([INDEPENDENT_REVIEW_NOTICE]));
    expect(new Set(noticeFor(commitment.id))).toEqual(new Set([INDEPENDENT_REVIEW_NOTICE]));
    expect(new Set(noticeFor(insp.id!))).toEqual(new Set([null]));
    expect(acks.filter((a) => a.document_id === insp.id).every((a) => a.independent_review_notice_shown_at === null)).toBe(true);

    // 9. The audit trail can reconstruct the month.
    const audit = db().table("audit_log");
    const ACTORS = new Set(["admin", "buyer", "agent", "system", "broker", "seller"]);
    expect(audit.filter((a) => !ACTORS.has(a.actor_type)).map((a) => a.action_type)).toEqual([]);
    expect(audit.filter((a) => a.actor_type === "seller").map((a) => a.action_type)).toEqual([]); // no seller acted in this flow
    for (const prefix of [
      "diligence.",
      "authorization.",
      "earnest.",
      "closing_funds.",
      "insurance.",
      "entity.",
      "title.",
      "settlement.",
      "closing_saga.",
      "disbursement_check.",
    ])
      expect(audit.some((a) => String(a.action_type).startsWith(prefix)), prefix).toBe(true);
    expect(audit.every((a) => a.action_type && a.entity_type !== undefined)).toBe(true);
  });
});

describe("6. Independent-Review Notice defaults", () => {
  it("OA, REPA and title commitments default to governing; inspections don't", async () => {
    const { GOVERNING_CATEGORIES, AUTO_GOVERNING_CATEGORIES } = await import("@/lib/due-diligence");
    for (const c of ["operating_agreement", "real_estate_purchase_agreement", "title_commitment"]) {
      expect(GOVERNING_CATEGORIES).toContain(c);
      expect(AUTO_GOVERNING_CATEGORIES).toContain(c); // the admin uploader's default toggle
    }
    expect(AUTO_GOVERNING_CATEGORIES).not.toContain("inspection");
    const { detectReportFlags } = await import("@/lib/reports");
    expect(detectReportFlags).toBeTypeOf("function"); // report delivery places inspections as non-governing (Prompt 6 suite)
  });
});

describe("8. Manager's Restraint — no copy implies the Manager originates commission terms", () => {
  it("scans every source file", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    walk(join(__dirname, "..", "src"));
    const forbidden =
      /(divieight|the manager|manager|we|our)\s+(propose[sd]?|recommend[sed]*|negotiate[sd]?|set[s]?|determine[sd]?|price[sd]?)\s+(the\s+|your\s+|a\s+)?(buyer-side\s+)?commission/i;
    const hits = files.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => (forbidden.test(line) ? `${f}:${i + 1}: ${line.trim()}` : null))
        .filter(Boolean),
    );
    expect(hits).toEqual([]);
  });
});
