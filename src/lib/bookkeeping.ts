/**
 * Bookkeeping foundation (Module 22), shared and pure. One double-entry ledger per property LLC, in integer cents.
 *
 * The database is the source of truth (bookkeeping.sql): it checks that every entry balances, that nothing in the journal is
 * ever changed or deleted, and that a closed period refuses posting. This file holds the standard chart (the same accounts
 * the SQL seeds; a test keeps the two equal) and the small checks the server runs before it asks the database.
 *
 * It does not touch owner_capital_accounts, expenses, capital calls or distribution_events. Later prompts connect them by
 * posting entries with the matching source.
 */

export const LEDGER_SOURCES = ["plaid", "manual", "system", "capital_call", "expense", "distribution", "resale", "opening"] as const;
export type LedgerSource = (typeof LEDGER_SOURCES)[number];
export const isLedgerSource = (s: unknown): s is LedgerSource => typeof s === "string" && (LEDGER_SOURCES as readonly string[]).includes(s);

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type NormalBalance = "debit" | "credit";

export interface ChartAccount {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  /** Kept per member: a line on it names the member. */
  isMemberControl: boolean;
}

/**
 * The standard chart every property starts with. There is deliberately NO short-term-rental revenue account: that income
 * does not accrue to the LLC (COOA Section 10). "Other Income" is for incidental LLC income only.
 */
export const STANDARD_CHART: ChartAccount[] = [
  { code: "1000", name: "Cash (LLC operating account)", type: "asset", normalBalance: "debit", isMemberControl: false },
  { code: "1100", name: "Prepaid and Other Assets", type: "asset", normalBalance: "debit", isMemberControl: false },
  { code: "1200", name: "Property (acquisition cost)", type: "asset", normalBalance: "debit", isMemberControl: false },
  { code: "1210", name: "Furnishings and Capital Improvements", type: "asset", normalBalance: "debit", isMemberControl: false },
  { code: "1290", name: "Accumulated Depreciation", type: "asset", normalBalance: "credit", isMemberControl: false },
  { code: "3000", name: "Member Capital Contributions", type: "equity", normalBalance: "credit", isMemberControl: true },
  { code: "3100", name: "Member Distributions", type: "equity", normalBalance: "debit", isMemberControl: true },
  { code: "3200", name: "Member Capital Account (control)", type: "equity", normalBalance: "credit", isMemberControl: true },
  { code: "4000", name: "Other Income (incidental LLC income only)", type: "income", normalBalance: "credit", isMemberControl: false },
  { code: "6000", name: "Property Tax Expense", type: "expense", normalBalance: "debit", isMemberControl: false },
  { code: "6100", name: "Hazard Insurance Expense", type: "expense", normalBalance: "debit", isMemberControl: false },
  { code: "6110", name: "Umbrella Insurance Expense", type: "expense", normalBalance: "debit", isMemberControl: false },
  { code: "6200", name: "HOA Dues Expense", type: "expense", normalBalance: "debit", isMemberControl: false },
  { code: "6300", name: "Utilities Expense", type: "expense", normalBalance: "debit", isMemberControl: false },
  { code: "6400", name: "Repairs and Maintenance Expense", type: "expense", normalBalance: "debit", isMemberControl: false },
  { code: "6500", name: "Property Management Fee Expense", type: "expense", normalBalance: "debit", isMemberControl: false },
  { code: "6600", name: "Cleaning and Turnover Expense", type: "expense", normalBalance: "debit", isMemberControl: false },
];

export const accountByCode = (code: string) => STANDARD_CHART.find((a) => a.code === code);

/** A line as the caller gives it: name the account by id or by its code on the chart in force. Amounts are whole cents. */
export interface LedgerLineInput {
  accountId?: string;
  code?: string;
  memberId?: string | null;
  debitCents?: number;
  creditCents?: number;
}

export interface LedgerEntryMeta {
  /** YYYY-MM-DD. Defaults to today. */
  entryDate?: string;
  source: LedgerSource;
  sourceRef?: string | null;
  memo?: string | null;
  /** A flagged adjustment to a closed period: the Manager only, and a reason. */
  isAdjustment?: boolean;
  adjustmentReason?: string | null;
}

export const isWholeCents = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export const sumCents = (lines: LedgerLineInput[]) => ({
  debit: lines.reduce((s, l) => s + (l.debitCents ?? 0), 0),
  credit: lines.reduce((s, l) => s + (l.creditCents ?? 0), 0),
});

/** A first check before the database's own: at least two lines, whole cents, one side each, and balanced. Null when fine. */
export function ledgerLineProblem(lines: LedgerLineInput[]): string | null {
  if (!Array.isArray(lines) || lines.length < 2) return "An entry needs at least two lines.";
  for (const [i, l] of lines.entries()) {
    const d = l.debitCents ?? 0;
    const c = l.creditCents ?? 0;
    if (!isWholeCents(d) || !isWholeCents(c)) return `Line ${i + 1}: amounts are whole numbers of cents.`;
    if ((d > 0) === (c > 0)) return `Line ${i + 1}: each line is a debit or a credit, above zero, not both.`;
    if (!l.accountId && !l.code) return `Line ${i + 1}: name the account.`;
  }
  const { debit, credit } = sumCents(lines);
  return debit === credit ? null : `The entry is unbalanced: debits ${debit} cents, credits ${credit} cents.`;
}

export interface TrialBalanceRow {
  accountId: string;
  coaVersion: number;
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  /** The member, for a per-member account; a label ("Member 1") for a viewer who may not see who. */
  member: string | null;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
}

export interface TrialBalance {
  asOf: string;
  rows: TrialBalanceRow[];
  totalDebitCents: number;
  totalCreditCents: number;
  /** Debits equal credits. Always true for a ledger the database has accepted. */
  balanced: boolean;
}

export interface LedgerActivityRow {
  entryId: string;
  entryDate: string;
  postedAt: string;
  source: string;
  sourceRef: string | null;
  memo: string | null;
  reversesEntryId: string | null;
  member: string | null;
  debitCents: number;
  creditCents: number;
  runningBalanceCents: number;
}

/** Who is reading the ledger. */
export type LedgerRole = "manager" | "member" | "heavy_lifting_agent" | "cpa";
