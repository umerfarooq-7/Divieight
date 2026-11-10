/** The eligibility result engine: deterministic, per member, facts in, result out — no override. */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import {
  HELD_BUYER_TEXT,
  RESULT_LABELS,
  RESULT_TONES,
  dispositionDisqualifies,
  evaluateEligibility,
  moneyStatusFor,
  type Screening,
} from "@/lib/eligibility-engine";
import type { DeclarationAnswers } from "@/lib/eligibility-declaration";
import { submitEligibilityDeclaration } from "@/lib/eligibility-declaration.functions";
import {
  listHeldMembers,
  listPossibleSanctionsMatches,
  markDeclarationUntrueFn,
  recordChargeDisposition,
  resolveSanctionsIdentity,
} from "@/lib/eligibility-engine.functions";
import { evaluateGoldenTicket, issueGoldenTicketIfEligible } from "@/lib/golden-ticket";
import { getMyAccountMembers } from "@/lib/account-members.functions";
import { listMyTetheredBuyers } from "@/lib/agent-leads.functions";
import { setSanctionsAdapterForTesting } from "@/lib/sanctions-adapters";

const yes: DeclarationAnswers = { q1: "yes", q2: "yes", q3: "yes", q4: "yes", q5: "yes", q6: "yes" };
const clean: Screening = { identityComplete: true, liveness: "passed", sanctions: "clear", declarationFoundUntrue: false, disposition: null, appliedAt: "2026-11-01" };

afterEach(() => setSanctionsAdapterForTesting(null));

// ---------------------------------------------------------------------------
// The pure function
// ---------------------------------------------------------------------------

describe("evaluateEligibility (pure)", () => {
  it("same answers and facts always give the same result", () => {
    const cases: Array<[DeclarationAnswers, Screening]> = [
      [yes, clean],
      [{ ...yes, q3: "no" }, clean],
      [{ ...yes, q1: "no" }, clean],
      [yes, { ...clean, sanctions: "possible_match" }],
    ];
    for (const [a, s] of cases) {
      const first = evaluateEligibility(a, s);
      for (let i = 0; i < 20; i += 1) expect(evaluateEligibility({ ...a }, { ...s })).toEqual(first);
    }
  });

  it("all clean is eligible", () => {
    expect(evaluateEligibility(yes, clean)).toEqual({ result: "eligible", reason_codes: ["all_clear"] });
  });

  it("Q3 No is held — not refused, not unpaid", () => {
    const r = evaluateEligibility({ ...yes, q3: "no" }, clean);
    expect(r).toEqual({ result: "held", reason_codes: ["q3_pending_charge_disclosed"] });
    expect(RESULT_LABELS.held).toBe("Held");
    expect(RESULT_TONES.held).not.toMatch(/destructive|amber|red|warn/);
    expect(RESULT_TONES.held).not.toBe(RESULT_TONES.not_eligible);
    expect(RESULT_TONES.held).not.toBe(RESULT_TONES.pending);
    expect(HELD_BUYER_TEXT).toBe("Your application is held until the disclosed charge is resolved.");
  });

  it("Q1, Q2 or Q4 No, a confirmed match, an untrue declaration, or a failed liveness is not eligible", () => {
    expect(evaluateEligibility({ ...yes, q1: "no" }, clean)).toEqual({ result: "not_eligible", reason_codes: ["q1_no"] });
    expect(evaluateEligibility({ ...yes, q2: "no" }, clean).result).toBe("not_eligible");
    expect(evaluateEligibility({ ...yes, q4: "no" }, clean).result).toBe("not_eligible");
    expect(evaluateEligibility(yes, { ...clean, sanctions: "confirmed_match" })).toEqual({ result: "not_eligible", reason_codes: ["sanctions_confirmed_match"] });
    expect(evaluateEligibility(yes, { ...clean, declarationFoundUntrue: true })).toEqual({ result: "not_eligible", reason_codes: ["declaration_found_untrue"] });
    expect(evaluateEligibility(yes, { ...clean, liveness: "failed" }).reason_codes).toEqual(["liveness_failed"]);
    // A disqualifying answer outranks a held one.
    expect(evaluateEligibility({ ...yes, q1: "no", q3: "no" }, clean).result).toBe("not_eligible");
  });

  it("incomplete is not a result: no declaration, or no Q5 authorization", () => {
    expect(evaluateEligibility(null, clean)).toEqual({ result: null, reason_codes: ["declaration_missing"] });
    expect(evaluateEligibility({ ...yes, q5: "no" }, clean)).toEqual({ result: null, reason_codes: ["q5_authorization_not_given"] });
    // ...unless the declaration was found untrue (Part F applies in any respect).
    expect(evaluateEligibility({ ...yes, q5: "no" }, { ...clean, declarationFoundUntrue: true }).result).toBe("not_eligible");
    expect(evaluateEligibility({ ...yes, q5: "no" }, { ...clean, sanctions: "confirmed_match" })).toEqual({ result: "not_eligible", reason_codes: ["sanctions_confirmed_match"] });
  });

  it("eligible needs identity, liveness and sanctions all clear; until then there is no result", () => {
    expect(evaluateEligibility(yes, { ...clean, identityComplete: false }).result).toBeNull();
    expect(evaluateEligibility(yes, { ...clean, liveness: null }).reason_codes).toEqual(["liveness_pending"]);
    expect(evaluateEligibility(yes, { ...clean, liveness: "inconclusive" }).reason_codes).toEqual(["liveness_inconclusive"]);
    expect(evaluateEligibility(yes, { ...clean, sanctions: "possible_match" })).toEqual({ result: null, reason_codes: ["sanctions_possible_match"] });
    expect(evaluateEligibility(yes, { ...clean, sanctions: null }).reason_codes).toEqual(["sanctions_pending"]);
    expect(evaluateEligibility({ ...yes, q6: "no" }, clean).result).toBeNull();
  });

  it("a disposition is judged by Standard A, B and C", () => {
    const held = { ...yes, q3: "no" as const };
    const at = (d: Screening["disposition"]) => evaluateEligibility(held, { ...clean, disposition: d });
    expect(at({ outcome: "convicted", offenseKey: "A1", dispositionDate: "2026-12-01" }).result).toBe("not_eligible");
    expect(at({ outcome: "convicted", offenseKey: "B4", dispositionDate: "2026-12-01" }).result).toBe("not_eligible");
    expect(at({ outcome: "convicted", offenseKey: "none", dispositionDate: "2026-12-01" }).result).toBe("eligible");
    for (const outcome of ["dismissed", "withdrawn", "acquitted", "nolle_prosequi", "expunged_sealed_or_pardoned", "juvenile_adjudication"] as const)
      expect(at({ outcome, offenseKey: null, dispositionDate: "2026-12-01" }).result).toBe("eligible");
    // A conviction with no offense named can't be judged: still held.
    expect(at({ outcome: "convicted", offenseKey: null, dispositionDate: "2026-12-01" }).result).toBe("held");
    // Standard B's ten years run from the conviction, counted back from the application.
    expect(dispositionDisqualifies({ outcome: "convicted", offenseKey: "B1", dispositionDate: "2015-01-01" }, "2026-11-01").disqualifies).toBe(false);
    expect(dispositionDisqualifies({ outcome: "convicted", offenseKey: "B1", dispositionDate: "2017-01-01" }, "2026-11-01").disqualifies).toBe(true);
    expect(dispositionDisqualifies({ outcome: "convicted", offenseKey: "A3", dispositionDate: "1990-01-01" }, "2026-11-01").disqualifies).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Through the app
// ---------------------------------------------------------------------------

const db = () => harness.db;
const results = () => db().table("eligibility_results");
const member = (id: string) => db().table("account_members").find((m) => m.id === id)!;
const account = (id: string) => db().table("buyer_accounts").find((a) => a.id === id)!;

function seed() {
  seedPod(db());
  for (const m of db().table("account_members")) {
    Object.assign(m, { status: "active", date_of_birth: "1980-01-01", address: "1 Main St", id_document_url: `ids/${m.id}.jpg`, vetting_status: "in_progress" });
  }
  db().seed("member_liveness_checks", db().table("account_members").map((m) => ({ account_member_id: m.id, buyer_account_id: m.buyer_account_id, status: "passed", created_at: "2026-11-01T00:00:00Z" })));
}

function declare(memberId: string, answers: DeclarationAnswers = yes, extra: { supersedesId?: string | null; kind?: string } = {}) {
  harness.userId = USERS.b1;
  return submitEligibilityDeclaration({ data: { actingMemberId: memberId, answers, attestedPersonally: true, signedName: member(memberId).full_name, supersedesId: extra.supersedesId ?? null, kind: extra.kind } });
}
const admin = () => (harness.userId = USERS.admin);

describe("results are per member, appended, and recomputed", () => {
  it("each recompute inserts a row with the Standard version, the declaration and a snapshot of the facts", async () => {
    seed();
    const a = await declare(IDS.b1m1);
    const b = await declare(IDS.b1m2, { ...yes, q3: "no" });
    expect([a.result, b.result]).toEqual(["eligible", "held"]);
    expect(results()).toHaveLength(2);
    const r = results().find((x) => x.account_member_id === IDS.b1m1)!;
    expect(r).toMatchObject({ buyer_account_id: IDS.b1, standard_version: "1.1", result: "eligible", reason_codes: ["all_clear"], declaration_id: a.id });
    expect(r.screening_snapshot).toMatchObject({ identityComplete: true, liveness: "passed", sanctions: "clear", trigger: "declaration_made" });
    expect(member(IDS.b1m1).vetting_status).toBe("cleared");
    expect(member(IDS.b1m2).vetting_status).toBe("held");
  });

  it("incomplete writes no result row", async () => {
    seed();
    const r = await declare(IDS.b1m1, { ...yes, q5: "no" });
    expect(r.result).toBeNull();
    expect(results()).toEqual([]);
  });

  it("same answers give the same result, through the whole app", async () => {
    seed();
    const first = await declare(IDS.b1m1, { ...yes, q3: "no" });
    const second = await declare(IDS.b1m1, { ...yes, q3: "no" }, { supersedesId: first.id });
    expect(second.result).toBe(first.result);
    expect(second.reasonCodes).toEqual(first.reasonCodes);
  });

  it("a correction of fact is recomputed; the old result is kept but no longer current", async () => {
    seed();
    const first = await declare(IDS.b1m1, { ...yes, q1: "no" });
    expect(first.result).toBe("not_eligible");
    const fixed = await declare(IDS.b1m1, yes, { supersedesId: first.id });
    expect(fixed.result).toBe("eligible");
    expect(results().map((r) => r.result)).toEqual(["not_eligible", "eligible"]);
    harness.userId = USERS.b1;
    expect((await getMyAccountMembers()).members.find((m) => m.id === IDS.b1m1)!.eligibility).toBe("eligible");
  });

  it("a result on an earlier declaration is not current: a correction to incomplete leaves no result", async () => {
    seed();
    const first = await declare(IDS.b1m1);
    expect(first.result).toBe("eligible");
    await declare(IDS.b1m1, { ...yes, q5: "no" }, { supersedesId: first.id });
    harness.userId = USERS.b1;
    expect((await getMyAccountMembers()).members.find((m) => m.id === IDS.b1m1)!.eligibility).toBe("pending");
    expect(member(IDS.b1m1).vetting_status).toBe("in_progress");
    db().seed("signed_documents", [{ buyer_account_id: IDS.b1, document_type: "PRA", signed_name: "Alice One" }]);
    await declare(IDS.b1m2);
    expect((await issueGoldenTicketIfEligible({ authUserId: USERS.b1, buyerAccountId: IDS.b1 })).eligible).toBe(false);
  });

  it("a correction that has no result yet doesn't keep the old one", async () => {
    seed();
    const first = await declare(IDS.b1m1);
    expect(first.result).toBe("eligible");
    db().seed("member_liveness_checks", [{ account_member_id: IDS.b1m1, buyer_account_id: IDS.b1, status: "inconclusive", created_at: "2026-11-09T00:00:00Z" }]);
    const again = await declare(IDS.b1m1, yes, { supersedesId: first.id });
    expect(again.result).toBeNull();
    harness.userId = USERS.b1;
    expect((await getMyAccountMembers()).members.find((m) => m.id === IDS.b1m1)!.eligibility).not.toBe("eligible");
  });

  it("Report a change (Q6) opens a new version and recomputes", async () => {
    seed();
    const first = await declare(IDS.b1m1);
    const changed = await declare(IDS.b1m1, { ...yes, q3: "no" }, { supersedesId: first.id, kind: "change_report" });
    expect(changed.result).toBe("held");
    const audit = db().audits("buyer.eligibility_declaration_made").at(-1)!;
    expect(audit.metadata).toMatchObject({ kind: "change_report", eligibility_result: "held" });
    expect(db().audits("eligibility.recomputed").at(-1)!.metadata.trigger).toBe("change_reported");
  });
});

describe("held", () => {
  it("a held member stops the whole account getting a Golden Ticket; the account is pending, the member held", async () => {
    const base = { goldenTicketIssued: false, liquidityVerified: true, liquidityStatus: "verified", praSigned: true, memberStatuses: ["cleared", "held"], livenessStatuses: ["passed", "passed"] };
    expect(evaluateGoldenTicket({ ...base, eligibilityResults: ["eligible", "held"] }).missing).toEqual(["An Account Member's application is held until the disclosed charge is resolved"]);
    expect(evaluateGoldenTicket({ ...base, eligibilityResults: ["eligible", "eligible"] }).eligible).toBe(true);
    expect(evaluateGoldenTicket({ ...base, eligibilityResults: ["eligible", null] }).eligible).toBe(false);

    seed();
    db().seed("signed_documents", [{ buyer_account_id: IDS.b1, document_type: "PRA", signed_name: "Alice One" }]);
    Object.assign(account(IDS.b1), { liquidity_verified: true, golden_ticket_issued: false });
    await declare(IDS.b1m1);
    await declare(IDS.b1m2, { ...yes, q3: "no" });
    const gt = await issueGoldenTicketIfEligible({ authUserId: USERS.b1, buyerAccountId: IDS.b1 });
    expect(gt.eligible).toBe(false);
    expect(account(IDS.b1).golden_ticket_issued).toBe(false);
    harness.userId = USERS.b1;
    const view = await getMyAccountMembers();
    expect(view.members.map((m) => [m.id, m.eligibility])).toEqual([
      [IDS.b1m1, "eligible"],
      [IDS.b1m2, "held"],
    ]);
  });

  it("the admin records only the fact of the disposition; the engine decides", async () => {
    seed();
    await declare(IDS.b1m2, { ...yes, q3: "no" });
    admin();
    expect((await listHeldMembers()).map((h) => h.memberId)).toEqual([IDS.b1m2]);
    const r = await recordChargeDisposition({ data: { memberId: IDS.b1m2, outcome: "dismissed", offenseKey: null, dispositionDate: "2026-11-05" } });
    expect(r.result).toBe("eligible");
    expect(db().table("charge_dispositions")[0]).toMatchObject({ outcome: "dismissed", offense_key: null, recorded_by: USERS.admin });
    expect(await listHeldMembers()).toEqual([]);
  });

  it("a disqualifying conviction is not eligible; the admin never picks the result", async () => {
    seed();
    await declare(IDS.b1m2, { ...yes, q3: "no" });
    admin();
    await expect(recordChargeDisposition({ data: { memberId: IDS.b1m2, outcome: "convicted", offenseKey: null, dispositionDate: "2026-11-05" } })).rejects.toThrow("choose the offense");
    const r = await recordChargeDisposition({ data: { memberId: IDS.b1m2, outcome: "convicted", offenseKey: "B1", dispositionDate: "2026-11-05" } });
    expect(r).toMatchObject({ result: "not_eligible", reason_codes: ["conviction_standard_b_B1"] });
    await expect(recordChargeDisposition({ data: { memberId: IDS.b1m2, outcome: "acquitted", offenseKey: null, dispositionDate: "2999-01-01" } })).rejects.toThrow("future");
  });

  it("only for a member who disclosed a pending charge, and only by an admin", async () => {
    seed();
    await declare(IDS.b1m1);
    harness.userId = USERS.b1;
    await expect(recordChargeDisposition({ data: { memberId: IDS.b1m1, outcome: "dismissed", offenseKey: null, dispositionDate: "2026-11-05" } })).rejects.toThrow("Not authorized");
    admin();
    await expect(recordChargeDisposition({ data: { memberId: IDS.b1m1, outcome: "dismissed", offenseKey: null, dispositionDate: "2026-11-05" } })).rejects.toThrow("hasn't disclosed");
  });
});

describe("no admin override", () => {
  it("there is no override route or function, and only the engine writes results", () => {
    const routes = readdirSync("src/routes");
    expect(routes.filter((f) => /override|set-result|setresult/i.test(f))).toEqual([]);
    const fns = readFileSync("src/lib/eligibility-engine.functions.ts", "utf8");
    expect(fns).not.toMatch(/override|setResult|set_result|forceResult/i);
    const heldPage = readFileSync("src/routes/admin.eligibility.held.tsx", "utf8");
    expect(heldPage).not.toMatch(/override|Mark eligible|Approve|Reject|Set result/i);
    // Every write to eligibility_results in the code base is the engine's own recompute.
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && /from\("eligibility_results"\)\s*\.(insert|update|upsert|delete)/.test(readFileSync(p, "utf8"))) writers.push(p);
      }
    };
    walk("src");
    expect(writers).toEqual(["src/lib/eligibility-engine.server.ts"]);
  });
});

describe("admin and money views never show refused or unpaid for a held account", () => {
  it("the money status helper", () => {
    for (const s of ["unpaid", "pending", "failed", "refused", "canceled"]) expect(moneyStatusFor(s, true)).toEqual({ label: "held", held: true });
    expect(moneyStatusFor("paid", true)).toEqual({ label: "paid", held: true });
    expect(moneyStatusFor("unpaid", false)).toEqual({ label: "unpaid", held: false });
  });

  it("the admin and money pages use it, and never say refused", () => {
    for (const f of ["src/routes/admin.buyers.tsx", "src/routes/admin.payments.tsx", "src/routes/admin.eligibility.held.tsx", "src/routes/admin.eligibility.sanctions.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/refused|Refused/);
    }
    expect(readFileSync("src/routes/admin.payments.tsx", "utf8")).toContain('moneyStatusFor(r.status, r.side === "Buyer" && heldLogins.has(r.who))');
    expect(readFileSync("src/routes/admin.buyers.tsx", "utf8")).toMatch(/key: "held", label: "Held"/);
  });

  it("the agent's lead view shows a held account's unpaid fee as pending, not unpaid (and doesn't reveal held)", async () => {
    seed();
    await declare(IDS.b1m2, { ...yes, q3: "no" });
    harness.userId = USERS.ra;
    const leads = await listMyTetheredBuyers();
    const b1 = leads.find((l) => l.buyerAccountId === IDS.b1)!;
    const b2 = leads.find((l) => l.buyerAccountId === IDS.b2)!;
    expect(b1.pefStatus).toBe("pending");
    expect(b2.pefStatus).toBe("unpaid");
    expect(JSON.stringify(b1)).not.toMatch(/held/i);
  });
});

describe("sanctions", () => {
  it("a possible match keeps the account pending and issues a Verification Request; the identity answer decides", async () => {
    seed();
    member(IDS.b1m1).full_name = "Sanctions Test Person";
    const r = await declare(IDS.b1m1);
    expect(r.result).toBeNull();
    expect(r.reasonCodes).toEqual(["sanctions_possible_match"]);
    expect(account(IDS.b1).onboarding_status).toBe("verification_pending");
    expect(db().audits("buyer.verification_requested")[0]!.metadata).toMatchObject({ reason: "sanctions_possible_match", question: "Are you the person the list names?" });
    admin();
    const [m] = await listPossibleSanctionsMatches();
    const done = await resolveSanctionsIdentity({ data: { memberId: IDS.b1m1, screeningId: m!.screeningId, samePerson: true } });
    expect(done.result).toBe("not_eligible");
    expect(await listPossibleSanctionsMatches()).toEqual([]);
    await expect(resolveSanctionsIdentity({ data: { memberId: IDS.b1m1, screeningId: m!.screeningId, samePerson: false } })).rejects.toThrow("already resolved");
  });

  it("not the person the list names: clear, and eligible", async () => {
    seed();
    member(IDS.b1m1).full_name = "Sanctions Test Person";
    await declare(IDS.b1m1);
    admin();
    const [m] = await listPossibleSanctionsMatches();
    expect((await resolveSanctionsIdentity({ data: { memberId: IDS.b1m1, screeningId: m!.screeningId, samePerson: false } })).result).toBe("eligible");
  });

  it("each member is screened once, by the vendor behind the adapter", async () => {
    seed();
    let calls = 0;
    setSanctionsAdapterForTesting({ provider: "acme", screen: async () => (calls++, { status: "clear", listName: null, matchedName: null }) });
    const first = await declare(IDS.b1m1);
    await declare(IDS.b1m1, yes, { supersedesId: first.id });
    expect(calls).toBe(1);
    expect(db().table("member_sanctions_screenings")[0]).toMatchObject({ provider: "acme", status: "clear" });
  });
});

describe("Mark declaration untrue (Part F)", () => {
  it("sets the member to not eligible, audits it, deletes nothing", async () => {
    seed();
    await declare(IDS.b1m1);
    const before = db().table("eligibility_declarations").length;
    admin();
    const r = await markDeclarationUntrueFn({ data: { memberId: IDS.b1m1, finding: "Conviction found in county records" } });
    expect(r).toMatchObject({ result: "not_eligible", reason_codes: ["declaration_found_untrue"], legalReviewFlagged: false });
    expect(db().table("eligibility_declarations")).toHaveLength(before);
    expect(results().map((x) => x.result)).toEqual(["eligible", "not_eligible"]);
    expect(db().audits("eligibility.declaration_marked_untrue")[0]!.metadata).toMatchObject({ account_member_id: IDS.b1m1, after_closing: false });
    expect(account(IDS.b1).legal_review_flagged_at ?? null).toBeNull();
    await expect(markDeclarationUntrueFn({ data: { memberId: IDS.b1m1, finding: "  " } })).rejects.toThrow("Describe");
  });

  it("after closing, the account is flagged for legal review", async () => {
    seed();
    await declare(IDS.b1m1);
    db().table("properties")[0]!.deed_recorded_at = "2026-10-01T00:00:00Z";
    if (!db().table("pod_reservations").some((r) => r.buyer_account_id === IDS.b1)) db().seed("pod_reservations", [{ buyer_account_id: IDS.b1, property_id: IDS.property, status: "reserved" }]);
    admin();
    const r = await markDeclarationUntrueFn({ data: { memberId: IDS.b1m1, finding: "Untrue answer to Q2" } });
    expect(r.legalReviewFlagged).toBe(true);
    expect(account(IDS.b1)).toMatchObject({ legal_review_reason: "declaration_found_untrue_after_closing" });
    expect(account(IDS.b1).legal_review_flagged_at).toBeTruthy();
  });

  it("only admins", async () => {
    seed();
    await declare(IDS.b1m1);
    harness.userId = USERS.b1;
    await expect(markDeclarationUntrueFn({ data: { memberId: IDS.b1m1, finding: "x" } })).rejects.toThrow("Not authorized");
  });
});
