import type { BankFeedAdapter, BankFeedBatch, BankFeedTransaction, LinkedBankAccount } from "@/lib/bank-feed";

const tx = (o: Partial<BankFeedTransaction> & Pick<BankFeedTransaction, "plaidTxnId" | "postedDate" | "amountCents" | "direction">): BankFeedTransaction => ({
  pendingTxnId: null,
  merchantName: null,
  rawCategory: null,
  description: null,
  pending: false,
  ...o,
});

/**
 * A deterministic bank feed: the same calls always return the same days. Each call to listTransactions returns the next
 * batch of the script (the last one repeats), so a test can run "day one", "day two" and "day two again".
 * The default script covers a pending transaction that later posts, a duplicate, a refund, an unknown merchant,
 * an unknown deposit and a short-term-rental payout.
 */
export function defaultSimulatedScript(): BankFeedBatch[] {
  const taxMan = tx({ plaidTxnId: "sim-tax-1", postedDate: "2026-11-02", amountCents: 450_000, direction: "out", merchantName: "Converse County Treasurer", description: "PROPERTY TAX 2026", rawCategory: "GENERAL_GOVERNMENT" });
  const hazard = tx({ plaidTxnId: "sim-ins-1", postedDate: "2026-11-03", amountCents: 120_000, direction: "out", merchantName: "State Farm", description: "INSURANCE PREMIUM", rawCategory: "INSURANCE" });
  const unknownOut = tx({ plaidTxnId: "sim-unknown-1", postedDate: "2026-11-04", amountCents: 8_800, direction: "out", merchantName: "Zeta Widgets Co", description: "POS PURCHASE", rawCategory: "GENERAL_MERCHANDISE" });
  const pending = tx({ plaidTxnId: "sim-pend-1", postedDate: "2026-11-05", amountCents: 30_000, direction: "out", merchantName: "Rapid Plumbing LLC", description: "PLUMBING REPAIR", pending: true });
  const unknownIn = tx({ plaidTxnId: "sim-in-1", postedDate: "2026-11-05", amountCents: 250_000, direction: "in", merchantName: "ACH CREDIT", description: "DEPOSIT" });
  const str = tx({ plaidTxnId: "sim-str-1", postedDate: "2026-11-05", amountCents: 180_000, direction: "in", merchantName: "Airbnb", description: "AIRBNB PAYOUT" });
  const refund = tx({ plaidTxnId: "sim-refund-1", postedDate: "2026-11-07", amountCents: 5_000, direction: "in", merchantName: "Home Depot", description: "REFUND HOME DEPOT" });
  const postedPlumbing = tx({ plaidTxnId: "sim-post-1", pendingTxnId: "sim-pend-1", postedDate: "2026-11-06", amountCents: 30_000, direction: "out", merchantName: "Rapid Plumbing LLC", description: "PLUMBING REPAIR" });
  return [
    { transactions: [taxMan, hazard, unknownOut, pending, unknownIn, str], removed: [], balanceCents: 4_000_000 },
    // Day two: the pending one posts under a new id; the tax payment is delivered again; a refund arrives.
    { transactions: [taxMan, postedPlumbing, refund], removed: [], balanceCents: 3_975_000 },
  ];
}

export class SimulatedBankFeedAdapter implements BankFeedAdapter {
  readonly provider = "simulated";
  private calls = 0;
  constructor(private readonly script: BankFeedBatch[] = defaultSimulatedScript()) {}

  async link(params: { propertyId: string }): Promise<LinkedBankAccount> {
    return { itemRef: `sim-item-${params.propertyId}`, institutionName: "Simulated Bank", accountMask: "0000" };
  }

  async listTransactions(_itemRef: string, since: string | null): Promise<BankFeedBatch> {
    const batch = this.script[Math.min(this.calls, this.script.length - 1)] ?? { transactions: [], removed: [], balanceCents: null };
    this.calls += 1;
    return { ...batch, transactions: batch.transactions.filter((t) => !since || t.postedDate >= since || t.pending || Boolean(t.pendingTxnId)) };
  }
}
