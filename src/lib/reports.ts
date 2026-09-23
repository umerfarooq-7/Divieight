/**
 * Appraisal & Inspection Report Delivery — shared, client-safe logic.
 *
 * Manager's Restraint on Interpretation: the platform delivers reports exactly
 * as received. It never interprets, characterizes, or recommends a course of
 * action on their contents. Any annotation belongs to the Resident Agent.
 *
 * Material-Adverse-Finding flags are deliberately non-substantive: they state
 * that a finding EXISTS (a number, or a phrase that appears in the text) and
 * nothing about what it means.
 */

export type ReportType = "appraisal" | "inspection";

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  appraisal: "Appraisal report",
  inspection: "Inspection report",
};

export interface ReportFlag {
  code: "appraisal_below_contract" | "flag_phrase";
  message: string;
}

export interface PropertyReportRow {
  id: string;
  property_id: string;
  report_type: ReportType;
  title: string;
  vendor_name: string | null;
  report_date: string | null;
  file_url: string;
  content_hash: string;
  data_room_document_id: string | null;
  diligence_document_id: string | null;
  contract_price: number | null;
  appraised_value: number | null;
  flags: ReportFlag[];
  received_at: string;
}

export interface ReportAnnotation {
  id: string;
  report_id: string;
  buyer_account_id: string;
  agent_id: string;
  agent_name: string | null;
  note: string;
  created_at: string;
}

/** Shown wherever a report is presented — the Manager does not interpret. */
export const DELIVERY_NOTICE =
  "This report is delivered exactly as received from the vendor. divieight does not interpret, characterize, or recommend any course of action regarding its contents. Please direct questions about what it means to your Resident Agent.";

export const FLAG_NOTICE =
  "Automated flag. It only notes that this finding exists in the report — it is not an interpretation, assessment, or recommendation.";

export const ANNOTATION_NOTICE =
  "Notes here are written by the buyer's tethered Resident Agent and are visible only to that buyer. They are the agent's own professional commentary, not divieight's.";

export const DEFAULT_APPRAISAL_SHORTFALL_PERCENT = 2;

/**
 * Phrases whose presence raises a flag. Matched case-insensitively as whole
 * phrases; the flag quotes the phrase and says nothing else.
 */
export const FLAG_PHRASES = [
  "structural deficiency",
  "structural deficiencies",
  "structural defect",
  "structural failure",
  "foundation failure",
  "hazardous condition",
  "hazardous conditions",
  "health hazard",
  "safety hazard",
  "fire hazard",
  "asbestos",
  "lead-based paint",
  "radon",
  "toxic mold",
  "black mold",
  "carbon monoxide",
  "knob and tube",
  "active leak",
  "termite damage",
  "not habitable",
  "uninhabitable",
] as const;

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Percent the appraised value falls below the contract price (0 if not below). */
export function appraisalShortfallPercent(
  contractPrice: number | null | undefined,
  appraisedValue: number | null | undefined,
): number {
  if (!contractPrice || !appraisedValue || contractPrice <= 0) return 0;
  if (appraisedValue >= contractPrice) return 0;
  return ((contractPrice - appraisedValue) / contractPrice) * 100;
}

export function formatPercent(p: number): string {
  return `${p.toFixed(1).replace(/\.0$/, "")}%`;
}

/** Material-Adverse-Finding filter. Returns non-substantive flags only. */
export function detectReportFlags(input: {
  reportType: ReportType;
  contractPrice?: number | null;
  appraisedValue?: number | null;
  reportText?: string | null;
  shortfallThresholdPercent?: number;
}): ReportFlag[] {
  const flags: ReportFlag[] = [];
  const threshold = input.shortfallThresholdPercent ?? DEFAULT_APPRAISAL_SHORTFALL_PERCENT;

  if (input.reportType === "appraisal") {
    const shortfall = appraisalShortfallPercent(input.contractPrice, input.appraisedValue);
    if (shortfall > 0 && shortfall >= threshold) {
      flags.push({
        code: "appraisal_below_contract",
        message: `Appraised value is below the contract price by ${formatPercent(shortfall)}.`,
      });
    }
  }

  const text = (input.reportText ?? "").replace(/\s+/g, " ");
  if (text) {
    const seen = new Set<string>();
    for (const phrase of FLAG_PHRASES) {
      const re = new RegExp(`\\b${escapeRegex(phrase)}\\b`, "i");
      if (re.test(text) && !seen.has(phrase)) {
        seen.add(phrase);
        flags.push({
          code: "flag_phrase",
          message: `Report text contains the phrase "${phrase}".`,
        });
      }
    }
  }
  return flags;
}

export function money(amount: number | null | undefined) {
  if (amount == null) return "—";
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function formatReportDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
