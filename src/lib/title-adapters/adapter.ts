/**
 * Title/Escrow provider adapter.
 *
 * Every title/escrow integration implements this interface; the rest of the
 * platform only ever speaks the normalized shapes below. Qualia is the first
 * implementation; SoftPro (Month 7+) is a second implementation, not a rewrite.
 */
import type { TitleMilestone, TitleProvider } from "@/lib/title-escrow";

/** What the platform sends when a deal is ready to open with title. */
export interface ClosingBundle {
  propertyId: string;
  property: { address: string; city: string; state: string; zip: string; purchasePrice: number | null };
  seller: { sellerId: string | null; retainedShares: number };
  buyers: Array<{ buyerAccountId: string; shares: number; memberNames: string[]; residentAgentId: string | null }>;
  closingTimeline: {
    anticipatedClosingDate: string | null;
    earnestMoneyDeadline: string | null;
    closingFundsDeadline: string | null;
  };
  escrow: { company: string | null; reference: string | null };
  sourceRequestId: string | null;
}

export interface OpenOrderResult {
  externalOrderId: string;
  simulated: boolean;
  /** Exactly what went (or would have gone) over the wire, for the audit log. */
  request: unknown;
}

/** A provider webhook reduced to what the platform acts on. */
export interface NormalizedTitleEvent {
  milestone: TitleMilestone;
  externalOrderId: string;
  externalEventId: string;
  occurredAt: string;
  deposits?: Array<{ buyerAccountId: string; amount: number }>;
  allDepositsComplete?: boolean;
  closingDate?: string | null;
  titleCommitment?: { url: string; title: string; contentHash: string } | null;
}

/** Inputs the simulator uses to shape a provider-native webhook body. */
export interface SimulationOptions {
  deposits?: Array<{ buyerAccountId: string; amount: number }>;
  allDepositsComplete?: boolean;
  closingDate?: string | null;
}

export interface TitleEscrowAdapter {
  readonly provider: TitleProvider;
  /** Open the order with the provider by pushing the Closing Bundle. */
  openOrder(bundle: ClosingBundle): Promise<OpenOrderResult>;
  /** Authenticate an inbound webhook (signature over the raw body). */
  verifyWebhook(rawBody: string, headers: Headers): Promise<boolean>;
  /** Map the provider's webhook body to a platform event (null = ignore). */
  parseWebhook(rawBody: string): NormalizedTitleEvent | null;
  /** Build a provider-native webhook body for the admin simulation panel. */
  simulateWebhook(externalOrderId: string, milestone: TitleMilestone, opts: SimulationOptions): string;
  /** Sign a simulated body the way the provider would, so it can go through verifyWebhook. */
  signForSimulation(rawBody: string): Promise<Record<string, string>>;
  /**
   * Transmit a Commission Disbursement Authorization (the Source of Truth) to
   * the order. This is an INSTRUCTION to title/escrow — it never moves money.
   */
  transmitDisbursementInstruction(externalOrderId: string, cda: DisbursementInstruction): Promise<TransmitResult>;
}

/** Broker-to-broker payee lines title/escrow is instructed to pay from proceeds. */
export interface DisbursementInstruction {
  documentId: string;
  version: number;
  contentHash: string;
  totalCommissionCents: number;
  payees: Array<{ brokerId: string; brokerageName: string; licenseNumber: string | null; amountCents: number; creditedAgents: string[] }>;
}

export interface TransmitResult {
  externalReference: string;
  simulated: boolean;
  request: unknown;
}
