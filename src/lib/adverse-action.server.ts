/**
 * Adverse-action notices (server side). Admin action only: there is no trigger yet.
 *
 * No consumer report is obtained in the ordinary course. If the Question 5 authorization is ever
 * exercised and divieight then acts on information in the report, an admin issues the notice here.
 * It names the action and the consumer reporting agency and states the member's rights. The report
 * itself is never supplied.
 */
import { requireActingMember } from "@/lib/account-members.server";
import { adverseActionNoticeText, type ReportingAgency } from "@/lib/adverse-action";
import { deliver } from "@/lib/authorization.notify.server";
import { sha256 } from "@/lib/entity-genesis-stage2.server";

type Db = { from: (t: string) => any };

const TABLE = "adverse_action_notices";
const MISSING_SCHEMA = "Database is missing adverse-action notices — run eligibility-wording.sql in Supabase.";

export interface NoticeRow {
  id: string;
  account_member_id: string;
  action_statement: string;
  agency_name: string;
  rendered_text: string;
  document_hash: string;
  issued_at: string;
}

export async function issueAdverseActionNotice(
  db: Db,
  params: { adminId: string; memberId: string; actionStatement: string; agency: ReportingAgency; reportObtainedAttested: boolean },
): Promise<{ id: string; emailed: boolean }> {
  if (params.reportObtainedAttested !== true) {
    throw new Error("Confirm that a consumer report was obtained under the Question 5 authorization and that divieight is acting on information in it.");
  }
  const statement = params.actionStatement.trim();
  const agency = { name: params.agency.name.trim(), address: params.agency.address.trim(), phone: params.agency.phone.trim(), website: params.agency.website?.trim() || null };
  if (!statement) throw new Error("State the action taken.");
  if (!agency.name || !agency.address || !agency.phone) throw new Error("Give the consumer reporting agency's name, address and phone number.");

  const { data: m } = await db.from("account_members").select("id, buyer_account_id, full_name, email, role, adverse_action_issued_at").eq("id", params.memberId).maybeSingle();
  const member = m as { id: string; buyer_account_id: string; full_name: string | null; email: string | null; adverse_action_issued_at: string | null } | null;
  if (!member) throw new Error("Member not found");
  // A report can only have been obtained under the Q5 authorization: the member's current declaration must carry it.
  const { data: decls } = await db.from("eligibility_declarations").select("id, status, answers").eq("account_member_id", member.id);
  const decl = ((decls ?? []) as Array<{ id: string; status: string; answers: { q5?: string } | null }>).find((d) => d.status === "complete");
  if (!decl || decl.answers?.q5 !== "yes") {
    throw new Error("This member hasn't given the Question 5 authorization, so no report could have been obtained under it.");
  }

  const issuedAt = new Date().toISOString();
  const text = adverseActionNoticeText({ memberName: member.full_name ?? "Account Member", actionStatement: statement, agency, issuedAt });
  const hash = sha256(text);
  const { data, error } = await db
    .from(TABLE)
    .insert({
      account_member_id: member.id,
      buyer_account_id: member.buyer_account_id,
      declaration_id: decl.id,
      action_statement: statement,
      agency_name: agency.name,
      agency_address: agency.address,
      agency_phone: agency.phone,
      agency_website: agency.website,
      rendered_text: text,
      document_hash: hash,
      report_obtained_attested: true,
      issued_by: params.adminId,
      issued_at: issuedAt,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(MISSING_SCHEMA);
  const id = (data as { id: string }).id;
  if (!member.adverse_action_issued_at) await db.from("account_members").update({ adverse_action_issued_at: issuedAt }).eq("id", member.id);
  await db.from("audit_log").insert({
    actor_id: params.adminId,
    actor_type: "admin",
    action_type: "adverse_action.notice_issued",
    entity_type: "buyer_account",
    entity_id: member.buyer_account_id,
    metadata: { notice_id: id, account_member_id: member.id, declaration_id: decl.id, agency_name: agency.name, document_hash: hash, report_supplied: false },
  });
  let emailed = false;
  if (member.email) {
    try {
      const r = await deliver(db as never, { authUserId: null, email: member.email }, { subject: "Notice of adverse action", message: text, link: "/buyer/adverse-action", type: "authorization" });
      emailed = Boolean(r?.emailed);
    } catch {
      emailed = false;
    }
  }
  return { id, emailed };
}

/** The notices addressed to this member (the page shows the acting member's own only). */
export async function myNotices(db: Db, params: { userId: string; actingMemberId: string }): Promise<NoticeRow[]> {
  const { member } = await requireActingMember(db, params.userId, params.actingMemberId);
  const { data, error } = await db.from(TABLE).select("id, account_member_id, action_statement, agency_name, rendered_text, document_hash, issued_at").eq("account_member_id", member.id);
  if (error) return [];
  return ((data ?? []) as NoticeRow[]).sort((a, b) => (a.issued_at < b.issued_at ? 1 : -1));
}
