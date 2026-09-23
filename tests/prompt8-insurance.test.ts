/**
 * Prompt 8 — Insurance Procurement by the Manager (Rev 48).
 */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { checkCoverage, tallyVotes, validateRules, declaredUseFor, type CoverageRule } from "@/lib/insurance";
import {
  saveCoverageRequirements,
  recordInsurancePolicy,
  bindInsurancePolicy,
  markInsurancePremiumPaid,
  renewInsurancePolicy,
  proposeInsuranceAlternative,
  reviewInsuranceProposal,
  castInsuranceVote,
  resolveInsuranceAlternatives,
  getBuyerInsurance,
  getAdminInsurance,
} from "@/lib/insurance.functions";
import { runInsuranceLapseSweep } from "@/lib/insurance.server";
import { assertDisbursementAllowed, insuranceGate } from "@/lib/closing-gates.server";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;

const RULES: CoverageRule[] = [
  { min_replacement_cost: 0, max_replacement_cost: 1_000_000, declared_use: "personal_use", min_dwelling_coverage: 1_000_000, min_liability_coverage: 300_000 },
  { min_replacement_cost: 1_000_000, max_replacement_cost: null, declared_use: "personal_use", min_dwelling_coverage: 2_500_000, min_liability_coverage: 500_000 },
  { min_replacement_cost: 0, max_replacement_cost: null, declared_use: "short_term_rental", min_dwelling_coverage: 2_500_000, min_liability_coverage: 2_000_000 },
];

function seed() {
  seedPod(db());
  Object.assign(db().table("properties")[0], { usage_tag: "owner_occupied", anticipated_closing_date: "2026-10-15" });
  db().seed("coverage_requirements", [{ version: 1, rules: RULES, is_placeholder: true, is_active: true }]);
}

const POLICY = {
  propertyId: IDS.property,
  carrierName: "Chubb",
  policyNumber: "HO-1",
  coverageAmount: 2_600_000,
  liabilityCoverage: 500_000,
  premium: 9_800,
  effectiveDate: "2026-10-01",
  renewsAt: "2027-10-01",
  replacementCost: 2_400_000,
  method: "default" as const,
};

async function recordAndBind(overrides: Partial<typeof POLICY> = {}) {
  as(USERS.admin);
  const r = await recordInsurancePolicy({ data: { ...POLICY, ...overrides } });
  await bindInsurancePolicy({ data: { policyId: r.id } });
  return r.id;
}

const proposal = (carrierName: string, liability = 600_000) => ({
  propertyId: IDS.property,
  carrierName,
  coverageAmount: 2_600_000,
  liabilityCoverage: liability,
  premium: 8_500,
});

describe("coverage requirement framework", () => {
  it("looks up minimums by replacement cost and declared use", () => {
    expect(declaredUseFor("short_term_rental")).toBe("short_term_rental");
    expect(declaredUseFor("owner_occupied")).toBe("personal_use");
    const ok = checkCoverage(RULES, { replacementCost: 2_400_000, use: "personal_use", coverage: 2_500_000, liability: 500_000 });
    expect(ok.meets).toBe(true);
    const short = checkCoverage(RULES, { replacementCost: 2_400_000, use: "short_term_rental", coverage: 2_500_000, liability: 500_000 });
    expect(short.meets).toBe(false);
    expect(short.shortfalls[0]).toMatch(/Liability/);
  });

  it("rejects overlapping ranges and non-positive minimums", () => {
    expect(validateRules(RULES)).toBeNull();
    expect(validateRules([{ ...RULES[0]!, max_replacement_cost: 1_500_000 }, RULES[1]!])).toMatch(/overlap/);
    expect(validateRules([{ ...RULES[0]!, min_liability_coverage: 0 }])).toMatch(/positive/);
  });

  it("saving creates a new active version and keeps history (audited)", async () => {
    seed();
    as(USERS.admin);
    const r = await saveCoverageRequirements({ data: { rules: RULES, notes: "Compliance draft", isPlaceholder: false } });
    expect(r.version).toBe(2);
    const versions = db().table("coverage_requirements");
    expect(versions.filter((v) => v.is_active).map((v) => v.version)).toEqual([2]);
    expect(versions).toHaveLength(2);
    expect(db().audits("insurance.requirements_versioned")[0].metadata.previous_version).toBe(1);
    as(USERS.b1);
    await expect(saveCoverageRequirements({ data: { rules: RULES, isPlaceholder: true } })).rejects.toThrow("Not authorized");
  });
});

describe("Manager procurement and the Disbursement Check gate", () => {
  it("BLOCKS disbursement with no bound policy — a hard stop, not a warning", async () => {
    seed();
    await expect(assertDisbursementAllowed(db(), IDS.property)).rejects.toThrow("No bound homeowners/hazard policy");
    expect(db().audits("disbursement.blocked")).toHaveLength(1);
  });

  it("a pending policy still blocks; bound + effective by closing clears it", async () => {
    seed();
    as(USERS.admin);
    const { id, placeholder } = await recordInsurancePolicy({ data: POLICY });
    expect(placeholder).toBe(true);
    expect((await insuranceGate(db(), IDS.property)).ok).toBe(false);
    await bindInsurancePolicy({ data: { policyId: id } });
    await expect(assertDisbursementAllowed(db(), IDS.property)).resolves.toBeUndefined();
  });

  it("coverage effective AFTER closing does not satisfy the gate", async () => {
    seed();
    await recordAndBind({ effectiveDate: "2026-10-20" });
    expect((await insuranceGate(db(), IDS.property)).ok).toBe(false);
  });

  it("records procured_by=manager, Block 2 authority and the LLC operating account as premium source", async () => {
    seed();
    const id = await recordAndBind();
    const pol = db().table("insurance_policies").find((p) => p.id === id)!;
    expect(pol).toMatchObject({
      procured_by: "manager",
      procurement_method: "default",
      status: "bound",
      premium_paid_from: "llc_operating_account",
      premium_expense_category: "insurance_premium",
      requirement_version: 1,
      renews_at: "2027-10-01",
    });
    const proc = db().audits("insurance.procured")[0].metadata;
    expect(proc.authority).toBe("block_2_required_buyer_authorizations");
    expect(db().audits("insurance.bound")).toHaveLength(1);
    expect(db().notificationsFor(USERS.b1).some((n) => /coverage for .* is bound/.test(n.message))).toBe(true);

    await markInsurancePremiumPaid({ data: { policyId: id } });
    expect(db().audits("insurance.premium_paid")[0].metadata.paid_from).toBe("llc_operating_account");
  });

  it("refuses a policy below the coverage minimums", async () => {
    seed();
    as(USERS.admin);
    await expect(recordInsurancePolicy({ data: { ...POLICY, liabilityCoverage: 100_000 } })).rejects.toThrow(
      "does not meet coverage requirements",
    );
  });

  it("only admins (the Manager) can procure", async () => {
    seed();
    as(USERS.b1);
    await expect(recordInsurancePolicy({ data: POLICY })).rejects.toThrow("Not authorized");
  });
});

describe("Right to Shop and the member vote", () => {
  it("one approved alternative is selected outright and the Manager procures it instead", async () => {
    seed();
    as(USERS.b1);
    const { id } = await proposeInsuranceAlternative({ data: proposal("Travelers") });
    as(USERS.admin);
    await reviewInsuranceProposal({ data: { proposalId: id, approve: true, replacementCost: 2_400_000 } });
    const r = await resolveInsuranceAlternatives({ data: { propertyId: IDS.property } });
    expect(r.selectedId).toBe(id);

    await expect(
      recordInsurancePolicy({ data: { ...POLICY, method: "buyer_alternative", alternativeProposalId: "nope" } }),
    ).rejects.toThrow("selected alternative");
    const pol = await recordInsurancePolicy({ data: { ...POLICY, carrierName: "Travelers", method: "buyer_alternative", alternativeProposalId: id } });
    expect(db().table("insurance_policies").find((p) => p.id === pol.id)!.procurement_method).toBe("buyer_alternative");
    for (const a of ["insurance.alternative_proposed", "insurance.alternative_reviewed", "insurance.alternative_selected"])
      expect(db().audits(a)).toHaveLength(1);
  });

  it("an alternative that misses the requirements cannot be approved", async () => {
    seed();
    as(USERS.b1);
    const { id } = await proposeInsuranceAlternative({ data: proposal("CheapCo", 100_000) });
    as(USERS.admin);
    await expect(
      reviewInsuranceProposal({ data: { proposalId: id, approve: true, replacementCost: 2_400_000 } }),
    ).rejects.toThrow("requirements not met");
    await reviewInsuranceProposal({ data: { proposalId: id, approve: false, replacementCost: 2_400_000 } });
    expect(db().table("insurance_alternative_proposals")[0].status).toBe("rejected");
  });

  it("different approved alternatives go to a vote: one vote per Buyer Account, plurality wins", async () => {
    seed();
    db().seed("pod_reservations", [{ property_id: IDS.property, buyer_account_id: IDS.b3, shares_reserved: 1, status: "reserved" }]);
    as(USERS.b1);
    const a = await proposeInsuranceAlternative({ data: proposal("Travelers") });
    as(USERS.b2);
    const b = await proposeInsuranceAlternative({ data: proposal("Allstate") });
    as(USERS.admin);
    await reviewInsuranceProposal({ data: { proposalId: a.id, approve: true, replacementCost: 2_400_000 } });
    await reviewInsuranceProposal({ data: { proposalId: b.id, approve: true, replacementCost: 2_400_000 } });
    expect(db().notificationsFor(USERS.b3).some((n) => /Cast your Buyer Account's vote/.test(n.message))).toBe(true);

    as(USERS.b1);
    await castInsuranceVote({ data: { propertyId: IDS.property, proposalId: b.id } });
    await castInsuranceVote({ data: { propertyId: IDS.property, proposalId: a.id } }); // changes, not doubles
    as(USERS.b2);
    await castInsuranceVote({ data: { propertyId: IDS.property, proposalId: b.id } });
    as(USERS.b3);
    await castInsuranceVote({ data: { propertyId: IDS.property, proposalId: a.id } });
    expect(db().table("insurance_votes")).toHaveLength(3);

    as(USERS.b1);
    const view = (await getBuyerInsurance()).properties[0]!;
    expect(view.voteOpen).toBe(true);
    expect(view.myVote).toBe(a.id);

    as(USERS.admin);
    const r = await resolveInsuranceAlternatives({ data: { propertyId: IDS.property } });
    expect(r.selectedId).toBe(a.id);
    expect(db().table("insurance_alternative_proposals").find((x) => x.id === b.id)!.status).toBe("not_selected");
    expect(db().audits("insurance.vote_closed")[0].metadata.counts).toEqual({ [a.id]: 2, [b.id]: 1 });
  });

  it("a tie keeps the Manager's default", async () => {
    seed();
    as(USERS.b1);
    const a = await proposeInsuranceAlternative({ data: proposal("Travelers") });
    as(USERS.b2);
    const b = await proposeInsuranceAlternative({ data: proposal("Allstate") });
    as(USERS.admin);
    await reviewInsuranceProposal({ data: { proposalId: a.id, approve: true, replacementCost: 2_400_000 } });
    await reviewInsuranceProposal({ data: { proposalId: b.id, approve: true, replacementCost: 2_400_000 } });
    as(USERS.b1);
    await castInsuranceVote({ data: { propertyId: IDS.property, proposalId: a.id } });
    as(USERS.b2);
    await castInsuranceVote({ data: { propertyId: IDS.property, proposalId: b.id } });
    as(USERS.admin);
    const r = await resolveInsuranceAlternatives({ data: { propertyId: IDS.property } });
    expect(r).toMatchObject({ selectedId: null, reason: "tie" });
    expect(db().audits("insurance.default_retained")).toHaveLength(1);
  });

  it("non-members can't propose or vote", async () => {
    seed();
    as(USERS.b3); // not reserved
    await expect(proposeInsuranceAlternative({ data: proposal("X") })).rejects.toThrow("reserved into this property");
  });

  it("tallyVotes: no votes → no winner", () => {
    expect(tallyVotes(["a", "b"], [])).toMatchObject({ winnerId: null, tie: false, totalVotes: 0 });
  });
});

describe("renewal tracking", () => {
  it("renewal is a new linked policy; the lapse sweep lapses an un-renewed policy only", async () => {
    seed();
    const oldId = await recordAndBind({ effectiveDate: "2025-01-01", renewsAt: "2026-01-01" });
    const keepId = await recordAndBind({ policyNumber: "HO-2", effectiveDate: "2025-06-01", renewsAt: "2026-06-01" });
    as(USERS.admin);
    const renewal = await renewInsurancePolicy({
      data: { policyId: keepId, policyNumber: "HO-2R", coverageAmount: 2_600_000, liabilityCoverage: 500_000, premium: 10_200, effectiveDate: "2026-06-01", renewsAt: "2027-06-01" },
    });
    await bindInsurancePolicy({ data: { policyId: renewal.id } });
    expect(db().table("insurance_policies").find((p) => p.id === renewal.id)!.renewed_from_policy_id).toBe(keepId);
    expect(db().audits("insurance.renewal_recorded")).toHaveLength(1);

    const r = await runInsuranceLapseSweep(db());
    expect(r.lapsed).toBe(1);
    expect(db().table("insurance_policies").find((p) => p.id === oldId)!.status).toBe("lapsed");
    expect(db().table("insurance_policies").find((p) => p.id === keepId)!.status).toBe("bound");
    expect(db().audits("insurance.lapsed")[0].metadata.reason).toBe("renewal_date_passed_without_bound_renewal");
  });

  it("admin view reports the gate and the placeholder flag", async () => {
    seed();
    as(USERS.admin);
    const v = await getAdminInsurance({ data: { propertyId: IDS.property } });
    expect(v.gate.ok).toBe(false);
    expect(v.requirements?.is_placeholder).toBe(true);
  });
});
