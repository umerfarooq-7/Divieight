/**
 * Buyer-side commission cascade — the single calculation for one 1/8th share.
 *
 * NOTE: Month 3 Prompt 13's calculation was referenced as "existing" but was
 * never present in this codebase, so it lives here and nowhere else. Every
 * caller (Source of Truth / CDA, Disbursement Check) must use these functions.
 *
 * Rules (confirmed 2026-09-23):
 *  1. Referral split: when a Standard NAR Referral Agreement is executed for
 *     the Buyer Account, the referring agent receives 25% and the tethered
 *     (receiving) Resident Agent 75% of the share's buyer-side commission.
 *     Otherwise the Resident Agent receives 100%.
 *  2. Heavy Lifter Premium: 15% is carved out of each agent's portion and paid
 *     to the pod's Heavy Lifting Agent. The HLA's own portion is never reduced
 *     (no premium to oneself). The share's total commission never changes.
 *  3. Money flows broker-to-broker: every amount is payable to the agent's
 *     Broker of Record, never to the agent.
 *
 * All math is in integer cents; rounding remainders stay with the Resident
 * Agent so every share's lines sum exactly to its commission.
 */

export const REFERRAL_SPLIT_PERCENT = 25;
export const HEAVY_LIFTER_PREMIUM_PERCENT = 15;

export type CascadeRole = "resident_agent" | "referring_agent" | "heavy_lifting_agent";

export interface CascadeLine {
  agentId: string;
  role: CascadeRole;
  /** Portion before the Heavy Lifter Premium carve-out. */
  grossCents: number;
  /** Carved out of this line and paid to the HLA (0 for the HLA's own line). */
  premiumToHlaCents: number;
  /** For the HLA line: premium received from other agents' portions. */
  premiumReceivedCents: number;
  netCents: number;
}

export interface ShareCascade {
  commissionCents: number;
  referralApplies: boolean;
  lines: CascadeLine[];
}

const pct = (cents: number, percent: number) => Math.round((cents * percent) / 100);

export function computeShareCascade(input: {
  commissionCents: number;
  residentAgentId: string;
  referringAgentId?: string | null;
  heavyLiftingAgentId?: string | null;
}): ShareCascade {
  const total = Math.max(0, Math.round(input.commissionCents));
  const referral = Boolean(input.referringAgentId) && input.referringAgentId !== input.residentAgentId;
  const referralCents = referral ? pct(total, REFERRAL_SPLIT_PERCENT) : 0;

  const portions: Array<{ agentId: string; role: CascadeRole; grossCents: number }> = [
    { agentId: input.residentAgentId, role: "resident_agent", grossCents: total - referralCents },
  ];
  if (referral) portions.push({ agentId: input.referringAgentId!, role: "referring_agent", grossCents: referralCents });

  const hla = input.heavyLiftingAgentId ?? null;
  const lines: CascadeLine[] = portions.map((p) => {
    const premium = hla && p.agentId !== hla ? pct(p.grossCents, HEAVY_LIFTER_PREMIUM_PERCENT) : 0;
    return { ...p, premiumToHlaCents: premium, premiumReceivedCents: 0, netCents: p.grossCents - premium };
  });

  const premiumTotal = lines.reduce((s, l) => s + l.premiumToHlaCents, 0);
  if (hla && premiumTotal > 0) {
    const own = lines.find((l) => l.agentId === hla);
    if (own) {
      own.premiumReceivedCents = premiumTotal;
      own.netCents += premiumTotal;
    } else {
      lines.push({
        agentId: hla,
        role: "heavy_lifting_agent",
        grossCents: 0,
        premiumToHlaCents: 0,
        premiumReceivedCents: premiumTotal,
        netCents: premiumTotal,
      });
    }
  }
  return { commissionCents: total, referralApplies: referral, lines };
}

export function formatUsdCents(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
