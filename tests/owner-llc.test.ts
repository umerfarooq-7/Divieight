/** Owner LLC page: per-property scoping, no PII in the roster, the Rev 48 floor, and admin edits. */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import {
  deleteGovernanceRule,
  getAdminGovernance,
  getOwnerLlc,
  orderRules,
  postOwnerNotice,
  saveGovernanceRule,
} from "@/lib/owner-llc.functions";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const A = IDS.property;
const B = "prop-2";

function cap(propertyId: string, shareNumber: number, holder: { buyer?: string; seller?: string; names?: string[] }) {
  db().seed("cap_table_entries", [
    {
      property_id: propertyId,
      share_number: shareNumber,
      holder_type: holder.buyer ? "buyer_account" : "retained_seller",
      buyer_account_id: holder.buyer ?? null,
      seller_id: holder.seller ?? null,
      account_member_names: holder.names ?? [],
      acquisition_date: "2026-10-01T00:00:00.000Z",
      retention_lock_expires_at: "2027-10-01T00:00:00.000Z",
    },
  ]);
}

/** A: executed; B1 (shares 1, 2), B2 (share 3), retained seller (share 4). B: B3 only. */
function seed() {
  seedPod(db());
  db().seed("properties", [{ id: B, address: "77 Second St", city: "Casper", state: "WY", zip: "82601", seller_id: "seller-2" }]);
  db().seed("sellers", [{ id: IDS.seller, email: "seller@test.local", phone: "555-0100", full_name: "Sam Seller" }]);
  Object.assign(db().table("buyer_accounts").find((b) => b.id === IDS.b2)!, { phone: "555-0199", target_budget: 987654 });
  cap(A, 1, { buyer: IDS.b1, names: ["Alice One", "Bob One"] });
  cap(A, 2, { buyer: IDS.b1, names: ["Alice One", "Bob One"] });
  cap(A, 3, { buyer: IDS.b2, names: ["Carol Two"] });
  cap(A, 4, { seller: IDS.seller });
  cap(B, 1, { buyer: IDS.b3, names: ["Dan Three"] });
  db().seed("entity_genesis", [
    { property_id: A, llc_name: "D8 A, LLC", oa_executed_at: "2026-10-05T00:00:00.000Z", executed_oa_url: "entity-genesis/a/oa.md", final_oa_text: "THE AGREEMENT TEXT", final_oa_hash: "sha256:abc" },
    { property_id: B, llc_name: "D8 B, LLC" },
  ]);
  for (const holder of [{ buyer_account_id: IDS.b1, holder_type: "buyer_account" }, { buyer_account_id: IDS.b2, holder_type: "buyer_account" }])
    db().seed("co_owner_digital_keys", [{ property_id: A, shares: 1, status: "active", seller_id: null, ...holder }]);
  db().seed("governance_rules", [
    { id: "d1", property_id: null, section_key: "one_vote_per_share", title: "One vote", body: "Default body", sort_order: 10 },
    { id: "d2", property_id: null, section_key: "capital_calls", title: "Capital calls", body: "Default capital", sort_order: 60 },
  ]);
  db().seed("owner_notices", [
    { id: "n-a", property_id: A, title: "A notice", body: "for A", created_at: "2026-10-10T00:00:00.000Z" },
    { id: "n-b", property_id: B, title: "B notice", body: "for B", created_at: "2026-10-10T00:00:00.000Z" },
  ]);
}

const open = (propertyId: string) => getOwnerLlc({ data: { propertyId } });
async function ownerView(propertyId: string) {
  const r = await open(propertyId);
  if (r.access !== "owner") throw new Error("expected owner access");
  return r;
}

describe("scoping", () => {
  it("an owner of A can't read B's roster, notices or agreement; a stranger gets nothing", async () => {
    seed();
    as(USERS.b1);
    expect(await open(B)).toEqual({ access: "none" });
    as("u-nobody");
    expect(await open(A)).toEqual({ access: "none" });
    as(USERS.b3);
    expect(await open(A)).toEqual({ access: "none" });
    const b = await ownerView(B);
    expect(b.notices.map((n) => n.id)).toEqual(["n-b"]);
    expect(JSON.stringify(b)).not.toContain("Carol");
  });
});

describe("roster", () => {
  it("groups holders with names, share numbers and dates, and labels the retained seller", async () => {
    seed();
    as(USERS.b1);
    const { roster } = await ownerView(A);
    expect(roster).toEqual([
      { name: "Alice One & Bob One", holderLabel: "Co-owner", shareNumbers: [1, 2], acquisitionDate: "2026-10-01T00:00:00.000Z", isMe: true },
      { name: "Carol Two", holderLabel: "Co-owner", shareNumbers: [3], acquisitionDate: "2026-10-01T00:00:00.000Z", isMe: false },
      { name: "Sam Seller", holderLabel: "Seller co-owner (retained)", shareNumbers: [4], acquisitionDate: "2026-10-01T00:00:00.000Z", isMe: false },
    ]);
  });

  it("carries no PII or internal ids beyond names", async () => {
    seed();
    as(USERS.b1);
    const text = JSON.stringify((await ownerView(A)).roster);
    for (const secret of ["@test.local", "555-01", "987654", IDS.b2, IDS.seller, USERS.b2]) expect(text).not.toContain(secret);
  });

  it("stays closed until ownership is active", async () => {
    seed();
    db().table("co_owner_digital_keys").find((k) => k.buyer_account_id === IDS.b1)!.status = "revoked";
    as(USERS.b1);
    expect((await ownerView(A)).roster).toBeNull();
  });
});

describe("Rev 48 floor", () => {
  it("the agreement, rules and notices stay open whatever the key's status", async () => {
    seed();
    db().table("co_owner_digital_keys").find((k) => k.buyer_account_id === IDS.b1)!.status = "revoked";
    as(USERS.b1);
    const view = await ownerView(A);
    expect(view.operatingAgreement).toMatchObject({ text: "THE AGREEMENT TEXT", hash: "sha256:abc", executedAt: "2026-10-05T00:00:00.000Z" });
    expect(view.operatingAgreement!.downloadUrl).toContain("entity-genesis/a/oa.md");
    expect(view.rules).toHaveLength(2);
    expect(view.notices.map((n) => n.id)).toEqual(["n-a"]);
  });

  it("shows no agreement when none is executed, without blocking the rest", async () => {
    seed();
    as(USERS.b3);
    const view = await ownerView(B);
    expect(view.operatingAgreement).toBeNull();
    expect(view.rules).toHaveLength(2);
  });
});

describe("governance rules", () => {
  it("lists property rows first, and a property's row replaces the default with its key", () => {
    const rule = (id: string, property_id: string | null, section_key: string, sort_order: number) => ({ id, property_id, section_key, sort_order, title: id, body: id });
    const ordered = orderRules([
      rule("d-a", null, "a", 1),
      rule("d-b", null, "b", 2),
      rule("p-z", A, "z", 9),
      rule("p-b", A, "b", 5),
    ]);
    expect(ordered.map((r) => r.id)).toEqual(["p-b", "p-z", "d-a"]);
  });

  it("an admin's edit reaches that property's owners, not other properties or the default", async () => {
    seed();
    as(USERS.admin);
    await saveGovernanceRule({ data: { propertyId: A, sectionKey: "capital_calls", title: "Capital calls", body: "Custom for A" } });
    await saveGovernanceRule({ data: { propertyId: A, title: "New rule", body: "Only A", sortOrder: 1 } });

    as(USERS.b1);
    const a = await ownerView(A);
    expect(a.rules.map((r) => r.body)).toEqual(["Custom for A", "Only A", "Default body"]);
    as(USERS.b3);
    expect((await ownerView(B)).rules.map((r) => r.body)).toEqual(["Default body", "Default capital"]);
    expect(db().table("governance_rules").find((r) => r.id === "d2")!.body).toBe("Default capital");

    as(USERS.admin);
    await saveGovernanceRule({ data: { propertyId: A, sectionKey: "capital_calls", title: "Capital calls", body: "Edited again" } });
    expect(db().table("governance_rules").filter((r) => r.property_id === A && r.section_key === "capital_calls")).toHaveLength(1);
    await deleteGovernanceRule({ data: { propertyId: A, sectionKey: "capital_calls" } });
    expect((await getAdminGovernance({ data: { propertyId: A } })).rules.find((r) => r.section_key === "capital_calls")!.id).toBe("d2");
    expect(db().audits("governance.rule_saved").length).toBe(3);
  });

  it("deleting from a property can't remove a default", async () => {
    seed();
    as(USERS.admin);
    await deleteGovernanceRule({ data: { propertyId: A, sectionKey: "one_vote_per_share" } });
    expect(db().table("governance_rules").find((r) => r.id === "d1")).toBeTruthy();
  });
});

describe("admin only", () => {
  it("rejects everyone else", async () => {
    seed();
    as(USERS.b1);
    await expect(getAdminGovernance({ data: { propertyId: A } })).rejects.toThrow("Not authorized");
    await expect(saveGovernanceRule({ data: { propertyId: A, title: "x", body: "y" } })).rejects.toThrow("Not authorized");
    await expect(deleteGovernanceRule({ data: { propertyId: A, sectionKey: "x" } })).rejects.toThrow("Not authorized");
    await expect(postOwnerNotice({ data: { propertyId: A, title: "x", body: "y" } })).rejects.toThrow("Not authorized");
  });

  it("a posted notice shows on that property only", async () => {
    seed();
    as(USERS.admin);
    await postOwnerNotice({ data: { propertyId: A, title: "Roof work", body: "Next week" } });
    as(USERS.b1);
    expect((await ownerView(A)).notices.map((n) => n.title)).toContain("Roof work");
    as(USERS.b3);
    expect((await ownerView(B)).notices.map((n) => n.title)).not.toContain("Roof work");
  });
});
