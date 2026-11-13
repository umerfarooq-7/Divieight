/** Launch readiness: the founder-only list, its audited edits, and the admin-only deployment warnings. */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, USERS } from "./fixtures";
import { LAUNCH_ITEMS, LAUNCH_ITEM_KEYS, LAUNCH_STATUSES } from "@/lib/launch-readiness";
import { computeLaunchWarnings, listLaunchItems } from "@/lib/launch-readiness.server";
import { getAdminLaunchWarnings, getLaunchReadiness, saveLaunchItem } from "@/lib/launch-readiness.functions";

const db = () => harness.db;
const as = (u: string) => (harness.userId = u);
const FOUNDER = "u-founder";

beforeEach(() => {
  seedPod(db());
  db().rpcResults.has_role = (a: { _user_id: string; _role: string }) => (a._role === "admin" && [USERS.admin, FOUNDER].includes(a._user_id)) || (a._role === "founder" && a._user_id === FOUNDER);
});

describe("the list", () => {
  it("has every placeholder or simulated part that was named, each with a status and a detail", () => {
    expect(LAUNCH_ITEM_KEYS).toEqual([
      "stripe_test_mode", "stripe_webhook", "stripe_live_keys", "title_escrow", "liveness_vendor", "sanctions_vendor", "plaid", "insurance_minimums",
      "oa_draft_clauses", "governance_thresholds", "standard_q5_copy", "adverse_action_template", "kyo_list", "joint_interest", "usage_adjusted_allocation", "distribution_minimum_reserve", "ach_disbursements", "statement_holiday_calendar", "year_end_json_validation", "learning_library", "w9_encryption_key",
    ]);
    expect([...LAUNCH_STATUSES]).toEqual(["Placeholder", "Simulated", "Test mode", "Needs counsel", "Done"]);
    for (const item of LAUNCH_ITEMS) {
      expect(LAUNCH_STATUSES).toContain(item.status);
      expect(item.detail.length).toBeGreaterThan(20);
    }
    const status = Object.fromEntries(LAUNCH_ITEMS.map((i) => [i.key, i.status]));
    expect(status).toMatchObject({ stripe_test_mode: "Test mode", title_escrow: "Simulated", liveness_vendor: "Simulated", sanctions_vendor: "Simulated", plaid: "Test mode", oa_draft_clauses: "Needs counsel", adverse_action_template: "Needs counsel", kyo_list: "Needs counsel", joint_interest: "Needs counsel", standard_q5_copy: "Needs counsel", insurance_minimums: "Placeholder", learning_library: "Placeholder", w9_encryption_key: "Placeholder" });
  });

  it("only a founder opens it: another admin and a buyer get a 403", async () => {
    const { setResponseStatus } = await import("@tanstack/react-start/server");
    for (const user of [USERS.admin, USERS.b1, USERS.ra]) {
      as(user);
      await expect(getLaunchReadiness()).rejects.toThrow("Not authorized");
      await expect(saveLaunchItem({ data: { key: "plaid", status: "Done", owner: "x", notes: "y" } })).rejects.toThrow("Not authorized");
    }
    expect(setResponseStatus).toHaveBeenCalledWith(403);
    as(FOUNDER);
    expect((await getLaunchReadiness()).items).toHaveLength(21);
    expect(db().table("launch_readiness_items")).toHaveLength(0);
  });

  it("the page and the navigation are founder only", () => {
    expect(readFileSync("src/routes/admin.tsx", "utf8")).toMatch(/item\.to !== "\/admin\/launch-readiness"\) \|\| roles\?\.isFounder === true/);
    expect(readFileSync("src/routes/admin.launch-readiness.tsx", "utf8")).toMatch(/Only founders can open Launch readiness/);
  });
});

describe("editing", () => {
  it("a founder changes the status, owner and notes; it is saved, shown, and audit logged with what it was before", async () => {
    as(FOUNDER);
    const r = await saveLaunchItem({ data: { key: "liveness_vendor", status: "Done", owner: "Mark", notes: "Persona contract signed" } });
    expect(r.items.find((i) => i.key === "liveness_vendor")).toMatchObject({ status: "Done", owner: "Mark", notes: "Persona contract signed" });
    expect(r.items.find((i) => i.key === "sanctions_vendor")).toMatchObject({ status: "Simulated", owner: "", notes: "" }); // untouched
    const log = db().audits("launch_readiness.updated");
    expect(log).toHaveLength(1);
    expect(log[0]!.actor_id).toBe(FOUNDER);
    expect(log[0]!.metadata).toMatchObject({ key: "liveness_vendor", before: { status: "Simulated", owner: "", notes: "" }, after: { status: "Done", owner: "Mark", notes: "Persona contract signed" } });
    // A second change records the first as its 'before'.
    await saveLaunchItem({ data: { key: "liveness_vendor", status: "Needs counsel", owner: "Mark", notes: "Reviewing the DPA" } });
    expect(db().audits("launch_readiness.updated")[1]!.metadata).toMatchObject({ before: { status: "Done" }, after: { status: "Needs counsel" } });
    expect((await listLaunchItems(db() as never)).find((i) => i.key === "liveness_vendor")!.status).toBe("Needs counsel");
  });

  it("refuses an unknown item or status", async () => {
    as(FOUNDER);
    await expect(saveLaunchItem({ data: { key: "nonsense", status: "Done", owner: "", notes: "" } })).rejects.toThrow("Unknown item");
    await expect(saveLaunchItem({ data: { key: "plaid", status: "Mostly done", owner: "", notes: "" } })).rejects.toThrow("Status must be one of");
    expect(db().table("launch_readiness_items")).toHaveLength(0);
    expect(db().audits("launch_readiness.updated")).toHaveLength(0);
  });

  it("a stored status that isn't valid is ignored in favour of the default", async () => {
    db().seed("launch_readiness_items", [{ key: "plaid", status: "bogus", owner: "x", notes: "n" }]);
    expect((await listLaunchItems(db() as never)).find((i) => i.key === "plaid")!.status).toBe("Test mode");
  });

  it("the database stores the same statuses, behind the server only", () => {
    const sql = readFileSync("launch-readiness.sql", "utf8");
    expect(sql).toContain("CHECK (status IN ('Placeholder', 'Simulated', 'Test mode', 'Needs counsel', 'Done'))");
    expect(sql).toMatch(/REVOKE ALL ON public\.launch_readiness_items FROM anon, authenticated/);
  });
});

describe("the admin-only warnings", () => {
  const sim = { liveness: "simulated", sanctions: "simulated" };
  const keys = (env: Record<string, string | undefined>, providers = sim) => computeLaunchWarnings(env, providers).map((w) => w.key);

  it("warns when W9_TIN_ENCRYPTION_KEY is missing", () => {
    expect(keys({})).toContain("w9_key_missing");
    expect(keys({ W9_TIN_ENCRYPTION_KEY: "k" })).not.toContain("w9_key_missing");
  });

  it("warns when Stripe is in test mode", () => {
    expect(keys({ STRIPE_SECRET_KEY: "sk_test_abc" })).toContain("stripe_test_mode");
    expect(keys({ STRIPE_SECRET_KEY: "sk_live_abc" })).not.toContain("stripe_test_mode");
  });

  it("warns about simulated adapters only while IS_PRODUCTION is true", () => {
    const base = { W9_TIN_ENCRYPTION_KEY: "k", STRIPE_SECRET_KEY: "sk_live_x" };
    expect(computeLaunchWarnings(base, sim)).toEqual([]);
    expect(computeLaunchWarnings({ ...base, IS_PRODUCTION: "false" }, sim)).toEqual([]);
    expect(keys({ ...base, IS_PRODUCTION: "true" })).toEqual(["liveness_simulated", "sanctions_simulated", "title_simulated", "plaid_sandbox"]);
    expect(computeLaunchWarnings({ ...base, IS_PRODUCTION: "true" }, sim).map((w) => w.message)).toContain("IS_PRODUCTION is true but the liveness vendor is simulated.");
  });

  it("a real vendor, or real title credentials, clears that warning", () => {
    const env = { W9_TIN_ENCRYPTION_KEY: "k", STRIPE_SECRET_KEY: "sk_live_x", IS_PRODUCTION: "true", QUALIA_API_URL: "u", QUALIA_API_TOKEN: "t" };
    expect(keys(env, { liveness: "persona", sanctions: "simulated" })).toEqual(["sanctions_simulated", "plaid_sandbox"]);
  });

  it("only an admin gets them", async () => {
    as(USERS.b1);
    await expect(getAdminLaunchWarnings()).rejects.toThrow("Not authorized");
    as(USERS.admin);
    expect((await getAdminLaunchWarnings()).warnings.every((w) => typeof w.message === "string")).toBe(true);
    expect(readFileSync("src/routes/admin.tsx", "utf8")).toMatch(/<LaunchWarningsBanner enabled=\{isAdmin\} \/>/);
  });
});
