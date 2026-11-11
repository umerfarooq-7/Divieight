/** Block 4 — Eligibility Declaration and Authorization. */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { block4DeclarationLine, block4Questions, STANDARD_VERSION } from "@/constants/eligibilityCopy";
import { EligibilityDeclaration, type DeclarationSummary } from "@/components/EligibilityDeclaration";
import { getDeclarationState, submitEligibilityDeclaration } from "@/lib/eligibility-declaration.functions";
import { declarationHash } from "@/lib/eligibility-declaration.server";
import { Q5_REQUIRED_MESSAGE, declarationText, legalNamesMatch, type DeclarationAnswers } from "@/lib/eligibility-declaration";
import { eligibilityOf } from "@/lib/account-members";

const db = () => harness.db;
const rows = () => db().table("eligibility_declarations");
const allYes: DeclarationAnswers = { q1: "yes", q2: "yes", q3: "yes", q4: "yes", q5: "yes", q6: "yes" };

/** The fixture pod, with both of account 1's members through the identity step (name + ID on file). */
function seed() {
  seedPod(db());
  for (const m of db().table("account_members")) {
    Object.assign(m, { status: "active", date_of_birth: "1980-01-01", address: "1 Main St", id_document_url: `ids/${m.id}.jpg`, vetting_status: "in_progress" });
  }
  // Liveness passed for everyone, so the engine has a result to give once the declaration is in.
  db().seed("member_liveness_checks", db().table("account_members").map((m) => ({ account_member_id: m.id, buyer_account_id: m.buyer_account_id, status: "passed", created_at: "2026-11-01T00:00:00Z" })));
}

const member = (id: string) => db().table("account_members").find((m) => m.id === id)!;

function declare(memberId: string, overrides: Partial<{ answers: DeclarationAnswers; attestedPersonally: boolean; signedName: string; supersedesId: string | null; user: string }> = {}) {
  harness.userId = overrides.user ?? USERS.b1;
  return submitEligibilityDeclaration({
    data: {
      actingMemberId: memberId,
      answers: overrides.answers ?? allYes,
      attestedPersonally: overrides.attestedPersonally ?? true,
      signedName: overrides.signedName ?? member(memberId).full_name,
      supersedesId: overrides.supersedesId ?? null,
    },
  });
}

describe("(1) one question at a time, Yes or No only", () => {
  const render = (current: DeclarationSummary | null = null) =>
    renderToStaticMarkup(createElement(EligibilityDeclaration, { memberName: "Alice One", verifiedName: "Alice One", current, onSubmit: async () => undefined }));

  it("shows the first question alone, with exactly two answers: Yes and No", () => {
    const html = render();
    const shown = block4Questions.filter((q) => html.includes(q.replace(/'/g, "&#x27;")));
    expect(shown).toEqual([block4Questions[0]]);
    const answers = html.match(/<button[^>]*role="radio"[^>]*>([^<]*)<\/button>/g) ?? [];
    expect(answers.map((b) => b.replace(/<[^>]+>/g, ""))).toEqual(["Yes", "No"]);
    expect(html).not.toMatch(/aria-checked="true"/);
    expect(html).toContain("Question 1 of 6");
  });

  it("there is no free-text field anywhere in the flow: the typed signature is the only input", () => {
    const html = render();
    expect(html).not.toMatch(/<textarea|<input|contenteditable/);
    const source = readFileSync("src/components/EligibilityDeclaration.tsx", "utf8");
    expect(source).not.toMatch(/<textarea|<Textarea|contentEditable/);
    expect(source.match(/<Input\b/g)).toHaveLength(1);
    expect(source).toMatch(/<Input id="block4-signature"/);
  });

  it("the questions are the copy file's, in order, and the declaration line is the copy file's", () => {
    const text = declarationText(allYes, STANDARD_VERSION);
    let at = 0;
    for (const q of block4Questions) {
      const i = text.indexOf(q, at);
      expect(i).toBeGreaterThan(at - 1);
      at = i + q.length;
    }
    expect(text.endsWith(block4DeclarationLine)).toBe(true);
    expect(block4Questions).toHaveLength(6);
  });

  it("a made declaration is shown with its answers and can be corrected", () => {
    const html = render({ id: "d1", status: "complete", answers: allYes, declared_at: new Date().toISOString(), signed_name: "Alice One", standard_version: STANDARD_VERSION, declaration_hash: "sha256_" + "0".repeat(64) });
    expect(html).toContain("Correct and resubmit");
    for (const q of block4Questions) expect(html).toContain(q.replace(/'/g, "&#x27;"));
  });
});

describe("(2) a separate record, hash and signature for each member", () => {
  it("two members make two declarations, each with their own signature, IP and acting member", async () => {
    seed();
    expect((await declare(IDS.b1m1)).waitingOn).toEqual(["Bob One"]);
    expect((await declare(IDS.b1m2)).waitingOn).toEqual([]);
    expect(rows()).toHaveLength(2);
    const [a, b] = [rows().find((r) => r.account_member_id === IDS.b1m1)!, rows().find((r) => r.account_member_id === IDS.b1m2)!];
    expect(a).toMatchObject({ buyer_account_id: IDS.b1, signed_name: "Alice One", attested_personally: true, status: "complete", ip: "203.0.113.7" });
    expect(b).toMatchObject({ buyer_account_id: IDS.b1, signed_name: "Bob One", attested_personally: true, status: "complete" });
    expect(a.id).not.toBe(b.id);
    expect(a.declaration_hash).toMatch(/^sha256_[0-9a-f]{64}$/);
    const audits = db().audits("buyer.eligibility_declaration_made");
    expect(audits.map((x) => x.metadata.acted_by_member_id).sort()).toEqual([IDS.b1m1, IDS.b1m2].sort());
    expect(audits.map((x) => x.metadata.declaration_id).sort()).toEqual([a.id, b.id].sort());
  });

  it("one member can't declare for another account's member, or for a removed member", async () => {
    seed();
    await expect(declare(IDS.b2m1)).rejects.toThrow("isn't on your account");
    member(IDS.b1m2).status = "removed";
    await expect(declare(IDS.b1m2)).rejects.toThrow("isn't on your account");
    expect(rows()).toEqual([]);
  });
});

describe("(3) the hash", () => {
  it("same input, same hash; it is the SHA-256 of the stored snapshot", async () => {
    expect(declarationHash(allYes, STANDARD_VERSION)).toBe(declarationHash({ ...allYes }, STANDARD_VERSION));
    seed();
    await declare(IDS.b1m1);
    await declare(IDS.b1m2);
    const [a, b] = rows();
    expect(a!.declaration_hash).toBe(b!.declaration_hash);
    for (const r of rows()) {
      expect(r.rendered_text_snapshot).toBe(declarationText(allYes, STANDARD_VERSION));
      expect(r.declaration_hash).toBe(`sha256_${createHash("sha256").update(r.rendered_text_snapshot, "utf8").digest("hex")}`);
    }
  });

  it("any answer, or the Standard's version, changes the hash", () => {
    const base = declarationHash(allYes, STANDARD_VERSION);
    for (const k of Object.keys(allYes) as Array<keyof DeclarationAnswers>) expect(declarationHash({ ...allYes, [k]: "no" }, STANDARD_VERSION)).not.toBe(base);
    expect(declarationHash(allYes, "9.9")).not.toBe(base);
  });

  it("the text is pinned: an old record's hash can be recomputed years later", () => {
    // If this fails, the snapshot format changed: bump DECLARATION_TEXT_FORMAT instead of editing the old one.
    expect(declarationHash(allYes, "1.1")).toBe(PINNED_HASH);
  });
});

describe("(4) correct and resubmit", () => {
  it("a correction is a new row; the old one stays, word for word, marked superseded", async () => {
    seed();
    const first = await declare(IDS.b1m1);
    const before = { ...rows()[0]! };
    const second = await declare(IDS.b1m1, { answers: { ...allYes, q3: "no" }, supersedesId: first.id });
    expect(rows()).toHaveLength(2);
    const old = rows().find((r) => r.id === first.id)!;
    expect(old.status).toBe("superseded");
    expect({ ...old, status: before.status }).toEqual(before);
    const fresh = rows().find((r) => r.id === second.id)!;
    expect(fresh).toMatchObject({ supersedes_id: first.id, status: "complete" });
    expect(fresh.declaration_hash).not.toBe(old.declaration_hash);
  });

  it("a stale or missing correction target is refused", async () => {
    seed();
    const first = await declare(IDS.b1m1);
    await declare(IDS.b1m1, { supersedesId: first.id });
    await expect(declare(IDS.b1m1, { supersedesId: first.id })).rejects.toThrow("already corrected");
    await expect(declare(IDS.b1m1)).rejects.toThrow("already corrected");
    await expect(declare(IDS.b1m2, { supersedesId: first.id })).rejects.toThrow("no earlier declaration");
    expect(rows()).toHaveLength(2);
  });
});

describe("(5) the Standard's version", () => {
  it("is stored on every declaration", async () => {
    seed();
    const first = await declare(IDS.b1m1);
    await declare(IDS.b1m1, { supersedesId: first.id });
    expect(rows().map((r) => r.standard_version)).toEqual([STANDARD_VERSION, STANDARD_VERSION]);
    expect(rows()[0]!.rendered_text_snapshot).toContain(`version ${STANDARD_VERSION}`);
  });
});

describe("(6) Q5 = No", () => {
  it("leaves the declaration incomplete and creates no failed result", async () => {
    seed();
    const r = await declare(IDS.b1m1, { answers: { ...allYes, q5: "no" } });
    expect(r.status).toBe("incomplete");
    expect(rows()[0]!.status).toBe("incomplete");
    expect(member(IDS.b1m1).vetting_status).toBe("in_progress");
    expect(eligibilityOf(member(IDS.b1m1).vetting_status)).toBe("pending");
    expect(JSON.stringify([rows(), db().table("account_members"), db().table("audit_log")])).not.toMatch(/"failed"|not_eligible/);
    expect(db().audits("buyer.eligibility_declaration_made")).toEqual([]);
    expect(db().audits("buyer.eligibility_declaration_incomplete")).toHaveLength(1);
    expect(r.waitingOn).toContain("Alice One");
  });

  it("changing the answer to Yes completes it, as a new version", async () => {
    seed();
    const r = await declare(IDS.b1m1, { answers: { ...allYes, q5: "no" } });
    const fixed = await declare(IDS.b1m1, { supersedesId: r.id });
    expect(fixed.status).toBe("complete");
    expect(member(IDS.b1m1).vetting_status).toBe("cleared");
    expect(rows().map((x) => x.status)).toEqual(["superseded", "complete"]);
  });

  it("the neutral message is the one agreed", () => {
    expect(Q5_REQUIRED_MESSAGE).toBe("This authorization is required to complete enrollment. You can change your answer at any time.");
  });
});

describe("(7) personal attestation and the ID-verified name", () => {
  it("is refused without the personal attestation", async () => {
    seed();
    await expect(declare(IDS.b1m1, { attestedPersonally: false })).rejects.toThrow("personally making this declaration");
    expect(rows()).toEqual([]);
  });

  it("is refused when the typed name doesn't match the name on the verified ID", async () => {
    seed();
    await expect(declare(IDS.b1m1, { signedName: "Bob One" })).rejects.toThrow("doesn't match the name on your verified ID");
    await expect(declare(IDS.b1m1, { signedName: "Alice" })).rejects.toThrow("doesn't match");
    expect(rows()).toEqual([]);
  });

  it("case, accents, punctuation and spacing don't count", async () => {
    expect(legalNamesMatch("  alice   ONE. ", "Alice One")).toBe(true);
    expect(legalNamesMatch("José O'Neil", "Jose ONeil")).toBe(false);
    expect(legalNamesMatch("José O'Neil", "jose o neil")).toBe(true);
    expect(legalNamesMatch("", "")).toBe(false);
    seed();
    await declare(IDS.b1m1, { signedName: "  alice   ONE " });
    expect(rows()[0]!.signed_name).toBe("alice   ONE");
  });

  it("is refused until the member's identity (name and ID document) is on file", async () => {
    seed();
    member(IDS.b1m2).id_document_url = null;
    await expect(declare(IDS.b1m2)).rejects.toThrow("identity step");
    harness.userId = USERS.b1;
    expect((await getDeclarationState({ data: { actingMemberId: IDS.b1m2 } })).verifiedName).toBeNull();
  });

  it("stores the acting member's id", async () => {
    seed();
    await declare(IDS.b1m2);
    expect(rows()[0]!.account_member_id).toBe(IDS.b1m2);
    expect(db().audits("buyer.eligibility_declaration_made")[0]!.metadata).toMatchObject({ acted_by_member_id: IDS.b1m2, account_member_id: IDS.b1m2 });
  });
});

describe("a No to a statement", () => {
  it("goes to the engine: Q1 No is not eligible, Q3 No is held, and a correction is recomputed", async () => {
    seed();
    const r = await declare(IDS.b1m1, { answers: { ...allYes, q1: "no" } });
    expect(r).toMatchObject({ status: "complete", result: "not_eligible", reasonCodes: ["q1_no"] });
    expect(member(IDS.b1m1).vetting_status).toBe("not_eligible");
    const fixed = await declare(IDS.b1m1, { supersedesId: r.id });
    expect(fixed.result).toBe("eligible");
    expect(member(IDS.b1m1).vetting_status).toBe("cleared");
    const held = await declare(IDS.b1m2, { answers: { ...allYes, q3: "no" } });
    expect(held.result).toBe("held");
    expect(eligibilityOf(member(IDS.b1m2).vetting_status)).toBe("held");
  });

  it("no consumer report is requested: nothing but the declaration and its audit entry is written", async () => {
    seed();
    const before = Object.fromEntries(["account_members", "signed_documents", "buyer_accounts"].map((t) => [t, JSON.stringify(db().table(t).map((r) => ({ ...r, vetting_status: undefined, fcra_consent_at: undefined })))]));
    await declare(IDS.b1m1);
    for (const [t, snap] of Object.entries(before)) expect(JSON.stringify(db().table(t).map((r) => ({ ...r, vetting_status: undefined, fcra_consent_at: undefined })))).toBe(snap);
    // The only thing recorded on the member is the Q5 authorization itself (the legacy fcra_consent_at mirrors it).
    expect(member(IDS.b1m1).fcra_consent_at).toBe(db().table("eligibility_declarations").find((d) => d.account_member_id === IDS.b1m1)!.declared_at);
    expect(member(IDS.b1m1).background_check_result ?? null).toBeNull();
  });
});

const PINNED_HASH = "sha256_ac190f80b69092b4587829f3df3b86aa8f5b9c185e7686db3f298e9b66e5d22e";
