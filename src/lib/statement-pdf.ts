/**
 * The monthly statement as a PDF, made on the server with no dependency: US Letter, Helvetica, text never smaller than 11 pt
 * (about 14.7 px) so it is easy to read, amounts right-aligned, automatic pagination. It is drawn only from the issued snapshot, so
 * the same statement always gives the same document.
 */
import { CAPITAL_TYPE_LABELS, capitalRows, periodLabel, statementMoney, type StatementAccountLine, type StatementSnapshot } from "@/lib/statements";

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const RIGHT = PAGE_W - MARGIN;
export const PDF_MIN_FONT_PT = 11;
const BODY = PDF_MIN_FONT_PT;
const LEAD = 16;

// Helvetica advance widths (1000 units per em) for ASCII 32..126, to right-align amounts and wrap lines.
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

const clean = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/·/g, "*").replace(/[^\x20-\x7E]/g, "?");
const esc = (s: string) => clean(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
export const textWidth = (s: string, size: number, bold = false) => (clean(s).split("").reduce((n, c) => n + (W[c.charCodeAt(0) - 32] ?? 556), 0) * size * (bold ? 1.06 : 1)) / 1000;

function wrap(text: string, size: number, width: number, bold = false): string[] {
  const out: string[] = [];
  for (const para of clean(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= width || !line) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

type Draw = { x: number; y: number; text: string; size: number; bold: boolean } | { rule: number };

class Doc {
  pages: Draw[][] = [[]];
  y = PAGE_H - MARGIN - 8;
  private room(h: number) {
    if (this.y - h < MARGIN + 24) {
      this.pages.push([]);
      this.y = PAGE_H - MARGIN - 8;
    }
  }
  private put(d: Draw) {
    this.pages[this.pages.length - 1]!.push(d);
  }
  space(h = 8) {
    this.y -= h;
  }
  text(text: string, o: { size?: number; bold?: boolean; x?: number; width?: number } = {}) {
    const size = o.size ?? BODY;
    for (const line of wrap(text, size, o.width ?? RIGHT - (o.x ?? MARGIN), o.bold)) {
      this.room(size + 5);
      this.put({ x: o.x ?? MARGIN, y: this.y, text: line, size, bold: !!o.bold });
      this.y -= size + 5;
    }
  }
  heading(text: string, size = 14) {
    this.space(10);
    this.room(size + 30);
    this.text(text, { size, bold: true });
    this.put({ rule: this.y + 2 });
    this.space(2);
  }
  /** A label on the left and an amount on the right. */
  row(label: string, amount: string, o: { bold?: boolean; indent?: number } = {}) {
    const x = MARGIN + (o.indent ?? 0);
    const room = RIGHT - x - textWidth(amount, BODY, o.bold) - 12;
    const lines = wrap(label, BODY, room, o.bold);
    this.room(LEAD * lines.length);
    lines.forEach((line, i) => {
      this.put({ x, y: this.y, text: line, size: BODY, bold: !!o.bold });
      if (i === 0) this.put({ x: RIGHT - textWidth(amount, BODY, o.bold), y: this.y, text: amount, size: BODY, bold: !!o.bold });
      this.y -= LEAD;
    });
  }
  /** A dated line item: date, description, amount. */
  item(date: string, memo: string, amount: string, indent = 12) {
    const dx = MARGIN + indent;
    const mx = dx + 72;
    const room = RIGHT - mx - textWidth(amount, BODY) - 12;
    const lines = wrap(memo || "(no description)", BODY, room);
    this.room(LEAD * lines.length);
    lines.forEach((line, i) => {
      if (i === 0) {
        this.put({ x: dx, y: this.y, text: date, size: BODY, bold: false });
        this.put({ x: RIGHT - textWidth(amount, BODY), y: this.y, text: amount, size: BODY, bold: false });
      }
      this.put({ x: mx, y: this.y, text: line, size: BODY, bold: false });
      this.y -= LEAD;
    });
  }
}

function accountBlock(doc: Doc, title: string, lines: StatementAccountLine[], total: number, sign: 1 | -1, showItems: boolean) {
  doc.text(title, { bold: true });
  if (lines.length === 0) doc.text("None this period.", { x: MARGIN + 12 });
  for (const a of lines) {
    doc.row(`${a.code}  ${a.name}`, statementMoney(a.total_cents * sign), { indent: 12, bold: true });
    if (showItems) for (const i of a.items) doc.item(i.date, i.memo, statementMoney(i.amount_cents * sign), 24);
  }
  doc.row(`Total ${title.toLowerCase()}`, statementMoney(total * sign), { bold: true });
  doc.space(6);
}

export interface StatementPdfInput {
  snapshot: StatementSnapshot;
  /** The account holder, as the Manager knows them. */
  memberLabel: string;
  version: number;
  status: "draft" | "issued" | "superseded";
  issuedAt: string | null;
}

export function renderStatementPdf(input: StatementPdfInput): Uint8Array<ArrayBuffer> {
  const s = input.snapshot;
  const doc = new Doc();
  doc.text(`Monthly statement: ${periodLabel(s.period)}`, { size: 18, bold: true });
  doc.text(`${s.property.llc_name ?? "LLC"}`, { size: 13, bold: true });
  doc.text(`Prepared for ${input.memberLabel}`);
  doc.text(`Version ${input.version}${input.status === "superseded" ? " (superseded by a newer version)" : input.status === "draft" ? " (DRAFT, not yet issued)" : ""}${input.issuedAt ? `, issued ${input.issuedAt.slice(0, 10)}` : ""}`);

  doc.heading("Property summary");
  doc.row("Property", [s.property.address, s.property.city, s.property.state].filter(Boolean).join(", ") || "-");
  doc.row("LLC", s.property.llc_name ?? "-");
  doc.row("Shares held at month end", `${s.property.shares} of ${s.property.total_shares}`);
  doc.row("Percentage interest", `${s.property.interest_percent}%`);

  doc.heading(`Your capital account, ${periodLabel(s.period)}`);
  for (const [label, cents] of capitalRows(s.capital)) doc.row(label, statementMoney(cents), { bold: label === "Opening balance" || label === "Closing balance" });
  if ((s.capital.lines ?? []).length > 0) {
    doc.space(4);
    doc.text("Activity", { bold: true });
    for (const l of s.capital.lines!) doc.item(l.date, `${CAPITAL_TYPE_LABELS[l.type] ?? l.type}${l.memo ? `: ${l.memo}` : ""}`, statementMoney(l.amount_cents));
  }

  doc.heading(`The LLC's income and expense, ${periodLabel(s.period)}`);
  doc.text("Property-level activity of the LLC itself, before it is passed on to the owners.", { size: BODY });
  accountBlock(doc, "Income", s.llc_month.income, s.llc_month.income_cents, 1, true);
  accountBlock(doc, "Expense", s.llc_month.expense, s.llc_month.expense_cents, 1, true);
  doc.row("Net income (expense)", statementMoney(s.llc_month.net_cents), { bold: true });

  doc.heading(`Year to date, ${s.ytd.year}`);
  doc.text("Your capital account", { bold: true });
  doc.row("Beginning of year", statementMoney(s.ytd.capital.beginning_cents));
  doc.row("Contributions", statementMoney(s.ytd.capital.contributions_cents));
  doc.row("Distributions", statementMoney(s.ytd.capital.distributions_cents));
  doc.row("Allocable income", statementMoney(s.ytd.capital.income_cents));
  doc.row("Allocable expense", statementMoney(s.ytd.capital.expense_cents));
  if (s.ytd.capital.depreciation_cents !== 0) doc.row("Allocable depreciation", statementMoney(s.ytd.capital.depreciation_cents));
  if (s.ytd.capital.transfers_cents !== 0) doc.row("Shares bought and sold", statementMoney(s.ytd.capital.transfers_cents));
  doc.row("Closing balance", statementMoney(s.ytd.capital.closing_cents), { bold: true });
  doc.space(6);
  doc.text("The LLC's property-level activity", { bold: true });
  doc.row("Income", statementMoney(s.ytd.llc.income_cents));
  doc.row("Expense", statementMoney(s.ytd.llc.expense_cents));
  doc.row("Net income (expense)", statementMoney(s.ytd.llc.net_cents), { bold: true });

  doc.heading("Manager's notes");
  doc.text(s.manager_notes?.trim() ? s.manager_notes : "No notes this month.");
  doc.space(10);
  doc.text("This statement is a record of the LLC's books for your records and your CPA. It is not a tax return or a K-1.", { size: BODY });

  // Emit.
  const total = doc.pages.length;
  const objects: string[] = [];
  const pageIds = doc.pages.map((_, i) => 6 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${total} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[5] = `<< /Title (${esc(`Monthly statement ${s.period}`)}) /Producer (divieight) >>`;
  doc.pages.forEach((draws, i) => {
    const ops: string[] = [];
    for (const d of draws) {
      if ("rule" in d) ops.push(`0.6 G 0.5 w ${MARGIN} ${d.rule} m ${RIGHT} ${d.rule} l S 0 G`);
      else ops.push(`BT /${d.bold ? "F2" : "F1"} ${d.size} Tf ${d.x.toFixed(2)} ${d.y.toFixed(2)} Td (${esc(d.text)}) Tj ET`);
    }
    const footer = `Page ${i + 1} of ${total}`;
    ops.push(`BT /F1 ${BODY} Tf ${(RIGHT - textWidth(footer, BODY)).toFixed(2)} ${MARGIN - 18} Td (${footer}) Tj ET`);
    const body = ops.join("\n");
    objects[pageIds[i]!] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`;
    objects[pageIds[i]! + 1] = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
