/**
 * Prompt 11 — Commission Settlement: Source of Truth + CDA.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS, hoursFromNow } from "./fixtures";
import { computeShareCascade } from "@/lib/commission-cascade";
import { ensureDigitalGenesis } from "@/lib/entity-genesis.server";
import { generateSourceOfTruth, listSettlements } from "@/lib/settlement.functions";
import { latestSourceOfTruth, settlementPreconditions } from "@/lib/settlement.server";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const PER_SHARE = 781_250; // 2.5% of a $312,500 share, in cents

afterEach(() => vi.unstubAllGlobals());

describe("commission cascade (single source of the math)", () => {
  it("no referral, no HLA: Resident Agent takes 100%", () => {
    const c = computeShareCascade({ commissionCents: 100_000, residentAgentId: "ra" });
    expect(c.lines).toEqual([
      { agentId: "ra", role: "resident_agent", grossCents: 100_000, premiumToHlaCents: 0, premiumReceivedCents: 0, netCents: 100_000 },
    ]);
  });

  it("referral: 25% referring / 75% receiving", () => {
    const c = computeShareCascade({ commissionCents: 100_000, residentAgentId: "ra", referringAgentId: "nra" });
    expect(c.lines.map((l) => [l.role, l.netCents])).toEqual([
      ["resident_agent", 75_000],
      ["referring_agent", 25_000],
    ]);
  });

  it("15% Heavy Lifter Premium is carved from each other agent's portion; total never changes", () => {
    const c = computeShareCascade({ commissionCents: 100_000, residentAgentId: "ra", referringAgentId: "nra", heavyLiftingAgentId: "hla" });
    const by = Object.fromEntries(c.lines.map((l) => [l.role, l]));
    expect(by.resident_agent).toMatchObject({ grossCents: 75_000, premiumToHlaCents: 11_250, netCents: 63_750 });
    expect(by.referring_agent).toMatchObject({ grossCents: 25_000, premiumToHlaCents: 3_750, netCents: 21_250 });
    expect(by.heavy_lifting_agent).toMatchObject({ premiumReceivedCents: 15_000, netCents: 15_000 });
    expect(c.lines.reduce((s, l) => s + l.netCents, 0)).toBe(100_000);
  });

  it("the HLA pays no premium to themselves when they are the Resident Agent", () => {
    const c = computeShareCascade({ commissionCents: 100_000, residentAgentId: "hla", heavyLiftingAgentId: "hla" });
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toMatchObject({ agentId: "hla", netCents: 100_000, premiumToHlaCents: 0 });
    const withRef = computeShareCascade({ commissionCents: 100_000, residentAgentId: "hla", referringAgentId: "nra", heavyLiftingAgentId: "hla" });
    expect(withRef.lines.find((l) => l.agentId === "hla")).toMatchObject({ grossCents: 75_000, premiumReceivedCents: 3_750, netCents: 78_750 });
  });

  it("odd cents still sum exactly", () => {
    for (const cents of [1, 7, 99_999, 781_250, 123_457]) {
      const c = computeShareCascade({ commissionCents: cents, residentAgentId: "ra", referringAgentId: "nra", heavyLiftingAgentId: "hla" });
      expect(c.lines.reduce((s, l) => s + l.netCents, 0)).toBe(cents);
    }
  });
});

/** Closing-ready pod: 5 retained + B1 (1 share) + B2 (2 shares); B2 came via a NAR referral from RA2; HLA at a second brokerage. */
async function seedClosing() {
  seedPod(db());
  Object.assign(db().table("properties")[0], {
    exit_type: "hybrid_exit",
    retained_shares: 5,
    anticipated_closing_date: "2026-10-15",
    listing_agent_id: null,
  });
  db().table("agents").find((a) => a.id === IDS.hla)!.broker_id = "broker-2";
  db().seed("brokers", [{ id: "broker-2", auth_user_id: "u-broker2", brokerage_name: "Summit Realty", license_number: "BR-2", tax_form_verified: true }]);
  Object.assign(db().table("brokers").find((b) => b.id === IDS.broker)!, { brokerage_name: "Lusk Homes", license_number: "BR-1", tax_form_verified: true });

  await ensureDigitalGenesis(db(), { propertyId: IDS.property, actorId: USERS.admin, reason: "hard_lock" });
  Object.assign(db().table("entity_genesis")[0], {
    cap_table_locked_at: new Date().toISOString(),
    llc_name: "D8 Independence Lusk, LLC",
    ein: "12-3456789",
    ein_status: "verified",
    tin_match_result: "match",
  });
  db().seed("insurance_policies", [
    { property_id: IDS.property, status: "bound", effective_date: "2026-10-01", renews_at: "2027-10-01", carrier_name: "Chubb", policy_number: "HO-1" },
  ]);
  db().seed("title_escrow_orders", [{ property_id: IDS.property, provider: "qualia", external_order_id: "SIM-QUALIA-ORDER1", bundle_payload: {} }]);
  db().seed("pending_referral_agreements", [
    { buyer_account_id: IDS.b2, non_resident_agent_id: IDS.ra2, resident_agent_id: IDS.ra, referring_agent_role: "non_resident", status: "executed" },
  ]);
  for (const [buyer, id] of [
    [IDS.b1, "req-b1"],
    [IDS.b2, "req-b2"],
  ] as const) {
    db().seed("authorization_requests", [
      { id, property_id: IDS.property, buyer_account_id: buyer, action_type: "final_repa_acceptance", status: "authorized", headline: "REPA", deadline_at: hoursFromNow(1), consequence_text: "x" },
    ]);
    db().seed("authorization_commission_items", [{ request_id: id, status: "authorized", per_share_amount_cents: PER_SHARE, rate_percent: 2.5 }]);
  }
}

async function generate() {
  as(USERS.admin);
  return generateSourceOfTruth({ data: { propertyId: IDS.property } });
}

describe("pre-closing gates — any failure blocks generation", () => {
  it("all gates pass on a clean closing-ready pod", async () => {
    await seedClosing();
    expect(await settlementPreconditions(db(), IDS.property)).toEqual([]);
  });

  const cases: Array<[string, () => void, string]> = [
    ["Broker Closing Hold", () => (db().table("pods")[0].closing_hold_active = true), "closing_hold_active"],
    ["agent transactions_held", () => (db().table("agents").find((a) => a.id === IDS.ra2)!.transactions_held = true), "agent_transactions_held"],
    ["broker without W-9/W-8", () => (db().table("brokers").find((b) => b.id === "broker-2")!.tax_form_verified = false), "broker_payment_gate"],
    ["dual agency", () => (db().table("properties")[0].listing_agent_id = IDS.ra), "dual_agency_violation"],
    ["no bound insurance", () => (db().table("insurance_policies")[0].status = "pending"), "insurance_not_bound"],
    ["TIN not matched", () => (db().table("entity_genesis")[0].tin_match_result = "name_mismatch"), "llc_tin_not_verified"],
    ["not Closing-Ready", () => (db().table("entity_genesis")[0].cap_table_locked_at = null), "not_closing_ready"],
    ["no title order", () => db().tables.set("title_escrow_orders", []), "no_title_order"],
    ["commission not authorized", () => (db().table("authorization_commission_items")[1].status = "proposed"), "commission_not_authorized"],
  ];
  for (const [name, breakIt, code] of cases)
    it(`${name} blocks with a clear reason and writes nothing`, async () => {
      await seedClosing();
      breakIt();
      const r = await generate();
      expect(r.status).toBe("blocked");
      if (r.status !== "blocked") return;
      expect(r.blockers.map((b) => b.code)).toContain(code);
      expect(db().table("settlement_documents")).toHaveLength(0);
      expect(db().audits("settlement.generation_blocked")[0].metadata.blockers.map((b: { code: string }) => b.code)).toContain(code);
    });

  it("reports every failing precondition at once on the admin dashboard", async () => {
    await seedClosing();
    db().table("pods")[0].closing_hold_active = true;
    db().table("insurance_policies")[0].status = "lapsed";
    as(USERS.admin);
    const { rows } = await listSettlements();
    expect(rows[0]!.blockers.map((b) => b.code).sort()).toEqual(["closing_hold_active", "insurance_not_bound"]);
  });
});

describe("Source of Truth / CDA", () => {
  it("compiles every share's cascade, pays broker-to-broker, and transmits via the adapter (simulated)", async () => {
    await seedClosing();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await generate();
    expect(r.status).toBe("transmitted");
    if (r.status !== "transmitted") return;
    expect(r.simulated).toBe(true);
    expect(r.externalReference).toMatch(/^SIM-CDA-/);
    expect(fetchSpy).not.toHaveBeenCalled();

    const doc = db().table("settlement_documents")[0]!;
    const sot = doc.structured;
    expect(sot.retainedSellerShares).toBe(5);
    expect(sot.shares).toHaveLength(3);
    expect(sot.totals.commissionCents).toBe(3 * PER_SHARE);

    // B1's share: no referral; RA gives 15% to the HLA.
    const b1 = sot.shares.find((s: any) => s.buyerAccountId === IDS.b1);
    expect(b1.referral).toBeNull();
    expect(b1.lines.map((l: any) => [l.role, l.netCents])).toEqual([
      ["resident_agent", 664_062],
      ["heavy_lifting_agent", 117_188],
    ]);
    // B2's shares: 25/75 referral, both portions carved 15%.
    const b2 = sot.shares.find((s: any) => s.buyerAccountId === IDS.b2);
    expect(b2.referral).toEqual({ agentId: IDS.ra2, role: "non_resident" });
    expect(b2.lines.map((l: any) => [l.role, l.grossCents, l.premiumToHlaCents, l.netCents])).toEqual([
      ["resident_agent", 585_937, 87_891, 498_046],
      ["referring_agent", 195_313, 29_297, 166_016],
      ["heavy_lifting_agent", 0, 0, 117_188],
    ]);

    // Payees are Brokers of Record only, and sum to the total.
    expect(sot.payees.map((p: any) => p.brokerageName).sort()).toEqual(["Lusk Homes", "Summit Realty"]);
    expect(sot.payees.reduce((s: number, p: any) => s + p.amountCents, 0)).toBe(3 * PER_SHARE);
    expect(sot.payees.find((p: any) => p.brokerId === "broker-2").amountCents).toBe(3 * 117_188);
    expect(sot.instruction).toMatch(/does not hold, receive, or disburse/);

    expect(doc).toMatchObject({ status: "transmitted", version: 1, provider: "qualia", simulated: true });
    expect(doc.pdf_url).toMatch(/^settlement\/prop-1\/source-of-truth-v1-/);
    expect(db().table("property_records_vault").map((v) => v.document_type)).toEqual(["source_of_truth_cda"]);
  });

  it("audits a full snapshot of every figure, and the transmission moves no money", async () => {
    await seedClosing();
    const r = await generate();
    if (r.status !== "transmitted") throw new Error("expected transmitted");
    const gen = db().audits("settlement.source_of_truth_generated")[0].metadata;
    expect(gen.content_hash).toBe(r.contentHash);
    expect(gen.snapshot.shares.flatMap((s: any) => s.lines)).toHaveLength(8);
    const sent = db().audits("settlement.cda_transmitted")[0].metadata;
    expect(sent.money_moved).toBe(false);
    const payees = sent.request.variables.input.payees;
    const agentIds = [IDS.ra, IDS.ra2, IDS.hla];
    expect(payees.every((p: any) => !agentIds.includes(p.externalReference))).toBe(true);
    // Only instruction/record tables were written — nothing payout-like exists.
    expect([...db().tables.keys()].filter((t) => /payout|payment|transfer|disburse/.test(t))).toEqual([]);
  });

  it("the PDF is a real PDF", async () => {
    await seedClosing();
    const uploads: Array<{ path: string; body: Blob }> = [];
    (db() as any).storage = {
      from: () => ({
        upload: async (path: string, body: Blob) => {
          uploads.push({ path, body });
          return { data: { path }, error: null };
        },
      }),
    };
    await generate();
    const bytes = new Uint8Array(await uploads[0]!.body.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("COMMISSION DISBURSEMENT AUTHORIZATION");
    expect(text).toContain("Summit Realty");
  });

  it("regeneration supersedes the prior version; the latest transmitted one is the Disbursement Check reference", async () => {
    await seedClosing();
    await generate();
    db().table("authorization_commission_items")[0].per_share_amount_cents = 800_000;
    await generate();
    const docs = db().table("settlement_documents");
    expect(docs.map((d) => [d.version, d.status])).toEqual([
      [1, "superseded"],
      [2, "transmitted"],
    ]);
    const latest = await latestSourceOfTruth(db(), IDS.property);
    expect(latest?.version).toBe(2);
    expect(latest?.total_commission_cents).toBe(800_000 + 2 * PER_SHARE);
  });

  it("admin only", async () => {
    await seedClosing();
    as(USERS.b1);
    await expect(generateSourceOfTruth({ data: { propertyId: IDS.property } })).rejects.toThrow("Not authorized");
  });
});
