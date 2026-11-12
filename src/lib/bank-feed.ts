/**
 * The daily bank feed for each LLC operating account (shared and pure).
 *
 * The LLC's own consent (llc_plaid_consents, granted by divieight, LLC as Manager) is a separate record and flow from the
 * buyer-side Block 1 consent. The database (bank-feed.sql) does the real work: idempotent ingestion, rules, posting.
 */

export type BankDirection = "in" | "out";
export type BankTransactionStatus = "new" | "categorized" | "needs_review" | "posted" | "ignored";
export const BANK_STATUSES: BankTransactionStatus[] = ["new", "categorized", "needs_review", "posted", "ignored"];

/** One transaction as every bank-feed adapter reports it: amounts are positive whole cents, direction says which way. */
export interface BankFeedTransaction {
  plaidTxnId: string;
  /** Set on a posted transaction that replaces a pending one. */
  pendingTxnId?: string | null;
  /** YYYY-MM-DD */
  postedDate: string;
  amountCents: number;
  direction: BankDirection;
  merchantName: string | null;
  rawCategory: string | null;
  description: string | null;
  pending: boolean;
}

export interface BankFeedBatch {
  transactions: BankFeedTransaction[];
  /** Pending transactions the bank took back. */
  removed: string[];
  /** The account balance now, when the bank says. */
  balanceCents: number | null;
}

export interface LinkedBankAccount {
  /** The secret handle for the linked item. Encrypted before it is stored; never logged. */
  itemRef: string;
  institutionName: string;
  accountMask: string;
}

/** What every bank feed provider implements. */
export interface BankFeedAdapter {
  readonly provider: string;
  link(params: { propertyId: string }): Promise<LinkedBankAccount>;
  listTransactions(itemRef: string, since: string | null): Promise<BankFeedBatch>;
}

/** Words that mark a short-term-rental payout. Kept in step with looks_like_str_revenue() in bank-feed.sql (a test compares them). */
export const STR_REVENUE_HINTS = ["airbnb", "vrbo", "homeaway", "booking\\.com", "guesty", "hostaway", "lodgify", "turno payout", "guest payout", "rental income", "rental revenue", "str revenue", "short.term rental", "nightly rate", "reservation payout"] as const;
const STR_REGEX = new RegExp(`(${STR_REVENUE_HINTS.join("|")})`);
export const looksLikeStrRevenue = (...parts: Array<string | null | undefined>) => STR_REGEX.test(parts.map((p) => p ?? "").join(" ").toLowerCase());

export const REVIEW_REASON_LABELS: Record<string, string> = {
  looks_like_str_revenue: "STR income does not belong to the LLC. It can only be ignored or reclassified, never posted as LLC income.",
  money_in_unknown_source: "Money in from an unknown source. Never auto-posted to income.",
  money_in_not_an_expense_refund: "Money in that isn't a refund of an expense.",
  no_matching_rule: "No categorization rule matched.",
  rule_account_not_postable: "The matching rule points at an account that can't be posted automatically.",
  removed_by_bank: "The bank took this pending transaction back.",
  removed_by_bank_after_posting: "The bank removed this after it was posted. Review the ledger entry.",
};
export const reviewReasonLabel = (reason: string | null) => (reason ? (reason.startsWith("ledger_refused") ? `The ledger refused it (${reason.slice(16)}).` : (REVIEW_REASON_LABELS[reason] ?? reason)) : "");

export const centsFromDollars = (dollars: number) => Math.round(Math.abs(dollars) * 100);

export interface BankReconciliationRow {
  propertyId: string;
  bankBalanceCents: number | null;
  ledgerCashCents: number;
  differenceCents: number | null;
  unmatchedCount: number;
  unmatchedInCents: number;
  unmatchedOutCents: number;
  needsReviewCount: number;
  pendingCount: number;
  /** The part of the gap that unposted bank transactions don't explain. Zero when everything adds up. */
  unreconciledCents: number | null;
  lastIngestedThrough: string | null;
}
