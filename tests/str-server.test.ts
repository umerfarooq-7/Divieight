/** Month 6, Prompt 7, the app side: the owner's STR tracker, the hidden tracker, the Manager's lodging-tax flag, and the wording. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, USERS, IDS } from "./fixtures";
import * as str from "@/lib/str.server";
import * as books from "@/lib/books.server";
import { LODGING_TAX_FLAG_TITLE, OWNER_STR_NOTICE, STR_LLC_WARNING, strRecordProblem, strTrackerAllowed } from "@/lib/str";
import { reviewReasonLabel } from "@/lib/bank-feed";

const db = () => harness.db as any;
const A = IDS.property;

const input = (o: Record<string, unknown> = {}) => ({ userId: USERS.b1, propertyId: A, periodStart: "2026-07-01", periodEnd: "2026-07-14", nights: 9, grossCents: 250_000, feesCents: 30_000, lodgingTaxStatus: "owed" as const, ...o });
const setUsage = (usage: string | null) => {
  db().table("properties").forEach((p: any) => { if (p.id === A) p.usage_tag = usage; });
};

beforeEach(() => {
  seedPod(db());
  db().seed("cap_table_entries", [
    { property_id: A, share_number: 1, holder_type: "buyer_account", buyer_account_id: IDS.b1 },
    { property_id: A, share_number: 2, holder_type: "buyer_account", buyer_account_id: IDS.b2 },
  ]);
  setUsage("short_term_rental");
  db().seed("owner_str_records", [
    { id: "r1", property_id: A, member_key: IDS.b1, period_start: "2026-07-01", period_end: "2026-07-14", nights: 9, gross_amount_cents: 250_000, platform_fees_cents: 30_000, lodging_tax_status: "owed", lodging_tax_note: "County form due", entered_by_member_id: IDS.b1 },
    { id: "r2", property_id: A, member_key: IDS.b2, period_start: "2026-08-01", period_end: "2026-08-07", nights: 5, gross_amount_cents: 99_900, platform_fees_cents: 0, lodging_tax_status: "unknown", lodging_tax_note: null, entered_by_member_id: IDS.b2 },
  ]);
  db().rpcResults.save_owner_str_record = vi.fn(() => "r-new");
  db().rpcResults.delete_owner_str_record = vi.fn(() => null);
  db().rpcResults.lodging_tax_exposure = [{ member_key: IDS.b2, statuses: ["unknown"], record_count: 1 }];
});

describe("the owner's tracker", () => {
  it("an owner sees their own records, newest first, and never another owner's", async () => {
    const r = await str.ownerStrView(db(), { userId: USERS.b1, propertyId: A });
    expect(r).toMatchObject({ allowed: true, trackerEnabled: true });
    expect(r.records.map((x) => x.id)).toEqual(["r1"]);
    expect(r.records[0]).toMatchObject({ nights: 9, grossCents: 250_000, feesCents: 30_000, lodgingTaxStatus: "owed", lodgingTaxNote: "County form due" });
    const theirs = JSON.stringify(await str.ownerStrView(db(), { userId: USERS.b1, propertyId: A }));
    expect(theirs).not.toContain("99900");
    expect((await str.ownerStrView(db(), { userId: USERS.b2, propertyId: A })).records.map((x) => x.id)).toEqual(["r2"]);
  });

  it("someone who owns nothing here gets nothing at all", async () => {
    for (const u of [USERS.b3, USERS.ra, USERS.hla, USERS.broker, USERS.admin, "u-nobody"]) expect(await str.ownerStrView(db(), { userId: u, propertyId: A }), u).toEqual({ allowed: false, trackerEnabled: false, records: [] });
  });

  it("a pod whose intent profile doesn't allow STR hides the tracker, reads nothing and refuses a save", async () => {
    for (const usage of ["owner_occupied", null, "something_else"]) {
      setUsage(usage);
      expect(await str.ownerStrView(db(), { userId: USERS.b1, propertyId: A }), String(usage)).toEqual({ allowed: true, trackerEnabled: false, records: [] });
      await expect(str.saveStrRecord(db(), input())).rejects.toThrow("doesn't include short-term rental");
    }
    expect(db().rpcCalls?.filter?.((c: any) => c.fn === "save_owner_str_record") ?? []).toHaveLength(0);
    expect(strTrackerAllowed("short_term_rental")).toBe(true);
    expect(strTrackerAllowed("owner_occupied")).toBe(false);
    expect(strTrackerAllowed(null)).toBe(false);
  });

  it("saving checks the record first, then hands it to the database as the owner", async () => {
    const spy = vi.fn(() => "r-new");
    db().rpcResults.save_owner_str_record = spy;
    expect(await str.saveStrRecord(db(), input({ lodgingTaxNote: "Remit by the 20th" }))).toEqual({ id: "r-new" });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ _property: A, _user: USERS.b1, _gross_cents: 250_000, _fees_cents: 30_000, _tax_status: "owed", _tax_note: "Remit by the 20th" }));
    for (const bad of [{ nights: 20 }, { feesCents: 999_999 }, { periodEnd: "2026-06-01" }, { grossCents: 1.5 }, { lodgingTaxStatus: "maybe" }]) await expect(str.saveStrRecord(db(), input(bad as any))).rejects.toThrow();
    await expect(str.saveStrRecord(db(), input({ userId: USERS.b3 }))).rejects.toThrow("don't have ownership");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("the record check", () => {
    const base = { periodStart: "2026-07-01", periodEnd: "2026-07-14", nights: 9, grossCents: 100, feesCents: 10, lodgingTaxStatus: "owed" };
    expect(strRecordProblem(base)).toBeNull();
    expect(strRecordProblem({ ...base, nights: 15 })).toMatch(/more nights/);
    expect(strRecordProblem({ ...base, feesCents: 101 })).toMatch(/can't be more than/);
    expect(strRecordProblem({ ...base, periodEnd: "2026-06-30" })).toMatch(/can't end before/);
    expect(strRecordProblem({ ...base, lodgingTaxStatus: "x" })).toMatch(/lodging-tax status/);
  });

  it("is recordkeeping only: the tracker's code never posts to the ledger or reads an LLC report", () => {
    for (const f of ["src/lib/str.server.ts", "src/lib/str.functions.ts", "src/routes/owner.properties.$propertyId.str.tsx"]) {
      const code = readFileSync(f, "utf8");
      expect(code, f).not.toMatch(/post_entry|post_manual_entry|journal_|capital_account_ledger|trial_balance|ledgerTrialBalance|bookkeeping\./);
    }
    const server = readFileSync("src/lib/str.server.ts", "utf8");
    expect(server).not.toMatch(/\.reduce\(|sum\(|total/i); // nothing adds the amounts up
  });
});

describe("the wording", () => {
  it("the owner portal says STR income is the owner's, word for word", () => {
    expect(OWNER_STR_NOTICE).toBe("Short-term rental income from your own weeks is yours, not the LLC's. You are responsible for reporting it and any lodging taxes. divieight records it for your convenience and does not file or remit on your behalf.");
    expect(readFileSync("src/routes/owner.properties.$propertyId.str.tsx", "utf8")).toContain("OWNER_STR_NOTICE");
  });

  it("a deposit that looks like STR carries the warning and says it can only be ignored or reclassified", () => {
    expect(STR_LLC_WARNING).toBe("STR income does not belong to the LLC");
    expect(reviewReasonLabel("looks_like_str_revenue")).toContain("STR income does not belong to the LLC");
    expect(reviewReasonLabel("looks_like_str_revenue")).toMatch(/only be ignored or reclassified/);
    const page = readFileSync("src/routes/admin.books.$propertyId.tsx", "utf8");
    expect(page).toContain("STR_LLC_WARNING");
    expect(page).toContain("Reclassify as the owner's");
    expect(page).toContain("{!isStr ? (");
  });
});

describe("the Manager", () => {
  it("reclassifying a deposit reaches the database as the Manager, and nobody else can", async () => {
    const spy = vi.fn(() => null);
    db().rpcResults.reclassify_str_deposit = spy;
    await books.reclassifyStrDeposit(db(), { actorId: USERS.admin, transactionId: "t1", reason: "Dana's own week" });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ _txn: "t1", _reason: "Dana's own week", _actor: USERS.admin }));
    for (const u of [USERS.b1, USERS.hla, USERS.ra, USERS.broker, "u-nobody"]) await expect(books.reclassifyStrDeposit(db(), { actorId: u, transactionId: "t1", reason: "x" })).rejects.toThrow("Only the Manager");
  });

  it("reads the lodging-tax flag: who, with their status, and no amounts", async () => {
    const r = await str.lodgingTaxExposure(db(), { userId: USERS.admin, propertyId: A });
    expect(r.rows).toEqual([{ member: "b2@test.local", statuses: ["unknown"], recordCount: 1 }]);
    expect(JSON.stringify(r)).not.toMatch(/cents|amount|gross|99900/i);
    for (const u of [USERS.b1, USERS.b2, USERS.hla, USERS.ra, USERS.broker, "u-nobody"]) await expect(str.lodgingTaxExposure(db(), { userId: u, propertyId: A })).rejects.toThrow("Only the Manager");
  });

  it("the flag appears on the books page, titled for the worksheet", () => {
    expect(LODGING_TAX_FLAG_TITLE).toBe("State and local lodging-tax exposure");
    expect(readFileSync("src/routes/admin.books.$propertyId.tsx", "utf8")).toContain("LODGING_TAX_FLAG_TITLE");
  });

  it("the pages are wired in", () => {
    expect(readFileSync("src/routes/owner.properties.$propertyId.index.tsx", "utf8")).toContain("Short-term rental records");
    expect(readFileSync("src/routeTree.gen.ts", "utf8")).toContain("/owner/properties/$propertyId/str");
  });
});
