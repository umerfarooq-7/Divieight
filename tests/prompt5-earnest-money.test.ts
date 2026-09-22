/**
 * Prompt 5 — Earnest Money Coordination: pro-rata issue, funding, late →
 * Default (PRA §8) → Member Substitution Pipeline → substitute obligation.
 */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS, hoursFromNow } from "./fixtures";
import {
  issueEarnestObligations,
  markObligationFunded,
  runEarnestMoneySweep,
} from "@/lib/earnest-money.server";
import {
  issueEarnestMoney,
  markEarnestFunded,
  listAdminEarnestMoney,
  listBuyerEarnestMoney,
} from "@/lib/earnest-money.functions";
import { createAuthorizationRequest, respondToAuthorization } from "@/lib/authorization.functions";
import { respondToInvitation } from "@/lib/substitution-invite.server";
import { splitProRata } from "@/lib/earnest-money";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const obligation = (buyer: string) =>
  db().table("earnest_money_obligations").find((o) => o.buyer_account_id === buyer)!;

const ISSUE = {
  propertyId: IDS.property,
  totalAmount: 8000,
  fundingDeadline: hoursFromNow(72),
  escrowCompany: "First American Title",
  escrowAccountDetails: "Acct 000123, Routing 111000025",
  escrowReference: "ESC-42",
  escrowContactEmail: "escrow@test.local",
};

async function issue(overrides: Partial<typeof ISSUE> = {}) {
  as(USERS.admin);
  return issueEarnestMoney({ data: { ...ISSUE, ...overrides } });
}

function setGraceHours(h: number) {
  db().seed("platform_settings", [
    { key: "earnest_money", value: { grace_hours: h, substitute_minimum_hours: 24 } },
  ]);
}

describe("Prompt 5 — pro-rata calculation", () => {
  it("a 2-share Account owes twice a 1-share Account; parts always sum to the total", () => {
    const even = splitProRata(900_000, [
      { buyerAccountId: "a", shares: 1 },
      { buyerAccountId: "b", shares: 2 },
    ]);
    expect(even.map((p) => p.amountCents)).toEqual([300_000, 600_000]);

    const odd = splitProRata(800_000, [
      { buyerAccountId: "a", shares: 1 },
      { buyerAccountId: "b", shares: 2 },
    ]);
    expect(odd.reduce((s, p) => s + p.amountCents, 0)).toBe(800_000);
    expect(Math.abs(odd[1]!.amountCents - 2 * odd[0]!.amountCents)).toBeLessThanOrEqual(2);
  });
});

describe("Prompt 5 — issuing funding instructions", () => {
  it("only the admin can issue; each Buyer Account gets its own obligation + instruction", async () => {
    seedPod(db());
    as(USERS.b1);
    await expect(issueEarnestMoney({ data: ISSUE })).rejects.toThrow("Not authorized");

    const r = await issue({ totalAmount: 9000 });
    expect(r).toMatchObject({ issued: 2, sharesBasis: 3 });
    expect(obligation(IDS.b1).amount).toBe(3000);
    expect(obligation(IDS.b2).amount).toBe(6000);
    expect(obligation(IDS.b2).shares).toBe(2);
    expect(obligation(IDS.b1).status).toBe("pending");

    const terms = db().table("earnest_money_terms")[0];
    expect(terms.per_share_amount).toBe(3000);
    expect(terms.escrow_company).toBe("First American Title");

    const msg = db().notificationsFor(USERS.b1)[0].message;
    expect(msg).toContain("$3,000.00");
    expect(msg).toContain("First American Title");
    expect(msg).toContain("never receives, holds, or disburses");
    expect(msg).toContain("not your Platform Enrollment Fee");
    expect(db().notificationsFor(USERS.ra).length).toBeGreaterThan(0);
    expect(db().audits("earnest.obligation_issued")).toHaveLength(2);
    expect(db().audits("earnest.obligation_issued")[0].metadata.custody).toBe(
      "direct_to_escrow_platform_never_holds",
    );
  });

  it("the buyer sees only their own obligation, with the escrow terms", async () => {
    seedPod(db());
    await issue();
    as(USERS.b2);
    const { rows } = await listBuyerEarnestMoney();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.obligation.buyer_account_id).toBe(IDS.b2);
    expect(rows[0]!.terms?.escrow_reference).toBe("ESC-42");
  });

  it("seller acceptance via the authorization flow flags the property for issue", async () => {
    seedPod(db());
    as(USERS.admin);
    const { id } = await createAuthorizationRequest({
      data: {
        propertyId: IDS.property,
        buyerAccountId: IDS.b2,
        actionType: "counter_offer_acceptance",
        headline: "Accept seller counter",
        terms: { Price: "$2,480,000" },
      },
    });
    as(USERS.b2);
    await respondToAuthorization({
      data: { requestId: id, accountMemberId: IDS.b2m1, decision: "confirmed", signedName: "CT", secondaryVerificationMethod: "typed_initials" },
    });
    as(USERS.admin);
    const { properties } = await listAdminEarnestMoney();
    expect(properties.find((p) => p.propertyId === IDS.property)?.acceptanceAuthorized).toBe(true);
  });

  it("re-issuing never rewrites a funded obligation", async () => {
    seedPod(db());
    await issue();
    await markObligationFunded(db(), USERS.admin, { obligationId: obligation(IDS.b1).id, reference: "WIRE-1" });
    await issue({ totalAmount: 12_000 });
    expect(obligation(IDS.b1).status).toBe("funded");
    expect(obligation(IDS.b1).amount).toBe(2666.66);
    expect(obligation(IDS.b2).amount).toBe(8000);
  });
});

describe("Prompt 5 — funding, late, Default and substitution", () => {
  it("marking funded records it, notifies the buyer, and the sweep leaves it alone", async () => {
    seedPod(db());
    await issue({ fundingDeadline: hoursFromNow(-1) });
    as(USERS.admin);
    await markEarnestFunded({ data: { obligationId: obligation(IDS.b1).id, reference: "WIRE-9" } });
    expect(obligation(IDS.b1).status).toBe("funded");
    expect(obligation(IDS.b1).funded_reference).toBe("WIRE-9");
    expect(db().notificationsFor(USERS.b1).some((n) => /receipt/i.test(n.message))).toBe(true);

    const r = await runEarnestMoneySweep(db());
    expect(r.markedLate).toBe(1); // only B2
    expect(obligation(IDS.b1).status).toBe("funded");
  });

  it("past deadline → late (with PRA §8 warning); still within grace → no Default", async () => {
    seedPod(db());
    await issue({ fundingDeadline: hoursFromNow(-1) });
    const first = await runEarnestMoneySweep(db());
    expect(first).toMatchObject({ markedLate: 2, defaulted: 0 });
    expect(obligation(IDS.b1).status).toBe("late");
    expect(db().notificationsFor(USERS.b1).at(-1)!.message).toContain("Default under PRA Section 8");

    const again = await runEarnestMoneySweep(db());
    expect(again).toMatchObject({ markedLate: 0, defaulted: 0 });
  });

  it("after grace → Default: slice released, cap table re-synced, lock released, parties notified", async () => {
    seedPod(db());
    setGraceHours(0);
    db().table("properties")[0].listing_status = "system_lock";
    await issue({ fundingDeadline: hoursFromNow(-1) });
    await markObligationFunded(db(), USERS.admin, { obligationId: obligation(IDS.b2).id });
    await runEarnestMoneySweep(db()); // B1 → late
    const r = await runEarnestMoneySweep(db()); // B1 → missed

    expect(r.defaulted).toBe(1);
    expect(obligation(IDS.b1).status).toBe("missed");
    expect(db().table("pod_reservations").find((x) => x.id === IDS.res1)!.status).toBe("defaulted");
    expect(db().table("properties")[0].listing_status).toBe("forming");

    const cap = db().table("cap_table_entries");
    expect(cap).toHaveLength(2);
    expect(cap.every((c) => c.buyer_account_id === IDS.b2)).toBe(true);

    // Non-defaulting member told only that substitution is in progress — no name/reason.
    const toB2 = db().notificationsFor(USERS.b2).map((n) => n.message).join("\n");
    expect(toB2).toMatch(/substitut/i);
    expect(toB2).not.toContain("Alice");
    expect(toB2).not.toContain("b1@test.local");
    // Tethered RA told it's a PRA §8 Default.
    expect(db().notificationsFor(USERS.ra).map((n) => n.message).join("\n")).toContain("PRA Section 8");

    expect(db().audits("earnest.default_declared")[0].metadata.basis).toBe(
      "pra_section_8_default_failure_to_fund",
    );
    expect(db().audits("earnest.substitution_opened")).toHaveLength(1);
    expect(db().audits("entity.cap_table_updated").some((a) => a.metadata.reason === "earnest_money_default")).toBe(true);
  });

  it("a defaulted obligation can't later be marked funded", async () => {
    seedPod(db());
    setGraceHours(0);
    await issue({ fundingDeadline: hoursFromNow(-1) });
    await runEarnestMoneySweep(db());
    await runEarnestMoneySweep(db());
    as(USERS.admin);
    await expect(
      markEarnestFunded({ data: { obligationId: obligation(IDS.b1).id } }),
    ).rejects.toThrow("already declared a Default");
  });

  it("overdue rows are processed even when many future-dated rows exist", async () => {
    seedPod(db());
    await issue({ fundingDeadline: hoursFromNow(-1) });
    for (let i = 0; i < 150; i++)
      db().seed("earnest_money_obligations", [
        { buyer_account_id: `x-${i}`, property_id: `p-${i}`, amount: 1, funding_deadline: hoursFromNow(48) },
      ]);
    const r = await runEarnestMoneySweep(db(), null, 100);
    expect(r.markedLate).toBe(2);
  });

  it("substitute accepts → installed, owes pro-rata on the SAME deadline, linked to the replaced obligation", async () => {
    seedPod(db());
    setGraceHours(0);
    const deadline = hoursFromNow(-1);
    await issue({ totalAmount: 9000, fundingDeadline: deadline });
    await runEarnestMoneySweep(db());
    await runEarnestMoneySweep(db()); // both B1 and B2 default here
    // Re-fund B2 path isn't the point — reinstate B2 so only B1's slice is vacant.
    db().table("pod_reservations").find((x) => x.id === IDS.res2)!.status = "reserved";

    const defaultedId = obligation(IDS.b1).id;
    db().seed("substitution_invitations", [
      {
        id: "inv-1",
        property_id: IDS.property,
        buyer_account_id: IDS.b3,
        vacated_reservation_id: IDS.res1,
        shares_offered: 1,
        sequence: 1,
        expires_at: hoursFromNow(24),
      },
    ]);

    const r = await respondToInvitation(db() as never, {
      invitationId: "inv-1",
      buyerAccountId: IDS.b3,
      authUserId: USERS.b3,
      response: "accepted",
    });
    expect(r).toMatchObject({ ok: true, reason: "accepted" });

    const sub = obligation(IDS.b3);
    expect(sub.is_substitute).toBe(true);
    expect(sub.amount).toBe(3000); // per-share × 1
    expect(sub.replaces_obligation_id).toBe(defaultedId);
    // Original deadline has passed → minimum window (24h) so it's actionable.
    expect(Date.parse(sub.funding_deadline)).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(db().notificationsFor(USERS.b3).at(-1)!.message).toContain("condition of your installation");

    const cap = db().table("cap_table_entries");
    expect(cap.some((c) => c.buyer_account_id === IDS.b3)).toBe(true);
    expect(cap.some((c) => c.buyer_account_id === IDS.b1)).toBe(false);
  });

  it("substitute inherits the original deadline when it hasn't passed yet", async () => {
    seedPod(db());
    const deadline = hoursFromNow(96);
    await issue({ fundingDeadline: deadline });
    db().table("pod_reservations").find((x) => x.id === IDS.res1)!.status = "withdrawn";
    db().seed("substitution_invitations", [
      { id: "inv-2", property_id: IDS.property, buyer_account_id: IDS.b3, vacated_reservation_id: IDS.res1, shares_offered: 1, sequence: 1, expires_at: hoursFromNow(24) },
    ]);
    await respondToInvitation(db() as never, { invitationId: "inv-2", buyerAccountId: IDS.b3, authUserId: USERS.b3, response: "accepted" });
    expect(obligation(IDS.b3).funding_deadline).toBe(new Date(deadline).toISOString());
  });

  it("a substitute who then fails to fund is itself defaulted (installation is conditional)", async () => {
    seedPod(db());
    setGraceHours(0);
    await issue({ fundingDeadline: hoursFromNow(-1) });
    db().table("pod_reservations").find((x) => x.id === IDS.res1)!.status = "withdrawn";
    db().seed("substitution_invitations", [
      { id: "inv-3", property_id: IDS.property, buyer_account_id: IDS.b3, vacated_reservation_id: IDS.res1, shares_offered: 1, sequence: 1, expires_at: hoursFromNow(24) },
    ]);
    await respondToInvitation(db() as never, { invitationId: "inv-3", buyerAccountId: IDS.b3, authUserId: USERS.b3, response: "accepted" });
    obligation(IDS.b3).funding_deadline = hoursFromNow(-1);
    await runEarnestMoneySweep(db());
    await runEarnestMoneySweep(db());
    expect(obligation(IDS.b3).status).toBe("missed");
    const b3res = db().table("pod_reservations").find((x) => x.buyer_account_id === IDS.b3)!;
    expect(b3res.status).toBe("defaulted");
  });
});
