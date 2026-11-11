/** The Participant Eligibility Standard as a versioned document: one live version, no re-measuring of existing participants. */
import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { decisionPageCopy, STANDARD_VERSION } from "@/constants/eligibilityCopy";
import { EligibilityStandardContent } from "@/components/EligibilityStandard";
import { getLiveStandard } from "@/lib/standard-version.server";
import { getLiveStandardFn, listStandardVersionsFn, publishStandardVersionFn } from "@/lib/standard-version.functions";
import { PUBLISH_WARNING, STANDARD_ON_REQUEST, compareStandardVersions, eyebrowFor, standardDocumentName } from "@/lib/standard-version";
import { submitEligibilityDeclaration } from "@/lib/eligibility-declaration.functions";
import { getKyoForAdmin } from "@/lib/kyo.functions";
import { loadMemberSteps } from "@/lib/account-rollup";
import { recomputeEligibility } from "@/lib/eligibility-engine.server";
import { acknowledgeEligibilityStandard } from "@/lib/eligibility-standard.functions";
import { declarationText } from "@/lib/eligibility-declaration";
import { submitSellerEligibility } from "@/lib/seller-eligibility.functions";

const db = () => harness.db;
const as = (u: string) => (harness.userId = u);
const ALICE = IDS.b1m1;
const BOB = IDS.b1m2;
const yes = { q1: "yes", q2: "yes", q3: "yes", q4: "yes", q5: "yes", q6: "yes" };

const live = () => db().table("standard_versions").filter((v) => v.is_live);

beforeEach(() => {
  seedPod(db());
  for (const m of db().table("account_members")) Object.assign(m, { status: "active", role: m.role === "secondary" ? "member" : m.role, date_of_birth: "1980-01-01", address: "1 Main St", id_document_url: `ids/${m.id}.jpg` });
  db().seed("member_liveness_checks", db().table("account_members").map((m) => ({ account_member_id: m.id, buyer_account_id: m.buyer_account_id, status: "passed", created_at: "2026-11-01T00:00:00Z" })));
  db().seed("standard_versions", [{ version: "1.1", effective_from: "2026-11-04T00:00:00Z", is_live: true, file_url: "standards/Participant_Eligibility_Standard_v1.1.pdf" }]);
  // The database function publish_standard_version, as it behaves there (the SQL itself is run against Postgres separately).
  db().rpcResults.publish_standard_version = (a: { _version: string; _file_url: string; _published_by: string }) => {
    const at = "2026-11-12T09:00:00Z";
    for (const v of db().table("standard_versions")) v.is_live = false;
    db().seed("standard_versions", [{ version: a._version, effective_from: at, is_live: true, file_url: a._file_url, published_by: a._published_by }]);
    return at;
  };
});

const declare = (memberId: string, answers = yes, supersedesId: string | null = null) => {
  as(USERS.b1);
  return submitEligibilityDeclaration({ data: { actingMemberId: memberId, answers, attestedPersonally: true, signedName: db().table("account_members").find((m) => m.id === memberId)!.full_name as string, supersedesId } });
};
const publish = (version: string, fileUrl = `standards/${standardDocumentName(version)}.pdf`, ack = true) => (as(USERS.admin), publishStandardVersionFn({ data: { version, fileUrl, acknowledgedWarning: ack } }));

describe("the live version has one source", () => {
  it("is the live row of standard_versions; the bundled version only stands in until the table exists", async () => {
    expect(await getLiveStandard(db())).toMatchObject({ version: "1.1", source: "table", fileUrl: "standards/Participant_Eligibility_Standard_v1.1.pdf" });
    db().table("standard_versions").length = 0;
    expect(await getLiveStandard(db())).toMatchObject({ version: STANDARD_VERSION, source: "bundled", effectiveFrom: null });
  });

  it("the Decision Page eyebrow and the version a declaration is made under are the same value", async () => {
    expect(eyebrowFor(STANDARD_VERSION)).toBe(decisionPageCopy.eyebrow);
    await publish("1.2");
    const markup = renderToStaticMarkup(createElement(EligibilityStandardContent, { onContinue: () => undefined, version: (await getLiveStandard(db())).version }));
    expect(markup).toContain("Participant Eligibility Standard · Version 1.2");
    expect(markup).not.toContain("Version 1.1");
    as(USERS.b1);
    expect((await getLiveStandardFn()).version).toBe("1.2");
    const r = await declare(ALICE);
    expect(db().table("eligibility_declarations")[0]!.standard_version).toBe("1.2");
    expect(r.id).toBeTruthy();
  });

  it("only the eyebrow changes between versions: every other word of the Decision Page is the client's, unchanged", () => {
    const strip = (v: string) => renderToStaticMarkup(createElement(EligibilityStandardContent, { onContinue: () => undefined, version: v })).replace(eyebrowFor(v), "EYEBROW");
    expect(strip("1.2")).toBe(strip("1.1"));
  });

  it("no code decides which version is live from a build-time constant: it is imported only as the fallback", () => {
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && /\bSTANDARD_VERSION\b/.test(readFileSync(p, "utf8"))) users.push(p);
      }
    };
    walk("src");
    expect(users.sort()).toEqual(
      ["src/components/EligibilityDeclaration.tsx", "src/components/EligibilityStandard.tsx", "src/constants/eligibilityCopy.ts", "src/lib/account-rollup.ts", "src/lib/standard-version.server.ts"].sort(),
    );
    // Each of those only uses it as a default or a fallback.
    expect(readFileSync("src/lib/standard-version.server.ts", "utf8")).toContain("version: STANDARD_VERSION, effectiveFrom: null, fileUrl: null, source: \"bundled\"");
  });

  it("the route titles don't bake a version into the build", () => {
    for (const f of ["src/routes/buyer.eligibility-standard.tsx", "src/routes/buyer.onboarding.eligibility.tsx"]) expect(readFileSync(f, "utf8")).not.toContain("decisionPageCopy.eyebrow");
  });
});

describe("publishing a new version", () => {
  it("makes it the one live version and records it; the earlier version stays as an earlier version", async () => {
    const r = await publish("1.2");
    expect(r).toMatchObject({ version: "1.2", previousVersion: "1.1", warning: PUBLISH_WARNING });
    expect(live().map((v) => v.version)).toEqual(["1.2"]);
    expect(db().table("standard_versions").map((v) => [v.version, v.is_live])).toEqual([["1.1", false], ["1.2", true]]);
    expect(db().audits("standard.version_published")[0]!.metadata).toMatchObject({ version: "1.2", previous_version: "1.1", existing_results_remeasured: false, warning_acknowledged: true });
    as(USERS.admin);
    const view = await listStandardVersionsFn();
    expect(view.live.version).toBe("1.2");
    expect(view.versions.map((v) => v.version)).toEqual(["1.2", "1.1"]);
  });

  it("is admin only, and needs the warning acknowledged", async () => {
    as(USERS.b1);
    await expect(publishStandardVersionFn({ data: { version: "1.2", fileUrl: "standards/Participant_Eligibility_Standard_v1.2.pdf", acknowledgedWarning: true } })).rejects.toThrow("Not authorized");
    await expect(listStandardVersionsFn()).rejects.toThrow("Not authorized");
    await expect(publish("1.2", undefined, false)).rejects.toThrow("read the warning");
    expect(live().map((v) => v.version)).toEqual(["1.1"]);
  });

  it("the version must be newer than the live one (numerically), new, and well formed", async () => {
    await expect(publish("1.1")).rejects.toThrow("newer than the live version (1.1)");
    await expect(publish("1.0")).rejects.toThrow("newer than the live version");
    await expect(publish("one.two")).rejects.toThrow("looks like 1.2");
    await expect(publish("1.2.3")).rejects.toThrow("looks like 1.2");
    await publish("1.9");
    await publish("1.10"); // 1.10 is newer than 1.9, as a number
    expect(live().map((v) => v.version)).toEqual(["1.10"]);
    await expect(publish("1.9")).rejects.toThrow("newer than the live version");
    expect(compareStandardVersions("1.10", "1.9")).toBeGreaterThan(0);
  });

  it("a version that already exists can't be published again, even if it isn't the live one", async () => {
    db().seed("standard_versions", [{ version: "1.3", effective_from: "2026-12-01T00:00:00Z", is_live: false, file_url: "standards/Participant_Eligibility_Standard_v1.3.pdf" }]);
    await expect(publish("1.3")).rejects.toThrow("Version 1.3 already exists");
    expect(live().map((v) => v.version)).toEqual(["1.1"]);
  });

  it("the document is named for its version", async () => {
    await expect(publish("1.2", "standards/Participant_Eligibility_Standard_v1.1.pdf")).rejects.toThrow("must be named Participant_Eligibility_Standard_v1.2");
    await expect(publish("1.2", "   ")).rejects.toThrow("Give the document's location");
    expect(standardDocumentName("1.1")).toBe("Participant_Eligibility_Standard_v1.1");
    await publish("1.2", "https://files.example/Participant_Eligibility_Standard_v1.2.pdf");
    expect(live()[0]!.file_url).toContain("Participant_Eligibility_Standard_v1.2");
  });

  it("the admin page shows the live version, a publish form, and the warning word for word before publishing", () => {
    const page = readFileSync("src/routes/admin.standard.tsx", "utf8");
    expect(PUBLISH_WARNING).toBe("The Decision Page copy must be read against the Standard in the same pass. They are separate documents and do not stay in sync on their own.");
    expect(page).toContain("{PUBLISH_WARNING}");
    expect(page).toContain("Live now");
    expect(page).toContain("Publish a new version");
    expect(page).toContain("I have read this warning.");
    expect(readFileSync("src/routes/admin.tsx", "utf8")).toContain('to: "/admin/standard"');
  });
});

describe("with two versions, an older participant's result is unchanged", () => {
  it("Alice (declared under 1.1) keeps her declaration, result and version; Bob (after 1.2 is live) is measured under 1.2", async () => {
    const a = await declare(ALICE);
    const aliceDecl = JSON.stringify(db().table("eligibility_declarations").find((d) => d.id === a.id));
    const aliceResults = JSON.stringify(db().table("eligibility_results").filter((r) => r.account_member_id === ALICE));
    expect(JSON.parse(aliceResults)).toHaveLength(1);
    expect(JSON.parse(aliceResults)[0]).toMatchObject({ result: "eligible", standard_version: "1.1" });

    await publish("1.2");

    // Nothing of Alice's was touched by the publish.
    expect(JSON.stringify(db().table("eligibility_declarations").find((d) => d.id === a.id))).toBe(aliceDecl);
    expect(JSON.stringify(db().table("eligibility_results").filter((r) => r.account_member_id === ALICE))).toBe(aliceResults);

    const b = await declare(BOB);
    const bobDecl = db().table("eligibility_declarations").find((d) => d.id === b.id)!;
    expect(bobDecl.standard_version).toBe("1.2");
    expect(bobDecl.rendered_text_snapshot).toContain("version 1.2");
    expect(db().table("eligibility_results").find((r) => r.account_member_id === BOB)).toMatchObject({ result: "eligible", standard_version: "1.2" });
    // The same answers under the two versions are different records.
    expect(bobDecl.declaration_hash).not.toBe(JSON.parse(aliceDecl).declaration_hash);
    expect(bobDecl.rendered_text_snapshot).toBe(declarationText(yes, "1.2"));

    // The KYO record shows each under their own version.
    as(USERS.admin);
    const kyo = await getKyoForAdmin({ data: { accountId: IDS.b1 } });
    expect(kyo.find((m) => m.memberId === ALICE)!.eligibility).toMatchObject({ result: "eligible", standardVersion: "1.1" });
    expect(kyo.find((m) => m.memberId === BOB)!.eligibility).toMatchObject({ result: "eligible", standardVersion: "1.2" });
    expect(kyo.find((m) => m.memberId === ALICE)!.declaration).toMatchObject({ standardVersion: "1.1" });
  });

  it("a recompute after 1.2 is live (liveness, sanctions, a disposition…) keeps Alice on 1.1", async () => {
    const a = await declare(ALICE);
    await publish("1.2");
    await recomputeEligibility(db(), { memberId: ALICE, actorId: null, trigger: "test" });
    const rows = db().table("eligibility_results").filter((r) => r.account_member_id === ALICE);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.standard_version)).toEqual(["1.1", "1.1"]);
    expect(rows.every((r) => r.declaration_id === a.id)).toBe(true);
  });

  it("an existing participant isn't sent back to read the new version: having read the Standard they were measured under is enough", async () => {
    as(USERS.b1);
    await acknowledgeEligibilityStandard({ data: { actingMemberId: ALICE } }); // reads 1.1
    await declare(ALICE);
    await publish("1.2");
    const steps = await loadMemberSteps(db(), IDS.b1);
    expect(steps.find((s) => s.memberId === ALICE)!.standardRead).toBe(true);
    // Bob hasn't read anything and hasn't declared: he has to read the version that is live now.
    expect(steps.find((s) => s.memberId === BOB)!.standardRead).toBe(false);
    as(USERS.b1);
    await acknowledgeEligibilityStandard({ data: { actingMemberId: BOB } });
    expect(db().table("eligibility_page_acknowledgements").find((a) => a.account_member_id === BOB)!.standard_version).toBe("1.2");
    expect((await loadMemberSteps(db(), IDS.b1)).find((s) => s.memberId === BOB)!.standardRead).toBe(true);
  });

  it("having read some other version doesn't count: the Standard they are measured under is the one that has to have been read", async () => {
    db().seed("eligibility_page_acknowledgements", [{ account_member_id: ALICE, buyer_account_id: IDS.b1, standard_version: "1.0", page_spec_version: "1.0" }]);
    await declare(ALICE);
    expect((await loadMemberSteps(db(), IDS.b1)).find((s) => s.memberId === ALICE)!.standardRead).toBe(false);
  });

  it("a declaration made again after 1.2 is live (a correction, a change report) is a new declaration under 1.2; the old one stays on 1.1", async () => {
    const first = await declare(ALICE);
    await publish("1.2");
    const second = await declare(ALICE, { ...yes, q3: "no" }, first.id);
    const rows = db().table("eligibility_declarations").filter((d) => d.account_member_id === ALICE);
    expect(rows.map((r) => [r.status, r.standard_version])).toEqual([["superseded", "1.1"], ["complete", "1.2"]]);
    expect(db().table("eligibility_results").filter((r) => r.declaration_id === first.id).every((r) => r.standard_version === "1.1")).toBe(true);
    expect(db().table("eligibility_results").find((r) => r.declaration_id === second.id)).toMatchObject({ result: "held", standard_version: "1.2" });
  });

  it("sellers' declarations are made under the live version too", async () => {
    db().seed("sellers", [{ id: "seller-h", email: "h@test.local", full_name: "Hank Hybrid", address: "1 Main", date_of_birth: "1970-01-01", exit_type: "hybrid_exit" }]);
    await publish("1.2");
    as("seller-h");
    await submitSellerEligibility({ data: { answers: yes, attestedPersonally: true, signedName: "Hank Hybrid", supersedesId: null } });
    expect(db().table("seller_eligibility_declarations")[0]!.standard_version).toBe("1.2");
  });
});

describe("the footer's Standard on request is only text", () => {
  it("says support@divieight.com and has no form or link of its own", () => {
    expect(STANDARD_ON_REQUEST).toEqual({ label: "Standard on request", text: "support@divieight.com" });
    const footer = readFileSync("src/components/SiteFooter.tsx", "utf8");
    expect(footer).toContain("{STANDARD_ON_REQUEST.label}: {STANDARD_ON_REQUEST.text}");
    expect(footer).not.toMatch(/<form|<input|<textarea|mailto:|standard-request|request-standard/i);
  });
});

describe("the database rules", () => {
  it("one live version, immutable versions, live-version declarations and version-tied results are in the SQL", () => {
    const sql = readFileSync("standard-versions.sql", "utf8");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS standard_versions_one_live ON public.standard_versions ((true)) WHERE is_live;");
    expect(sql).toContain("CREATE CONSTRAINT TRIGGER standard_versions_exactly_one_live");
    expect(sql).toContain("A published Standard version can''t be edited");
    expect(sql).toContain("A declaration is made under the Standard that is live now");
    expect(sql).toContain("A result carries the Standard version of the declaration it was determined on");
  });
});
