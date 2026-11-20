import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JOURNEY_KEYS, journeyDone, journeyMember, nextJourneyPath, nextOnboardingStep, type ChecklistItem } from "@/lib/account-members";
import { BUYER_ENROLLMENT_CENTS_PER_MEMBER, enrollmentFeeCents } from "@/lib/buyer-fee";

const checklist = (doneKeys: readonly string[]): ChecklistItem[] =>
  [...JOURNEY_KEYS, "standard", "w9", "independent_advice"].map((key) => ({ key, label: key, done: doneKeys.includes(key) }));
const member = (role: "primary" | "member", doneKeys: readonly string[]) => ({ id: role, role, checklist: checklist(doneKeys) });
const ALL = [...JOURNEY_KEYS];

describe("two members go one at a time", () => {
  it("the account holder is first; the second member only starts once the holder has finished every step", () => {
    expect(journeyMember([member("member", []), member("primary", [])])?.role).toBe("primary");
    expect(journeyMember([member("primary", ["identity", "liveness"]), member("member", [])])?.role).toBe("primary");
    expect(journeyMember([member("primary", ALL), member("member", [])])?.role).toBe("member");
  });

  it("nobody has a turn on a one-member account, or once both are done", () => {
    expect(journeyMember([member("primary", [])])).toBeNull();
    expect(journeyMember([member("primary", ALL), member("member", ALL)])).toBeNull();
  });

  it("a member counts as done only when every onboarding step is done", () => {
    expect(journeyDone(member("primary", ALL))).toBe(true);
    for (const key of JOURNEY_KEYS) expect(journeyDone(member("primary", ALL.filter((k) => k !== key)))).toBe(false);
  });

  it("sends a member to their first open step", () => {
    expect(nextJourneyPath(member("member", []))).toBe("/buyer/onboarding/identity");
    expect(nextJourneyPath(member("member", ["identity"]))).toBe("/buyer/onboarding/liveness");
    expect(nextJourneyPath(member("member", ["identity", "liveness"]))).toBe("/buyer/onboarding/eligibility");
    expect(nextJourneyPath(member("member", ["identity", "liveness", "standard"]))).toBe("/buyer/onboarding/payment");
    expect(nextJourneyPath(member("member", ["identity", "liveness", "standard", "pra"]))).toBe("/buyer/onboarding/vetting");
    expect(nextJourneyPath(member("member", ["identity", "liveness", "standard", "pra", "hold_harmless", "declaration"]))).toBe("/buyer/onboarding/w9");
    expect(nextJourneyPath(member("member", ["identity", "liveness", "standard", "pra", "hold_harmless", "declaration", "w9"]))).toBe("/buyer/onboarding/liquidity");
    expect(nextJourneyPath(member("member", ALL))).toBeNull();
  });
});

describe("the enrollment fee is per member", () => {
  it("$2,570 for one, double for two", () => {
    expect(BUYER_ENROLLMENT_CENTS_PER_MEMBER).toBe(257000);
    expect(enrollmentFeeCents(1)).toBe(257000);
    expect(enrollmentFeeCents(2)).toBe(514000);
  });

  it("never charges less than one member's fee", () => {
    expect(enrollmentFeeCents(0)).toBe(257000);
    expect(enrollmentFeeCents(Number.NaN)).toBe(257000);
  });

  it("the server counts the active members itself and charges that many, and records the amount", () => {
    const src = readFileSync("src/utils/payments.functions.ts", "utf8");
    expect(src).toMatch(/from\("account_members"\)[\s\S]*eq\("status", "active"\)/);
    expect(src).toContain("quantity: memberCount");
    expect(src).toContain("amount_cents: feeCents");
  });

  it("the payment screen shows the per-member total", () => {
    const src = readFileSync("src/routes/buyer.onboarding.payment.tsx", "utf8");
    expect(src).toContain("enrollmentFeeCents(memberCount)");
    expect(src).toContain("Pay {formatUsd(feeCents)} now");
  });
});

describe("the onboarding screens follow the order", () => {
  it("every onboarding screen uses the one-person-at-a-time gate", () => {
    expect(readFileSync("src/components/EligibilityStandardPage.tsx", "utf8")).toContain("journey={next !== ");
    for (const f of ["identity", "liveness", "pra-review", "payment", "vetting", "liquidity"]) {
      expect(readFileSync(`src/routes/buyer.onboarding.${f}.tsx`, "utf8"), f).toMatch(/<ActingMemberGate[^>]* journey>/);
    }
  });

  it("the account holder goes on to the account steps after liveness; the second member goes to the Eligibility Standard", () => {
    const src = readFileSync("src/routes/buyer.onboarding.liveness.tsx", "utf8");
    expect(src).toContain('isPrimary ? "/buyer/onboarding/lifestyle" : "/buyer/onboarding/eligibility"');
  });

  it("the last screen hands over to the other member", () => {
    expect(readFileSync("src/routes/buyer.onboarding.liquidity.tsx", "utf8")).toContain("<JourneyHandoverCard");
    expect(readFileSync("src/components/AccountMembersCard.tsx", "utf8")).toContain("<JourneyHandoverCard");
  });
});

describe("what the dashboard says is still to do", () => {
  const ALL_KEYS = ["identity", "liveness", "standard", "independent_advice", "pra", "declaration", "hold_harmless", "w9", "block1", "block2"];
  const done = (...keys: string[]) => ({ checklist: ALL_KEYS.map((key) => ({ key, label: key, done: keys.includes(key) })) });

  it("is the W-9 for a buyer who has done everything else, and its button goes to the W-9 page", () => {
    const step = nextOnboardingStep(done(...ALL_KEYS.filter((k) => k !== "w9")));
    expect(step).toMatchObject({ key: "w9", label: "W-9", path: "/buyer/onboarding/w9" });
  });

  it("names the first open step, in the order the onboarding goes", () => {
    expect(nextOnboardingStep(done())).toMatchObject({ key: "identity", path: "/buyer/onboarding/identity" });
    expect(nextOnboardingStep(done("identity"))).toMatchObject({ key: "liveness", path: "/buyer/onboarding/liveness" });
    expect(nextOnboardingStep(done("identity", "liveness"))).toMatchObject({ key: "standard", path: "/buyer/onboarding/eligibility" });
    expect(nextOnboardingStep(done("identity", "liveness", "standard", "independent_advice"))).toMatchObject({ key: "pra", path: "/buyer/onboarding/payment" });
    expect(nextOnboardingStep(done("identity", "liveness", "standard", "independent_advice", "pra"))).toMatchObject({ key: "declaration", path: "/buyer/onboarding/vetting" });
    expect(nextOnboardingStep(done("identity", "liveness", "standard", "independent_advice", "pra", "declaration", "hold_harmless", "w9"))).toMatchObject({ key: "block1", path: "/buyer/onboarding/liquidity" });
  });

  it("is nothing once every step is done", () => {
    expect(nextOnboardingStep(done(...ALL_KEYS))).toBeNull();
  });
});

describe("the onboarding screens", () => {
  it("W-9 is a numbered step between Vetting and Liquidity, and vetting leads to it", () => {
    expect(readFileSync("src/components/BuyerOnboardingStepper.tsx", "utf8")).toContain('["Identity", "Lifestyle", "Payment", "Vetting", "W-9", "Liquidity"]');
    expect(readFileSync("src/routes/buyer.onboarding.vetting.tsx", "utf8")).toContain('navigate({ to: "/buyer/onboarding/w9" })');
    const w9 = readFileSync("src/routes/buyer.onboarding.w9.tsx", "utf8");
    expect(w9).toContain("<BuyerOnboardingStepper current={5} />");
    // After saving it goes to whatever is still open for this person, or the dashboard: it may have been done from the dashboard, out of order.
    expect(w9).toContain('navigate({ to: next?.path ?? "/buyer/dashboard" })');
    expect(w9).not.toContain('navigate({ to: "/buyer/onboarding/liquidity" })');
  });

  it("nobody on their own account sees Switch person", () => {
    for (const f of ["src/routes/buyer.onboarding.pra-review.tsx", "src/routes/buyer.onboarding.w9.tsx", "src/routes/buyer.kyo.tsx"]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/\{multi \? \(/);
    }
  });

  it("the dashboard says the onboarding is incomplete at the top, with a button to the page", () => {
    const src = readFileSync("src/routes/buyer.dashboard.tsx", "utf8");
    expect(src).toContain("Your onboarding is incomplete");
    expect(src).toContain("to={todo.step.path}");
  });
});
