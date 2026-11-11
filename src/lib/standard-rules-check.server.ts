/**
 * The guard behind "changing a question or a rule needs a new Standard version". It compares the hash of the questions
 * and rules in this build with the hash stored on the live standard_versions row.
 *
 *  - A new declaration is refused while they differ (buyer and seller), so nobody is measured by questions or rules the
 *    published Standard doesn't describe.
 *  - /api/public/standard-rules-check reports it, so a deploy that changed them is noticed straight away.
 *  - The test in tests/standard-rules-guard.test.ts fails the build the same way.
 * A live version with no stored hash yet (before standard-rules-hash.sql is run) isn't judged.
 */
import { RULES_CHANGED_MESSAGE, currentRulesHash } from "@/lib/standard-rules-hash";

type Db = { from: (t: string) => any };

export interface StandardRulesCheck {
  ok: boolean;
  message: string | null;
  liveVersion: string | null;
  storedHash: string | null;
  currentHash: string;
}

export async function checkStandardRules(db: Db): Promise<StandardRulesCheck> {
  const currentHash = currentRulesHash();
  const { data, error } = await db.from("standard_versions").select("version, rules_hash").eq("is_live", true).maybeSingle();
  const row = data as { version: string; rules_hash: string | null } | null;
  if (error || !row || !row.rules_hash) return { ok: true, message: null, liveVersion: row?.version ?? null, storedHash: null, currentHash };
  if (row.rules_hash === currentHash) return { ok: true, message: null, liveVersion: row.version, storedHash: row.rules_hash, currentHash };
  return { ok: false, message: RULES_CHANGED_MESSAGE, liveVersion: row.version, storedHash: row.rules_hash, currentHash };
}

export async function assertStandardRules(db: Db): Promise<void> {
  const check = await checkStandardRules(db);
  if (!check.ok) throw new Error(check.message ?? RULES_CHANGED_MESSAGE);
}
