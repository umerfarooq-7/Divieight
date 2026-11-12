/**
 * The disbursement rail (shared types). Real ACH is not wired: every adapter here is simulated. Callers ask the registry
 * for an adapter and never construct one, so a real provider can be dropped in without touching the distribution code.
 */
export type AchState = "sent" | "failed" | "processing";

export interface AchResult {
  state: AchState;
  /** The rail's own reference for the transfer. */
  ref: string;
  /** Why it failed, when it did. */
  reason?: string;
}

export interface DisbursementAdapter {
  readonly provider: string;
  /** Turns bank details into a token the app can keep. The full numbers are used here and nowhere else. */
  tokenizeBank(details: { routing: string; account: string }): Promise<{ token: string; last4: string }>;
  /** Sends one ACH credit to the bank behind memberBankRef (a token), for amountCents. The key makes a repeat of the same call harmless. */
  sendAch(memberBankRef: string, amountCents: number, idempotencyKey: string): Promise<AchResult>;
  /** Where a transfer that was still processing now stands. */
  checkAch(memberBankRef: string, idempotencyKey: string): Promise<AchResult>;
}
