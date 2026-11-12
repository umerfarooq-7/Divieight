/** The bank feed registry. Callers ask for an adapter here and never construct one. */
import type { BankFeedAdapter } from "@/lib/bank-feed";
import { PlaidSandboxAdapter } from "./plaid-sandbox";
import { SimulatedBankFeedAdapter } from "./simulated";

const ADAPTERS: Record<string, () => BankFeedAdapter> = {
  simulated: () => new SimulatedBankFeedAdapter(),
  plaid_sandbox: () => new PlaidSandboxAdapter(),
};

/** Plaid sandbox when its keys are set; otherwise the deterministic simulated feed. */
export const defaultBankFeedProvider = () => (process.env["PLAID_CLIENT_ID"] && process.env["PLAID_SECRET"] ? "plaid_sandbox" : "simulated");

let override: BankFeedAdapter | null = null;
export function setBankFeedAdapterForTesting(adapter: BankFeedAdapter | null) {
  override = adapter;
}

export function getBankFeedAdapter(provider: string = defaultBankFeedProvider()): BankFeedAdapter {
  if (override) return override;
  const make = ADAPTERS[provider];
  if (!make) throw new Error(`No bank feed adapter for provider "${provider}"`);
  return make();
}
