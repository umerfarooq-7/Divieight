/**
 * Pure helpers behind the document reader: the table of contents, in-document search, live cross-references between documents, text scaling, and the
 * "reached the bottom" test. No React, so every rule here is unit-tested.
 */

export const MIN_FONT_PX = 14;
export const TEXT_SCALES = [100, 115, 130, 150, 175, 200] as const;
export type TextScale = (typeof TEXT_SCALES)[number];

/** The reading size in px for a scale. Never below the 14px floor. */
export function fontPx(scale: number): number {
  return Math.max(MIN_FONT_PX, Math.round((MIN_FONT_PX * scale) / 100));
}

export function clampScale(value: unknown): TextScale {
  const n = Number(value);
  if (!Number.isFinite(n)) return 100;
  return TEXT_SCALES.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), 100 as TextScale);
}

export function stepScale(current: number, direction: 1 | -1): TextScale {
  const i = TEXT_SCALES.indexOf(clampScale(current));
  return TEXT_SCALES[Math.min(TEXT_SCALES.length - 1, Math.max(0, i + direction))]!;
}

/** The scroll position counts as "the bottom" within a few pixels, and a document that fits without scrolling counts as read to the end. */
export function reachedEnd(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, slackPx = 8): boolean {
  if (el.scrollHeight - el.clientHeight <= slackPx) return true;
  return el.scrollTop + el.clientHeight >= el.scrollHeight - slackPx;
}

// ---------------------------------------------------------------------------------------------------------
// Structure and table of contents
// ---------------------------------------------------------------------------------------------------------
export interface Block {
  kind: "heading" | "para" | "blank";
  text: string;
  /** Anchor id for a heading, e.g. "section-11" for "11. ELECTRONIC SIGNATURE". */
  id?: string;
  number?: string;
}
export interface TocEntry {
  id: string;
  label: string;
  number?: string;
}

const NUMBERED = /^(\d{1,2}(?:\.\d{1,2})?)\.?\s+([A-Z][^\n]{2,90})$/;
const ARTICLE = /^(ARTICLE|SECTION)\s+([IVXLC\d]+)\b[.:\-\s]*(.{0,80})$/;
const ALL_CAPS = /^[A-Z][A-Z0-9 ,&'/()\-—]{5,80}:?$/;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Cut a document into blocks. A line that looks like "11. ELECTRONIC SIGNATURE", "ARTICLE IV", or an ALL-CAPS title is a heading, with a stable anchor. */
export function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  const used = new Set<string>();
  const unique = (id: string) => {
    let candidate = id;
    let n = 2;
    while (used.has(candidate)) candidate = `${id}-${n++}`;
    used.add(candidate);
    return candidate;
  };
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      out.push({ kind: "blank", text: "" });
      continue;
    }
    const t = line.trim();
    const num = NUMBERED.exec(t);
    // A numbered heading has a capital title and is short and not a sentence (no trailing period): "11. ELECTRONIC SIGNATURE".
    if (num && !/[a-z]{4,}.*\.$/.test(t) && t.length <= 96) {
      out.push({ kind: "heading", text: t, number: num[1], id: unique(`section-${num[1]!.replace(".", "-")}`) });
      continue;
    }
    const art = ARTICLE.exec(t);
    if (art) {
      out.push({ kind: "heading", text: t, number: art[2], id: unique(`${art[1]!.toLowerCase()}-${slug(art[2]!)}`) });
      continue;
    }
    if (ALL_CAPS.test(t) && !/^BY SIGNING|^THE BUYER|^THE SELLER/.test(t) && t.length <= 80 && /[A-Z]{4}/.test(t) && !/^[A-Z ]+:\s/.test(t)) {
      out.push({ kind: "heading", text: t, id: unique(slug(t)) });
      continue;
    }
    out.push({ kind: "para", text: line });
  }
  return out;
}

export function tableOfContents(blocks: Block[]): TocEntry[] {
  return blocks.filter((b) => b.kind === "heading" && b.id).map((b) => ({ id: b.id!, label: b.text, number: b.number }));
}

// ---------------------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------------------
export interface Segment {
  text: string;
  hit?: boolean;
  href?: string;
  title?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** How many times the query appears in the whole document (case-insensitive). Queries under two characters match nothing. */
export function countMatches(text: string, query: string): number {
  const q = query.trim();
  if (q.length < 2) return 0;
  return (text.match(new RegExp(escapeRe(q), "gi")) ?? []).length;
}

/** Split a line into plain and highlighted segments. */
export function highlight(line: string, query: string): Segment[] {
  const q = query.trim();
  if (q.length < 2) return [{ text: line }];
  const re = new RegExp(escapeRe(q), "gi");
  const out: Segment[] = [];
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) });
    out.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out.length ? out : [{ text: line }];
}

// ---------------------------------------------------------------------------------------------------------
// Live cross-references between documents
// ---------------------------------------------------------------------------------------------------------
/** Which other documents exist for the reader to open. A reference to a document that is not available is left as plain text. */
export interface CrossRefTargets {
  terms: boolean;
  pra: boolean;
  operatingAgreement?: string | null;
  listingAgreement?: boolean;
}

export const TERMS_PATH = "/terms";
export const PRA_REVIEW_PATH = "/buyer/onboarding/pra-review";

interface Rule {
  re: RegExp;
  href: (m: RegExpExecArray, t: CrossRefTargets) => string | null;
  title: (m: RegExpExecArray) => string;
}

const TERMS_NAME = "(?:Terms and Conditions|Terms of Service|Terms of Use|T&C|T&Cs)";
const RULES: Rule[] = [
  // "Section 11 of the Terms and Conditions" / "Terms and Conditions, Section 11" / "T&C section 11" / "T&C §11"
  { re: new RegExp(`Section\\s+(\\d{1,2})\\s+of\\s+the\\s+(?:divieight\\s+)?${TERMS_NAME}`, "gi"), href: (m, t) => (t.terms ? `${TERMS_PATH}#section-${m[1]}` : null), title: (m) => `Open Terms and Conditions, section ${m[1]}` },
  { re: new RegExp(`${TERMS_NAME}[,:]?\\s+(?:Section|section|§)\\s*(\\d{1,2})`, "g"), href: (m, t) => (t.terms ? `${TERMS_PATH}#section-${m[1]}` : null), title: (m) => `Open Terms and Conditions, section ${m[1]}` },
  // "Section 11 of the Priority Reservation Agreement" / "Priority Reservation Agreement Section 11" / "PRA section 11"
  { re: /Section\s+(\d{1,2})\s+of\s+the\s+(?:Priority Reservation Agreement|PRA)/gi, href: (m, t) => (t.pra ? `${PRA_REVIEW_PATH}#section-${m[1]}` : null), title: (m) => `Open the Priority Reservation Agreement, section ${m[1]}` },
  { re: /(?:Priority Reservation Agreement|PRA)[,:]?\s+(?:Section|section|§)\s*(\d{1,2})/g, href: (m, t) => (t.pra ? `${PRA_REVIEW_PATH}#section-${m[1]}` : null), title: (m) => `Open the Priority Reservation Agreement, section ${m[1]}` },
  // The Operating Agreement, wherever it is named, once one exists for the reader.
  { re: /(?:Co-Ownership\s+)?Operating Agreement/g, href: (_m, t) => t.operatingAgreement ?? null, title: () => "Open the Operating Agreement" },
];

/** Turn the references in one line into links, leaving everything else (and any reference to a document that is not available) as plain text. */
export function linkReferences(segments: Segment[], targets: CrossRefTargets): Segment[] {
  let current = segments;
  for (const rule of RULES) {
    const next: Segment[] = [];
    for (const seg of current) {
      if (seg.href || seg.hit) {
        next.push(seg);
        continue;
      }
      const re = new RegExp(rule.re.source, rule.re.flags);
      let last = 0;
      let any = false;
      for (let m = re.exec(seg.text); m; m = re.exec(seg.text)) {
        const href = rule.href(m, targets);
        if (m[0].length === 0) re.lastIndex++;
        if (!href) continue;
        any = true;
        if (m.index > last) next.push({ text: seg.text.slice(last, m.index) });
        next.push({ text: m[0], href, title: rule.title(m) });
        last = m.index + m[0].length;
      }
      if (!any) next.push(seg);
      else if (last < seg.text.length) next.push({ text: seg.text.slice(last) });
    }
    current = next;
  }
  return current;
}

export const downloadFileName = (title: string, version: string, ext = "pdf") =>
  `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${version.toLowerCase().replace(/[^a-z0-9.]+/g, "")}.${ext}`;
