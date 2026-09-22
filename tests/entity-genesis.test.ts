/** Prompt 1 — cap table stays live and only logs real changes. */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { ensureDigitalGenesis, syncCapTable } from "@/lib/entity-genesis.server";

const db = () => harness.db;

describe("Prompt 1 — Entity Genesis", () => {
  it("creates one standalone LLC + draft OA once, and a share-by-share cap table", async () => {
    seedPod(db());
    const first = await ensureDigitalGenesis(db(), { propertyId: IDS.property, actorId: USERS.b1, reason: "hard_lock" });
    const second = await ensureDigitalGenesis(db(), { propertyId: IDS.property, actorId: USERS.b2, reason: "share_reserved" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(db().table("entity_genesis")).toHaveLength(1);
    expect(db().audits("entity.digital_genesis_created")[0].metadata.structure).toBe("standalone_llc");

    const cap = db().table("cap_table_entries").sort((a, b) => a.share_number - b.share_number);
    expect(cap.map((c) => c.buyer_account_id)).toEqual([IDS.b1, IDS.b2, IDS.b2]);
    expect(cap[0].account_member_names).toEqual(["Alice One", "Bob One"]);
    const lock = Date.parse(cap[0].retention_lock_expires_at) - Date.parse(cap[0].acquisition_date);
    expect(Math.round(lock / 86_400_000)).toBeGreaterThanOrEqual(365);
  });

  it("re-syncing an unchanged cap table does not write a new audit row", async () => {
    seedPod(db());
    await ensureDigitalGenesis(db(), { propertyId: IDS.property, actorId: USERS.b1, reason: "hard_lock" });
    const before = db().audits("entity.cap_table_updated").length;
    // Stored timestamps come back from Postgres as "+00:00", not "Z".
    for (const c of db().table("cap_table_entries"))
      c.acquisition_date = new Date(c.acquisition_date).toISOString().replace("Z", "+00:00");
    const r = await syncCapTable(db(), { propertyId: IDS.property, actorId: USERS.b1, reason: "noop" });
    expect(r.changed).toBe(false);
    expect(db().audits("entity.cap_table_updated").length).toBe(before);
  });

  it("hybrid exit: retained seller shares come first in the cap table", async () => {
    seedPod(db());
    Object.assign(db().table("properties")[0], { exit_type: "hybrid_exit", retained_shares: 2 });
    await syncCapTable(db(), { propertyId: IDS.property, actorId: USERS.b1, reason: "t" });
    const cap = db().table("cap_table_entries").sort((a, b) => a.share_number - b.share_number);
    expect(cap.map((c) => c.holder_type)).toEqual([
      "retained_seller", "retained_seller", "buyer_account", "buyer_account", "buyer_account",
    ]);
  });
});
