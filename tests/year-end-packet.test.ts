/**
 * Month 6, Prompt 11, the app side: the schema and the committed samples, the file formats (PDF, CSV, XLSX, JSON), generation, the private TIN files
 * and their audited decryption, the scheduled job, and who can download what.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { harness } from "./setup";
import { seedPod, USERS } from "./fixtures";
import * as pk from "@/lib/year-end-packet.server";
import * as cpa from "@/lib/cpa.server";
import { PACKET_SCHEMA, packetDeadline, packetTables, packetYearFor, tableRowsForCsv, tableRowsForXlsx, validatePacket, withoutTins, type PacketPayload } from "@/lib/year-end-packet";
import { validate } from "@/lib/json-schema";
import { toCsv } from "@/lib/csv";
import { buildXlsx, crc32 } from "@/lib/xlsx";
import { renderPacketPdf } from "@/lib/packet-pdf";
import { PDF_MIN_FONT_PT } from "@/lib/statement-pdf";
import { encryptPii } from "@/lib/pii-crypto.server";
import { LAUNCH_ITEMS } from "@/lib/launch-readiness";

const db = () => harness.db as any;
// Real uuids: the schema (like the database) wants them.
const A = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const B1 = "22222222-2222-4222-8222-bbbbbbbbbbbb";
const M1 = "33333333-3333-4333-8333-cccccccccccc";
const M2 = "44444444-4444-4444-8444-dddddddddddd";
const KEY = randomBytes(32).toString("base64");
const CPA = "u-cpa";
const sample = (n: number) => JSON.parse(readFileSync(`samples/year-end-packet/sample-packet-${n}.json`, "utf8")) as PacketPayload;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------------------------------------
// The schema and the samples
// ---------------------------------------------------------------------------------------------------------
describe("the JSON schema", () => {
  it("is versioned, committed as a file, and the file is exactly the schema the code validates with", () => {
    const file = JSON.parse(readFileSync("schemas/year-end-packet.schema.json", "utf8"));
    expect(file).toEqual(JSON.parse(JSON.stringify(PACKET_SCHEMA)));
    expect(file.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(file.properties.schema_version.const).toBe("1.1.0");
    for (const k of ["schema_version", "packet_id", "property", "period", "accounts", "entries", "members", "roll_forwards", "worksheet"]) expect(file.required, k).toContain(k);
  });

  it("both committed sample packets validate against it", () => {
    for (const n of [1, 2]) expect(validatePacket(sample(n)), `sample ${n}`).toEqual([]);
  });

  it("the samples are consistent books: the trial balance balances, the balance sheet balances, the ledger adds up, a member's beginning is the prior ending", () => {
    for (const n of [1, 2]) {
      const p = sample(n);
      expect(p.trial_balance.balanced).toBe(true);
      expect(p.trial_balance.total_debit_cents).toBe(p.trial_balance.total_credit_cents);
      expect(p.balance_sheet.balanced).toBe(true);
      expect(p.balance_sheet.total_assets_cents).toBe(p.balance_sheet.total_liabilities_and_equity_cents);
      expect(p.totals.debit_cents).toBe(p.totals.credit_cents);
      expect(p.entries.length).toBe(p.totals.entries);
      for (const e of p.entries) expect(e.lines.reduce((s: number, l: any) => s + l.debit_cents, 0), e.memo).toBe(e.lines.reduce((s: number, l: any) => s + l.credit_cents, 0));
      for (const r of p.roll_forwards) {
        expect(r.beginning_matches_prior_ending).toBe(true);
        expect(r.beginning_cents).toBe(r.prior_year_ending_cents);
        expect(r.beginning_cents + r.contributions_cents + r.distributions_cents + r.income_cents + r.expense_cents + r.depreciation_cents + (r.transfers_cents ?? 0)).toBe(r.ending_cents);
      }
      expect(p.income_statement.net_cents).toBe(p.income_statement.income_cents - p.income_statement.expense_cents);
    }
  });

  it("sample 2 carries the worksheet items, a 1099 and the depreciation from the CPA's schedule; neither has a TIN", () => {
    const s2 = sample(2);
    expect(s2.worksheet.items.map((i) => i.item_type).sort()).toEqual(["depreciation_needed", "lodging_tax_exposure", "section_754_review"]);
    expect(s2.worksheet.items.find((i) => i.item_type === "depreciation_needed")!.detail).toMatchObject({ entered: true });
    expect(JSON.stringify(s2.worksheet.items.find((i) => i.item_type === "section_754_review")!.detail)).not.toMatch(/amount|basis|step|cents/i);
    expect(s2.forms_1099).toHaveLength(1);
    expect(s2.roll_forwards.some((r) => r.depreciation_cents < 0)).toBe(true);
    for (const n of [1, 2]) {
      expect(sample(n).members.some((m) => "tin" in m)).toBe(false);
      expect(readFileSync(`samples/year-end-packet/sample-packet-${n}.json`, "utf8")).not.toMatch(/\d{3}-\d{2}-\d{4}/);
      expect(sample(n).members.map((m) => m.legal_name)).toEqual(expect.arrayContaining(["Ann Example", "Ben Example"])); // a two-member account: two people, one capital account
    }
  });

  it("rejects what is wrong: a missing section, a wrong type, an unknown field, a bad id, a TIN that isn't a TIN, a schema version it doesn't know", () => {
    const bad = (mutate: (p: any) => void) => {
      const p = JSON.parse(JSON.stringify(sample(1)));
      mutate(p);
      return validatePacket(p);
    };
    expect(bad((p) => delete p.roll_forwards)).toContain("$.roll_forwards: is required");
    expect(bad((p) => (p.entries[0].lines[0].debit_cents = "5")).join()).toMatch(/debit_cents: must be integer/);
    expect(bad((p) => (p.extra = 1))).toContain("$.extra: is not allowed");
    expect(bad((p) => (p.packet_id = "not-a-uuid"))).toContain("$.packet_id: is not a uuid");
    expect(bad((p) => (p.members[0].tin = "123456789")).join()).toMatch(/tin: does not match/);
    expect(bad((p) => (p.schema_version = "2.0.0")).join()).toMatch(/schema_version: must be "1.1.0"/);
    expect(bad((p) => (p.accounts[0].type = "revenue")).join()).toMatch(/type: must be one of/);
    expect(bad((p) => (p.entries[0].lines = [p.entries[0].lines[0]])).join()).toMatch(/needs at least 2 item/);
    expect(bad((p) => (p.worksheet.items[0].item_type = "k1"))).not.toEqual([]);
    expect(bad(() => undefined)).toEqual([]);
  });

  it("the small validator does what a JSON Schema does", () => {
    const schema = { type: "object", required: ["a"], properties: { a: { type: "integer", minimum: 1 }, b: { $ref: "#/definitions/s" } }, additionalProperties: false, definitions: { s: { type: ["string", "null"], pattern: "^x" } } };
    expect(validate(schema, { a: 1, b: "xy" })).toEqual([]);
    expect(validate(schema, { a: 1, b: null })).toEqual([]);
    expect(validate(schema, { a: 0 })).toEqual(["$.a: is below 1"]);
    expect(validate(schema, { a: 1.5 })).toEqual(["$.a: must be integer, not number"]);
    expect(validate(schema, { a: 1, b: "no" })).toEqual(["$.b: does not match ^x"]);
    expect(validate(schema, { a: 1, c: 1 })).toEqual(["$.c: is not allowed"]);
    expect(validate(schema, {})).toEqual(["$.a: is required"]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The formats
// ---------------------------------------------------------------------------------------------------------
function unzip(bytes: Uint8Array): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const b = Buffer.from(bytes);
  let o = 0;
  while (b.readUInt32LE(o) === 0x04034b50) {
    const method = b.readUInt16LE(o + 8);
    const crc = b.readUInt32LE(o + 14);
    const csize = b.readUInt32LE(o + 18);
    const usize = b.readUInt32LE(o + 22);
    const nlen = b.readUInt16LE(o + 26);
    const xlen = b.readUInt16LE(o + 28);
    const name = b.subarray(o + 30, o + 30 + nlen).toString("utf8");
    const data = b.subarray(o + 30 + nlen + xlen, o + 30 + nlen + xlen + csize);
    const raw = method === 8 ? inflateRawSync(data) : data;
    expect(raw.length, name).toBe(usize);
    expect(crc32(raw), `crc ${name}`).toBe(crc);
    out.set(name, raw);
    o += 30 + nlen + xlen + csize;
  }
  return out;
}

describe("the files", () => {
  it("CSV: quotes what needs quoting, uses CRLF, and never lets a spreadsheet run a cell as a formula", () => {
    const csv = toCsv(["a", "b"], [["x,y", 'say "hi"'], ["=SUM(A1)", "-5"], ["line\nbreak", null], ["+cmd", "@x"]]);
    expect(csv).toBe('a,b\r\n"x,y","say ""hi"""\r\n\'=SUM(A1),-5\r\n"line\nbreak",\r\n\'+cmd,\'@x\r\n');
  });

  it("each section is a table: whole cents come out as dollars in CSV and as numbers in XLSX", () => {
    const tables = packetTables(sample(2));
    expect(tables.map((t) => t.name)).toEqual(["accounts", "general_ledger", "trial_balance", "balance_sheet", "income_statement", "roll_forwards", "members", "forms_1099", "worksheet", "ownership_records", "sales_1099s"]);
    const tb = tables.find((t) => t.name === "trial_balance")!;
    const cash = tb.rows.find((r) => r[0] === "1000")!;
    expect(tableRowsForCsv(tb).find((r) => r[0] === "1000")![3]).toBe(((cash[3] as number) / 100).toFixed(2));
    expect(tableRowsForXlsx(tb).find((r) => r[0] === "1000")![3]).toBe((cash[3] as number) / 100);
    const gl = tables.find((t) => t.name === "general_ledger")!;
    expect(gl.rows).toHaveLength(sample(2).entries.reduce((n, e) => n + e.lines.length, 0));
    expect(gl.rows.some((r) => r[12] === "Tenant ACH")).toBe(true); // the bank's merchant and category travel with the entry
    expect(tableRowsForCsv(gl)[0]![9]).toMatch(/^\d+\.\d{2}$/);
  });

  it("XLSX is a real workbook: the parts a spreadsheet needs, every CRC right, text as text and numbers as numbers", () => {
    const xlsx = buildXlsx([{ name: "Trial balance: 2025/12", headers: ["code", "amount"], rows: [["1000", 1234.5], ["a & <b>", null]] }, { name: "Trial balance: 2025/12", headers: ["x"], rows: [] }]);
    expect(Buffer.from(xlsx.subarray(0, 4)).toString("hex")).toBe("504b0304");
    const parts = unzip(xlsx);
    expect([...parts.keys()].sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
    const book = parts.get("xl/workbook.xml")!.toString();
    expect(book).toContain('name="Trial balance  2025 12"'); // : and / are not allowed in a sheet name
    expect(book).toContain('name="Trial balance  2025 12 2"'); // and two sheets can't share one
    const sheet = parts.get("xl/worksheets/sheet1.xml")!.toString();
    expect(sheet).toContain('<c r="B2"><v>1234.5</v></c>');
    expect(sheet).toContain('<t xml:space="preserve">1000</t>');
    expect(sheet).toContain("a &amp; &lt;b&gt;");
    expect(buildXlsx([{ name: "x", headers: ["h"], rows: [["1"]] }])).toEqual(buildXlsx([{ name: "x", headers: ["h"], rows: [["1"]] }])); // the same content, the same bytes
  });

  it("the PDF is readable and has no TIN in it: text never under 11 pt, every section, the page count on each page", () => {
    const p = withoutTins(sample(2));
    const bytes = renderPacketPdf(p, 3, "abc123");
    const t = new TextDecoder().decode(bytes);
    expect(t.startsWith("%PDF-1.4")).toBe(true);
    const sizes = [...t.matchAll(/\/F[12] ([\d.]+) Tf/g)].map((m) => Number(m[1]));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(PDF_MIN_FONT_PT);
    for (const s of ["Year-End CPA Export Packet 2025", "Trial balance as of 2025-12-31", "Balance sheet as of 2025-12-31", "Income statement 2025", "Capital account roll-forward 2025", "Member roster", "1099 forms issued to LLC vendors", "CPA Cooperation Worksheet", "General ledger 2025", "Ann Example", "Version 3", "Hash abc123", "TIN on file", "Lusk Roofing"]) expect(t, s).toContain(s);
    const pages = Number(/\/Count (\d+)/.exec(t)![1]);
    expect(pages).toBeGreaterThan(2);
    expect(t).toContain(`Page ${pages} of ${pages}`);
    expect(t).not.toMatch(/\d{3}-\d{2}-\d{4}/);
    expect(t).toContain("no K-1");
  });

  it("the deadline is 30 days after year-end, and the job is about the year that has just ended", () => {
    expect(packetDeadline(2025)).toBe("2026-01-30");
    expect(packetDeadline(2023)).toBe("2024-01-30");
    expect(packetYearFor("2026-01-02")).toBe(2025);
    expect(packetYearFor("2026-12-31")).toBe(2025);
  });

  it("the JSON assumption is on the launch readiness page", () => {
    const item = LAUNCH_ITEMS.find((i) => i.key === "year_end_json_validation");
    expect(item).toMatchObject({ status: "Placeholder" });
    expect(item!.detail).toMatch(/ASSUMPTION.*Lacerte or ProConnect/s);
    expect(readFileSync("samples/year-end-packet/README.md", "utf8")).toMatch(/Lacerte or ProConnect/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Generation, the private TIN files, downloads and the job
// ---------------------------------------------------------------------------------------------------------
const store = new Map<string, Uint8Array>();
const SAMPLE = sample(2);
const TIN_A = "123456789"; // Ann (SSN)
const TIN_B = "987654321"; // Ben (SSN)
const audits = (a: string) => (db().table("audit_log") as any[]).filter((x) => x.action_type === a);
let recorded: Array<Record<string, any>> = [];

function wire() {
  const d = db();
  d.rpcResults.refresh_worksheet_items = vi.fn(() => 2);
  d.rpcResults.packet_ledger_sections = vi.fn(() => ({ accounts: SAMPLE.accounts, entries: SAMPLE.entries, trial_balance: SAMPLE.trial_balance, balance_sheet: SAMPLE.balance_sheet, income_statement: SAMPLE.income_statement, roll_forwards: SAMPLE.roll_forwards }));
  d.rpcResults.holder_shares_as_of = () => [{ member_id: B1, shares: 4 }];
  d.rpcResults.record_year_end_packet = vi.fn((a: any) => {
    const version = (d.table("year_end_packets") as any[]).filter((x) => x.property_id === a._property && x.year === a._year).length + 1;
    const hash = sha(JSON.stringify(a._payload));
    (d.table("year_end_packets") as any[]).push({ id: a._id, property_id: a._property, year: a._year, version, data: a._payload, hash, trigger: a._trigger, generated_by: a._actor, generated_at: new Date().toISOString(), files: [], has_tins: false });
    recorded.push(a);
    return { id: a._id, version, hash };
  });
  d.rpcResults.set_packet_files = vi.fn((a: any) => {
    const row = (d.table("year_end_packets") as any[]).find((x) => x.id === a._id)!;
    row.files = a._files;
    row.has_tins = a._has_tins;
  });
  d.rpcResults.log_packet_download = vi.fn((a: any) => {
    (d.table("audit_log") as any[]).push({ actor_id: a._actor, action_type: a._pii ? "packet.pii_file_downloaded" : "packet.downloaded", entity_id: a._id, metadata: { file: a._file, pii: a._pii } });
  });
  d.rpcResults.packet_reconciliation = () => [{ check_name: "x", ok: true }];
  d.rpcResults.is_property_cpa = (a: any) => a._user === CPA && a._property === A;
  d.storage = {
    from: (bucket: string) => ({
      upload: async (path: string, blob: Blob) => {
        store.set(`${bucket}/${path}`, new Uint8Array(await blob.arrayBuffer()));
        return { data: { path }, error: null };
      },
      download: async (path: string) => {
        const b = store.get(`${bucket}/${path}`);
        return b ? { data: new Blob([b as BlobPart]), error: null } : { data: null, error: { message: "not found" } };
      },
    }),
  };
}

beforeEach(() => {
  vi.stubEnv("W9_TIN_ENCRYPTION_KEY", KEY);
  seedPod(db());
  store.clear();
  recorded = [];
  db().seed("year_end_packets", []);
  db().seed("cpa_worksheet_items", [{ id: "w-1", property_id: A, year: 2025, item_type: "depreciation_needed", title: "Depreciation entry needed for 2025: the CPA supplies the schedule", status: "open", manager_note: "Waiting on Pat", detail: { entered: false } }]);
  db().seed("vendor_1099_copies", []);
  db().seed("bank_transactions", []);
  db().seed("properties", [{ id: A, address: "5632 Independence Ave", city: "Lusk", state: "WY", zip: "82225" }]);
  db().seed("entity_genesis", [{ property_id: A, llc_name: "5632 Independence Ave LLC" }]);
  db().seed("buyer_accounts", [{ id: B1, auth_user_id: USERS.b1, email: "b1@test.local" }]);
  db().seed("account_members", [{ id: M1, buyer_account_id: B1, full_name: "Ann Example", status: "active" }, { id: M2, buyer_account_id: B1, full_name: "Ben Example", status: "active" }]);
  db().seed("cap_table_entries", [{ property_id: A, share_number: 1, holder_type: "buyer_account", buyer_account_id: B1, seller_id: null }]);
  db().seed("journal_entries", [{ id: "e1", property_id: A, entry_date: "2025-04-10" }]);
  db().seed("member_w9", [
    { id: "w9-ann", account_member_id: M1, buyer_account_id: B1, legal_name: "Ann Example", address: "12 Oak St, Lusk, WY 82225", tin_kind: "ssn" },
    { id: "w9-ben", account_member_id: M2, buyer_account_id: B1, legal_name: "Ben Example", address: "12 Oak St, Lusk, WY 82225", tin_kind: "ssn" },
  ]);
  db().seed("member_w9_tin_secrets", [{ w9_id: "w9-ann", ...encryptPii(TIN_A, "member_w9:w9-ann") }, { w9_id: "w9-ben", ...encryptPii(TIN_B, "member_w9:w9-ben") }]);
  wire();
});
afterEach(() => vi.unstubAllEnvs());

const generate = (o: Partial<Parameters<typeof pk.generatePacket>[1]> = {}) => pk.generatePacket(db(), { userId: USERS.admin, propertyId: A, year: 2025, trigger: "manual", now: new Date("2026-01-05T09:00:00Z"), ...o });
const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const filesIn = (bucket: string) => [...store.entries()].filter(([k]) => k.startsWith(`${bucket}/`));

describe("generating a packet", () => {
  it("only the Manager (or the scheduled job), only after the year has ended", async () => {
    await expect(generate({ userId: USERS.b1 })).rejects.toThrow("Only the Manager");
    await expect(generate({ year: 2026 })).rejects.toThrow("after the year has ended");
    await expect(generate({ year: 1999 })).rejects.toThrow("valid year");
    expect(recorded).toHaveLength(0);
  });

  it("records the packet (as the schema says) with a hash and who generated it, and makes the whole set of files", async () => {
    const r = await generate();
    expect(r).toMatchObject({ version: 1, trigger: "manual" });
    const row = (db().table("year_end_packets") as any[])[0];
    expect(row).toMatchObject({ property_id: A, year: 2025, generated_by: USERS.admin, trigger: "manual", has_tins: true });
    expect(validatePacket(row.data)).toEqual([]);
    expect(row.hash).toBe(r.hash);
    const names = (row.files as Array<{ name: string; pii: boolean }>).filter((f) => !f.pii).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["packet.pdf", "packet.json", ...["accounts", "general_ledger", "trial_balance", "balance_sheet", "income_statement", "roll_forwards", "members", "forms_1099", "worksheet"].flatMap((s) => [`${s}.csv`, `${s}.xlsx`])]));
    expect((row.files as Array<{ name: string; pii: boolean }>).filter((f) => f.pii).map((f) => f.name).sort()).toEqual(["members-with-tins.csv", "members-with-tins.xlsx", "packet-with-tins.json"]);
    for (const f of row.files as Array<{ path: string; sha256: string; bytes: number; pii: boolean }>) {
      const bytes = store.get(`${f.pii ? "packet-pii" : "year-end-packets"}/${f.path}`)!;
      expect(bytes.length).toBe(f.bytes);
      expect(sha(bytes)).toBe(f.sha256);
      expect(f.path).toBe(`${A}/2025/v1/${f.path.split("/").pop()}`);
    }
    // the worksheet, the roster by legal name and the capital roll-forward are in the JSON
    expect(row.data.worksheet.items[0]).toMatchObject({ item_type: "depreciation_needed", manager_note: "Waiting on Pat" });
    // People who held a share earlier in the year, or still have a capital account, are in the roster at zero shares.
    expect(row.data.members.filter((m: any) => m.share_count > 0).map((m: any) => [m.legal_name, m.tin_status])).toEqual([["Ann Example", "on_file"], ["Ben Example", "on_file"]]);
    expect(row.data.members.filter((m: any) => m.share_count === 0).every((m: any) => m.tin_status === "missing")).toBe(true);
    expect(row.data.members[0]).toMatchObject({ share_count: 4, interest_percent: "100.00", mailing_address: "12 Oak St, Lusk, WY 82225" });
    expect(db().rpcResults.refresh_worksheet_items).toHaveBeenCalledWith({ _property: A, _year: 2025, _actor: USERS.admin });
  });

  it("every generation is a new version; nothing is overwritten", async () => {
    await generate();
    await generate();
    const rows = db().table("year_end_packets") as any[];
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(filesIn("year-end-packets").some(([k]) => k.includes("/v1/packet.pdf"))).toBe(true);
    expect(filesIn("year-end-packets").some(([k]) => k.includes("/v2/packet.pdf"))).toBe(true);
    expect(rows[0].hash).not.toBe(rows[1].hash);
  });

  it("a packet that doesn't match its schema is refused before anything is recorded", async () => {
    db().rpcResults.packet_ledger_sections = () => ({ accounts: [], entries: [{ id: "not-a-uuid", date: "2025-01-01", source: "manual", memo: "", lines: [] }], trial_balance: SAMPLE.trial_balance, balance_sheet: SAMPLE.balance_sheet, income_statement: SAMPLE.income_statement, roll_forwards: [] });
    await expect(generate()).rejects.toThrow(/doesn't match its schema/);
    expect(recorded).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it("if a file can't be stored the Manager is told, and the packet is not marked complete", async () => {
    db().storage = { from: () => ({ upload: async () => ({ data: null, error: { message: "bucket missing" } }) }) };
    await expect(generate()).rejects.toThrow(/could not be stored/);
    expect(db().rpcResults.set_packet_files).not.toHaveBeenCalled();
  });

  it("a scheduled run is the platform's: no Manager id on the packet, the worksheet run as the first Manager account", async () => {
    await generate({ userId: null, trigger: "scheduled" });
    expect((db().table("year_end_packets") as any[])[0]).toMatchObject({ generated_by: null, trigger: "scheduled" });
    expect(db().rpcResults.refresh_worksheet_items).toHaveBeenCalledWith({ _property: A, _year: 2025, _actor: USERS.admin });
  });

  it("makes no tax return: no K-1, 1065, depreciation figure or Section 754 figure in any file", async () => {
    await generate();
    for (const [key, bytes] of filesIn("year-end-packets")) {
      if (!/\.(csv|json)$/.test(key)) continue;
      expect(text(bytes), key).not.toMatch(/schedule k-1|form 1065|step.?up|basis_cents/i);
    }
    const src = readFileSync("src/lib/year-end-packet.server.ts", "utf8").split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*")).join("\n");
    expect(src).not.toMatch(/k-1|1065|depreciat\w*\s*\(|section_754.*\*/i);
  });
});

describe("TINs: only through the audited decrypt, only into the private files", () => {
  it("every decryption is audit logged (who, why, which LLC), once per W-9, and never with the TIN", async () => {
    await generate();
    const log = audits("admin.w9_tin_decrypted");
    expect(log).toHaveLength(2);
    expect(log.map((l) => l.entity_id).sort()).toEqual(["w9-ann", "w9-ben"]);
    for (const l of log) {
      expect(l).toMatchObject({ actor_id: USERS.admin, actor_type: "admin" });
      expect(l.metadata).toMatchObject({ property_id: A, reason: "Year-end CPA export packet 2025" });
      expect(l.metadata.at).toBeTruthy();
    }
    expect(JSON.stringify(db().table("audit_log"))).not.toMatch(new RegExp(`${TIN_A}|${TIN_B}|123-45-6789|987-65-4321`));
  });

  it("the scheduled job's decryptions are logged as the system's", async () => {
    await generate({ userId: null, trigger: "scheduled" });
    const log = audits("admin.w9_tin_decrypted");
    expect(log).toHaveLength(2);
    expect(log.every((l) => l.actor_type === "system" && l.actor_id === null)).toBe(true);
  });

  it("the TINs are in the PII sub-vault bucket only: not in a single general file, in any format", async () => {
    await generate();
    const general = filesIn("year-end-packets");
    expect(general.length).toBeGreaterThanOrEqual(20);
    for (const [key, bytes] of general) {
      const s = text(bytes);
      expect(s, key).not.toMatch(/123-?45-?6789|987-?65-?4321/);
      if (key.endsWith(".xlsx")) for (const [, part] of unzip(bytes)) expect(part.toString(), key).not.toMatch(/123-?45-?6789|987-?65-?4321/);
    }
    const pii = filesIn("packet-pii");
    expect(pii.map(([k]) => k.split("/").pop()).sort()).toEqual(["members-with-tins.csv", "members-with-tins.xlsx", "packet-with-tins.json"]);
    const full = JSON.parse(text(pii.find(([k]) => k.endsWith("packet-with-tins.json"))![1]));
    expect(validatePacket(full)).toEqual([]);
    expect(full.members.filter((m: any) => m.share_count > 0).map((m: any) => m.tin)).toEqual(["123-45-6789", "987-65-4321"]);
    expect(text(pii.find(([k]) => k.endsWith("members-with-tins.csv"))![1])).toContain("987-65-4321");
    // the private files are the packet and nothing else changed
    expect(withoutTins(full)).toEqual(JSON.parse(text(general.find(([k]) => k.endsWith("packet.json"))![1])));
  });

  it("if the audit row can't be written nothing is decrypted, and the message never carries a TIN", async () => {
    const original = db().from.bind(db());
    db().from = (t: string) => {
      const q = original(t);
      if (t === "audit_log") q.insert = async () => ({ error: { message: `cannot write ${TIN_A}` } });
      return q;
    };
    const err = (await generate().catch((e) => e)) as Error;
    expect(err.message).toBe("The TINs can't be shown: the audit log could not be written.");
    expect(err.message).not.toContain(TIN_A);
  });

  it("a tampered ciphertext leaves that TIN out (missing), without a word about it", async () => {
    (db().table("member_w9_tin_secrets") as any[])[0].ciphertext = Buffer.from("tampered!!!!").toString("base64");
    await generate();
    const full = JSON.parse(text(filesIn("packet-pii").find(([k]) => k.endsWith("packet-with-tins.json"))![1]));
    expect(full.members.filter((m: any) => m.share_count > 0).map((m: any) => m.tin ?? null)).toEqual([null, "987-65-4321"]);
  });

  it("a roster with no TINs on file makes no private files at all", async () => {
    (db().table("member_w9") as any[]).length = 0;
    (db().table("member_w9_tin_secrets") as any[]).length = 0;
    await generate();
    expect(filesIn("packet-pii")).toHaveLength(0);
    expect((db().table("year_end_packets") as any[])[0].has_tins).toBe(false);
    expect((db().table("year_end_packets") as any[])[0].data.members.every((m: any) => m.tin_status === "on_file" || m.tin_status === "missing")).toBe(true);
  });

  it("the decrypt function is still used in exactly one place", () => {
    const src = readFileSync("src/lib/year-end-packet.server.ts", "utf8");
    expect(src).not.toMatch(/decryptPii|decryptTinForTaxExport\(|member_w9_tin_secrets/);
  });
});

describe("downloads", () => {
  it("the Manager downloads a file; each download is logged; the hash is checked first", async () => {
    await generate();
    const id = (db().table("year_end_packets") as any[])[0].id;
    const f = await pk.downloadPacketFile(db(), { userId: USERS.admin, packetId: id, file: "packet.pdf" });
    expect(Buffer.from(f.base64, "base64").toString("latin1").startsWith("%PDF-1.4")).toBe(true);
    expect(f.pii).toBe(false);
    expect(audits("packet.downloaded")).toHaveLength(1);
    const key = [...store.keys()].find((k) => k.endsWith("/packet.pdf"))!;
    store.set(key, new Uint8Array([1, 2, 3]));
    await expect(pk.downloadPacketFile(db(), { userId: USERS.admin, packetId: id, file: "packet.pdf" })).rejects.toThrow("doesn't match the hash");
    expect(audits("packet.downloaded")).toHaveLength(1); // a file that wasn't served isn't logged as downloaded
  });

  it("a non-admin cannot download a TIN file, or any packet file; the Manager can, and it is logged as a TIN-file download", async () => {
    await generate();
    const id = (db().table("year_end_packets") as any[])[0].id;
    for (const user of [USERS.b1, USERS.hla, USERS.ra, USERS.broker, "u-nobody", CPA]) {
      await expect(pk.downloadPacketFile(db(), { userId: user, packetId: id, file: "packet-with-tins.json" }), user).rejects.toThrow("Only the Manager");
      await expect(pk.downloadPacketFile(db(), { userId: user, packetId: id, file: "packet.pdf" }), user).rejects.toThrow("Only the Manager");
    }
    expect(audits("packet.pii_file_downloaded")).toHaveLength(0);
    const f = await pk.downloadPacketFile(db(), { userId: USERS.admin, packetId: id, file: "packet-with-tins.json" });
    expect(f.pii).toBe(true);
    expect(Buffer.from(f.base64, "base64").toString()).toContain("123-45-6789");
    expect(audits("packet.pii_file_downloaded")[0]).toMatchObject({ actor_id: USERS.admin, metadata: { file: "packet-with-tins.json", pii: true } });
  });

  it("the board lists versions with who made them and the hash, and offers the TIN files only under their own heading", async () => {
    await generate();
    await generate({ userId: null, trigger: "scheduled" });
    const b = await pk.packetBoard(db(), { userId: USERS.admin, propertyId: A, today: "2026-01-10" });
    expect(b).toMatchObject({ year: 2025, deadline: "2026-01-30" });
    expect(b.packets.map((p) => [p.version, p.trigger, p.generatedBy === "The scheduled job"])).toEqual([[2, "scheduled", true], [1, "manual", false]]);
    expect(b.packets[0]!.files.every((f) => !f.name.includes("tins"))).toBe(true);
    expect(b.packets[0]!.piiFiles.map((f) => f.name).sort()).toEqual(["members-with-tins.csv", "members-with-tins.xlsx", "packet-with-tins.json"]);
    expect(b.packets[0]!.reconciles).toBe(true);
    await expect(pk.packetBoard(db(), { userId: USERS.b1, propertyId: A })).rejects.toThrow("Only the Manager");
  });

  it("the designated CPA gets the general files only, from their own LLC, and the download is logged; never a TIN file", async () => {
    await generate();
    const id = (db().table("year_end_packets") as any[])[0].id;
    const list = await cpa.cpaPackets(db(), { userId: CPA, propertyId: A });
    expect(list.packets[0]!.files.map((f) => f.name)).toContain("packet.pdf");
    expect(JSON.stringify(list)).not.toContain("tins");
    const f = await cpa.cpaDownloadPacketFile(db(), { userId: CPA, packetId: id, file: "packet.json" });
    expect(JSON.parse(Buffer.from(f.base64, "base64").toString()).packet_id).toBe(id);
    expect(audits("cpa.packet_downloaded")[0]).toMatchObject({ actor_id: CPA, actor_type: "cpa", metadata: expect.objectContaining({ file: "packet.json" }) });
    for (const file of ["packet-with-tins.json", "members-with-tins.csv", "members-with-tins.xlsx", "nope.pdf"]) await expect(cpa.cpaDownloadPacketFile(db(), { userId: CPA, packetId: id, file })).rejects.toThrow("File not found.");
    // another person, an owner, a stranger: the same answer as for a packet that doesn't exist
    for (const user of [USERS.b1, "u-nobody", USERS.admin]) await expect(cpa.cpaDownloadPacketFile(db(), { userId: user, packetId: id, file: "packet.pdf" }), user).rejects.toThrow("File not found.");
    await expect(cpa.cpaDownloadPacketFile(db(), { userId: CPA, packetId: "nope", file: "packet.pdf" })).rejects.toThrow("File not found.");
  });
});

describe("the worksheet", () => {
  it("only the Manager refreshes or annotates it", async () => {
    await expect(pk.refreshWorksheet(db(), { userId: USERS.b1, propertyId: A, year: 2025 })).rejects.toThrow("Only the Manager");
    await expect(pk.annotateWorksheet(db(), { userId: USERS.b1, itemId: "w-1", note: "x", status: "reviewed" })).rejects.toThrow("Only the Manager");
    db().rpcResults.annotate_worksheet_item = vi.fn();
    await pk.annotateWorksheet(db(), { userId: USERS.admin, itemId: "w-1", note: "Asked Pat", status: "reviewed" });
    expect(db().rpcResults.annotate_worksheet_item).toHaveBeenCalledWith({ _id: "w-1", _note: "Asked Pat", _status: "reviewed", _actor: USERS.admin });
    expect((await pk.refreshWorksheet(db(), { userId: USERS.admin, propertyId: A, year: 2025 })).made).toBe(2);
  });
});

describe("the scheduled job", () => {
  it("makes the packet for the year that just ended, once per LLC, and running it again adds nothing", async () => {
    const r = await pk.runPacketSweep(db(), { now: new Date("2026-01-05T09:00:00Z") });
    expect(r).toMatchObject({ year: 2025, deadline: "2026-01-30", generated: 1, failed: 0 });
    expect((db().table("year_end_packets") as any[]).map((p) => [p.year, p.trigger])).toEqual([[2025, "scheduled"]]);
    const again = await pk.runPacketSweep(db(), { now: new Date("2026-01-06T09:00:00Z") });
    expect(again).toMatchObject({ generated: 0, skipped: 1 });
    expect(db().table("year_end_packets")).toHaveLength(1);
  });

  it("skips an LLC with no books for that year", async () => {
    const entries = db().table("journal_entries") as any[];
    entries.length = 0;
    entries.push({ id: "e9", property_id: A, entry_date: "2026-02-01" });
    expect(await pk.runPacketSweep(db(), { now: new Date("2026-01-05T09:00:00Z") })).toMatchObject({ generated: 0, skipped: 1 });
  });

  it("tells the Manager, once, if the deadline has passed and the packet could not be made; before the deadline it only retries", async () => {
    db().rpcResults.packet_ledger_sections = () => {
      throw new Error("ledger unavailable");
    };
    const before = await pk.runPacketSweep(db(), { now: new Date("2026-01-20T09:00:00Z") });
    expect(before).toMatchObject({ failed: 1, alerts: 0 });
    const after = await pk.runPacketSweep(db(), { now: new Date("2026-02-02T09:00:00Z") });
    expect(after).toMatchObject({ failed: 1, alerts: 1 });
    await pk.runPacketSweep(db(), { now: new Date("2026-02-03T09:00:00Z") });
    const note = (db().table("notifications") as any[]).filter((n) => n.seller_id === USERS.admin);
    expect(note).toHaveLength(1);
    expect(note[0].message).toContain("2026-01-30");
  });

  it("the route and the cron entry exist", () => {
    expect(readFileSync("src/routes/api.public.year-end-packet-sweep.ts", "utf8")).toContain("runPacketSweep");
    expect(readFileSync("cron-sweeps.sql", "utf8")).toContain("year-end-packet-sweep");
  });

  it("the screens carry the flow", () => {
    const books = readFileSync("src/routes/admin.books.$propertyId.tsx", "utf8");
    for (const l of ["Generate now", "Refresh the worksheet", "Private files with TINs", "Save note", "Mark reviewed"]) expect(books, l).toContain(l);
    expect(readFileSync("src/routes/cpa.index.tsx", "utf8")).toContain("cpaDownloadPacketFileFn");
  });
});
