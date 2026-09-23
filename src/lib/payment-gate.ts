import { supabase } from "@/integrations/supabase/client";

/**
 * W-9/W-8 payment gate — Broker of Record level.
 *
 * Scope: the only payment a broker ever receives is a real-estate commission
 * paid at closing by the title/escrow company from sale proceeds. There is no
 * other payment type from the Platform to a broker. This guard exists so that
 * Month 4's commission disbursement logic can call a single check before
 * releasing anything.
 *
 * "Verified" for Month 3 means a W-9/W-8 document is on file (presence, not
 * human approval). A manual admin review step can tighten `tax_form_verified`
 * later without changing any caller of `canReceivePayment`.
 */

const db = supabase as unknown as { from: (table: string) => any };

export interface PaymentGateResult {
  allowed: boolean;
  reason?: string;
}

export const TAX_FORM_GATE_MESSAGE =
  "No commission payout will be released until your W-9/W-8 is on file";

/** Detailed gate check — use when the caller wants to surface a reason. */
export async function checkCommissionPaymentGate(
  brokerId: string,
  /** Server callers pass their service-role client; defaults to the session client. */
  client: { from: (table: string) => any } = db,
): Promise<PaymentGateResult> {
  if (!brokerId) return { allowed: false, reason: "No Broker of Record on file." };

  const { data, error } = await client
    .from("brokers")
    .select("id, tax_form_verified, w9_or_w8_url")
    .eq("id", brokerId)
    .maybeSingle();

  if (error) return { allowed: false, reason: error.message };
  if (!data) return { allowed: false, reason: "Broker of Record not found." };
  if (!data.tax_form_verified) {
    return {
      allowed: false,
      reason: "Broker W-9/W-8 tax form is not on file — commission payout is blocked.",
    };
  }
  return { allowed: true };
}

/**
 * Guard stub for Month 4 commission disbursement.
 * Returns false when the broker's tax form is not verified.
 */
export async function canReceivePayment(
  brokerId: string,
  client?: { from: (table: string) => any },
): Promise<boolean> {
  const result = await checkCommissionPaymentGate(brokerId, client);
  return result.allowed;
}
