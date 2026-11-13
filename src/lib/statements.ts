/**
 * Monthly Co-owner Statements (shared and pure): the schedule, the shape of a snapshot, and its labels.
 * The database (monthly-statements.sql) builds and keeps the snapshots; nothing here changes a number.
 */
import { expenseMoney, fromCents } from "@/lib/expenses";

export type StatementStatus = "draft" | "issued" | "superseded";
export const STATEMENT_STATUS_LABELS: Record<StatementStatus, string> = { draft: "Draft", issued: "Issued", superseded: "Superseded by a newer version" };

/** Statements are generated within this many business days of the month's first business day ("the first business week"). */
export const STATEMENT_DEADLINE_BUSINESS_DAYS = 5;

/**
 * ASSUMPTION (flagged on the launch readiness page): no holiday calendar has been decided. Until one is, only weekends are skipped, so a
 * holiday counts as a business day. Add dates here (YYYY-MM-DD) when the calendar is chosen.
 */
export const STATEMENT_HOLIDAYS: readonly string[] = [];
export const STATEMENT_HOLIDAY_ASSUMPTION = "ASSUMPTION: no holiday calendar has been chosen. The monthly statement schedule skips weekends only, so a holiday counts as a business day. Add the real calendar before relying on the deadline.";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const isBusinessDay = (d: Date, holidays: readonly string[]) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !holidays.includes(iso(d));

/** The nth business day (1 = first) of a calendar month, as YYYY-MM-DD. */
export function nthBusinessDay(year: number, monthIndex: number, n: number, holidays: readonly string[] = STATEMENT_HOLIDAYS): string {
  const d = utc(year, monthIndex, 1);
  let seen = 0;
  for (;;) {
    if (isBusinessDay(d, holidays)) {
      seen += 1;
      if (seen === n) return iso(d);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

export const firstBusinessDay = (year: number, monthIndex: number, holidays: readonly string[] = STATEMENT_HOLIDAYS) => nthBusinessDay(year, monthIndex, 1, holidays);

/** The month a run on `today` is about: the month that just ended. */
export function previousPeriod(today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)); // 1-12, this month
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Where the schedule stands on a given day for the month that has just ended. */
export function statementSchedule(today: string, holidays: readonly string[] = STATEMENT_HOLIDAYS) {
  const year = Number(today.slice(0, 4));
  const monthIndex = Number(today.slice(5, 7)) - 1;
  const starts = firstBusinessDay(year, monthIndex, holidays);
  const deadline = nthBusinessDay(year, monthIndex, STATEMENT_DEADLINE_BUSINESS_DAYS, holidays);
  return { period: previousPeriod(today), starts, deadline, due: today >= starts, overdue: today > deadline };
}

export const isPeriod = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const periodLabel = (period: string) => `${MONTHS[Number(period.slice(5, 7)) - 1] ?? period} ${period.slice(0, 4)}`;

// ---------------------------------------------------------------------------------------------------------
// The snapshot, as monthly-statements.sql builds it
// ---------------------------------------------------------------------------------------------------------
export interface StatementItem {
  date: string;
  memo: string;
  amount_cents: number;
}
export interface StatementAccountLine {
  code: string;
  name: string;
  total_cents: number;
  items: StatementItem[];
}
export interface StatementLlcActivity {
  income_cents: number;
  expense_cents: number;
  net_cents: number;
  income: StatementAccountLine[];
  expense: StatementAccountLine[];
}
export interface StatementCapital {
  opening_cents: number;
  contributions_cents: number;
  distributions_cents: number;
  income_cents: number;
  expense_cents: number;
  depreciation_cents: number;
  transfers_cents: number;
  closing_cents: number;
  lines?: Array<{ date: string; type: string; amount_cents: number; memo: string }>;
}
export interface StatementSnapshot {
  schema: string;
  period: string;
  period_start: string;
  period_end: string;
  version?: number;
  issued_at?: string;
  manager_notes?: string | null;
  property: { property_id: string; address: string | null; city: string | null; state: string | null; zip: string | null; llc_name: string | null; shares: number; total_shares: number; interest_percent: string };
  member_key: string;
  capital: StatementCapital;
  llc_month: StatementLlcActivity;
  ytd: { year: number; capital: Omit<StatementCapital, "opening_cents" | "lines"> & { beginning_cents: number }; llc: StatementLlcActivity };
  generated_at: string;
}

/** Money for a statement: whole cents in, "$1,234.56" or "-$1,234.56" out. */
export const statementMoney = (cents: number) => (cents < 0 ? `-${expenseMoney(fromCents(-cents))}` : expenseMoney(fromCents(cents)));

export const CAPITAL_TYPE_LABELS: Record<string, string> = {
  opening: "Opening capital from the closing",
  contribution: "Contribution",
  income: "Allocable income",
  expense: "Allocable expense",
  depreciation: "Allocable depreciation",
  distribution: "Distribution",
  transfer_in: "Share purchased (transferred in)",
  transfer_out: "Share sold (transferred out)",
};

/** The rows of the member's capital account table, in the order the statement shows them. */
export function capitalRows(c: StatementCapital): Array<[string, number]> {
  const rows: Array<[string, number]> = [
    ["Opening balance", c.opening_cents],
    ["Contributions", c.contributions_cents],
    ["Distributions", c.distributions_cents],
    ["Allocable income", c.income_cents],
    ["Allocable expense", c.expense_cents],
  ];
  if (c.depreciation_cents !== 0) rows.push(["Allocable depreciation", c.depreciation_cents]);
  if (c.transfers_cents !== 0) rows.push(["Shares bought and sold", c.transfers_cents]);
  rows.push(["Closing balance", c.closing_cents]);
  return rows;
}

/** The statement is one balance: it must add up. */
export const capitalAddsUp = (c: StatementCapital) => c.opening_cents + c.contributions_cents + c.distributions_cents + c.income_cents + c.expense_cents + c.depreciation_cents + c.transfers_cents === c.closing_cents;

export const statementTitle = (s: Pick<StatementSnapshot, "period" | "property">) => `Monthly statement, ${periodLabel(s.period)}: ${s.property.llc_name ?? s.property.address ?? "LLC"}`;
