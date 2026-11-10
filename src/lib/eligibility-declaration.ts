/**
 * Block 4 — Eligibility Declaration and Authorization (shared, no server imports).
 *
 * Each Account Member answers the six questions in block4Questions, one at a time, Yes or No,
 * then confirms block4DeclarationLine with a personal attestation and their typed full legal name.
 * What they swore to is kept as one exact text (the snapshot) and its SHA-256 hash, so it can be
 * shown again, word for word, years later.
 *
 * No consumer report is ever requested from this flow: Q5 is the authorization, nothing more.
 */

import { block4DeclarationLine, block4Questions } from "@/constants/eligibilityCopy";

export type DeclarationAnswer = "yes" | "no";
export type DeclarationAnswers = { q1: DeclarationAnswer; q2: DeclarationAnswer; q3: DeclarationAnswer; q4: DeclarationAnswer; q5: DeclarationAnswer; q6: DeclarationAnswer };
export type DeclarationStatus = "incomplete" | "complete" | "superseded" | "legacy";

export const QUESTION_KEYS = ["q1", "q2", "q3", "q4", "q5", "q6"] as const;
export type QuestionKey = (typeof QUESTION_KEYS)[number];

/** Q5 is the consumer-report authorization. It is required; "No" leaves the declaration incomplete. */
export const AUTHORIZATION_QUESTION: QuestionKey = "q5";

export const Q5_REQUIRED_MESSAGE = "This authorization is required to complete enrollment. You can change your answer at any time.";

export const NAME_MISMATCH_MESSAGE =
  "The name you typed doesn't match the name on your verified ID. Type your full legal name exactly as it appears on the ID you uploaded.";

export const attestationLabel = (fullName: string) => `I am ${fullName} and I am personally making this declaration`;

/** Format of the snapshot text below. Changing the layout means a new version; old records keep theirs. */
export const DECLARATION_TEXT_FORMAT = "block4-v1";

export function parseAnswers(input: unknown): DeclarationAnswers {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out = {} as DeclarationAnswers;
  for (const k of QUESTION_KEYS) {
    const v = src[k];
    if (v !== "yes" && v !== "no") throw new Error("Answer every question Yes or No.");
    out[k] = v;
  }
  return out;
}

/**
 * The exact text a member declared: every question's words, their answer, the declaration line
 * and the Standard's version. This string is what is hashed and what is stored as the snapshot.
 */
export function declarationText(answers: DeclarationAnswers, standardVersion: string): string {
  const lines = [`divieight — Eligibility Declaration and Authorization`, `Participant Eligibility Standard version ${standardVersion}`, `Format ${DECLARATION_TEXT_FORMAT}`, ""];
  QUESTION_KEYS.forEach((k, i) => {
    lines.push(`${i + 1}. ${block4Questions[i]}`, `Answer: ${answers[k] === "yes" ? "Yes" : "No"}`, "");
  });
  lines.push(block4DeclarationLine);
  return lines.join("\n");
}

/** Complete only when the authorization (Q5) is given. "No" to Q5 is never a failed result. */
export function declarationStatusFor(answers: DeclarationAnswers): "incomplete" | "complete" {
  return answers[AUTHORIZATION_QUESTION] === "yes" ? "complete" : "incomplete";
}

/** A "No" to any statement other than the authorization is held for divieight's review — never refused automatically. */
export function needsReview(answers: DeclarationAnswers): boolean {
  return QUESTION_KEYS.some((k) => k !== AUTHORIZATION_QUESTION && answers[k] === "no");
}

/** Case, accents, punctuation and spacing don't count; the letters and their order do. */
export function normalizeLegalName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function legalNamesMatch(typed: string, verified: string): boolean {
  const a = normalizeLegalName(typed);
  return a.length > 0 && a === normalizeLegalName(verified);
}
