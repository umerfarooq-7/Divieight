/**
 * Prompt 7 — Closing-Cost Funding Coordination.
 */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS, hoursFromNow } from "./fixtures";
import {
  ENROLLMENT_FEE_DOES_NOT_FUND,
  ENROLLMENT_FEE_FUNDS,
  ENROLLMENT_FEE_SCOPE_NOTICE,
} from "@/lib/closing-funds";
import {
  issueClosingFunds,
  markClosingFundsFunded,
  runClosingFundsDeadlineSweep,
  listBuyerClosingFunds,
  listAgentClosingFunds,
  getPodClosingFunds,
} from "@/lib/closing-funds.functions";
import { issueEarnestObligations } from "@/lib/earnest-money.server";
import { respondToInvitation } from "@/lib/substitution-invite.server";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const closing = (buyer: string) =>
  db().table("closing_funds_obligations").find((o) => o.buyer_account_id === buyer)!;

const NOTICE = {
  propertyId: IDS.property,
  totalAmount: 1_800_000,
  fundingDeadline: hoursFromNow(10 * 24),
  escrowCompany: "First American Title",
  escrowAccountDetails: "Wire: Acct 000123 / Routing 111000025",
  escrowReference: "CLS-7",
  escrowContactEmail: "escrow@test.local",
};

async function issue(overrides: Partial<typeof NOTICE> = {}) {
  as(USERS.admin);
  return issueClosingFunds({ data: { ...NOTICE, ...overrides } });
}

function podId() {
  return db().table("pods")[0].id as string;
}

describe("Prompt 7 — Enrollment Fee scope is explicit", () => {
  it("lists exactly what the fee does and does not fund", () => {
    expect([...ENROLLMENT_FEE_FUNDS]).toEqual([
      "Manager compensation (divieight, LLC)",
      "Third-party API and vendor costs",
      "The appraisal",
      "The inspection",
    ]);
    for (const x of ["purchase price", "taxes", "title fees", "recording fees", "escrow fees", "lender fees", "prepaid items"])
      expect(ENROLLMENT_FEE_DOES_NOT_FUND.join(" ").toLowerCase()).toContain(x);
    expect(ENROLLMENT_FEE_SCOPE_NOTICE).toMatch(/does NOT fund/);
  });
});

describe("Prompt 7 — Closing Funds Notice", () => {
  it("admin-only; pro-rata by shares; the notice states the exact amount, escrow, deadline, methods and fee scope", async () => {
    seedPod(db());
    as(USERS.b1);
    await expect(issueClosingFunds({ data: NOTICE })).rejects.toThrow("Not authorized");

    const r = await issue();
    expect(r).toMatchObject({ issued: 2, sharesBasis: 3 });
    expect(closing(IDS.b1).amount).toBe(600_000);
    expect(closing(IDS.b2).amount).toBe(1_200_000);

    const msg = db().notificationsFor(USERS.b1)[0].message;
    expect(msg).toContain("Closing Funds Notice");
    expect(msg).toContain("exactly $600,000.00");
    expect(msg).toContain("First American Title");
    expect(msg).toContain("CLS-7");
    expect(msg).toContain("Accepted methods: Wire transfer");
    expect(msg).toContain("never receives, holds, or distributes");
    expect(msg).toContain("does NOT fund");
    expect(db().audits("closing_funds.obligation_issued")).toHaveLength(2);
  });

  it("is separate from earnest money (own tables, audit prefix and portal)", async () => {
    seedPod(db());
    await issueEarnestObligations(db(), USERS.admin, { ...NOTICE, totalAmount: 9000 });
    await issue();
    expect(db().table("earnest_money_obligations")).toHaveLength(2);
    expect(db().table("closing_funds_obligations")).toHaveLength(2);
    expect(db().audits("earnest.")).toHaveLength(2);
    expect(db().audits("closing_funds.")).toHaveLength(2);
    expect(db().notificationsFor(USERS.b1).some((n) => n.message.includes("/buyer/closing-funds"))).toBe(false);
  });

  it("surfaces in the buyer portal, the Resident Agent dashboard and the HLA's Master Briefcase (de-identified)", async () => {
    seedPod(db());
    await issue();

    as(USERS.b2);
    const buyer = await listBuyerClosingFunds();
    expect(buyer.rows).toHaveLength(1);
    expect(buyer.rows[0]!.obligation.amount).toBe(1_200_000);

    as(USERS.ra);
    const agent = await listAgentClosingFunds();
    expect(agent.rows.map((r) => r.buyerEmail).sort()).toEqual(["b1@test.local", "b2@test.local"]);

    as(USERS.hla);
    const pod = await getPodClosingFunds({ data: { podId: podId() } });
    if ("error" in pod) throw new Error(pod.error);
    expect(pod.rows).toHaveLength(2);
    expect(JSON.stringify(pod)).not.toMatch(/b1@test|b2@test|Alice|Carol/);

    as(USERS.ra2);
    const denied = await getPodClosingFunds({ data: { podId: podId() } });
    expect("error" in denied).toBe(true);
  });

  it("tracks pending → funded, and refuses re-pricing a funded wire", async () => {
    seedPod(db());
    await issue();
    as(USERS.admin);
    await markClosingFundsFunded({ data: { obligationId: closing(IDS.b1).id, reference: "FED-1" } });
    expect(closing(IDS.b1).status).toBe("funded");
    await expect(issue({ totalAmount: 2_000_000 })).rejects.toThrow("already wired closing funds");
  });
});

describe("Prompt 7 — Default and substitution", () => {
  function graceZero() {
    db().seed("platform_settings", [{ key: "closing_funds", value: { grace_hours: 0, substitute_minimum_hours: 24 } }]);
  }

  it("late → missed is a PRA §8 Default: slice released, cap table synced, substitution opened", async () => {
    seedPod(db());
    graceZero();
    await issue({ fundingDeadline: hoursFromNow(-1) });
    as(USERS.admin);
    await markClosingFundsFunded({ data: { obligationId: closing(IDS.b2).id } });
    await runClosingFundsDeadlineSweep();
    expect(closing(IDS.b1).status).toBe("late");
    await runClosingFundsDeadlineSweep();
    expect(closing(IDS.b1).status).toBe("missed");
    expect(db().table("pod_reservations").find((r) => r.id === IDS.res1)!.status).toBe("defaulted");
    expect(db().audits("closing_funds.default_declared")[0].metadata.basis).toBe("pra_section_8_default_failure_to_fund");
    expect(db().audits("closing_funds.substitution_opened")).toHaveLength(1);
    expect(db().audits("entity.cap_table_updated").some((a) => a.metadata.reason === "closing_funds_default")).toBe(true);
  });

  it("a slice already vacated by an earnest-money Default isn't defaulted twice", async () => {
    seedPod(db());
    graceZero();
    await issue({ fundingDeadline: hoursFromNow(-1) });
    db().table("pod_reservations").find((r) => r.id === IDS.res1)!.status = "defaulted";
    as(USERS.admin);
    await runClosingFundsDeadlineSweep();
    await runClosingFundsDeadlineSweep();
    expect(closing(IDS.b1).status).toBe("missed");
    const declared = db().audits("closing_funds.default_declared").find((a) => a.metadata.buyer_account_id === IDS.b1)!;
    expect(declared.metadata.slice_already_vacated).toBe(true);
    expect(
      db().audits("closing_funds.substitution_opened").some((a) => a.metadata.vacated_reservation_id === IDS.res1),
    ).toBe(false);
  });

  it("a substitute inherits the closing-funds obligation as a condition precedent", async () => {
    seedPod(db());
    await issue();
    const replaced = closing(IDS.b1).id;
    db().table("pod_reservations").find((r) => r.id === IDS.res1)!.status = "withdrawn";
    db().seed("substitution_invitations", [
      { id: "inv-c", property_id: IDS.property, buyer_account_id: IDS.b3, vacated_reservation_id: IDS.res1, shares_offered: 1, sequence: 1, expires_at: hoursFromNow(24) },
    ]);
    await respondToInvitation(db() as never, { invitationId: "inv-c", buyerAccountId: IDS.b3, authUserId: USERS.b3, response: "accepted" });
    const sub = closing(IDS.b3);
    expect(sub).toMatchObject({ is_substitute: true, amount: 600_000, replaces_obligation_id: replaced });
    expect(sub.funding_deadline).toBe(new Date(NOTICE.fundingDeadline).toISOString());
    expect(db().notificationsFor(USERS.b3).some((n) => n.message.includes("condition precedent"))).toBe(true);
  });
});
