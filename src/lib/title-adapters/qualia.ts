/**
 * Qualia implementation of the TitleEscrowAdapter — SIMULATED.
 *
 * Structured exactly as a real Qualia GraphQL + webhook integration. Until a
 * Qualia partnership agreement exists (contact: Qualia PropTech partnerships)
 * there are no credentials, so `openOrder` builds the real request but does
 * not send it, and webhooks arrive from the admin simulation panel.
 *
 * TODO(qualia-credentials): set QUALIA_API_URL, QUALIA_API_TOKEN and
 * QUALIA_WEBHOOK_SECRET in Vercel once the partnership is signed. With the URL
 * and token present, `openOrder` performs the live GraphQL call.
 * TODO(qualia-schema): confirm the mutation, field names, milestone codes and
 * signature header against Qualia's partner API docs — the shapes below are
 * placeholders modeled on their published GraphQL conventions.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { TitleMilestone } from "@/lib/title-escrow";
import type {
  DisbursementInstruction,
  TransmitResult,
  ClosingBundle,
  NormalizedTitleEvent,
  OpenOrderResult,
  SimulationOptions,
  TitleEscrowAdapter,
} from "./adapter";

const CREATE_ORDER_MUTATION = /* GraphQL */ `
  mutation CreateOrder($input: CreateOrderInput!) {
    createOrder(input: $input) {
      order { id status }
      errors { field message }
    }
  }
`;

/** Qualia milestone codes → platform milestones. TODO(qualia-schema): verify codes. */
/** TODO(qualia-schema): confirm the disbursement-instruction mutation with Qualia. */
const ATTACH_DISBURSEMENT_MUTATION = /* GraphQL */ `
  mutation AttachDisbursementInstruction($orderId: ID!, $input: DisbursementInstructionInput!) {
    attachDisbursementInstruction(orderId: $orderId, input: $input) {
      instruction { id }
      errors { field message }
    }
  }
`;

const MILESTONE_CODES: Record<string, TitleMilestone> = {
  ORDER_OPENED: "order_opened",
  TITLE_COMMITMENT_ISSUED: "title_report_ready",
  EARNEST_MONEY_RECEIVED: "earnest_money_deposited",
  CLOSING_SCHEDULED: "closing_scheduled",
  FUNDED_AND_RECORDED: "funded_and_recorded",
};
const CODE_FOR: Record<TitleMilestone, string> = Object.fromEntries(
  Object.entries(MILESTONE_CODES).map(([code, m]) => [m, code]),
) as Record<TitleMilestone, string>;

const SIGNATURE_HEADER = "x-qualia-signature";

function sign(secret: string, body: string) {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

interface QualiaWebhookBody {
  id: string;
  type: string;
  created_at: string;
  data: {
    order: { id: string };
    milestone: string;
    deposits?: Array<{ party_reference: string; amount: number }>;
    deposits_complete?: boolean;
    closing?: { scheduled_at: string | null };
    documents?: Array<{ type: string; url: string; name: string; sha256: string }>;
  };
}

export class QualiaAdapter implements TitleEscrowAdapter {
  readonly provider = "qualia" as const;

  private get apiUrl() {
    return process.env.QUALIA_API_URL ?? null;
  }
  private get apiToken() {
    return process.env.QUALIA_API_TOKEN ?? null;
  }
  private get webhookSecret() {
    return process.env.QUALIA_WEBHOOK_SECRET ?? null;
  }

  async openOrder(bundle: ClosingBundle): Promise<OpenOrderResult> {
    const request = {
      query: CREATE_ORDER_MUTATION,
      variables: {
        input: {
          externalReference: bundle.propertyId,
          transactionType: "PURCHASE",
          property: {
            street: bundle.property.address,
            city: bundle.property.city,
            state: bundle.property.state,
            zip: bundle.property.zip,
          },
          purchasePrice: bundle.property.purchasePrice,
          estimatedClosingDate: bundle.closingTimeline.anticipatedClosingDate,
          buyers: bundle.buyers.map((b) => ({
            externalReference: b.buyerAccountId,
            ownershipShares: b.shares,
            names: b.memberNames,
          })),
          sellers: bundle.seller.sellerId
            ? [{ externalReference: bundle.seller.sellerId, retainedShares: bundle.seller.retainedShares }]
            : [],
          notes: `divieight fractional purchase: ${bundle.buyers.reduce((s, b) => s + b.shares, 0)}/8 shares to buyers, ${bundle.seller.retainedShares}/8 retained by seller.`,
        },
      },
    };

    if (!this.apiUrl || !this.apiToken) {
      // SIMULATED: no credentials yet — log the exact request instead of sending it.
      return { externalOrderId: `SIM-QUALIA-${randomUUID().slice(0, 8).toUpperCase()}`, simulated: true, request };
    }

    const res = await fetch(this.apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiToken}` },
      body: JSON.stringify(request),
    });
    const json = (await res.json()) as { data?: { createOrder?: { order?: { id: string }; errors?: Array<{ message: string }> } } };
    const order = json.data?.createOrder?.order;
    if (!res.ok || !order) {
      const why = json.data?.createOrder?.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
      throw new Error(`Qualia rejected the Closing Bundle: ${why}`);
    }
    return { externalOrderId: order.id, simulated: false, request };
  }

  async verifyWebhook(rawBody: string, headers: Headers): Promise<boolean> {
    const secret = this.webhookSecret;
    const provided = headers.get(SIGNATURE_HEADER);
    if (!secret || !provided) return false;
    const expected = Buffer.from(sign(secret, rawBody), "hex");
    const got = Buffer.from(provided, "hex");
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  parseWebhook(rawBody: string): NormalizedTitleEvent | null {
    const body = JSON.parse(rawBody) as QualiaWebhookBody;
    if (body.type !== "order.milestone.updated") return null;
    const milestone = MILESTONE_CODES[body.data.milestone];
    if (!milestone) return null;
    const commitment = body.data.documents?.find((d) => d.type === "TITLE_COMMITMENT");
    return {
      milestone,
      externalOrderId: body.data.order.id,
      externalEventId: body.id,
      occurredAt: body.created_at,
      deposits: body.data.deposits?.map((d) => ({ buyerAccountId: d.party_reference, amount: Number(d.amount) })),
      allDepositsComplete: body.data.deposits_complete,
      closingDate: body.data.closing?.scheduled_at ?? null,
      titleCommitment: commitment ? { url: commitment.url, title: commitment.name, contentHash: commitment.sha256 } : null,
    };
  }

  simulateWebhook(externalOrderId: string, milestone: TitleMilestone, opts: SimulationOptions): string {
    const id = `evt_sim_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const body: QualiaWebhookBody = {
      id,
      type: "order.milestone.updated",
      created_at: new Date().toISOString(),
      data: { order: { id: externalOrderId }, milestone: CODE_FOR[milestone] },
    };
    if (milestone === "title_report_ready")
      body.data.documents = [
        {
          type: "TITLE_COMMITMENT",
          url: `title-escrow/${externalOrderId}/title-commitment-${id}.pdf`,
          name: "Title Commitment (Schedule A & B)",
          sha256: `sha256_sim_${id}`,
        },
      ];
    if (milestone === "earnest_money_deposited") {
      body.data.deposits = (opts.deposits ?? []).map((d) => ({ party_reference: d.buyerAccountId, amount: d.amount }));
      body.data.deposits_complete = opts.allDepositsComplete ?? true;
    }
    if (milestone === "closing_scheduled") body.data.closing = { scheduled_at: opts.closingDate ?? null };
    return JSON.stringify(body);
  }

  async transmitDisbursementInstruction(externalOrderId: string, cda: DisbursementInstruction): Promise<TransmitResult> {
    const request = {
      query: ATTACH_DISBURSEMENT_MUTATION,
      variables: {
        orderId: externalOrderId,
        input: {
          externalReference: cda.documentId,
          version: cda.version,
          documentHash: cda.contentHash,
          kind: "COMMISSION_DISBURSEMENT_AUTHORIZATION",
          // Payees are Brokers of Record only — never individual agents.
          payees: cda.payees.map((p) => ({
            externalReference: p.brokerId,
            name: p.brokerageName,
            licenseNumber: p.licenseNumber,
            amount: p.amountCents / 100,
            memo: `Buyer-side commission; credited agents: ${p.creditedAgents.join(", ")}`,
          })),
          total: cda.totalCommissionCents / 100,
        },
      },
    };
    if (!this.apiUrl || !this.apiToken) {
      // SIMULATED: logged instead of sent until Qualia credentials exist.
      return { externalReference: `SIM-CDA-${randomUUID().slice(0, 8).toUpperCase()}`, simulated: true, request };
    }
    const res = await fetch(this.apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiToken}` },
      body: JSON.stringify(request),
    });
    const json = (await res.json()) as {
      data?: { attachDisbursementInstruction?: { instruction?: { id: string }; errors?: Array<{ message: string }> } };
    };
    const out = json.data?.attachDisbursementInstruction;
    if (!res.ok || !out?.instruction) {
      const why = out?.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
      throw new Error(`Qualia rejected the disbursement instruction: ${why}`);
    }
    return { externalReference: out.instruction.id, simulated: false, request };
  }

  async signForSimulation(rawBody: string): Promise<Record<string, string>> {
    return this.webhookSecret ? { [SIGNATURE_HEADER]: sign(this.webhookSecret, rawBody) } : {};
  }
}
