/**
 * Adverse-action notice template (shared). No consumer report is obtained in the ordinary course.
 * If the Question 5 authorization is ever exercised and divieight then acts on information in the
 * report, an adverse-action notice issues: the action, the consumer reporting agency's name and
 * contact details, and the member's rights. The report itself is NOT supplied by divieight.
 *
 * There is no trigger yet: this template is used only by the admin action.
 */

export interface ReportingAgency {
  name: string;
  address: string;
  phone: string;
  website?: string | null;
}

export interface AdverseActionNoticeInput {
  memberName: string;
  /** What divieight did, in words ("Your application to take part was declined."). */
  actionStatement: string;
  agency: ReportingAgency;
  issuedAt: string;
}

export const ADVERSE_ACTION_TITLE = "Notice of adverse action";

export function adverseActionNoticeText(i: AdverseActionNoticeInput): string {
  const contact = [i.agency.address, i.agency.phone, i.agency.website].filter((s) => s && String(s).trim()).join(" · ");
  return [
    ADVERSE_ACTION_TITLE,
    `Issued ${new Date(i.issuedAt).toISOString().slice(0, 10)}`,
    "",
    `${i.memberName}, divieight does not obtain a consumer report in the ordinary course. A report was obtained about you under the authorization you gave at Question 5 of your Eligibility Declaration, and divieight has acted on information in it.`,
    "",
    `The action taken: ${i.actionStatement.trim()}`,
    "",
    `The consumer reporting agency that provided the report: ${i.agency.name.trim()}${contact ? ` — ${contact}` : ""}. The agency did not make this decision and cannot tell you why it was made.`,
    "",
    "Your rights: you have the right to obtain a free copy of your consumer report from that agency if you ask for it within 60 days of receiving this notice, and the right to dispute directly with that agency the accuracy or completeness of any information in the report. divieight does not supply the report itself; ask the agency named above.",
    "",
    "If you believe an answer in your declaration was recorded wrongly, you can correct it and resubmit it. That is a correction of fact, not an appeal.",
  ].join("\n");
}
