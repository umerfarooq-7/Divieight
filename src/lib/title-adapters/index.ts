/**
 * Adapter registry. Adding SoftPro later means one more entry here plus a
 * `SoftProAdapter implements TitleEscrowAdapter` — nothing else changes.
 */
import type { TitleProvider } from "@/lib/title-escrow";
import type { TitleEscrowAdapter } from "./adapter";
import { QualiaAdapter } from "./qualia";

const ADAPTERS: Partial<Record<TitleProvider, () => TitleEscrowAdapter>> = {
  qualia: () => new QualiaAdapter(),
  // softpro: () => new SoftProAdapter(),  // Month 7+
};

export const DEFAULT_TITLE_PROVIDER: TitleProvider = "qualia";

export function getTitleAdapter(provider: string): TitleEscrowAdapter {
  const make = ADAPTERS[provider as TitleProvider];
  if (!make) throw new Error(`No title/escrow adapter for provider "${provider}"`);
  return make();
}

export type { TitleEscrowAdapter, ClosingBundle, NormalizedTitleEvent } from "./adapter";
