/**
 * The Year-End CPA Export Packet (shared and pure): when it is due, how the packet is put together from the ledger sections the database builds, and
 * the section tables the CSV and XLSX files are made from. Nothing here computes a tax figure: no K-1, no 1065, no depreciation, no Section 754.
 */
import { PACKET_SCHEMA, PACKET_SCHEMA_VERSION } from "@/lib/year-end-packet-schema";
import { validate } from "@/lib/json-schema";

export { PACKET_SCHEMA, PACKET_SCHEMA_VERSION };

/** The packet is generated within this many days of the calendar year-end. */
export const PACKET_DEADLINE_DAYS = 30;
/** The last day to have it: 30 days after December 31. */
export const packetDeadline = (year: number) => new Date(Date.UTC(year, 11, 31) + PACKET_DEADLINE_DAYS * 86_400_000).toISOString().slice(0, 10);
/** The year a run on `today` is about: the year that has just ended (from January 1). */
export const packetYearFor = (today: string) => Number(today.slice(0, 4)) - 1;

/** ASSUMPTION (flagged on the launch readiness page). */
export const PACKET_JSON_ASSUMPTION =
  "ASSUMPTION: the packet's JSON has been validated only against its own schema. A CPA must validate it against real Lacerte or ProConnect before launch. Two sample packets are in samples/year-end-packet for that.";

export interface PacketMember {
  member_key: string;
  legal_name: string;
  share_count: number;
  interest_percent: string;
  mailing_address: string | null;
  tin_kind: "ssn" | "ein" | null;
  tin_status: "on_file" | "missing";
  tin?: string;
}

export interface PacketPayload {
  schema_version: string;
  packet_id: string;
  generated_at: string;
  trigger: "scheduled" | "manual";
  property: { property_id: string; llc_name: string | null; address: string | null; city: string | null; state: string | null; zip: string | null; total_shares: number };
  period: { year: number; start: string; end: string };
  accounts: Array<Record<string, any>>;
  entries: Array<Record<string, any>>;
  trial_balance: Record<string, any>;
  balance_sheet: Record<string, any>;
  income_statement: Record<string, any>;
  members: PacketMember[];
  roll_forwards: Array<Record<string, any>>;
  forms_1099: Array<{ vendor_name: string; form_type: string; tax_year: number; amount_cents: number; issued_at: string | null; file: string | null }>;
  worksheet: { items: Array<{ item_type: string; title: string; status: string; manager_note: string | null; detail: Record<string, any> }> };
  totals: { entries: number; debit_cents: number; credit_cents: number };
}

/** The ledger sections exactly as packet_ledger_sections returns them. */
export interface LedgerSections {
  accounts: Array<Record<string, any>>;
  entries: Array<Record<string, any>>;
  trial_balance: Record<string, any>;
  balance_sheet: Record<string, any>;
  income_statement: Record<string, any>;
  roll_forwards: Array<Record<string, any>>;
}

export function composePacket(a: {
  packetId: string;
  generatedAt: string;
  trigger: "scheduled" | "manual";
  property: PacketPayload["property"];
  year: number;
  sections: LedgerSections;
  members: PacketMember[];
  forms1099?: PacketPayload["forms_1099"];
  worksheetItems: PacketPayload["worksheet"]["items"];
  /** Bank-feed details for entries that came from the bank, by entry id. */
  bank?: Record<string, { merchant: string | null; raw_category: string | null }>;
}): PacketPayload {
  const entries = a.sections.entries.map((e) => {
    const bank = a.bank?.[e.id as string];
    return bank ? { ...e, bank } : e;
  });
  let debit = 0;
  let credit = 0;
  for (const e of entries) for (const l of e.lines as Array<Record<string, any>>) {
    debit += Number(l.debit_cents);
    credit += Number(l.credit_cents);
  }
  return {
    schema_version: PACKET_SCHEMA_VERSION,
    packet_id: a.packetId,
    generated_at: a.generatedAt,
    trigger: a.trigger,
    property: a.property,
    period: { year: a.year, start: `${a.year}-01-01`, end: `${a.year}-12-31` },
    accounts: a.sections.accounts,
    entries,
    trial_balance: a.sections.trial_balance,
    balance_sheet: a.sections.balance_sheet,
    income_statement: a.sections.income_statement,
    members: a.members,
    roll_forwards: a.sections.roll_forwards,
    forms_1099: a.forms1099 ?? [],
    worksheet: { items: a.worksheetItems },
    totals: { entries: entries.length, debit_cents: debit, credit_cents: credit },
  };
}

/** Problems with a packet against its schema (an empty list means it is valid). */
export const validatePacket = (packet: unknown) => validate(PACKET_SCHEMA as never, packet);

/** The same packet with each member's TIN added: the private file. Nothing else changes. */
export const withTins = (packet: PacketPayload, tins: Record<string, string>): PacketPayload => ({
  ...packet,
  members: packet.members.map((m) => (tins[m.member_key + ":" + m.legal_name] ? { ...m, tin: tins[m.member_key + ":" + m.legal_name]! } : m)),
});

/** The TIN-free copy: whatever came in, nothing with a `tin` goes out. */
export const withoutTins = (packet: PacketPayload): PacketPayload => ({ ...packet, members: packet.members.map(({ tin: _tin, ...m }) => m as PacketMember) });

// ---------------------------------------------------------------------------------------------------------
// The section tables
// ---------------------------------------------------------------------------------------------------------
export type Cell = string | number | null;
export interface SectionTable {
  /** The file name, without its extension. */
  name: string;
  title: string;
  headers: string[];
  rows: Cell[][];
  /** Columns that hold whole cents. They are written as dollars. */
  money: number[];
}

export const SECTION_NAMES = ["accounts", "general_ledger", "trial_balance", "balance_sheet", "income_statement", "roll_forwards", "members", "forms_1099", "worksheet"] as const;

export function packetTables(p: PacketPayload): SectionTable[] {
  const gl: Cell[][] = [];
  for (const e of p.entries) {
    for (const l of e.lines as Array<Record<string, any>>) {
      gl.push([e.date, e.id, e.source, e.source_ref ?? null, e.memo, l.account_code, l.account_name, l.category, l.member_key ?? null, l.debit_cents, l.credit_cents, e.reverses_entry_id ?? null, e.bank?.merchant ?? null, e.bank?.raw_category ?? null]);
    }
  }
  const bs: Cell[][] = [
    ...(p.balance_sheet.assets as Array<Record<string, any>>).map((a): Cell[] => ["Assets", `${a.code} ${a.name}`, a.balance_cents]),
    ["Assets", "Total assets", p.balance_sheet.total_assets_cents],
    ...((p.balance_sheet.liabilities ?? []) as Array<Record<string, any>>).map((a): Cell[] => ["Liabilities", `${a.code} ${a.name}`, a.balance_cents]),
    ...(p.balance_sheet.member_capital as Array<Record<string, any>>).map((m): Cell[] => ["Members' capital", `Member ${m.member_key}`, m.balance_cents]),
    ["Members' capital", "Earned and not yet allocated to the members", p.balance_sheet.unallocated_net_income_cents ?? 0],
    ["Liabilities and capital", "Total liabilities and capital", p.balance_sheet.total_liabilities_and_equity_cents],
  ];
  const is: Cell[][] = [];
  for (const [section, accounts] of [["Income", p.income_statement.income], ["Expense", p.income_statement.expense]] as Array<[string, Array<Record<string, any>>]>) {
    for (const a of accounts) {
      is.push([section, `${a.code} ${a.name}`, null, "Account total", a.total_cents]);
      for (const i of a.items as Array<Record<string, any>>) is.push([section, `${a.code} ${a.name}`, i.date, i.memo, i.amount_cents]);
    }
  }
  is.push(["Total", "Income", null, "", p.income_statement.income_cents], ["Total", "Expense", null, "", p.income_statement.expense_cents], ["Total", "Net income (expense)", null, "", p.income_statement.net_cents]);
  const alloc = p.income_statement.allocated_to_members as Record<string, number> | undefined;
  if (alloc) is.push(["Passed on to the members", "Income allocated", null, "", alloc.income_allocated_cents ?? 0], ["Passed on to the members", "Expense allocated", null, "", alloc.expense_allocated_cents ?? 0]);
  const nameOf = new Map(p.members.map((m) => [m.member_key, m.legal_name]));
  return [
    { name: "accounts", title: "Chart of accounts", headers: ["code", "name", "type", "normal_balance", "member_control"], rows: p.accounts.map((a) => [a.code, a.name, a.type, a.normal_balance, a.member_control ? "yes" : "no"]), money: [] },
    { name: "general_ledger", title: `General ledger ${p.period.year}`, headers: ["date", "entry_id", "source", "source_ref", "memo", "account_code", "account_name", "category", "member_key", "debit", "credit", "reverses_entry_id", "bank_merchant", "bank_category"], rows: gl, money: [9, 10] },
    { name: "trial_balance", title: `Trial balance as of ${p.trial_balance.as_of}`, headers: ["code", "name", "type", "debit", "credit", "balance"], rows: [...(p.trial_balance.rows as Array<Record<string, any>>).map((r): Cell[] => [r.code, r.name, r.type, r.debit_cents, r.credit_cents, r.balance_cents]), ["", "Total", "", p.trial_balance.total_debit_cents, p.trial_balance.total_credit_cents, null]], money: [3, 4, 5] },
    { name: "balance_sheet", title: `Balance sheet as of ${p.balance_sheet.as_of}`, headers: ["section", "line", "amount"], rows: bs, money: [2] },
    { name: "income_statement", title: `Income statement ${p.period.year}`, headers: ["section", "account", "date", "description", "amount"], rows: is, money: [4] },
    { name: "roll_forwards", title: `Capital account roll-forward ${p.period.year}`, headers: ["member_key", "member", "beginning", "contributions", "distributions", "allocable_income", "allocable_expense", "allocable_depreciation", "transfers", "ending"], rows: p.roll_forwards.map((r) => [r.member_key, nameOf.get(r.member_key as string) ?? "", r.beginning_cents, r.contributions_cents, r.distributions_cents, r.income_cents, r.expense_cents, r.depreciation_cents, r.transfers_cents ?? 0, r.ending_cents]), money: [2, 3, 4, 5, 6, 7, 8, 9] },
    { name: "members", title: "Member roster", headers: ["member_key", "legal_name", "share_count", "interest_percent", "mailing_address", "tin_kind", "tin_status", ...(p.members.some((m) => m.tin) ? ["tin"] : [])], rows: p.members.map((m) => [m.member_key, m.legal_name, m.share_count, m.interest_percent, m.mailing_address, m.tin_kind, m.tin_status, ...(p.members.some((x) => x.tin) ? [m.tin ?? null] : [])]), money: [] },
    { name: "forms_1099", title: "1099 forms issued to LLC vendors", headers: ["vendor_name", "form_type", "tax_year", "amount", "issued_at", "file"], rows: p.forms_1099.map((f) => [f.vendor_name, f.form_type, f.tax_year, f.amount_cents, f.issued_at, f.file]), money: [3] },
    { name: "worksheet", title: "CPA Cooperation Worksheet", headers: ["item", "title", "status", "manager_note", "detail"], rows: p.worksheet.items.map((i) => [i.item_type, i.title, i.status, i.manager_note, JSON.stringify(i.detail)]), money: [] },
  ];
}

const dollars = (c: unknown) => (typeof c === "number" ? (c / 100).toFixed(2) : "");

/** A table as CSV text: whole cents become dollars. */
export function tableRowsForCsv(t: SectionTable): Cell[][] {
  return t.rows.map((r) => r.map((c, i) => (t.money.includes(i) ? (c === null ? null : dollars(c)) : c)));
}
/** A table for a spreadsheet: money cells are numbers, in dollars, so a column can be summed. */
export function tableRowsForXlsx(t: SectionTable): Cell[][] {
  return t.rows.map((r) => r.map((c, i) => (t.money.includes(i) && typeof c === "number" ? c / 100 : c)));
}
