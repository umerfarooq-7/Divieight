import { supabase } from "@/integrations/supabase/client";
import type { CredentialEntity } from "@/lib/credentialing";

/**
 * Broker of Record profiles, banking details and agent invitations.
 *
 * Money-flow scope: a broker only receives real-estate commission paid at
 * closing by the title/escrow company from sale proceeds. The Platform never
 * pays brokers — no bounty, marketing or referral fee exists in this system.
 */

const db = supabase as unknown as { from: (table: string) => any };

export const TAX_FORM_TYPES = ["W-9", "W-8BEN", "W-8BEN-E"] as const;
export type TaxFormType = (typeof TAX_FORM_TYPES)[number];

export const TAX_FORM_DESCRIPTIONS: Record<TaxFormType, string> = {
  "W-9": "US person or US-registered brokerage.",
  "W-8BEN": "Non-US individual broker.",
  "W-8BEN-E": "Non-US entity / foreign brokerage.",
};

export interface BrokerRow extends CredentialEntity {
  brokerage_name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  bank_account_last4: string | null;
  bank_routing_last4: string | null;
  bank_account_holder: string | null;
  bank_details_saved_at: string | null;
  w9_or_w8_url: string | null;
  w9_or_w8_type: TaxFormType | null;
  w9_or_w8_uploaded_at: string | null;
  tax_form_verified: boolean | null;
  tax_form_verified_at: string | null;
  invited_by_agent_id: string | null;
  created_at: string;
}

export async function getBrokerProfile(userId: string): Promise<BrokerRow | null> {
  const { data, error } = await db
    .from("brokers")
    .select("*")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (error) return null;
  return (data as BrokerRow) ?? null;
}

/** A single brokerage by id (used to show an agent their Broker of Record). */
export async function getBrokerById(brokerId: string): Promise<BrokerRow | null> {
  const { data, error } = await db
    .from("brokers")
    .select("*")
    .eq("id", brokerId)
    .maybeSingle();
  if (error) return null;
  return (data as BrokerRow) ?? null;
}


/** Brokers available for an agent to link to, filtered by a search term. */
export async function searchBrokers(term: string): Promise<BrokerRow[]> {
  let query = db
    .from("brokers")
    .select("*")
    .order("brokerage_name", { ascending: true })
    .limit(20);
  if (term.trim()) query = query.ilike("brokerage_name", `%${term.trim()}%`);
  const { data, error } = await query;
  if (error) return [];
  return (data as BrokerRow[]) ?? [];
}

export interface CreateBrokerInput {
  userId: string;
  brokerageName: string;
  contactName: string;
  email: string;
  phone?: string | null;
  licenseNumber: string;
  licenseState: string;
  invitedByAgentId?: string | null;
}

export async function createBrokerProfile(input: CreateBrokerInput): Promise<{
  broker?: BrokerRow;
  error?: string;
}> {
  const existing = await getBrokerProfile(input.userId);
  if (existing) return { broker: existing };

  const { data, error } = await db
    .from("brokers")
    .insert({
      auth_user_id: input.userId,
      brokerage_name: input.brokerageName,
      contact_name: input.contactName,
      email: input.email,
      phone: input.phone ?? null,
      license_number: input.licenseNumber,
      license_state: input.licenseState,
      onboarding_status: "arello_pending",
      invited_by_agent_id: input.invitedByAgentId ?? null,
    })
    .select("*")
    .maybeSingle();

  if (error) return { error: error.message };
  return { broker: (data as BrokerRow) ?? undefined };
}

export function brokerRedirect(onboardingStatus: string): string {
  switch (onboardingStatus) {
    case "not_started":
    case "arello_pending":
      return "/broker/onboarding/license-check";
    case "arello_pending_retry":
    case "insurance_pending":
      return "/broker/onboarding/insurance";
    case "compliance_pending":
    case "fincen_pending":
      return "/broker/onboarding/compliance";
    case "banking_pending":
      return "/broker/onboarding/banking";
    default:
      return "/broker/dashboard";
  }
}

/* ------------------------------------------------------------------ */
/* Banking + tax forms                                                 */
/* ------------------------------------------------------------------ */

export const BROKER_DOCS_BUCKET = "agent-documents";

export function last4(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.slice(-4);
}

export async function uploadTaxForm(
  authUserId: string,
  file: File,
): Promise<{ path?: string; error?: string }> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "pdf";
  const path = `${authUserId}/tax-form-${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from(BROKER_DOCS_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (error) return { error: error.message };
  return { path };
}

export interface BankingSubmission {
  brokerId: string;
  accountHolder: string;
  routingNumber: string;
  accountNumber: string;
  taxFormType: TaxFormType;
  taxFormPath?: string | null;
}

/**
 * Persist banking + tax details.
 *
 * TODO: route through a proper secrets/PCI-safe storage solution before
 * production, do not store raw account numbers in a plain database column in
 * production. Only the last 4 digits are persisted here; the full routing and
 * account numbers must be exchanged for a vault token that is written to
 * `bank_account_secure_ref`.
 */
export async function submitBankingDetails(
  input: BankingSubmission,
): Promise<{ error?: string }> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    bank_account_holder: input.accountHolder,
    bank_routing_last4: last4(input.routingNumber),
    bank_account_last4: last4(input.accountNumber),
    // Placeholder secure field — replace with the vault/tokenisation reference.
    bank_account_secure_ref: `pending_vault_token:${input.brokerId}`,
    bank_details_saved_at: now,
    w9_or_w8_type: input.taxFormType,
  };
  if (input.taxFormPath) {
    // A document upload is a copy for the file. It no longer clears anything: the payout gate reads the validated tax form
    // (broker_tax_forms), submitted on the tax-form page, and the database keeps the old flag in step with it.
    patch.w9_or_w8_url = input.taxFormPath;
    patch.w9_or_w8_uploaded_at = now;
  }

  const { error } = await db.from("brokers").update(patch).eq("id", input.brokerId);
  if (error) return { error: error.message };
  return {};
}

/**
 * Finish onboarding: activate the broker and link the inviting agent, so the
 * agent's Broker of Record is set for commission routing at closing.
 */
export async function completeBrokerOnboarding(
  broker: BrokerRow,
): Promise<{ error?: string }> {
  const { error } = await db
    .from("brokers")
    .update({ onboarding_status: "active" })
    .eq("id", broker.id);
  if (error) return { error: error.message };

  if (broker.invited_by_agent_id) {
    await db
      .from("agents")
      .update({ broker_id: broker.id })
      .eq("id", broker.invited_by_agent_id);
  }

  await db
    .from("broker_invitations")
    .update({
      status: "accepted",
      accepted_broker_id: broker.id,
      accepted_at: new Date().toISOString(),
    })
    .eq("invited_email", broker.email ?? "")
    .eq("status", "pending");

  return {};
}

/* ------------------------------------------------------------------ */
/* Invitations                                                         */
/* ------------------------------------------------------------------ */

export interface BrokerInvitationRow {
  id: string;
  invited_email: string;
  invited_brokerage_name: string | null;
  invited_contact_name: string | null;
  invited_by_agent_id: string | null;
  status: "pending" | "accepted" | "expired" | "cancelled";
  created_at: string;
}

export async function createBrokerInvitation(input: {
  agentId: string;
  email: string;
  brokerageName: string;
  contactName?: string;
}): Promise<{ invitation?: BrokerInvitationRow; error?: string }> {
  const { data, error } = await db
    .from("broker_invitations")
    .insert({
      invited_email: input.email.trim().toLowerCase(),
      invited_brokerage_name: input.brokerageName,
      invited_contact_name: input.contactName ?? null,
      invited_by_agent_id: input.agentId,
      status: "pending",
    })
    .select("*")
    .maybeSingle();
  if (error) return { error: error.message };
  return { invitation: (data as BrokerInvitationRow) ?? undefined };
}

export async function getInvitation(id: string): Promise<BrokerInvitationRow | null> {
  const { data, error } = await db
    .from("broker_invitations")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return null;
  return (data as BrokerInvitationRow) ?? null;
}

export async function listAgentInvitations(agentId: string): Promise<BrokerInvitationRow[]> {
  const { data, error } = await db
    .from("broker_invitations")
    .select("*")
    .eq("invited_by_agent_id", agentId)
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data as BrokerInvitationRow[]) ?? [];
}

/** Link an agent to an already-onboarded broker. */
export async function linkAgentToBroker(
  agentId: string,
  brokerId: string,
): Promise<{ error?: string }> {
  const { error } = await db
    .from("agents")
    .update({
      broker_id: brokerId,
      onboarding_status: "active",
      relationship_status: "active",
      relationship_verified_at: new Date().toISOString(),
      transactions_held: false,
    })
    .eq("id", agentId);
  if (error) return { error: error.message };
  return {};
}

export function invitationLink(invitationId: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/broker/register?invite=${invitationId}`;
}
