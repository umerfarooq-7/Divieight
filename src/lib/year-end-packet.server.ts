/**
 * The Year-End CPA Export Packet (server side): the scheduled job and the Manager's "Generate now", the files (PDF, CSV and XLSX per section, JSON),
 * the private TIN files, and the audited downloads. The ledger sections are built and fixed by the database (year-end-packet.sql); the roster's TINs
 * come only through the one audited decrypt function. Nothing here makes a tax return, a K-1, a depreciation figure or a Section 754 figure.
 */
import { createHash, randomUUID } from "node:crypto";
import { adminRecipients, deliver } from "@/lib/authorization.notify.server";
import { toCsv } from "@/lib/csv";
import { renderPacketPdf } from "@/lib/packet-pdf";
import { decryptTinsForPacket, formatTin } from "@/lib/w9.server";
import { buildXlsx } from "@/lib/xlsx";
import { PACKET_DEADLINE_DAYS, composePacket, packetDeadline, packetTables, packetYearFor, tableRowsForCsv, tableRowsForXlsx, validatePacket, withTins, withoutTins, type LedgerSections, type PacketMember, type PacketPayload } from "@/lib/year-end-packet";

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any; storage?: any; auth?: any };
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}
const MISSING = "Database is missing the year-end packet: run year-end-packet.sql in Supabase.";
const BUCKET = "year-end-packets";
const PII_BUCKET = "packet-pii";
const meta = (r?: RequestContext) => ({ ip_address: r?.ip ?? null, user_agent: r?.userAgent ?? null });

async function requireManager(db: Db, userId: string) {
  const { data } = await db.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (data !== true) throw new Error("Only the Manager can do that.");
}
async function call<T = Record<string, any>>(db: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const m = String(error.message ?? "");
    if (/does not exist|schema cache|Could not find/i.test(m) && /packet|worksheet/i.test(m)) throw new Error(MISSING);
    throw new Error(m || "The books refused that.");
  }
  return data as T;
}
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const bytesOf = (s: string) => new TextEncoder().encode(s);

export interface PacketFile {
  name: string;
  path: string;
  kind: "pdf" | "json" | "csv" | "xlsx";
  bytes: number;
  sha256: string;
  pii: boolean;
}

// ---------------------------------------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------------------------------------
/** Who held shares at year-end, by legal name. One row per person (a two-member account is one capital account with two people). */
async function buildRoster(db: Db, propertyId: string, year: number): Promise<{ members: PacketMember[]; w9: Array<{ w9Id: string; key: string; kind: string }>; totalShares: number }> {
  const { data: held } = await db.rpc("holder_shares_as_of", { _property: propertyId, _date: `${year}-12-31` });
  const holders = ((held ?? []) as Array<{ member_id: string; shares: number }>).map((h) => ({ id: h.member_id, shares: Number(h.shares) }));
  const total = holders.reduce((n, h) => n + h.shares, 0);
  const members: PacketMember[] = [];
  const w9: Array<{ w9Id: string; key: string; kind: string }> = [];
  const percent = (shares: number) => (total > 0 ? (Math.round((shares * 10000) / total) / 100).toFixed(2) : "0.00");
  for (const h of holders) {
    const { data: account } = await db.from("buyer_accounts").select("id").eq("id", h.id).maybeSingle();
    if (account) {
      const { data: people } = await db.from("account_members").select("id, full_name, status").eq("buyer_account_id", h.id);
      const { data: forms } = await db.from("member_w9").select("id, account_member_id, legal_name, address, tin_kind").eq("buyer_account_id", h.id);
      const byMember = new Map(((forms ?? []) as Array<Record<string, any>>).map((f) => [f.account_member_id as string, f]));
      const active = ((people ?? []) as Array<Record<string, any>>).filter((p) => p.status !== "removed");
      const rows = active.length > 0 ? active : (forms ?? []).map((f: Record<string, any>) => ({ id: f.account_member_id, full_name: f.legal_name }));
      for (const person of rows as Array<Record<string, any>>) {
        const f = byMember.get(person.id as string);
        const legal = ((f?.legal_name as string | undefined) ?? (person.full_name as string | undefined) ?? "").trim() || `Member account ${h.id.slice(0, 8)}`;
        members.push({ member_key: h.id, legal_name: legal, share_count: h.shares, interest_percent: percent(h.shares), mailing_address: (f?.address as string | undefined) ?? null, tin_kind: (f?.tin_kind as "ssn" | "ein" | undefined) ?? null, tin_status: f ? "on_file" : "missing" });
        if (f) w9.push({ w9Id: f.id as string, key: `${h.id}:${legal}`, kind: f.tin_kind as string });
      }
      continue;
    }
    const { data: seller } = await db.from("sellers").select("full_name, address").eq("id", h.id).maybeSingle();
    members.push({ member_key: h.id, legal_name: ((seller?.full_name as string | undefined) ?? "").trim() || `Retained seller ${h.id.slice(0, 8)}`, share_count: h.shares, interest_percent: percent(h.shares), mailing_address: (seller?.address as string | undefined) ?? null, tin_kind: null, tin_status: "missing" });
  }
  return { members, w9, totalShares: total };
}

async function firstAdmin(db: Db): Promise<string> {
  const { data } = await adminRecipients(db as never).then((r) => ({ data: r }));
  const id = data[0]?.authUserId;
  if (!id) throw new Error("There is no Manager account to run the worksheet as.");
  return id;
}

// ---------------------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------------------
export interface GenerateParams {
  /** The Manager, or null for the scheduled job. */
  userId: string | null;
  propertyId: string;
  year: number;
  trigger: "scheduled" | "manual";
  request?: RequestContext;
  now?: Date;
}

export async function generatePacket(db: Db, p: GenerateParams) {
  if (p.userId) await requireManager(db, p.userId);
  if (!Number.isInteger(p.year) || p.year < 2000) throw new Error("Enter a valid year.");
  const now = p.now ?? new Date();
  if (p.year >= now.getUTCFullYear()) throw new Error("A year-end packet is made after the year has ended.");
  // The worksheet functions need a Manager; the scheduled job runs them as the platform's first Manager account (the audit shows the trigger).
  const actor = p.userId ?? (await firstAdmin(db));
  await call(db, "refresh_worksheet_items", { _property: p.propertyId, _year: p.year, _actor: actor });
  const sections = await call<LedgerSections>(db, "packet_ledger_sections", { _property: p.propertyId, _year: p.year });

  const { data: prop } = await db.from("properties").select("address, city, state, zip").eq("id", p.propertyId).maybeSingle();
  const { data: genesis } = await db.from("entity_genesis").select("llc_name").eq("property_id", p.propertyId).maybeSingle();
  const roster = await buildRoster(db, p.propertyId, p.year);
  const { data: items } = await db.from("cpa_worksheet_items").select("*").eq("property_id", p.propertyId).eq("year", p.year);
  const worksheetItems = ((items ?? []) as Array<Record<string, any>>)
    .sort((a, b) => String(a.item_type).localeCompare(String(b.item_type)) || String(a.title).localeCompare(String(b.title)))
    .map((i) => ({ item_type: i.item_type as string, title: i.title as string, status: i.status as string, manager_note: (i.manager_note ?? null) as string | null, detail: (i.detail ?? {}) as Record<string, any> }));
  const { data: forms } = await db.from("vendor_1099_copies").select("*").eq("property_id", p.propertyId).eq("tax_year", p.year);
  const forms1099 = ((forms ?? []) as Array<Record<string, any>>).map((f) => ({ vendor_name: f.vendor_name as string, form_type: f.form_type as string, tax_year: Number(f.tax_year), amount_cents: Number(f.amount_cents), issued_at: (f.issued_at ?? null) as string | null, file: (f.file_path ?? null) as string | null }));
  // Where an entry came from the bank, its merchant and the bank's category.
  const bank: Record<string, { merchant: string | null; raw_category: string | null }> = {};
  const entryIds = sections.entries.map((e) => e.id as string);
  if (entryIds.length > 0) {
    const { data: txns, error } = await db.from("bank_transactions").select("journal_entry_id, merchant_name, raw_category").in("journal_entry_id", entryIds);
    if (!error) for (const t of (txns ?? []) as Array<Record<string, any>>) if (t.journal_entry_id) bank[t.journal_entry_id as string] = { merchant: (t.merchant_name ?? null) as string | null, raw_category: (t.raw_category ?? null) as string | null };
  }

  const packetId = randomUUID();
  const payload = composePacket({
    packetId,
    generatedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    trigger: p.trigger,
    property: { property_id: p.propertyId, llc_name: (genesis?.llc_name ?? null) as string | null, address: (prop?.address ?? null) as string | null, city: (prop?.city ?? null) as string | null, state: (prop?.state ?? null) as string | null, zip: (prop?.zip ?? null) as string | null, total_shares: roster.totalShares },
    year: p.year,
    sections,
    members: roster.members,
    forms1099,
    worksheetItems,
    bank,
  });
  // Checked against its own schema before anything is recorded.
  const problems = validatePacket(payload);
  if (problems.length > 0) throw new Error(`The packet doesn't match its schema (${problems.length} problem(s)); nothing was recorded. First: ${problems[0]}`);

  const recorded = await call<{ id: string; version: number; hash: string }>(db, "record_year_end_packet", { _id: packetId, _property: p.propertyId, _year: p.year, _payload: payload, _trigger: p.trigger, _actor: p.userId, _meta: meta(p.request) });

  // The TINs, one audited decryption each. They go only into the private files.
  const tinByKey: Record<string, string> = {};
  if (roster.w9.length > 0) {
    const tins = await decryptTinsForPacket(db as never, { actorId: p.userId, propertyId: p.propertyId, year: p.year, w9Ids: roster.w9.map((w) => w.w9Id) });
    for (const w of roster.w9) if (tins[w.w9Id]) tinByKey[w.key] = formatTin(tins[w.w9Id]!, w.kind);
  }
  const hasTins = Object.keys(tinByKey).length > 0;

  const general = withoutTins(payload);
  const dir = `${p.propertyId}/${p.year}/v${recorded.version}`;
  const made: Array<{ file: PacketFile; bytes: Uint8Array; type: string }> = [];
  const add = (name: string, kind: PacketFile["kind"], bytes: Uint8Array, type: string, pii = false) =>
    made.push({ file: { name, path: `${dir}/${name}`, kind, bytes: bytes.length, sha256: sha256(bytes), pii }, bytes, type });
  add("packet.pdf", "pdf", renderPacketPdf(general, recorded.version, recorded.hash), "application/pdf");
  add("packet.json", "json", bytesOf(JSON.stringify(general, null, 2) + "\n"), "application/json");
  for (const t of packetTables(general)) {
    add(`${t.name}.csv`, "csv", bytesOf(toCsv(t.headers, tableRowsForCsv(t))), "text/csv");
    add(`${t.name}.xlsx`, "xlsx", buildXlsx([{ name: t.title, headers: t.headers, rows: tableRowsForXlsx(t) }]), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }
  if (hasTins) {
    const full = withTins(payload, tinByKey);
    const fullProblems = validatePacket(full);
    if (fullProblems.length > 0) throw new Error(`The private packet doesn't match its schema (${fullProblems.length} problem(s)); the private files were not made.`);
    add("packet-with-tins.json", "json", bytesOf(JSON.stringify(full, null, 2) + "\n"), "application/json", true);
    const members = packetTables(full).find((t) => t.name === "members")!;
    add("members-with-tins.csv", "csv", bytesOf(toCsv(members.headers, tableRowsForCsv(members))), "text/csv", true);
    add("members-with-tins.xlsx", "xlsx", buildXlsx([{ name: "Member roster with TINs", headers: members.headers, rows: tableRowsForXlsx(members) }]), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", true);
  }
  for (const m of made) {
    const up = await db.storage?.from(m.file.pii ? PII_BUCKET : BUCKET).upload(m.file.path, new Blob([m.bytes as BlobPart], { type: m.type }), { contentType: m.type, upsert: false });
    if (!up || up.error) throw new Error(`The packet was recorded (version ${recorded.version}) but ${m.file.name} could not be stored. Generate it again for a complete set.`);
  }
  await call(db, "set_packet_files", { _id: packetId, _files: made.map((m) => m.file), _has_tins: hasTins });
  return { id: packetId, version: recorded.version, hash: recorded.hash, files: made.filter((m) => !m.file.pii).length, piiFiles: made.filter((m) => m.file.pii).length, trigger: p.trigger };
}

// ---------------------------------------------------------------------------------------------------------
// The scheduled job
// ---------------------------------------------------------------------------------------------------------
async function alertManagers(db: Db, subject: string, message: string, dedupeKey: string) {
  for (const admin of await adminRecipients(db as never)) {
    await deliver(db as never, admin, { subject, message, link: "/admin/books", type: "year_end_packet", dedupeKey: `${dedupeKey}:${admin.authUserId}` });
  }
}

/**
 * Daily. For the year that has just ended it makes the packet for every LLC that has books for it and no packet yet, so running it again adds
 * nothing. If the deadline (30 days after year-end) has passed and a packet could not be made, the Manager is told, once.
 */
export async function runPacketSweep(db: Db, p: { now?: Date } = {}) {
  const now = p.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const year = packetYearFor(today);
  const deadline = packetDeadline(year);
  const result = { today, year, deadline, generated: 0, skipped: 0, failed: 0, alerts: 0 };
  const { data: cap } = await db.from("cap_table_entries").select("property_id");
  for (const propertyId of [...new Set(((cap ?? []) as Array<{ property_id: string }>).map((c) => c.property_id))]) {
    const { data: have } = await db.from("year_end_packets").select("id").eq("property_id", propertyId).eq("year", year).limit(1);
    // Books for that year: the ledger had something posted by December 31.
    const { data: books } = await db.from("journal_entries").select("id").eq("property_id", propertyId).lte("entry_date", `${year}-12-31`).limit(1);
    if ((have ?? []).length > 0 || (books ?? []).length === 0) {
      result.skipped += 1;
      continue;
    }
    try {
      await generatePacket(db, { userId: null, propertyId, year, trigger: "scheduled", now });
      result.generated += 1;
    } catch (e) {
      result.failed += 1;
      if (today > deadline) {
        await alertManagers(db, "A year-end packet could not be made", `The ${year} Year-End CPA Export Packet was due by ${deadline} (${PACKET_DEADLINE_DAYS} days after year-end) and could not be generated: ${(e as Error).message}. Generate it from the Books screens.`, `packet_failed:${propertyId}:${year}`);
        result.alerts += 1;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// The Manager's screens: versions, worksheet, downloads
// ---------------------------------------------------------------------------------------------------------
export async function packetBoard(db: Db, p: { userId: string; propertyId: string; today?: string }) {
  await requireManager(db, p.userId);
  const today = p.today ?? new Date().toISOString().slice(0, 10);
  const year = packetYearFor(today);
  const { data, error } = await db.from("year_end_packets").select("id, year, version, hash, trigger, generated_by, generated_at, files, has_tins").eq("property_id", p.propertyId).order("year", { ascending: false });
  if (error) throw new Error(MISSING);
  const packets = [];
  for (const r of ((data ?? []) as Array<Record<string, any>>).sort((a, b) => Number(b.year) - Number(a.year) || Number(b.version) - Number(a.version))) {
    const { data: rec } = await db.rpc("packet_reconciliation", { _packet: r.id });
    let by = "The scheduled job";
    if (r.generated_by) {
      const got = await db.auth?.admin?.getUserById?.(r.generated_by);
      by = (got?.data?.user?.email as string | undefined) ?? `Manager ${String(r.generated_by).slice(0, 8)}`;
    }
    const files = (r.files ?? []) as PacketFile[];
    packets.push({
      id: r.id as string,
      year: r.year as number,
      version: r.version as number,
      hash: r.hash as string,
      trigger: r.trigger as "scheduled" | "manual",
      generatedBy: by,
      generatedAt: r.generated_at as string,
      reconciles: ((rec ?? []) as Array<{ ok: boolean }>).length > 0 && ((rec ?? []) as Array<{ ok: boolean }>).every((x) => x.ok),
      files: files.filter((f) => !f.pii).map((f) => ({ name: f.name, kind: f.kind, bytes: f.bytes })),
      piiFiles: files.filter((f) => f.pii).map((f) => ({ name: f.name, kind: f.kind, bytes: f.bytes })),
      hasTins: !!r.has_tins,
    });
  }
  const { data: items } = await db.from("cpa_worksheet_items").select("*").eq("property_id", p.propertyId).order("year", { ascending: false });
  return {
    year,
    deadline: packetDeadline(year),
    packets,
    worksheet: ((items ?? []) as Array<Record<string, any>>).map((i) => ({ id: i.id as string, year: i.year as number, type: i.item_type as string, title: i.title as string, status: i.status as "open" | "reviewed", note: (i.manager_note ?? null) as string | null, detail: (i.detail ?? {}) as Record<string, any> })),
  };
}

export async function refreshWorksheet(db: Db, p: { userId: string; propertyId: string; year: number }) {
  await requireManager(db, p.userId);
  return { made: Number(await call<number>(db, "refresh_worksheet_items", { _property: p.propertyId, _year: p.year, _actor: p.userId })) };
}

export async function annotateWorksheet(db: Db, p: { userId: string; itemId: string; note: string; status: "open" | "reviewed" }) {
  await requireManager(db, p.userId);
  await call(db, "annotate_worksheet_item", { _id: p.itemId, _note: p.note, _status: p.status, _actor: p.userId });
}

/**
 * A file from a packet, for the Manager. The TIN files are in the PII sub-vault (their own private bucket) and are only ever served here, to the
 * Manager, and every download is logged. Nothing else can reach them: they are not in any list a non-admin can see.
 */
export async function downloadPacketFile(db: Db, p: { userId: string; packetId: string; file: string; request?: RequestContext }) {
  await requireManager(db, p.userId);
  const { data } = await db.from("year_end_packets").select("id, files").eq("id", p.packetId).maybeSingle();
  const file = ((data?.files ?? []) as PacketFile[]).find((f) => f.name === p.file);
  if (!data || !file) throw new Error("File not found.");
  const got = await db.storage?.from(file.pii ? PII_BUCKET : BUCKET).download(file.path);
  if (!got || got.error || !got.data) throw new Error("The file could not be read.");
  const bytes = new Uint8Array(await (got.data as Blob).arrayBuffer());
  if (sha256(bytes) !== file.sha256) throw new Error("The stored file doesn't match the hash recorded for it. It was not served.");
  await call(db, "log_packet_download", { _id: p.packetId, _file: file.name, _pii: file.pii, _actor: p.userId, _meta: meta(p.request) });
  return { filename: `${file.name}`, base64: Buffer.from(bytes).toString("base64"), pii: file.pii };
}

/** For the CPA: the general (TIN-free) files of a packet only. The caller has already checked the CPA is designated to this LLC. */
export async function readGeneralPacketFile(db: Db, p: { propertyId: string; packetId: string; file: string }) {
  const { data } = await db.from("year_end_packets").select("id, property_id, files").eq("id", p.packetId).eq("property_id", p.propertyId).maybeSingle();
  const file = ((data?.files ?? []) as PacketFile[]).find((f) => f.name === p.file && !f.pii);
  if (!data || !file) throw new Error("File not found.");
  const got = await db.storage?.from(BUCKET).download(file.path);
  if (!got || got.error || !got.data) throw new Error("The file could not be read.");
  const bytes = new Uint8Array(await (got.data as Blob).arrayBuffer());
  if (sha256(bytes) !== file.sha256) throw new Error("The stored file doesn't match the hash recorded for it. It was not served.");
  return { filename: file.name, base64: Buffer.from(bytes).toString("base64"), packetId: data.id as string };
}

export type { PacketPayload };
