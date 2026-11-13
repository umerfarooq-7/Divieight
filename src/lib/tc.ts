/**
 * Versioned Terms and Conditions: client-safe rules. Which version is in force on a day, the side-by-side marked diff between two versions, what a material
 * revision must carry before it can be published, and the words of the change notice. No database here, so every rule is unit-tested.
 */
import { diffLines, diffWords } from "diff";
import { TERMS_EFFECTIVE, TERMS_TEXT, TERMS_VERSION } from "@/lib/terms";

export interface TcVersion {
  id: string;
  version: string;
  effective_date: string;
  body: string;
  is_material: boolean;
  summary_of_changes: string | null;
  published_by: string | null;
  published_at: string;
  previous_version_id: string | null;
  is_current: boolean;
}

/** The first version: the Terms as they stood when versioning began. It is never a "change" and notifies no one. */
export const BASELINE = { version: TERMS_VERSION, effectiveDate: isoDay(TERMS_EFFECTIVE), body: TERMS_TEXT };

function isoDay(text: string): string {
  const d = new Date(`${text} UTC`);
  return Number.isNaN(d.getTime()) ? "2026-11-13" : d.toISOString().slice(0, 10);
}

export const today = (now: Date = new Date()) => now.toISOString().slice(0, 10);

/** The version people are bound by on a given day: the newest whose effective date has arrived. A published but not yet effective version is "upcoming". */
export function inForceVersion<T extends { effective_date: string; published_at: string }>(versions: T[], day: string = today()): T | null {
  const effective = versions.filter((v) => v.effective_date <= day);
  effective.sort((a, b) => b.effective_date.localeCompare(a.effective_date) || String(b.published_at).localeCompare(String(a.published_at)));
  return effective[0] ?? null;
}

export function upcomingVersion<T extends { effective_date: string; published_at: string }>(versions: T[], day: string = today()): T | null {
  const later = versions.filter((v) => v.effective_date > day);
  later.sort((a, b) => a.effective_date.localeCompare(b.effective_date));
  return later[0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------
// Publishing rules
// ---------------------------------------------------------------------------------------------------------
export const MIN_SUMMARY_CHARS = 10;

export interface PublishInput {
  version: string;
  effectiveDate: string;
  body: string;
  isMaterial: boolean;
  summary: string;
}

/** What is wrong with a proposed publication, or null. A MATERIAL revision must say what changed. */
export function publishProblem(input: PublishInput, existing: Array<{ version: string; body: string }>, day: string = today()): string | null {
  if (!/^\d+(\.\d+){0,2}$/.test(input.version.trim())) return "The version is a number such as 1.1 or 2.0.";
  if (existing.some((v) => v.version === input.version.trim())) return `Version ${input.version.trim()} already exists. Versions are never edited: publish a new number.`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate) || Number.isNaN(new Date(input.effectiveDate).getTime())) return "Enter the effective date.";
  if (input.effectiveDate < day) return "The effective date cannot be in the past: people must be able to read a revision before it binds them.";
  if (!input.body.trim()) return "The text of the Terms is empty.";
  if (existing.length && existing.some((v) => v.body.trim() === input.body.trim())) return "This text is identical to a version already published.";
  if (input.isMaterial && input.summary.trim().length < MIN_SUMMARY_CHARS) return `A material revision needs a summary of changes (at least ${MIN_SUMMARY_CHARS} characters): it is what every user is sent.`;
  return null;
}

export const diffPath = (fromVersion: string, toVersion: string) => `/terms-changes?from=${encodeURIComponent(fromVersion)}&to=${encodeURIComponent(toVersion)}`;

/** The in-app notification and the email carry the same words: the summary, the effective date, and where to see the diff. */
export function noticeMessage(p: { version: string; effectiveDate: string; summary: string; diffUrl: string }): { subject: string; message: string } {
  return {
    subject: `Terms and Conditions update: version ${p.version} takes effect ${p.effectiveDate}`,
    message: `We are updating the divieight Terms and Conditions to version ${p.version}, effective ${p.effectiveDate}. Summary of changes: ${p.summary.trim()} See exactly what changed, side by side: ${p.diffUrl} If you keep using divieight after ${p.effectiveDate}, you are accepting version ${p.version}, as the Terms provide. You do not need to sign anything.`,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The marked, side-by-side diff
// ---------------------------------------------------------------------------------------------------------
export interface Seg {
  text: string;
  mark?: "add" | "del";
}
export interface DiffRow {
  kind: "same" | "added" | "removed" | "changed";
  left: Seg[] | null;
  right: Seg[] | null;
  leftNo: number | null;
  rightNo: number | null;
}
export interface TermsDiff {
  rows: DiffRow[];
  stats: { added: number; removed: number; changed: number; unchanged: number };
}

const lines = (value: string) => {
  const v = value.endsWith("\n") ? value.slice(0, -1) : value;
  return v === "" && value === "" ? [] : v.split("\n");
};

/** Line by line, with the words that changed inside a changed line marked on both sides. */
export function buildDiff(previous: string, next: string): TermsDiff {
  const parts = diffLines(previous.replace(/\r\n/g, "\n"), next.replace(/\r\n/g, "\n"));
  const rows: DiffRow[] = [];
  let l = 0;
  let r = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p.added && !p.removed) {
      for (const text of lines(p.value)) rows.push({ kind: "same", left: [{ text }], right: [{ text }], leftNo: ++l, rightNo: ++r });
      continue;
    }
    // A run of removed lines followed by added lines is a rewrite: pair them up.
    let removed: string[] = [];
    let added: string[] = [];
    if (p.removed) {
      removed = lines(p.value);
      if (parts[i + 1]?.added) added = lines(parts[++i]!.value);
    } else {
      added = lines(p.value);
    }
    const n = Math.max(removed.length, added.length);
    for (let k = 0; k < n; k++) {
      const a = removed[k];
      const b = added[k];
      if (a !== undefined && b !== undefined) {
        const words = diffWords(a, b);
        rows.push({
          kind: "changed",
          left: words.filter((w) => !w.added).map((w) => ({ text: w.value, mark: w.removed ? ("del" as const) : undefined })),
          right: words.filter((w) => !w.removed).map((w) => ({ text: w.value, mark: w.added ? ("add" as const) : undefined })),
          leftNo: ++l,
          rightNo: ++r,
        });
      } else if (a !== undefined) {
        rows.push({ kind: "removed", left: [{ text: a, mark: "del" }], right: null, leftNo: ++l, rightNo: null });
      } else if (b !== undefined) {
        rows.push({ kind: "added", left: null, right: [{ text: b, mark: "add" }], leftNo: null, rightNo: ++r });
      }
    }
  }
  const count = (k: DiffRow["kind"]) => rows.filter((x) => x.kind === k).length;
  return { rows, stats: { added: count("added"), removed: count("removed"), changed: count("changed"), unchanged: count("same") } };
}
