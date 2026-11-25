/**
 * The owner's Ledger in plain words. The books are double-entry (debits and credits by account code), which is right for the
 * Manager and the accountant but not something an owner should have to read. This turns one entry into a sentence: what
 * happened, how much, and whether it moved the LLC's cash or the owner's own capital account. The accounting lines stay
 * available underneath, unchanged.
 */

export interface PlainLine {
  code: string;
  name: string;
  debitCents: number;
  creditCents: number;
}

export interface PlainEntry {
  /** What happened, in a few words. */
  title: string;
  /** One sentence saying where the money went. */
  detail: string;
  amountCents: number;
  /** For the LLC's cash: in, out, or no cash moved (an entry between accounts). */
  cash: "in" | "out" | "none";
  /** True when the entry is on the viewer's own capital account. */
  yours: boolean;
}

const CASH = "1000";
const CONTRIBUTIONS = "3000";
const DISTRIBUTIONS = "3100";
const isMember = (code: string) => code === CONTRIBUTIONS || code === DISTRIBUTIONS || code === "3200";
const isExpense = (code: string) => code.startsWith("6");

/** "Repairs and Maintenance Expense" reads better as "Repairs and maintenance". */
export function plainAccountName(name: string): string {
  const s = name.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+Expense$/i, "").trim();
  return s ? (s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).replace(/\bhoa\b/gi, "HOA").replace(/\bllc\b/gi, "LLC") : name;
}

export const SOURCE_LABELS: Record<string, string> = {
  plaid: "From the bank feed",
  manual: "Entered by the Manager",
  system: "Automatic",
  capital_call: "Capital call",
  expense: "Expense",
  distribution: "Distribution",
  resale: "Share resale",
  opening: "Opening balance",
};
export const sourceLabel = (source: string) => SOURCE_LABELS[source] ?? "Entry";

const list = (names: string[]) => {
  const u = [...new Set(names)];
  return u.length <= 1 ? (u[0] ?? "") : `${u.slice(0, -1).join(", ")} and ${u[u.length - 1]}`;
};

export function plainEntry(entry: { source: string; lines: PlainLine[] }): PlainEntry {
  const lines = entry.lines;
  const sum = (ls: PlainLine[], side: "debitCents" | "creditCents") => ls.reduce((a, l) => a + l[side], 0);
  const total = sum(lines, "debitCents");
  const cashIn = sum(lines.filter((l) => l.code === CASH), "debitCents");
  const cashOut = sum(lines.filter((l) => l.code === CASH), "creditCents");
  const member = lines.filter((l) => isMember(l.code));
  const yours = member.length > 0;
  const expensesDr = lines.filter((l) => isExpense(l.code) && l.debitCents > 0);
  const expensesCr = lines.filter((l) => isExpense(l.code) && l.creditCents > 0);
  const what = (ls: PlainLine[]) => list(ls.map((l) => plainAccountName(l.name)));

  // A cost passed on to the owner: no cash moves, the owner's capital account is charged.
  if (yours && cashIn === 0 && cashOut === 0 && expensesCr.length > 0) {
    const amount = sum(member, "debitCents") || total;
    return { title: `Your share of ${what(expensesCr).toLowerCase()}`, detail: "The LLC already paid this cost. This is the part charged to your capital account. No new payment is taken from you here.", amountCents: amount, cash: "none", yours };
  }
  // Income passed on to the owner.
  if (yours && cashIn === 0 && cashOut === 0 && sum(member, "creditCents") > 0) {
    return { title: "Added to your capital account", detail: "Your share of the LLC's income or an adjustment, credited to your capital account. No cash moved.", amountCents: sum(member, "creditCents"), cash: "none", yours };
  }
  // Money the owner put in.
  if (yours && cashIn > 0 && sum(member, "creditCents") > 0) {
    return { title: "Your contribution received", detail: "Money you paid in reached the LLC's bank account and was added to your capital account.", amountCents: sum(member, "creditCents"), cash: "in", yours };
  }
  // Money paid out to the owner.
  if (yours && cashOut > 0 && sum(member, "debitCents") > 0) {
    return { title: "Distribution paid to you", detail: "The LLC paid this to you from its bank account. It is deducted from your capital account.", amountCents: sum(member, "debitCents"), cash: "out", yours };
  }
  if (yours) {
    return { title: entry.source === "resale" ? "Share transfer on your capital account" : "Change to your capital account", detail: "An entry on your own capital account. Ask the Manager below if you'd like it explained.", amountCents: sum(member, "debitCents") || sum(member, "creditCents") || total, cash: "none", yours };
  }

  // The LLC paying a cost.
  if (cashOut > 0 && expensesDr.length > 0) {
    return { title: `${what(expensesDr)} paid`, detail: "Paid from the LLC's bank account. Each owner's share of it appears as its own line on their ledger.", amountCents: cashOut, cash: "out", yours };
  }
  if (cashOut > 0) {
    const to = lines.filter((l) => l.code !== CASH && l.debitCents > 0);
    return { title: to.length ? `Payment: ${what(to).toLowerCase()}` : "Payment from the LLC", detail: "Paid from the LLC's bank account.", amountCents: cashOut, cash: "out", yours };
  }
  if (cashIn > 0) {
    const from = lines.filter((l) => l.code !== CASH && l.creditCents > 0);
    return { title: from.length ? `Money received: ${what(from).toLowerCase()}` : "Money received by the LLC", detail: "Received into the LLC's bank account.", amountCents: cashIn, cash: "in", yours };
  }
  // A cost or refund recorded without cash (a correction, depreciation, a move between categories).
  if (expensesDr.length > 0 && expensesCr.length > 0) {
    return { title: `Moved from ${what(expensesCr).toLowerCase()} to ${what(expensesDr).toLowerCase()}`, detail: "A correction to how a cost is categorized. No cash moved and the total did not change.", amountCents: total, cash: "none", yours };
  }
  return { title: entry.source === "system" ? "Automatic bookkeeping entry" : "Bookkeeping entry", detail: "An entry between the LLC's accounts. No cash moved.", amountCents: total, cash: "none", yours };
}
