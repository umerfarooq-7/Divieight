import { supabase } from "@/integrations/supabase/client";
import { BROKER_TAX_FORM_LINK, gateMessage, gateStateFromForms, type GateCode, type FormRow } from "@/lib/tax-forms";

/**
 * W-9/W-8 payment gate: Broker of Record level. A HARD gate, not a warning.
 *
 * No payout of any kind is released to a Broker of Record (a commission, a Heavy Lifter Premium, anything) until a VALID tax form is on file: a W-9 for a
 * US person or entity, a W-8BEN for a non-US individual, a W-8BEN-E for a non-US entity. A W-8 lapses; an expired, rejected or missing form blocks.
 * The Disbursement Check and the Settlement steps both ask this one function.
 *
 * It reads broker_tax_forms (the forms, as the database keeps them). It does NOT read brokers.tax_form_verified: that column is only a cache the
 * database maintains, and a broker's own login can't set it.
 */

const db = supabase as unknown as { from: (table: string) => any };

export interface PaymentGateResult {
  allowed: boolean;
  reason?: string;
  code?: GateCode;
  /** Where the broker fixes it. */
  link?: string;
}

export const TAX_FORM_GATE_MESSAGE = "No commission payout will be released until your W-9/W-8 is on file";

/** Detailed gate check: use when the caller wants to surface a reason. */
export async function checkCommissionPaymentGate(
  brokerId: string,
  /** Server callers pass their service-role client; defaults to the session client. */
  client: { from: (table: string) => any } = db,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<PaymentGateResult> {
  if (!brokerId) return { allowed: false, reason: "No Broker of Record on file." };
  const { data: broker, error: brokerError } = await client.from("brokers").select("id").eq("id", brokerId).maybeSingle();
  if (brokerError) return { allowed: false, reason: brokerError.message };
  if (!broker) return { allowed: false, reason: "Broker of Record not found." };
  const { data, error } = await client.from("broker_tax_forms").select("id, form_type, status, expiry_date, created_at").eq("broker_id", brokerId);
  // Fail closed: a database that can't say whether there is a form is a broker with none.
  if (error) return { allowed: false, code: "tax_form_missing", reason: gateMessage("tax_form_missing"), link: BROKER_TAX_FORM_LINK };
  const gate = gateStateFromForms((data ?? []) as FormRow[], today);
  if (gate.allowed) return { allowed: true };
  return { allowed: false, code: gate.code, reason: gateMessage(gate.code!, gate.expiry), link: BROKER_TAX_FORM_LINK };
}

/** Returns false when the broker has no valid tax form. */
export async function canReceivePayment(brokerId: string, client?: { from: (table: string) => any }): Promise<boolean> {
  const result = await checkCommissionPaymentGate(brokerId, client);
  return result.allowed;
}
