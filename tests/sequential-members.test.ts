import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JOURNEY_KEYS, journeyDone, journeyMember, nextJourneyPath, type ChecklistItem } from "@/lib/account-members";
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
    expect(nextJourneyPath(member("member", ["identity", "liveness"]))).toBe("/buyer/onboarding/payment");
    expect(nextJourneyPath(member("member", ["identity", "liveness", "pra"]))).toBe("/buyer/onboarding/vetting");
    expect(nextJourneyPath(member("member", ["identity", "liveness", "pra", "hold_harmless", "declaration"]))).toBe("/buyer/onboarding/liquidity");
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
    for (const f of ["identity", "liveness", "pra-review", "payment", "vetting", "liquidity"]) {
      expect(readFileSync(`src/routes/buyer.onboarding.${f}.tsx`, "utf8"), f).toMatch(/<ActingMemberGate[^>]* journey>/);
    }
  });

  it("the account holder goes on to the account steps after liveness; the second member goes to their agreement", () => {
    const src = readFileSync("src/routes/buyer.onboarding.liveness.tsx", "utf8");
    expect(src).toContain('isPrimary ? "/buyer/onboarding/lifestyle" : "/buyer/onboarding/payment"');
  });

  it("the last screen hands over to the other member", () => {
    expect(readFileSync("src/routes/buyer.onboarding.liquidity.tsx", "utf8")).toContain("<JourneyHandoverCard");
    expect(readFileSync("src/components/AccountMembersCard.tsx", "utf8")).toContain("<JourneyHandoverCard");
  });
});
