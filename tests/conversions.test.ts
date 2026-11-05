/** The admin's Conversions page: who can see it, the filters and the sync. The rules themselves run on real Postgres. */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { listConversions, syncConversionsNow } from "@/lib/conversions.functions";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;

function seed() {
  seedPod(db());
  db().seed("buyer_attribution", [{ id: "stamp-1", buyer_user_id: USERS.b1, agent_id: IDS.ra, token_id: "t", stamped_at: "2026-01-01T00:00:00Z" }]);
  db().seed("conversion_events", [
    { id: "c1", buyer_account_id: IDS.b1, property_id: IDS.property, agent_attribution_id: "stamp-1", pra_executed_at: "2026-03-01T10:00:00Z", pef_cleared_at: "2026-03-02T10:00:00Z", converted_at: "2026-03-02T10:00:00Z", status: "converted", created_at: "2026-03-01T10:00:00Z" },
    { id: "c2", buyer_account_id: IDS.b2, property_id: null, agent_attribution_id: null, pra_executed_at: "2026-04-15T10:00:00Z", pef_cleared_at: null, converted_at: null, status: "partial", created_at: "2026-04-15T10:00:00Z" },
  ]);
}
const list = (data: Record<string, unknown> = {}) => {
  as(USERS.admin);
  return listConversions({ data: data as never });
};
const ids = async (data: Record<string, unknown>) => (await list(data)).rows.map((r) => r.id).sort();

describe("/admin/conversions", () => {
  it("is for admins only, reading and syncing", async () => {
    seed();
    for (const user of [USERS.b1, USERS.ra, USERS.broker]) {
      as(user);
      await expect(listConversions({ data: {} })).rejects.toThrow("Not authorized");
      await expect(syncConversionsNow()).rejects.toThrow("Not authorized");
    }
  });

  it("shows the buyer, property, agent, dates and totals", async () => {
    seed();
    const r = await list();
    expect(r.totals).toEqual({ converted: 1, partial: 1 });
    const c1 = r.rows.find((x) => x.id === "c1")!;
    expect(c1).toMatchObject({ status: "converted", agentId: IDS.ra, agentName: "Rita Resident", propertyId: IDS.property, convertedAt: "2026-03-02T10:00:00Z" });
    expect(c1.propertyLabel).toContain("Independence");
    expect(r.rows.find((x) => x.id === "c2")).toMatchObject({ status: "partial", agentName: null, propertyLabel: null });
  });

  it("filters by status, agent, property and date, and totals follow", async () => {
    seed();
    expect(await ids({ status: "converted" })).toEqual(["c1"]);
    expect(await ids({ status: "partial" })).toEqual(["c2"]);
    expect(await ids({ agentId: IDS.ra })).toEqual(["c1"]);
    expect(await ids({ agentId: IDS.ra2 })).toEqual([]);
    expect(await ids({ propertyId: IDS.property })).toEqual(["c1"]);
    expect(await ids({ from: "2026-04-01" })).toEqual(["c2"]);
    expect(await ids({ to: "2026-03-31" })).toEqual(["c1"]);
    expect(await ids({ from: "2026-03-02", to: "2026-03-02" })).toEqual(["c1"]); // the conversion date, not the first event
    expect(await ids({ from: "2026-03-01", to: "2026-03-01" })).toEqual([]);
    expect(await ids({ status: "converted", agentId: IDS.ra, propertyId: IDS.property })).toEqual(["c1"]);
    expect((await list({ status: "partial" })).totals).toEqual({ converted: 0, partial: 1 });
  });

  it("the filter lists keep every option while filtered", async () => {
    seed();
    const r = await list({ status: "partial" });
    expect(r.agents).toEqual([{ id: IDS.ra, label: "Rita Resident" }]);
    expect(r.properties.map((p) => p.id)).toEqual([IDS.property]);
  });

  it("refuses a bad status or date", async () => {
    seed();
    await expect(list({ status: "maybe" })).rejects.toThrow("status");
    await expect(list({ from: "soon" })).rejects.toThrow("date");
  });

  it("Sync now runs the sync and is audited", async () => {
    seed();
    let runs = 0;
    db().rpcResults.sync_conversion_events = () => ((runs += 1), { processed: 2, converted: 1, partial: 1 });
    as(USERS.admin);
    expect(await syncConversionsNow()).toEqual({ processed: 2, converted: 1, partial: 1 });
    expect(runs).toBe(1);
    expect(db().audits("conversion.synced")).toHaveLength(1);
  });
});
