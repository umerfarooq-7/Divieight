/**
 * Prompt 9 — Entity Genesis Stage 2: State Filing + EIN.
 */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { ensureDigitalGenesis, syncCapTable } from "@/lib/entity-genesis.server";
import { getStage2, runStage2Action, listMyOperatingAgreements, signMyOperatingAgreement } from "@/lib/entity-genesis-stage2.functions";
import { disbursementPreconditions } from "@/lib/closing-gates.server";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const g = () => db().table("entity_genesis")[0]!;
const act = (action: any) => {
  as(USERS.admin);
  return runStage2Action({ data: { propertyId: IDS.property, action } });
};

/** 5 retained seller shares (Hybrid Exit) + B1 (1) + B2 (2) = 8/8 with only 2 Buyer Accounts. */
async function seedFullPod() {
  seedPod(db());
  Object.assign(db().table("properties")[0], { exit_type: "hybrid_exit", retained_shares: 5, listing_status: "system_lock" });
  await ensureDigitalGenesis(db(), { propertyId: IDS.property, actorId: USERS.b1, reason: "hard_lock" });
}

async function throughFiling() {
  await act({ kind: "closing_ready" });
  await act({ kind: "atlas_request", reference: "ATLAS-123" });
  await act({ kind: "state_filed" });
  await act({
    kind: "state_confirmed",
    llcName: "D8 Independence Lusk, LLC",
    delawareFileNumber: "7654321",
    certificateFileUrl: "entity-genesis/prop-1/cert.pdf",
    certificateHash: "djb2_cert",
  });
}

function signAs(user: string, memberId: string, name: string, hash = g().final_oa_hash) {
  as(user);
  return signMyOperatingAgreement({
    data: {
      propertyId: IDS.property,
      accountMemberId: memberId,
      signedName: name,
      documentHash: hash,
      secondaryVerificationMethod: "typed_initials",
      deviceFingerprint: "fp",
    },
  });
}

describe("Closing-Ready uses the corrected pod arithmetic", () => {
  it("refuses below 8/8 and reports the arithmetic", async () => {
    seedPod(db());
    await ensureDigitalGenesis(db(), { propertyId: IDS.property, actorId: USERS.b1, reason: "hard_lock" });
    await expect(act({ kind: "closing_ready" })).rejects.toThrow("0 retained + 3 reserved = 3/8");
  });

  it("5 retained + 3 reserved is Closing-Ready with only two Buyer Accounts; cap table locks", async () => {
    await seedFullPod();
    await act({ kind: "closing_ready" });
    expect(g().cap_table_locked_at).toBeTruthy();
    expect(db().table("properties")[0].listing_status).toBe("closing_ready");
    expect(db().table("cap_table_entries")).toHaveLength(8);
    expect(db().audits("entity.closing_ready")).toHaveLength(1);
    expect(db().audits("entity.cap_table_locked")).toHaveLength(1);
  });

  it("nothing in Stage 2 can start before Closing-Ready", async () => {
    await seedFullPod();
    await expect(act({ kind: "atlas_request" })).rejects.toThrow("Closing-Ready");
    await expect(act({ kind: "ein", ein: "12-3456789", confirmationFileUrl: "x" })).rejects.toThrow("Closing-Ready");
  });
});

describe("Stripe Atlas → Delaware filing → EIN → TIN Matching", () => {
  it("records the Atlas request ($500, filing + EIN), filing, confirmation and vaults the certificate", async () => {
    await seedFullPod();
    await act({ kind: "closing_ready" });
    await expect(act({ kind: "state_filed" })).rejects.toThrow("Stripe Atlas first");
    await act({ kind: "atlas_request", reference: "ATLAS-123" });
    const req = db().audits("entity.atlas_requested")[0].metadata;
    expect(req).toMatchObject({ vendor: "stripe_atlas", fee_usd: 500, includes: ["delaware_filing", "ein"] });
    await expect(act({ kind: "state_confirmed", llcName: "X", delawareFileNumber: "1", certificateFileUrl: "c" })).rejects.toThrow("filed before confirming");
    await act({ kind: "state_filed" });
    expect(g().state_filing_status).toBe("filed");
    await act({ kind: "state_confirmed", llcName: "D8 Independence Lusk, LLC", delawareFileNumber: "7654321", certificateFileUrl: "entity-genesis/prop-1/cert.pdf" });
    expect(g()).toMatchObject({ state_filing_status: "confirmed", stage: "state_filed", llc_name: "D8 Independence Lusk, LLC" });
    expect(db().table("property_records_vault").map((v) => v.document_type)).toEqual(["certificate_of_formation"]);
  });

  it("validates and records the EIN, vaults the IRS confirmation, completes Atlas", async () => {
    await seedFullPod();
    await throughFiling();
    await expect(act({ kind: "ein", ein: "123456789", confirmationFileUrl: "x" })).rejects.toThrow("12-3456789");
    await act({ kind: "ein", ein: "12-3456789", confirmationFileUrl: "entity-genesis/prop-1/cp575.pdf" });
    expect(g()).toMatchObject({ ein: "12-3456789", ein_status: "issued", atlas_request_status: "completed" });
    expect(db().table("property_records_vault").map((v) => v.document_type)).toContain("ein_confirmation");
    expect(db().audits("entity.ein_issued")[0].metadata).toEqual({ ein_last4: "6789" });
  });

  it("LLC financial transactions stay blocked until TIN Matching returns 'match'", async () => {
    await seedFullPod();
    await throughFiling();
    await act({ kind: "ein", ein: "12-3456789", confirmationFileUrl: "c" });
    await act({ kind: "tin_match", result: "name_mismatch" });
    expect(g().ein_status).toBe("issued");
    let blockers = await disbursementPreconditions(db(), IDS.property);
    expect(blockers.map((b) => b.code)).toContain("llc_tin_not_verified");
    expect(blockers.find((b) => b.code === "llc_tin_not_verified")!.message).toContain("name_mismatch");

    await act({ kind: "tin_match", result: "match" });
    expect(g()).toMatchObject({ ein_status: "verified", tin_match_result: "match" });
    blockers = await disbursementPreconditions(db(), IDS.property);
    expect(blockers.map((b) => b.code)).not.toContain("llc_tin_not_verified");
    expect(db().audits("entity.tin_match_recorded")).toHaveLength(2);
  });
});

describe("Final Operating Agreement — parallel platform-native signing", () => {
  it("needs the confirmed filing, then locks the roster and opens signing for every Account Member", async () => {
    await seedFullPod();
    await act({ kind: "closing_ready" });
    await expect(act({ kind: "final_oa" })).rejects.toThrow("Confirm the Delaware filing");
    await act({ kind: "atlas_request" });
    await act({ kind: "state_filed" });
    await act({ kind: "state_confirmed", llcName: "D8 Independence Lusk, LLC", delawareFileNumber: "7654321", certificateFileUrl: "c" });
    await act({ kind: "final_oa" });

    const text: string = g().final_oa_text;
    expect(g().final_oa_status).toBe("awaiting_signatures");
    expect(g().final_oa_hash).toMatch(/^sha256_[0-9a-f]{64}$/);
    expect(text).toContain("D8 Independence Lusk, LLC");
    expect(text).toContain("file no. 7654321");
    expect(text).toContain("MEMBER ROSTER — FINAL");
    expect(text).not.toContain("DRAFT");
    expect(text.match(/Retained Seller Share/g)).toHaveLength(5);
    expect(text.match(/\[SIGNATURE PENDING\]/g)).toHaveLength(3); // Alice, Bob, Carol
    expect(text).toContain("divieight, LLC is the Manager");
    expect(db().notificationsFor(USERS.b1).some((n) => /Sign your LLC Operating Agreement/.test(n.message) || /ready for signature/.test(n.message))).toBe(true);

    as(USERS.b1);
    const mine = (await listMyOperatingAgreements()).agreements[0]!;
    expect(mine.members.map((m) => m.name)).toEqual(["Alice One", "Bob One"]);
  });

  it("signatures are pinned to the hash, name-checked, parallel and complete → executed + vaulted", async () => {
    await seedFullPod();
    await throughFiling();
    await act({ kind: "final_oa" });

    await expect(signAs(USERS.b1, IDS.b1m1, "Alice One", "sha256_stale")).rejects.toThrow("changed since you opened it");
    await expect(signAs(USERS.b1, IDS.b1m1, "Alicia One")).rejects.toThrow("exactly: Alice One");
    await expect(signAs(USERS.b1, IDS.b2m1, "Carol Two")).rejects.toThrow("not a signer");

    // No required order: B2 first, then B1's second member, then the first.
    expect(await signAs(USERS.b2, IDS.b2m1, "carol two")).toEqual({ executed: false, outstanding: 2 });
    expect(await signAs(USERS.b1, IDS.b1m2, "Bob One")).toEqual({ executed: false, outstanding: 1 });
    await expect(signAs(USERS.b1, IDS.b1m2, "Bob One")).rejects.toThrow("already signed");
    expect(await signAs(USERS.b1, IDS.b1m1, "Alice One")).toEqual({ executed: true, outstanding: 0 });

    expect(g().final_oa_status).toBe("executed");
    const sigs = db().table("operating_agreement_signatures");
    expect(sigs).toHaveLength(3);
    expect(sigs.every((s) => s.ip_address === harness.ip && s.document_hash === g().final_oa_hash)).toBe(true);
    const executed = db().table("property_records_vault").find((v) => v.document_type === "executed_operating_agreement")!;
    expect(executed.file_url).toMatch(/^entity-genesis\/prop-1\/executed-operating-agreement-/);
    expect(db().audits("entity.oa_signed")).toHaveLength(3);
    expect(db().audits("entity.oa_executed")).toHaveLength(1);
  });

  it("a holder change after the lock revokes Closing-Ready and forces re-signing", async () => {
    await seedFullPod();
    await throughFiling();
    await act({ kind: "final_oa" });
    await signAs(USERS.b2, IDS.b2m1, "Carol Two");
    const oldHash = g().final_oa_hash;

    db().table("pod_reservations").find((r) => r.id === IDS.res2)!.status = "defaulted";
    await syncCapTable(db(), { propertyId: IDS.property, actorId: USERS.admin, reason: "closing_funds_default" });

    expect(g()).toMatchObject({ cap_table_locked_at: null, final_oa_status: "not_started", final_oa_hash: null });
    expect(db().table("properties")[0].listing_status).toBe("forming");
    const unlocked = db().audits("entity.cap_table_unlocked")[0].metadata;
    expect(unlocked).toMatchObject({ reason: "closing_funds_default", superseded_oa_hash: oldHash });
    expect(db().table("operating_agreement_signatures")).toHaveLength(1); // kept, no longer current
    await expect(act({ kind: "final_oa" })).rejects.toThrow("Closing-Ready");
  });

  it("admin view summarizes the checklist", async () => {
    await seedFullPod();
    await throughFiling();
    as(USERS.admin);
    const v = await getStage2({ data: { propertyId: IDS.property } });
    expect(v.pod).toMatchObject({ retained: 5, reserved: 3, total: 8, full: true });
    expect(v.genesis?.state_filing_status).toBe("confirmed");
    expect(v.llcFinancials.ok).toBe(false);
    expect(v.vault).toHaveLength(1);
  });
});
