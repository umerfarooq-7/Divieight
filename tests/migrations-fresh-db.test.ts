/**
 * Do the repository's migrations apply cleanly on an empty database?
 *
 * Answer today: NO, and this test says exactly why. Several base tables (agents, brokers, pods, platform_settings, authorization_requests and a few more, plus some
 * columns of properties) were created in the Supabase project itself and were never checked in, so every script that builds on them cannot run on an empty database.
 * The fix is one file: dump the production schema (`supabase db dump --schema-only > schema-baseline.sql`) and check it in. This test applies it first when it exists,
 * and from that day it requires every script to apply with no exception.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { BASELINE, NOT_APPLICABLE, PGLITE_AVAILABLE, buildFreshDb, type Built } from "./helpers/fresh-db";

/** The base objects that exist in production but not in the repository. Every failure must trace to one of them. */
const MISSING_BASE = [
  "agents", "brokers", "pods", "platform_settings", "authorization_requests", "authorization_responses", "pending_referral_agreements", "listing_content_items",
  "buyer_attribution", "agent_attribution_tokens", "disbursement_checks", "capital_account_ledger", "deed_recorded_at", "published_at",
];

let built: Built;
beforeAll(async () => {
  if (!PGLITE_AVAILABLE) return;
  built = await buildFreshDb();
}, 600_000);

describe.skipIf(!PGLITE_AVAILABLE)("migrations on an empty database", () => {
  it("every checked-in Supabase migration applies, in order", () => {
    expect(built.failed.filter((f) => f.file.startsWith("supabase/migrations/"))).toEqual([]);
    expect(built.applied.filter((f) => f.startsWith("supabase/migrations/")).length).toBeGreaterThanOrEqual(34);
  });

  it("the scripts that apply, apply with no error, and no script is left out except the two that cannot run on a plain database", () => {
    expect(built.applied.length).toBeGreaterThan(80);
    expect([...NOT_APPLICABLE].sort()).toEqual(["cron-sweeps.sql", "reset-test-data.sql"]);
  });

  if (existsSync(BASELINE)) {
    it("with the production schema baseline checked in, EVERY script applies", () => {
      expect(built.failed).toEqual([]);
    });
  } else {
    it("without a schema baseline, every script that fails fails only because a base object is missing from the repository", () => {
      const unexplained = built.failed.filter((f) => !MISSING_BASE.some((b) => new RegExp(`(relation "public\\.${b}"|column "?(\\w+\\.)?${b}"?)`).test(f.error)));
      expect(unexplained, "a failure that is NOT a missing base object is a real migration bug: fix the script").toEqual([]);
      // Say what is missing, loudly, so nobody mistakes this for "migrations are fine".
      console.warn(`[schema gap] ${built.failed.length} scripts cannot run on an empty database: the base schema was never checked in. Run \`supabase db dump --schema-only > ${BASELINE}\`.`);
      expect(built.failed.length).toBeGreaterThan(0);
    });
  }

  it("the scripts say which must be run first (each header names what it needs)", () => {
    const withHeader = built.applied.filter((f) => !f.startsWith("supabase/")).filter((f) => /^--.*(AFTER|after|Run)/m.test(readFileSync(f, "utf8").slice(0, 1500)));
    expect(withHeader.length).toBeGreaterThan(40);
  });
});
