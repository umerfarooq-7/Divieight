/** Liveness: a simulated vendor behind an adapter, one record per attempt per member. */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { getLivenessState, submitLivenessSelfie, setLivenessTestSwitchFn, getLivenessTestSwitch } from "@/lib/liveness.functions";
import { getLivenessAdapter, setLivenessAdapterForTesting, type LivenessAdapter } from "@/lib/liveness-adapters";
import { SimulatedLivenessAdapter } from "@/lib/liveness-adapters/simulated";
import { evaluateGoldenTicket, issueGoldenTicketIfEligible } from "@/lib/golden-ticket";
import { eligibilityOf } from "@/lib/account-members";
import { getMyAccountMembers } from "@/lib/account-members.functions";

const db = () => harness.db;
const checks = () => db().table("member_liveness_checks");
const member = (id: string) => db().table("account_members").find((m) => m.id === id)!;
const account = (id: string) => db().table("buyer_accounts").find((a) => a.id === id)!;

function seed() {
  seedPod(db());
  for (const m of db().table("account_members")) {
    Object.assign(m, { status: "active", date_of_birth: "1980-01-01", address: "1 Main St", id_document_url: `${USERS.b1}/buyer-license-${m.id}.jpg`, vetting_status: "identity_submitted" });
  }
  account(IDS.b1).onboarding_status = "not_started";
}

let n = 0;
function selfie(memberId: string, fileName = "selfie-camera.jpg", user: string = USERS.b1) {
  harness.userId = user;
  n += 1;
  return submitLivenessSelfie({ data: { actingMemberId: memberId, selfiePath: `${user}/selfie-${memberId}-${n}.jpg`, selfieFileName: fileName, contentType: "image/jpeg" } });
}

afterEach(() => setLivenessAdapterForTesting(null));

describe("each member gets their own liveness record", () => {
  it("passes by default, one row per member, with the ID document it was checked against", async () => {
    seed();
    const a = await selfie(IDS.b1m1);
    expect(a).toMatchObject({ status: "passed", reason_code: null, advanced: false });
    expect(a.waitingOn).toEqual([{ memberId: IDS.b1m2, name: "Bob One", step: "liveness" }]);
    const b = await selfie(IDS.b1m2);
    expect(b).toMatchObject({ status: "passed", waitingOn: [], advanced: true });
    expect(account(IDS.b1).onboarding_status).toBe("lifestyle_survey_pending");
    expect(checks()).toHaveLength(2);
    for (const id of [IDS.b1m1, IDS.b1m2]) {
      const row = checks().find((c) => c.account_member_id === id)!;
      expect(row).toMatchObject({ buyer_account_id: IDS.b1, provider: "simulated", status: "passed", reason_code: null, id_document_ref: member(id).id_document_url });
      expect(row.checked_at).toBeTruthy();
      expect(row.selfie_url).toContain(id);
    }
    expect(db().audits("buyer.liveness_checked").map((x) => x.metadata.acted_by_member_id).sort()).toEqual([IDS.b1m1, IDS.b1m2].sort());
  });

  it("previous attempts are kept; the latest is the result", async () => {
    seed();
    await selfie(IDS.b1m1, "liveness-inconclusive.jpg");
    await selfie(IDS.b1m1);
    expect(checks().map((c) => c.status)).toEqual(["inconclusive", "passed"]);
    harness.userId = USERS.b1;
    const state = await getLivenessState({ data: { actingMemberId: IDS.b1m1 } });
    expect(state).toMatchObject({ attempts: 2, canAttempt: false, hasIdDocument: true });
    expect(state.latest!.status).toBe("passed");
    await expect(selfie(IDS.b1m1)).rejects.toThrow("already confirmed");
  });

  it("needs the member's ID photo first, the acting member on this account, and a selfie from this buyer's folder", async () => {
    seed();
    member(IDS.b1m2).id_document_url = null;
    await expect(selfie(IDS.b1m2)).rejects.toThrow("ID photo");
    await expect(selfie(IDS.b2m1)).rejects.toThrow("isn't on your account");
    harness.userId = USERS.b1;
    await expect(submitLivenessSelfie({ data: { actingMemberId: IDS.b1m1, selfiePath: `${USERS.b2}/x.jpg`, selfieFileName: "x.jpg" } })).rejects.toThrow("isn't one you uploaded");
    expect(checks()).toEqual([]);
  });

  it("is a member-level step after identity: the identity page sends the member to it and no longer moves the account on", () => {
    const identity = readFileSync("src/routes/buyer.onboarding.identity.tsx", "utf8");
    expect(identity).toContain(`navigate({ to: "/buyer/onboarding/liveness" })`);
    expect(identity).not.toContain(`onboarding_status: "lifestyle_survey_pending"`);
  });
});

describe("inconclusive creates a Verification Request", () => {
  it("records the request, holds the member and keeps the account pending", async () => {
    seed();
    const r = await selfie(IDS.b1m1, "IMG_liveness-inconclusive_01.jpg");
    expect(r.status).toBe("inconclusive");
    expect(checks()[0]!.reason_code).toBe("low_quality_capture");
    expect(member(IDS.b1m1).vetting_status).toBe("verification_pending");
    expect(account(IDS.b1).onboarding_status).toBe("verification_pending");
    expect(db().audits("buyer.verification_requested")[0]!.metadata).toMatchObject({ reason: "liveness_inconclusive", member_id: IDS.b1m1, liveness_check_id: r.id });
    expect(eligibilityOf(member(IDS.b1m1).vetting_status, "inconclusive")).toBe("held");
  });

  it("a later pass doesn't move a pending account on by itself", async () => {
    seed();
    await selfie(IDS.b1m1, "liveness-inconclusive.jpg");
    await selfie(IDS.b1m1);
    await selfie(IDS.b1m2);
    expect(account(IDS.b1).onboarding_status).toBe("verification_pending");
  });

  it("a vendor error or a vendor 'pending' is inconclusive, never a pass", async () => {
    seed();
    setLivenessAdapterForTesting({ provider: "broken", check: async () => { throw new Error("timeout"); } });
    expect((await selfie(IDS.b1m1)).status).toBe("inconclusive");
    expect(checks()[0]!.reason_code).toBe("provider_error");
    setLivenessAdapterForTesting({ provider: "slow", check: async () => ({ status: "pending", reason_code: null }) });
    expect((await selfie(IDS.b1m2)).status).toBe("inconclusive");
  });
});

describe("a failed liveness blocks eligibility for that member only", () => {
  it("the member is not eligible and can't retry; the other member is unaffected", async () => {
    seed();
    expect((await selfie(IDS.b1m1, "liveness-fail.png")).status).toBe("failed");
    expect(checks()[0]!.reason_code).toBe("face_mismatch");
    await expect(selfie(IDS.b1m1)).rejects.toThrow("failed");
    expect((await selfie(IDS.b1m2)).status).toBe("passed");
    for (const id of [IDS.b1m1, IDS.b1m2]) member(id).vetting_status = "cleared";
    harness.userId = USERS.b1;
    const view = await getMyAccountMembers();
    expect(view.members.map((m) => [m.id, m.eligibility])).toEqual([
      [IDS.b1m1, "not_eligible"],
      [IDS.b1m2, "eligible"],
    ]);
    expect(view.members[1]!.checklist.find((c) => c.key === "liveness")!.done).toBe(true);
    expect(view.members[0]!.checklist.find((c) => c.key === "liveness")!.done).toBe(false);
    expect(member(IDS.b1m1).vetting_status).toBe("cleared");
  });

  it("feeds the eligibility result", () => {
    expect(eligibilityOf("cleared", "passed")).toBe("eligible");
    expect(eligibilityOf("cleared", "failed")).toBe("not_eligible");
    expect(eligibilityOf("cleared", "inconclusive")).toBe("held");
    expect(eligibilityOf("cleared", null)).toBe("pending");
    expect(eligibilityOf("cleared", "pending")).toBe("pending");
    expect(eligibilityOf("held_for_review", "passed")).toBe("held");
  });

  it("feeds the Golden Ticket check: every active member's latest attempt must have passed", async () => {
    const base = { goldenTicketIssued: false, liquidityVerified: true, liquidityStatus: "verified", praSigned: true, memberStatuses: ["cleared", "cleared"] };
    expect(evaluateGoldenTicket({ ...base, livenessStatuses: ["passed", "passed"] }).eligible).toBe(true);
    for (const s of [["passed", "failed"], ["passed", null], ["passed", "inconclusive"], ["passed"]])
      expect(evaluateGoldenTicket({ ...base, livenessStatuses: s }).missing).toContain("Every Account Member must pass the liveness check");

    seed();
    for (const id of [IDS.b1m1, IDS.b1m2]) member(id).vetting_status = "cleared";
    Object.assign(account(IDS.b1), { liquidity_verified: true, golden_ticket_issued: false });
    db().seed("signed_documents", [{ buyer_account_id: IDS.b1, document_type: "PRA", signed_name: "Alice One" }]);
    await selfie(IDS.b1m1);
    await selfie(IDS.b1m2, "liveness-fail.jpg");
    const gt = await issueGoldenTicketIfEligible({ authUserId: USERS.b1, buyerAccountId: IDS.b1 });
    expect(gt.missing).toEqual(["Every Account Member must pass the liveness check"]);
    expect(account(IDS.b1).golden_ticket_issued).toBe(false);
  });
});

describe("the adapter can be replaced without touching callers", () => {
  it("callers only use getLivenessAdapter and the interface, never the simulated vendor", () => {
    for (const f of ["src/lib/liveness.server.ts", "src/lib/liveness.functions.ts", "src/routes/buyer.onboarding.liveness.tsx", "src/lib/golden-ticket.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/SimulatedLivenessAdapter|liveness-adapters\/simulated"\s*;?\s*$|new Simulated/m);
    }
    expect(readFileSync("src/lib/liveness.server.ts", "utf8")).toContain("getLivenessAdapter(");
  });

  it("a different vendor drops in, and its answer is what is recorded", async () => {
    seed();
    const calls: Array<[string, string]> = [];
    const vendor: LivenessAdapter = {
      provider: "acme",
      async check(s, idRef) {
        calls.push([s.storagePath, idRef]);
        return { status: "failed", reason_code: "spoof_detected" };
      },
    };
    setLivenessAdapterForTesting(vendor);
    const r = await selfie(IDS.b1m1);
    expect(r).toMatchObject({ status: "failed", reason_code: "spoof_detected" });
    expect(calls).toEqual([[checks()[0]!.selfie_url, member(IDS.b1m1).id_document_url]]);
    expect(db().audits("buyer.liveness_checked")[0]!.metadata.provider).toBe("acme");
  });

  it("an unknown vendor name is an error, not a silent pass", () => {
    expect(() => getLivenessAdapter("nobody")).toThrow("No liveness adapter");
    expect(getLivenessAdapter().provider).toBe("simulated");
  });
});

describe("QA hooks", () => {
  it("magic file names", async () => {
    const sim = new SimulatedLivenessAdapter();
    const s = (fileName: string) => sim.check({ storagePath: "u/x.jpg", fileName, contentType: "image/jpeg" }, "u/id.jpg");
    expect((await s("me.jpg")).status).toBe("passed");
    expect((await s("LIVENESS-FAIL.JPG")).status).toBe("failed");
    expect((await s("liveness-inconclusive.png")).status).toBe("inconclusive");
    expect((await sim.check({ storagePath: "u/x.jpg", fileName: "me.jpg", contentType: null }, "")).status).toBe("inconclusive");
  });

  it("the admin test switch forces an outcome; a magic file name still wins; only admins can set it", async () => {
    seed();
    harness.userId = USERS.b1;
    await expect(setLivenessTestSwitchFn({ data: { forced: "failed" } })).rejects.toThrow("Not authorized");
    harness.userId = USERS.admin;
    await setLivenessTestSwitchFn({ data: { forced: "inconclusive" } });
    expect(await getLivenessTestSwitch()).toEqual({ forced: "inconclusive" });
    expect((await selfie(IDS.b1m1)).status).toBe("inconclusive");
    expect((await selfie(IDS.b1m2, "liveness-pass.jpg")).status).toBe("passed");
    harness.userId = USERS.admin;
    await setLivenessTestSwitchFn({ data: { forced: null } });
    expect(await getLivenessTestSwitch()).toEqual({ forced: null });
    expect(db().audits("admin.liveness_test_switch_set")).toHaveLength(2);
  });
});

describe("the ID photo upload is unchanged", () => {
  it("the identity page still uploads the licence the same way", () => {
    const identity = readFileSync("src/routes/buyer.onboarding.identity.tsx", "utf8");
    expect(identity).toContain('.from("identity-documents")');
    expect(identity).toContain("const path = `${user.id}/buyer-license-${Date.now()}.${ext}`;");
    expect(identity).toContain("simulateOcrExtraction");
  });
});
