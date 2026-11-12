/** "Background Check" becomes "The Eligibility Check": wording, Hold Harmless, adverse action, vetting display, Hybrid Exit sellers. */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { holdHarmlessRecital, partThreeCoOwnerNotice } from "@/constants/eligibilityCopy";
import { eligibilityCheckScreen, fullExitSellerNotice, hybridSellerEligibilityCheck, hybridSellerNotice, verificationRequestCopy } from "@/constants/eligibilityCheckCopy";
import { HOLD_HARMLESS_VERSION, holdHarmlessDocumentText } from "@/lib/hold-harmless";
import { ADVERSE_ACTION_TITLE, adverseActionNoticeText } from "@/lib/adverse-action";
import { accountVettingDisplay, vettingDisplay, RESULT_TONES } from "@/lib/eligibility-engine";
import { getMyAdverseActionNotices, issueAdverseActionNoticeFn } from "@/lib/adverse-action.functions";
import { getSellerEligibility, submitSellerEligibility } from "@/lib/seller-eligibility.functions";

const db = () => harness.db;
const as = (u: string) => (harness.userId = u);

const sourceFiles = (dir = "src"): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(`${dir}/${e.name}`) : /\.(ts|tsx)$/.test(e.name) ? [`${dir}/${e.name}`] : []));

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe("no old wording is left in the app", () => {
  // Code identifiers for legacy database columns and the audit history are not user-facing wording.
  const IDENTIFIERS = /background_check_result|background_check_at|fcra_consent_at|background_check_completed|fcra_adverse_action_issued/g;
  const files = sourceFiles().filter((f) => !f.endsWith("integrations/supabase/types.ts"));
  const text = (f: string) => readFileSync(f, "utf8").replace(IDENTIFIERS, "");

  it("'background check' appears nowhere, in any spelling", () => {
    const hits = files.filter((f) => /background[\s_-]?check/i.test(text(f)));
    expect(hits).toEqual([]);
  });

  it("'FCRA' and 'copy of the report' appear nowhere", () => {
    expect(files.filter((f) => /\bFCRA\b/.test(text(f)))).toEqual([]);
    expect(files.filter((f) => /copy of the report|download report|Download report/i.test(text(f)))).toEqual([]);
  }, 30000);

  it("'vets all members' appears nowhere in the app's text (the locked client file only quotes it in a comment)", () => {
    const hits = files.filter((f) => /vets all members/i.test(text(f)) && !f.endsWith("src/constants/eligibilityCopy.ts"));
    expect(hits).toEqual([]);
  });

  it("'criminal' only appears where the client's wording or the new Eligibility Check says it", () => {
    const allowed = ["src/constants/eligibilityCopy.ts", "src/constants/eligibilityCheckCopy.ts", "src/routes/buyer.adverse-action.tsx", "src/lib/eligibility-engine.ts"];
    const hits = files.filter((f) => /criminal/i.test(text(f)) && !allowed.includes(f.replace(/\\/g, "/")));
    expect(hits).toEqual([]);
    // ...and in the adverse-action page it only says that no criminal history search is conducted.
    for (const m of readFileSync("src/routes/buyer.adverse-action.tsx", "utf8").match(/[^.]*criminal[^.]*\./gi) ?? []) expect(m).toMatch(/did not conduct a criminal history search/);
  });

  it("the Golden Ticket and Vetted Buyer names are kept", () => {
    expect(readFileSync("src/routes/buyer.dashboard.tsx", "utf8")).toContain("Golden Ticket · Vetted Buyer");
    expect(readFileSync("src/lib/notify.ts", "utf8")).toContain("Vetted Buyer");
    expect(readFileSync("src/routes/buyer.golden-ticket.tsx", "utf8")).toContain("Vetted Buyer");
    expect(readFileSync("src/routes/index.tsx", "utf8")).toContain("Vetted Buyers");
  });

  it("the Hold Harmless is no longer labelled with a background check consent", () => {
    expect(readFileSync("src/routes/buyer.documents.tsx", "utf8")).toContain('HOLD_HARMLESS: "Hold Harmless",');
  });
});

// ---------------------------------------------------------------------------
// 1. Screen 4
// ---------------------------------------------------------------------------

describe("The Eligibility Check", () => {
  it("is the client's text, word for word", () => {
    expect(eligibilityCheckScreen.heading).toBe("The Eligibility Check");
    expect(eligibilityCheckScreen.body).toBe(
      "The platform confirms identity and liveness for each Account Member individually, screens each Account Member against United States government sanctions, politically-exposed-person and law-enforcement watchlists, and records each Account Member's declaration made under penalty of perjury that they meet the Participant Eligibility Standard. The platform does not obtain a consumer report and does not conduct a criminal history search. The platform returns one of three results: eligible, held, or not eligible. No person at divieight exercises discretion, and identical declarations always receive the same result.",
    );
  });

  it("is what the screen shows, replacing 'The Background Check'", () => {
    const page = readFileSync("src/routes/buyer.onboarding.vetting.tsx", "utf8");
    expect(page).toContain("{eligibilityCheckScreen.heading}");
    expect(page).toContain("{eligibilityCheckScreen.body}");
    expect(page).toContain('{ title: "The Eligibility Check — divieight" }');
    expect(page).not.toMatch(/Vetting & Security Clearance|Member vetting/);
  });

  it("a possible sanctions match asks whether the member is the person the list names: identity, not merit", () => {
    expect(verificationRequestCopy.sanctionsBody).toContain("whether you are the person that list names");
    expect(verificationRequestCopy.sanctionsBody).toContain("a question of identity, not merit");
    const page = readFileSync("src/routes/buyer.verification.tsx", "utf8");
    expect(page).toContain("member_sanctions_screenings");
    expect(page).toContain("verificationRequestCopy.sanctionsBody");
    expect(readFileSync("src/routes/buyer.dashboard.tsx", "utf8")).toContain("verificationRequestCopy.dashboardBody");
    expect(Object.values(verificationRequestCopy).join(" ")).not.toMatch(/background|court|consumer report/i);
  });
});

// ---------------------------------------------------------------------------
// 4 and 5. The Hold Harmless and the Part Three paragraph
// ---------------------------------------------------------------------------

describe("the Hold Harmless", () => {
  it("is the client's recital, then the Part Three paragraph, verbatim", () => {
    expect(holdHarmlessDocumentText).toBe(`${holdHarmlessRecital}\n\n${partThreeCoOwnerNotice}`);
    expect(holdHarmlessDocumentText.split(partThreeCoOwnerNotice)).toHaveLength(2);
    expect(holdHarmlessDocumentText.split(holdHarmlessRecital)).toHaveLength(2);
    expect(holdHarmlessDocumentText).not.toMatch(/vets all members|while the platform vets/i);
    expect(holdHarmlessDocumentText).toContain("Each Account Member signs the Hold Harmless individually.");
  });

  it("is a new version; the old sentence is gone from the screen", () => {
    expect(HOLD_HARMLESS_VERSION).toBe("hh-v2");
    const page = readFileSync("src/routes/buyer.onboarding.vetting.tsx", "utf8");
    expect(page).toContain("{holdHarmlessDocumentText}");
    expect(page).toContain("`${HOLD_HARMLESS_VERSION}::${holdHarmlessDocumentText}`");
    expect(page).not.toContain("I acknowledge that while the platform");
  });

  it("every buyer-signed document that carries the Hold Harmless carries the Part Three paragraph", () => {
    // The Hold Harmless is the only document built from the recital; it is built only from the shared text.
    const carriers = sourceFiles().filter((f) => /holdHarmlessRecital/.test(readFileSync(f, "utf8")) && !f.endsWith("eligibilityCopy.ts"));
    expect(carriers.map((f) => f.replace(/\\/g, "/"))).toEqual(["src/lib/hold-harmless.ts"]);
    expect(readFileSync("src/lib/hold-harmless.ts", "utf8")).toContain("partThreeCoOwnerNotice");
    // The PRA and Block 5 do not carry the Hold Harmless.
    expect(readFileSync("src/routes/buyer.onboarding.payment.tsx", "utf8")).not.toMatch(/hold harmless/i);
    expect(readFileSync("src/components/Block5AdviceNotice.tsx", "utf8")).not.toMatch(/hold harmless/i);
  });

  it("each member signs it individually, with the typed name checked on the server (as before)", () => {
    expect(readFileSync("src/routes/buyer.onboarding.vetting.tsx", "utf8")).toContain('documentType: "HOLD_HARMLESS"');
    expect(readFileSync("src/lib/member-steps.server.ts", "utf8")).toContain("legalNamesMatch(typed, member.full_name");
  });
});

// ---------------------------------------------------------------------------
// 7. The vetting display
// ---------------------------------------------------------------------------

describe("the vetting display is fed from eligibility results", () => {
  it("one member: Vetted / Pending / Failed, and Held on its own", () => {
    expect(vettingDisplay("eligible")).toMatchObject({ key: "vetted", label: "Vetted" });
    expect(vettingDisplay("not_eligible")).toMatchObject({ key: "failed", label: "Failed" });
    expect(vettingDisplay("held")).toMatchObject({ key: "held", label: "Held" });
    expect(vettingDisplay(null)).toMatchObject({ key: "pending", label: "Pending" });
    expect(new Set(["eligible", "not_eligible", "held", null].map((r) => vettingDisplay(r as never).tone)).size).toBe(4);
  });

  it("the account: held if any member is held, never merged into Pending or Failed", () => {
    expect(accountVettingDisplay(["eligible", "held"]).key).toBe("held");
    expect(accountVettingDisplay([null, "held"]).key).toBe("held");
    expect(accountVettingDisplay(["not_eligible", "held"]).key).toBe("held");
    expect(accountVettingDisplay(["eligible", "not_eligible"]).key).toBe("failed");
    expect(accountVettingDisplay(["eligible", null]).key).toBe("pending");
    expect(accountVettingDisplay(["eligible", "eligible"]).key).toBe("vetted");
    expect(accountVettingDisplay([]).key).toBe("pending");
    expect(accountVettingDisplay(["held"]).tone).toBe(RESULT_TONES.held);
    expect(accountVettingDisplay(["held"]).tone).not.toBe(accountVettingDisplay([null]).tone);
    expect(accountVettingDisplay(["held"]).tone).not.toBe(accountVettingDisplay(["not_eligible"]).tone);
  });

  it("the dashboard shows it from loadMemberSteps (the results), and the old status-string helpers are gone", () => {
    const page = readFileSync("src/routes/buyer.dashboard.tsx", "utf8");
    expect(page).toContain("accountVettingDisplay((await loadMemberSteps(supabase, acct.id)).map((s) => s.result))");
    expect(page).not.toMatch(/function vettingLabel|function vettingTone|"Cleared"/);
  });
});

// ---------------------------------------------------------------------------
// 3. Adverse action
// ---------------------------------------------------------------------------

describe("adverse-action notice", () => {
  const agency = { name: "Acme Screening Inc.", address: "1 Report Way, Dover, DE 19901", phone: "800-555-0100", website: "acme.example" };
  const text = adverseActionNoticeText({ memberName: "Alice One", actionStatement: "Your application to take part was declined.", agency, issuedAt: "2026-11-11T00:00:00Z" });

  it("the template states the action, the agency's name and contact details, and the member's rights", () => {
    expect(text).toContain(ADVERSE_ACTION_TITLE);
    expect(text).toContain("The action taken: Your application to take part was declined.");
    for (const part of [agency.name, agency.address, agency.phone, agency.website]) expect(text).toContain(part);
    expect(text).toContain("free copy of your consumer report from that agency");
    expect(text).toContain("dispute directly with that agency");
    expect(text).toContain("cannot tell you why it was made");
  });

  it("the report itself is NOT supplied, and nothing promises a copy of it", () => {
    expect(text).toContain("divieight does not supply the report itself");
    expect(text).toContain("does not obtain a consumer report in the ordinary course");
    expect(text).not.toMatch(/copy of the report|download|attached/i);
    expect(readFileSync("src/routes/buyer.adverse-action.tsx", "utf8")).not.toMatch(/downloadPlaceholderReport|Download report|CONSUMER REPORT/);
  });

  function seed(q5 = "yes") {
    seedPod(db());
    db().seed("eligibility_declarations", [{ id: "d1", account_member_id: IDS.b1m1, buyer_account_id: IDS.b1, status: "complete", answers: { q1: "yes", q2: "yes", q3: "yes", q4: "yes", q5, q6: "yes" }, declared_at: "2026-11-01T00:00:00Z" }]);
    db().table("account_members").find((m) => m.id === IDS.b1m1)!.email = "alice@test.local";
  }
  const issue = (o: Record<string, unknown> = {}) => (as(USERS.admin), issueAdverseActionNoticeFn({ data: { memberId: IDS.b1m1, actionStatement: "Your application to take part was declined.", agencyName: agency.name, agencyAddress: agency.address, agencyPhone: agency.phone, reportObtainedAttested: true, ...o } as never }));

  it("an admin issues it: recorded, hashed and audited, with the report not supplied", async () => {
    seed();
    const r = await issue();
    const row = db().table("adverse_action_notices")[0]!;
    expect(row).toMatchObject({ id: r.id, account_member_id: IDS.b1m1, buyer_account_id: IDS.b1, declaration_id: "d1", agency_name: agency.name, report_obtained_attested: true, issued_by: USERS.admin });
    expect(row.document_hash).toMatch(/^sha256_[0-9a-f]{64}$/);
    expect(row.rendered_text).toContain(agency.phone);
    expect(db().audits("adverse_action.notice_issued")[0]!.metadata).toMatchObject({ report_supplied: false, agency_name: agency.name });
    expect(db().table("account_members").find((m) => m.id === IDS.b1m1)!.adverse_action_issued_at).toBeTruthy();
  });

  it("only an admin, only with the attestation, only for a member who gave the Q5 authorization, and only with the agency's details", async () => {
    seed();
    as(USERS.b1);
    await expect(issueAdverseActionNoticeFn({ data: { memberId: IDS.b1m1, actionStatement: "x", agencyName: "a", agencyAddress: "b", agencyPhone: "c", reportObtainedAttested: true } })).rejects.toThrow("Not authorized");
    await expect(issue({ reportObtainedAttested: false })).rejects.toThrow("Confirm that a consumer report was obtained");
    await expect(issue({ actionStatement: "  " })).rejects.toThrow("State the action");
    await expect(issue({ agencyName: "" })).rejects.toThrow("agency's name, address and phone");
    await expect(issue({ agencyPhone: " " })).rejects.toThrow("agency's name, address and phone");
    expect(db().table("adverse_action_notices")).toEqual([]);
  });

  it("a member who never gave the Question 5 authorization can't have been the subject of a report", async () => {
    seed("no");
    await expect(issue()).rejects.toThrow("hasn't given the Question 5 authorization");
    expect(db().table("adverse_action_notices")).toEqual([]);
  });

  it("a member sees only their own notices; the other member sees none", async () => {
    seed();
    await issue();
    as(USERS.b1);
    expect(await getMyAdverseActionNotices({ data: { actingMemberId: IDS.b1m1 } })).toHaveLength(1);
    expect(await getMyAdverseActionNotices({ data: { actingMemberId: IDS.b1m2 } })).toEqual([]);
    await expect(getMyAdverseActionNotices({ data: { actingMemberId: IDS.b2m1 } })).rejects.toThrow("isn't on your account");
    // The page asks for the acting member's own notices, and shows nothing of another member's.
    const page = readFileSync("src/routes/buyer.adverse-action.tsx", "utf8");
    expect(page).toContain("const mine = await loadNotices({ data: { actingMemberId } })");
    expect(page).toContain("setNotices(mine as Notice[])");
  });

  it("there is no trigger: nothing but the admin function issues a notice", () => {
    const issuers = sourceFiles().filter((f) => /issueAdverseActionNotice\(/.test(readFileSync(f, "utf8")) && !f.endsWith("adverse-action.server.ts") && !f.endsWith("adverse-action.functions.ts"));
    expect(issuers).toEqual([]);
    // The table is named in exactly one place that writes it (types.ts only describes it).
    const users = sourceFiles().filter((f) => /adverse_action_notices/.test(readFileSync(f, "utf8")) && !f.endsWith("types.ts"));
    expect(users.map((f) => f.replace(/\\/g, "/"))).toEqual(["src/lib/adverse-action.server.ts"]);
    expect(readFileSync("src/lib/adverse-action.server.ts", "utf8")).toMatch(/\.from\(TABLE\)\s*\.insert\(/);
  });
});

// ---------------------------------------------------------------------------
// 8. Hybrid Exit sellers
// ---------------------------------------------------------------------------

describe("Hybrid Exit sellers go through Block 4; Full Exit sellers have no eligibility check", () => {
  const yes = { q1: "yes", q2: "yes", q3: "yes", q4: "yes", q5: "yes", q6: "yes" };
  function seedSellers() {
    db().seed("sellers", [
      { id: "seller-h", email: "h@test.local", full_name: "Hank Hybrid", address: "1 Main", date_of_birth: "1970-01-01", exit_type: "hybrid_exit", retained_shares: 3 },
      { id: "seller-f", email: "f@test.local", full_name: "Fran Full", address: "2 Main", date_of_birth: "1971-01-01", exit_type: "full_exit", retained_shares: null },
    ]);
  }
  const submit = (user: string, answers = yes, o: Partial<{ signedName: string; supersedesId: string | null; attestedPersonally: boolean }> = {}) => (as(user), submitSellerEligibility({ data: { answers, attestedPersonally: o.attestedPersonally ?? true, signedName: o.signedName ?? (user === "seller-h" ? "Hank Hybrid" : "Fran Full"), supersedesId: o.supersedesId ?? null } }));

  it("the wording replaces the old 'background check' text: eligibility check (identity, liveness, sanctions screening, and the eligibility declaration at Block 4)", () => {
    expect(hybridSellerEligibilityCheck).toBe("eligibility check (identity, liveness, sanctions screening, and the eligibility declaration at Block 4)");
    expect(hybridSellerNotice).toContain(hybridSellerEligibilityCheck);
    expect(fullExitSellerNotice).toBe("Full Exit sellers have no eligibility check.");
    const intent = readFileSync("src/routes/onboarding.index.tsx", "utf8");
    expect(intent).toContain("{hybridSellerNotice}");
    expect(intent).toContain("{fullExitSellerNotice}");
  });

  it("a Hybrid Exit seller is sent to Block 4 after identity; a Full Exit seller goes straight on", () => {
    const identity = readFileSync("src/routes/onboarding.identity.tsx", "utf8");
    expect(identity).toContain('exit?.exit_type === "hybrid_exit" ? "/onboarding/eligibility" : "/onboarding/property"');
  });

  it("a Hybrid Exit seller makes the same declaration: same text and hash, a typed name matched to their own, versioned", async () => {
    seedSellers();
    as("seller-h");
    expect(await getSellerEligibility()).toMatchObject({ required: true, current: null, verifiedName: "Hank Hybrid" });
    await expect(submit("seller-h", yes, { signedName: "Fran Full" })).rejects.toThrow("doesn't match the name on your verified ID");
    await expect(submit("seller-h", yes, { attestedPersonally: false })).rejects.toThrow("personally making this declaration");
    expect(db().table("seller_eligibility_declarations")).toEqual([]);

    const first = await submit("seller-h");
    const row = db().table("seller_eligibility_declarations")[0]!;
    expect(row).toMatchObject({ seller_id: "seller-h", standard_version: "1.1", status: "complete", signed_name: "Hank Hybrid", attested_personally: true, ip: harness.ip });
    expect(row.declaration_hash).toMatch(/^sha256_[0-9a-f]{64}$/);
    expect(row.rendered_text_snapshot).toContain("Participant Eligibility Standard version 1.1");
    const memberText = (await import("@/lib/eligibility-declaration")).declarationText(yes, "1.1");
    expect(row.rendered_text_snapshot).toBe(memberText);
    // A correction is a new version; the old one stays.
    const second = await submit("seller-h", { ...yes, q3: "no" }, { supersedesId: first.id });
    expect(db().table("seller_eligibility_declarations").map((r) => r.status)).toEqual(["superseded", "complete"]);
    expect(second.result).toBe("held");
    await expect(submit("seller-h", yes, { supersedesId: first.id })).rejects.toThrow("already corrected");
  });

  it("the engine's rules apply to the seller's answers; nothing is called eligible before the seller's screening exists", async () => {
    seedSellers();
    expect((await submit("seller-h")).result).toBeNull();
    const q1 = db().table("seller_eligibility_declarations")[0]!;
    expect((await submit("seller-h", { ...yes, q1: "no" }, { supersedesId: q1.id })).result).toBe("not_eligible");
    const q5 = db().table("seller_eligibility_declarations").find((r) => r.status === "complete")!;
    const incomplete = await submit("seller-h", { ...yes, q5: "no" }, { supersedesId: q5.id });
    expect(incomplete).toMatchObject({ status: "incomplete", result: null });
  });

  it("a Full Exit seller has no eligibility check, and can't make the declaration", async () => {
    seedSellers();
    as("seller-f");
    expect(await getSellerEligibility()).toMatchObject({ required: false, current: null, message: "Full Exit sellers have no eligibility check." });
    await expect(submit("seller-f")).rejects.toThrow("Full Exit sellers have no eligibility check.");
    expect(db().table("seller_eligibility_declarations")).toEqual([]);
  });

  it("the database refuses it too", () => {
    expect(readFileSync("eligibility-wording.sql", "utf8")).toContain("s.exit_type = 'hybrid_exit'");
  });
});
