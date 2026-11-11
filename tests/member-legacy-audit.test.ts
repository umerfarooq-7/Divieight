/**
 * Gaps found by the six-point audit of the per-member eligibility work: the legacy fcra_consent_at follows the
 * Question 5 authorization, nothing writes the retired background_check_result, and the adverse-action page
 * reads only the acting member's own row.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { submitEligibilityDeclaration } from "@/lib/eligibility-declaration.functions";

const db = () => harness.db;
const ALICE = IDS.b1m1;
const BOB = IDS.b1m2;
const member = (id: string) => db().table("account_members").find((m) => m.id === id)!;
const yes = { q1: "yes", q2: "yes", q3: "yes", q4: "yes", q5: "yes", q6: "yes" };

const declare = (memberId: string, answers: Record<string, string>, supersedesId: string | null = null) => {
  harness.userId = USERS.b1;
  return submitEligibilityDeclaration({ data: { actingMemberId: memberId, answers, attestedPersonally: true, signedName: member(memberId).full_name, supersedesId } as never });
};

beforeEach(() => {
  seedPod(db());
  for (const m of db().table("account_members")) Object.assign(m, { status: "active", role: m.role === "secondary" ? "member" : m.role, date_of_birth: "1980-01-01", address: "1 Main St", id_document_url: `ids/${m.id}.jpg`, vetting_status: "in_progress" });
});

describe("fcra_consent_at follows the Block 4 Question 5 authorization", () => {
  it("is set when the member answers Yes to Q5, and only for that member", async () => {
    expect(member(ALICE).fcra_consent_at ?? null).toBeNull();
    await declare(ALICE, yes);
    expect(member(ALICE).fcra_consent_at).toBeTruthy();
    expect(Number.isNaN(Date.parse(member(ALICE).fcra_consent_at as string))).toBe(false);
    expect(member(BOB).fcra_consent_at ?? null).toBeNull();
  });

  it("is the declaration's own timestamp", async () => {
    await declare(ALICE, yes);
    const decl = db().table("eligibility_declarations").find((d) => d.account_member_id === ALICE)!;
    expect(member(ALICE).fcra_consent_at).toBe(decl.declared_at);
  });

  it("answering No to Q5 gives no consent (the declaration is incomplete)", async () => {
    await declare(ALICE, { ...yes, q5: "no" });
    expect(member(ALICE).fcra_consent_at ?? null).toBeNull();
  });

  it("is cleared if the member later withdraws the authorization, and set again when they re-give it", async () => {
    const first = await declare(ALICE, yes);
    expect(member(ALICE).fcra_consent_at).toBeTruthy();
    const second = await declare(ALICE, { ...yes, q5: "no" }, first.id);
    expect(member(ALICE).fcra_consent_at ?? null).toBeNull();
    await declare(ALICE, yes, second.id);
    expect(member(ALICE).fcra_consent_at).toBeTruthy();
  });

  it("the other member's consent is never touched", async () => {
    await declare(BOB, yes);
    const bobs = member(BOB).fcra_consent_at;
    await declare(ALICE, { ...yes, q5: "no" });
    expect(member(BOB).fcra_consent_at).toBe(bobs);
  });
});

describe("background_check_result is retired", () => {
  const files = (dir: string): string[] => (readdirSync(dir, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean }>).flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
  const sources = files("src").filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith("integrations/supabase/types.ts"));

  it("nothing in the app writes it: it is only ever read (legacy rows)", () => {
    for (const f of sources) {
      const text = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
      expect(text, f).not.toMatch(/\.(insert|update|upsert)\([^)]*background_check_result/s);
    }
  });

  it("the new Eligibility Check never sets it: no result ever lands in the legacy column", async () => {
    await declare(ALICE, yes);
    expect(member(ALICE).background_check_result ?? null).toBeNull();
    await declare(BOB, { ...yes, q1: "no" });
    expect(member(BOB).background_check_result ?? null).toBeNull();
  });

  it("the database marks the legacy columns as legacy", () => {
    const sql = readFileSync("legacy-columns.sql", "utf8");
    for (const column of ["background_check_result", "fcra_consent_at", "vetting_status"]) expect(sql).toMatch(new RegExp(`COMMENT ON COLUMN public\\.account_members\\.${column}`));
    expect(sql).toMatch(/LEGACY/);
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
  });
});

describe("the adverse-action page shows a member only their own result", () => {
  const page = readFileSync("src/routes/buyer.adverse-action.tsx", "utf8");

  it("reads only the acting member's own row, never the other member's", () => {
    expect(page).toMatch(/\.eq\("id", actingMemberId\)/);
    expect(page).not.toMatch(/\.eq\("buyer_account_id", b\.id\)\s*\.eq\("status", "active"\);/); // the old "every member" read
    expect(page).not.toMatch(/everyone|affected\./);
  });

  it("never names or hints at another member: no 'This is for <name>' screen", () => {
    expect(page).not.toMatch(/This is for/);
    expect(page).not.toMatch(/notForMe|full_name/);
    expect(page).toMatch(/navigate\(\{ to: "\/buyer\/dashboard"/);
  });
});
