/**
 * Minimal dependency-free PDF writer for plain-text documents (Helvetica,
 * US Letter, automatic pagination). Enough for instruction documents like the
 * Source of Truth / CDA; not a layout engine.
 */

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const SIZE = 9;
const LEADING = 12;
const MAX_CHARS = 110;

function escapePdf(s: string) {
  return s
    .replace(/[^\x20-\x7E]/g, (c) => (c === "—" || c === "–" ? "-" : c === "·" ? "*" : "?"))
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function wrap(line: string): string[] {
  if (line.length <= MAX_CHARS) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > MAX_CHARS) {
    const cut = rest.lastIndexOf(" ", MAX_CHARS);
    const at = cut > 20 ? cut : MAX_CHARS;
    out.push(rest.slice(0, at));
    rest = "  " + rest.slice(at).trimStart();
  }
  out.push(rest);
  return out;
}

export function renderTextPdf(text: string, title: string): Uint8Array<ArrayBuffer> {
  const lines = text.split("\n").flatMap(wrap);
  const perPage = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (pages.length === 0) pages.push([""]);

  const objects: string[] = [];
  // 1 catalog, 2 pages, 3 font, 4 info, then (page, content) pairs.
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objects[4] = `<< /Title (${escapePdf(title)}) /Producer (divieight) >>`;
  pages.forEach((pageLines, i) => {
    const body = [
      "BT",
      `/F1 ${SIZE} Tf`,
      `${LEADING} TL`,
      `${MARGIN} ${PAGE_H - MARGIN} Td`,
      ...pageLines.map((l) => `(${escapePdf(l)}) Tj T*`),
      "ET",
      "BT",
      `/F1 7 Tf ${PAGE_W - MARGIN - 60} ${MARGIN / 2} Td (Page ${i + 1} of ${pages.length}) Tj`,
      "ET",
    ].join("\n");
    objects[pageIds[i]!] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`;
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
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
