/**
 * A minimal XLSX writer with no dependency: one workbook, any number of sheets, text and number cells, a bold header row. An .xlsx is a zip of
 * XML parts; this writes the five a spreadsheet program needs. Text is stored as inline strings (no shared-strings part to keep in step), and
 * numbers as numbers, so a CPA can sum a column.
 */
import { deflateRawSync } from "node:zlib";

export type XlsxCell = string | number | null | undefined;
export interface XlsxSheet {
  name: string;
  headers: string[];
  rows: XlsxCell[][];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** A zip of named files (deflate). */
export function zip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  const central: number[] = [];
  // A fixed timestamp (1980-01-01) keeps the same content giving the same bytes.
  const time = u16(0);
  const date = u16((0 << 9) | (1 << 5) | 1);
  for (const f of files) {
    const name = enc.encode(f.name);
    const packed = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const offset = out.length;
    out.push(...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(8), ...time, ...date, ...u32(crc), ...u32(packed.length), ...u32(f.data.length), ...u16(name.length), ...u16(0), ...name, ...packed);
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(8), ...time, ...date, ...u32(crc), ...u32(packed.length), ...u32(f.data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name);
  }
  const cdOffset = out.length;
  out.push(...central, ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(central.length), ...u32(cdOffset), ...u16(0));
  return new Uint8Array(out);
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const col = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
/** A sheet name Excel accepts: at most 31 characters, none of []:*?/\ . */
export const sheetName = (name: string, taken: Set<string>) => {
  let base = name.replace(/[\[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let n = base;
  for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${base.slice(0, 28)} ${i}`;
  taken.add(n.toLowerCase());
  return n;
};

function sheetXml(s: XlsxSheet): string {
  const cell = (c: XlsxCell, r: number, i: number, style = 0) => {
    const ref = `${col(i)}${r}`;
    if (c === null || c === undefined || c === "") return "";
    if (typeof c === "number" && Number.isFinite(c)) return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${c}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${esc(String(c))}</t></is></c>`;
  };
  const rows = [s.headers, ...s.rows].map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => cell(c, ri + 1, ci, ri === 0 ? 1 : 0)).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${rows}</sheetData></worksheet>`;
}

export function buildXlsx(sheets: XlsxSheet[]): Uint8Array<ArrayBuffer> {
  const taken = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: sheetName(s.name, taken) }));
  const files: Array<{ name: string; data: Uint8Array }> = [
    { name: "[Content_Types].xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`) },
    { name: "_rels/.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: "xl/workbook.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${named.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: "xl/styles.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`) },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(s)) })),
  ];
  return zip(files);
}
