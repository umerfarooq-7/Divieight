import { supabase } from "@/integrations/supabase/client";
import { uploadProblem } from "@/lib/upload-rules";
import { ENTITY_CONFIG, type EntityType } from "@/lib/credentialing";
import { defaultEoExpiry } from "@/lib/eo-expiry";
import { logAudit } from "@/lib/audit";

/**
 * Agent onboarding step 2 — E&O insurance proof and NAR August 2024
 * settlement certification (plus its one-year re-certification clock).
 */

const db = supabase as unknown as { from: (table: string) => any };

export const AGENT_DOCS_BUCKET = "agent-documents";

export const NAR_CERT_TEXT =
  "I certify that I am in compliance with written buyer agreement rules as promulgated by the National Association of Realtors August 2024 litigation settlement.";

/** Certification is valid for one year from signature. */
export function narCertExpiry(signedAt: Date | string): string {
  const d = new Date(signedAt);
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString();
}

export function isNarCertExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now();
}

export function daysUntilExpiry(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
}

/** Upload an E&O certificate (PDF or image) to the private agent bucket. */
export async function uploadEoInsurance(
  authUserId: string,
  file: File,
): Promise<{ path?: string; error?: string }> {
  const problem = uploadProblem(file, "compliance");
  if (problem) return { error: problem };
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "pdf";
  const path = `${authUserId}/eo-insurance-${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from(AGENT_DOCS_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (error) return { error: error.message };
  return { path };
}

export interface InsuranceSubmission {
  /** E&O coverage end date (ISO). Defaults to one year out when omitted. */
  eoExpiresAt?: string | null;
  /** Agent or broker row id. */
  entityId: string;
  entityType?: EntityType;
  /** Storage path of the uploaded certificate, when a file was provided. */
  eoInsurancePath?: string | null;
  /** True when the broker affirms coverage instead of a file upload. */
  brokerAffirmed: boolean;
}

/**
 * Persist E&O proof (file URL or broker affirmation + timestamp), stamp the
 * NAR certification, set its one-year expiry, and advance onboarding.
 */
export async function submitInsuranceAndCertification(
  input: InsuranceSubmission,
): Promise<{ error?: string }> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    // E&O expiry is captured here, whether proof was uploaded or the broker
    // affirmed coverage. The 60/30/7-day reminders run off this date.
    eo_expires_at: input.eoExpiresAt || defaultEoExpiry(now),
    nar_cert_signed_at: now,
    nar_cert_expires_at: narCertExpiry(now),
    nar_cert_lapsed: false,
    onboarding_status: ENTITY_CONFIG[input.entityType ?? "agent"].next.afterInsurance,
  };

  // Lapse tracking and reminders are kept on agents only; a broker's row holds just the expiry date.
  if ((input.entityType ?? "agent") === "agent") {
    patch.eo_lapsed = false;
    patch.eo_reminder_60_sent_at = null;
    patch.eo_reminder_30_sent_at = null;
    patch.eo_reminder_7_sent_at = null;
  }

  if (input.brokerAffirmed) {
    patch.eo_broker_affirmed = true;
    patch.eo_broker_affirmed_at = now;
  } else {
    patch.eo_insurance_url = input.eoInsurancePath ?? null;
    patch.eo_insurance_uploaded_at = now;
    patch.eo_broker_affirmed = false;
    patch.eo_broker_affirmed_at = null;
  }

  const cfg = ENTITY_CONFIG[input.entityType ?? "agent"];
  const { error } = await db.from(cfg.table).update(patch).eq("id", input.entityId);
  if (error) return { error: error.message };
  return {};
}

/** Re-sign the certification after a lapse. */
export async function recertifyNar(
  entityId: string,
  entityType: EntityType = "agent",
): Promise<{ error?: string }> {
  const now = new Date().toISOString();
  const { error } = await db
    .from(ENTITY_CONFIG[entityType].table)
    .update({
      nar_cert_signed_at: now,
      nar_cert_expires_at: narCertExpiry(now),
      nar_cert_lapsed: false,
    })
    .eq("id", entityId);
  if (error) return { error: error.message };
  return {};
}

/**
 * Restore lapsed E&O coverage — immediate, no waiting period. Clears the
 * lapse, resets the reminder clock, and releases the transaction hold unless
 * the agent-broker relationship is independently holding it.
 */
export async function restoreEoCoverage(input: {
  entityId: string;
  authUserId: string;
  eoInsurancePath?: string | null;
  brokerAffirmed: boolean;
  eoExpiresAt?: string | null;
  entityType?: EntityType;
}): Promise<{ error?: string }> {
  const now = new Date().toISOString();
  const cfg = ENTITY_CONFIG[input.entityType ?? "agent"];
  const patch: Record<string, unknown> = {
    eo_expires_at: input.eoExpiresAt || defaultEoExpiry(now),
    eo_lapsed: false,
    eo_lapsed_at: null,
    eo_restored_at: now,
    eo_reminder_60_sent_at: null,
    eo_reminder_30_sent_at: null,
    eo_reminder_7_sent_at: null,
  };
  if (input.brokerAffirmed) {
    patch.eo_broker_affirmed = true;
    patch.eo_broker_affirmed_at = now;
  } else {
    patch.eo_insurance_url = input.eoInsurancePath ?? null;
    patch.eo_insurance_uploaded_at = now;
  }

  const { data: row } = await db
    .from(cfg.table)
    .select("relationship_status")
    .eq("id", input.entityId)
    .maybeSingle();
  // Only release the shared hold when nothing else is holding it.
  if ((row?.relationship_status ?? "active") === "active") patch.transactions_held = false;

  const { error } = await db.from(cfg.table).update(patch).eq("id", input.entityId);
  if (error) return { error: error.message };

  await logAudit({
    actorId: input.authUserId,
    actorType: input.entityType === "broker" ? "broker" : "agent",
    actionType: "agent.eo_insurance_restored",
    entityType: input.entityType === "broker" ? "broker" : "agent",
    entityId: input.entityId,
    metadata: {
      method: input.brokerAffirmed ? "broker_affirmation" : "document_upload",
      expires_at: patch.eo_expires_at,
    },
  });
  return {};
}
