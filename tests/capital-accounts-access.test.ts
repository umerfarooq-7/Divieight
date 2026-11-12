/** Month 6, Prompt 2, the app side: who opens the books, who reads the capital accounts and the reconciliation report. */
import { describe, it, expect, beforeEach } from "vitest";
import { harness } from "./setup";
import { seedPod, USERS, IDS } from "./fixtures";
import { backfillOpeningEntries, capitalAccountLedger, openPropertyLedger, ownerCapitalReport } from "@/lib/bookkeeping.server";

const db = () => harness.db as any;

beforeEach(() => {
  seedPod(db());
  db().seed("cap_table_entries", [
    { property_id: IDS.property, share_number: 1, holder_type: "buyer_account", buyer_account_id: IDS.b1 },
    { property_id: IDS.property, share_number: 2, holder_type: "buyer_account", buyer_account_id: IDS.b2 },
  ]);
  db().seed("capital_account_ledger", [
    { entry_id: "e1", property_id: IDS.property, member_key: IDS.b1, line_type: "opening", amount_cents: "100", balance_after_cents: "100", effective_date: "2026-10-15", seq: 1 },
    { entry_id: "e1", property_id: IDS.property, member_key: IDS.b2, line_type: "opening", amount_cents: "100", balance_after_cents: "100", effective_date: "2026-10-15", seq: 2 },
  ]);
  db().rpcResults.open_property_ledger = { status: "opened", entry_id: "e1" };
  db().rpcResults.backfill_opening_entries = [{ property_id: IDS.property, opening: { status: "already_open" } }];
});

describe("opening the books", () => {
  it("only the Manager opens a ledger or runs the backfill", async () => {
    expect(await openPropertyLedger(db(), { actorId: USERS.admin, propertyId: IDS.property })).toEqual({ status: "opened", entryId: "e1", reason: undefined, capTableChanged: undefined });
    expect(await backfillOpeningEntries(db(), { actorId: USERS.admin })).toEqual([{ propertyId: IDS.property, opening: { status: "already_open", reason: undefined, capTableChanged: undefined }, differences: 0, error: null }]);
    for (const u of [USERS.b1, USERS.hla, USERS.ra, USERS.broker, "u-nobody"]) {
      await expect(openPropertyLedger(db(), { actorId: u, propertyId: IDS.property })).rejects.toThrow("Only the Manager");
      await expect(backfillOpeningEntries(db(), { actorId: u })).rejects.toThrow("Only the Manager");
    }
  });

  it("initial cash is whole cents, zero or more", async () => {
    for (const bad of [-1, 1.5, Number.NaN]) await expect(openPropertyLedger(db(), { actorId: USERS.admin, propertyId: IDS.property, initialCashCents: bad })).rejects.toThrow("whole number of cents");
  });

  it("the reconciliation report is the Manager's, and counts what doesn't match", async () => {
    db().seed("owner_capital_reconciliation", [
      { property_id: IDS.property, user_id: USERS.b1, member_key: IDS.b1, table_contributed_cents: "10", ledger_contributed_cents: "10", table_distributions_cents: "0", ledger_distributions_cents: "0", opening_cents: "100", capital_balance_cents: "110", matches: true },
      { property_id: IDS.property, user_id: USERS.b2, member_key: IDS.b2, table_contributed_cents: "50", ledger_contributed_cents: "0", table_distributions_cents: "0", ledger_distributions_cents: "0", opening_cents: "100", capital_balance_cents: "100", matches: false },
    ]);
    const r = await ownerCapitalReport(db(), { userId: USERS.admin });
    expect(r.mismatches).toBe(1);
    expect(r.rows.find((x) => !x.matches)).toMatchObject({ tableContributedCents: 50, ledgerContributedCents: 0 });
    await expect(ownerCapitalReport(db(), { userId: USERS.b1 })).rejects.toThrow("Not authorized");
  });
});

describe("reading the capital accounts", () => {
  it("the Manager sees every member; a member sees only their own; a Heavy Lifting Agent sees anonymous labels; a stranger nothing", async () => {
    expect((await capitalAccountLedger(db(), { userId: USERS.admin, propertyId: IDS.property })).rows.map((r) => r.member)).toEqual([IDS.b1, IDS.b2]);
    const mine = await capitalAccountLedger(db(), { userId: USERS.b1, propertyId: IDS.property });
    expect(mine.role).toBe("member");
    expect(mine.rows.map((r) => r.member)).toEqual([IDS.b1]);
    const hla = await capitalAccountLedger(db(), { userId: USERS.hla, propertyId: IDS.property });
    expect(hla.rows.map((r) => r.member)).toEqual(["Member 1", "Member 2"]);
    expect(JSON.stringify(hla)).not.toContain(IDS.b1);
    await expect(capitalAccountLedger(db(), { userId: USERS.ra, propertyId: IDS.property })).rejects.toThrow("Not authorized");
  });
});
