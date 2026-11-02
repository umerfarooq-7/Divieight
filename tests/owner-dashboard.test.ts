/** Post-closing Owner Dashboard: who is an owner, the access gate, per-property scoping. */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { getOwnerNavState, getOwnerProperty, listOwnerProperties } from "@/lib/owner.functions";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const A = IDS.property;
const B = "prop-2";

function cap(propertyId: string, shareNumber: number, holder: { buyer?: string; seller?: string }, lockUntil = "2027-10-01T00:00:00.000Z") {
  db().seed("cap_table_entries", [
    {
      property_id: propertyId,
      share_number: shareNumber,
      holder_type: holder.buyer ? "buyer_account" : "retained_seller",
      buyer_account_id: holder.buyer ?? null,
      seller_id: holder.seller ?? null,
      acquisition_date: "2026-10-01T00:00:00.000Z",
      retention_lock_expires_at: lockUntil,
    },
  ]);
}
function close(propertyId: string, holder: { buyer?: string; seller?: string }, status = "active") {
  db().seed("co_owner_digital_keys", [
    {
      property_id: propertyId,
      holder_type: holder.buyer ? "buyer_account" : "retained_seller",
      buyer_account_id: holder.buyer ?? null,
      seller_id: holder.seller ?? null,
      shares: 1,
      status,
    },
  ]);
}
function genesis(propertyId: string, executed = true) {
  db().seed("entity_genesis", [
    { property_id: propertyId, llc_name: "D8 Test, LLC", ein_status: "verified", oa_executed_at: executed ? "2026-10-05T00:00:00.000Z" : null },
  ]);
}

function seed() {
  seedPod(db());
  db().seed("properties", [{ id: B, address: "77 Second St", city: "Casper", state: "WY", zip: "82601", seller_id: "seller-2" }]);
}

const open = (propertyId: string) => getOwnerProperty({ data: { propertyId } });

describe("who can open an owner property", () => {
  it("(1) a user with no cap table row gets nothing about the property", async () => {
    seed();
    cap(A, 1, { buyer: IDS.b1 });
    genesis(A);
    close(A, { buyer: IDS.b1 });
    as(USERS.b3);
    expect(await open(A)).toEqual({ access: "none" });
    expect(await getOwnerNavState()).toEqual({ isOwner: false });
    expect((await listOwnerProperties()).properties).toEqual([]);
    as("u-nobody");
    expect(await open(A)).toEqual({ access: "none" });
  });

  it("(2) an owner of A cannot open B", async () => {
    seed();
    cap(A, 1, { buyer: IDS.b1 });
    genesis(A);
    close(A, { buyer: IDS.b1 });
    cap(B, 1, { buyer: IDS.b2 });
    genesis(B);
    close(B, { buyer: IDS.b2 });
    as(USERS.b1);
    expect((await open(A)).access).toBe("active");
    expect(await open(B)).toEqual({ access: "none" });
  });

  it("(4) a user with shares in two properties sees two cards", async () => {
    seed();
    cap(A, 1, { buyer: IDS.b1 });
    cap(B, 2, { buyer: IDS.b1 });
    cap(B, 3, { buyer: IDS.b1 });
    as(USERS.b1);
    const { properties } = await listOwnerProperties();
    expect(properties.map((p) => [p.propertyId, p.shareCount]).sort()).toEqual([[A, 1], [B, 2]].sort());
    expect(await getOwnerNavState()).toEqual({ isOwner: true });
  });

  it("a retained seller is an owner through seller_id", async () => {
    seed();
    cap(A, 7, { seller: IDS.seller });
    genesis(A);
    close(A, { seller: IDS.seller });
    as(IDS.seller);
    const r = await open(A);
    expect(r.access).toBe("active");
    if (r.access === "active") expect(r.property.shareNumbers).toEqual([7]);
    as(USERS.b1);
    expect(await open(A)).toEqual({ access: "none" });
  });
});

describe("access gate", () => {
  it.each([
    ["no executed Operating Agreement", false, "active"],
    ["a revoked Digital Key", true, "revoked"],
  ])("stays inactive with %s, and shows no owner data", async (_name, executed, keyStatus) => {
    seed();
    cap(A, 1, { buyer: IDS.b1 });
    genesis(A, executed);
    close(A, { buyer: IDS.b1 }, keyStatus);
    as(USERS.b1);
    const r = await open(A);
    expect(r.access).toBe("inactive");
    expect(JSON.stringify(r)).not.toContain("D8 Test");
  });

  it("another holder's Digital Key doesn't open it", async () => {
    seed();
    cap(A, 1, { buyer: IDS.b1 });
    cap(A, 2, { buyer: IDS.b2 });
    genesis(A);
    close(A, { buyer: IDS.b2 });
    as(USERS.b1);
    expect((await open(A)).access).toBe("inactive");
  });

  it("is inactive before closing rather than an error, with no entity row at all", async () => {
    seed();
    cap(A, 1, { buyer: IDS.b1 });
    as(USERS.b1);
    expect((await open(A)).access).toBe("inactive");
  });
});

describe("dashboard data", () => {
  it("returns my shares, the latest Retention Lock, and only my capital account", async () => {
    seed();
    cap(A, 3, { buyer: IDS.b1 }, "2027-10-01T00:00:00.000Z");
    cap(A, 1, { buyer: IDS.b1 }, "2027-12-01T00:00:00.000Z");
    cap(A, 2, { buyer: IDS.b2 }, "2029-01-01T00:00:00.000Z");
    genesis(A);
    close(A, { buyer: IDS.b1 });
    db().seed("owner_capital_accounts", [
      { property_id: A, user_id: USERS.b2, contributed_amount: 999, distributions_amount: 0 },
    ]);
    as(USERS.b1);
    let r = await open(A);
    if (r.access !== "active") throw new Error("expected active");
    expect(r.property).toMatchObject({
      shareCount: 2,
      shareNumbers: [1, 3],
      retentionLockExpiresAt: "2027-12-01T00:00:00.000Z",
      llcName: "D8 Test, LLC",
      einStatus: "verified",
      capital: null,
    });

    db().seed("owner_capital_accounts", [
      { property_id: A, user_id: USERS.b1, contributed_amount: "1000.50", distributions_amount: "200" },
    ]);
    r = await open(A);
    if (r.access !== "active") throw new Error("expected active");
    expect(r.property.capital).toEqual({ contributed: 1000.5, distributions: 200, net: 800.5 });
  });
});
