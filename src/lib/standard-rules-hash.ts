/**
 * The questions and the engine's rules, as one hash.
 *
 * A published Standard version names the six questions and the rules that turn answers into a result. If either changes,
 * participants who declared under the old ones would be measured by something they never saw, so a change has to come with
 * a new Standard version. Each standard_versions row stores the hash of what it was published with; this module computes
 * the hash of what the code says now, and the guard in standard-rules-check.server.ts compares them.
 *
 * The hash covers three things, in canonical JSON (keys sorted, no spaces):
 *   1. the six questions, word for word;
 *   2. the rule definitions in ENGINE_RULE_SET below;
 *   3. a fingerprint of what evaluateEligibility actually returns across every combination of the six answers and a wide
 *      set of screening facts, so a rule changed in the code but not in the list above still changes the hash.
 */
import { createHash } from "node:crypto";
import { block4Questions } from "@/constants/eligibilityCopy";
import { evaluateEligibility, OFFENSES, type Disposition, type Screening } from "@/lib/eligibility-engine";
import type { DeclarationAnswers } from "@/lib/eligibility-declaration";

export const RULES_CHANGED_MESSAGE = "Questions or rules changed: publish a new Standard version.";

/** The rules, as data. Edit this list WITH the code, and publish a new Standard version. */
export const ENGINE_RULE_SET = {
  results: ["eligible", "held", "not_eligible"],
  not_eligible_when: [
    "q1 is no",
    "q2 is no",
    "q4 is no",
    "sanctions screening is a confirmed match",
    "a declaration is found untrue",
    "the liveness check failed",
    "a charge disclosed at q3 ended in a conviction listed in Standard A",
    "a charge disclosed at q3 ended in a conviction listed in Standard B within ten years of applying",
  ],
  held_when: ["q3 is no (a charge is pending) and no disposition has been recorded that resolves it"],
  no_result_yet_when: [
    "no declaration",
    "q5 (the authorization) is not given",
    "q6 (the ten-day undertaking) is not given",
    "identity is not on file",
    "the liveness check has not passed",
    "the sanctions screening is not clear",
  ],
  standard_b_window_years: 10,
  dispositions_that_do_not_disqualify: ["dismissed", "withdrawn", "acquitted", "nolle_prosequi", "expunged_sealed_or_pardoned", "juvenile_adjudication"],
  offenses: OFFENSES.map((o) => ({ key: o.key, list: o.list, label: o.label })),
} as const;

/** Keys sorted, no whitespace: the same value always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** What the engine returns for every combination of answers and screening facts below. */
export function engineBehaviourFingerprint(evaluate: typeof evaluateEligibility = evaluateEligibility): string {
  const yn = ["yes", "no"] as const;
  const livenessStates: Screening["liveness"][] = [null, "passed", "failed", "inconclusive", "pending"];
  const sanctionStates: Screening["sanctions"][] = [null, "clear", "pending", "possible_match", "confirmed_match"];
  const dispositions: Array<Disposition | null> = [
    null,
    { outcome: "convicted", offenseKey: "A1", dispositionDate: "2020-01-01" },
    { outcome: "convicted", offenseKey: "B1", dispositionDate: "2024-01-01" },
    { outcome: "convicted", offenseKey: "B1", dispositionDate: "2010-01-01" },
    { outcome: "convicted", offenseKey: "none", dispositionDate: "2024-01-01" },
    { outcome: "convicted", offenseKey: null, dispositionDate: "2024-01-01" },
    { outcome: "dismissed", offenseKey: null, dispositionDate: "2024-01-01" },
    { outcome: "expunged_sealed_or_pardoned", offenseKey: null, dispositionDate: "2024-01-01" },
  ];
  const h = createHash("sha256");
  for (const q1 of yn) for (const q2 of yn) for (const q3 of yn) for (const q4 of yn) for (const q5 of yn) for (const q6 of yn) {
    const answers: DeclarationAnswers = { q1, q2, q3, q4, q5, q6 };
    for (const liveness of livenessStates) for (const sanctions of sanctionStates) for (const untrue of [false, true]) for (const identity of [true, false]) for (const disposition of dispositions) {
      const r = evaluate(answers, { identityComplete: identity, liveness, sanctions, declarationFoundUntrue: untrue, disposition, appliedAt: "2026-11-01" });
      h.update(`${r.result}:${r.reason_codes.join("+")};`);
    }
  }
  // And the case with no declaration at all.
  const none = evaluate(null, { identityComplete: true, liveness: "passed", sanctions: "clear", declarationFoundUntrue: false, disposition: null, appliedAt: "2026-11-01" });
  h.update(`${none.result}:${none.reason_codes.join("+")}`);
  return h.digest("hex");
}

export function currentRulesDefinition() {
  return { questions: [...block4Questions], rules: ENGINE_RULE_SET, behaviour: engineBehaviourFingerprint() };
}

/** The hash of the questions and rules this build contains. */
export const currentRulesHash = (): string => sha(canonicalJson(currentRulesDefinition()));
