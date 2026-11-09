/**
 * "Read the Standard" acknowledgements (server side). One row per Account Member per
 * version. This is not the declaration: that is a separate record (Block 4).
 */

import { DECISION_PAGE_SPEC_VERSION, STANDARD_VERSION } from "@/constants/eligibilityCopy";
import { requireActingMember, type RequestContext } from "@/lib/account-members.server";

type Db = { from: (t: string) => any };

const MISSING_SCHEMA = "Database is missing eligibility acknowledgements — run eligibility-acknowledgements.sql in Supabase.";

/** Records this member's acknowledgement once, and says which active members are still to read it. */
export async function acknowledgeStandard(db: Db, params: { userId: string; actingMemberId: string; request: RequestContext }): Promise<{ remaining: number }> {
  const { account, member } = await requireActingMember(db, params.userId, params.actingMemberId);
  const { data: existing, error: readError } = await db
    .from("eligibility_page_acknowledgements")
    .select("id")
    .eq("account_member_id", member.id)
    .eq("standard_version", STANDARD_VERSION)
    .eq("page_spec_version", DECISION_PAGE_SPEC_VERSION)
    .maybeSingle();
  if (readError) throw new Error(MISSING_SCHEMA);
  if (!existing) {
    const { error } = await db.from("eligibility_page_acknowledgements").insert({
      account_member_id: member.id,
      buyer_account_id: account.id,
      standard_version: STANDARD_VERSION,
      page_spec_version: DECISION_PAGE_SPEC_VERSION,
      acknowledged_at: new Date().toISOString(),
      ip: params.request.ip,
      user_agent: params.request.userAgent,
    });
    // Two tabs at once: the unique key keeps it to one row, which is all that matters.
    if (error && error.code !== "23505") throw new Error(MISSING_SCHEMA);
    if (!error) {
      await db.from("audit_log").insert({
        actor_id: params.userId,
        actor_type: "buyer",
        action_type: "buyer.eligibility_standard_read",
        entity_type: "buyer_account",
        entity_id: account.id,
        metadata: {
          record: "read_the_standard",
          account_member_id: member.id,
          acted_by_member_id: member.id,
          standard_version: STANDARD_VERSION,
          page_spec_version: DECISION_PAGE_SPEC_VERSION,
          ip_address: params.request.ip,
          user_agent: params.request.userAgent,
        },
      });
    }
  }
  return { remaining: (await pending(db, account.id)).length };
}

async function pending(db: Db, accountId: string): Promise<string[]> {
  const { data: members } = await db.from("account_members").select("id").eq("buyer_account_id", accountId).eq("status", "active");
  const { data: acks } = await db
    .from("eligibility_page_acknowledgements")
    .select("account_member_id")
    .eq("buyer_account_id", accountId)
    .eq("standard_version", STANDARD_VERSION)
    .eq("page_spec_version", DECISION_PAGE_SPEC_VERSION);
  const done = new Set(((acks ?? []) as Array<{ account_member_id: string }>).map((a) => a.account_member_id));
  return ((members ?? []) as Array<{ id: string }>).map((m) => m.id).filter((id) => !done.has(id));
}

/** For the admin's buyer view, labelled "Read the Standard" — never "Declaration". */
export async function adminReadTheStandard(db: Db, accountIds: string[]) {
  if (accountIds.length === 0) return [];
  const { data, error } = await db.from("eligibility_page_acknowledgements").select("account_member_id, buyer_account_id, standard_version, page_spec_version, acknowledged_at").in("buyer_account_id", accountIds);
  if (error) return [];
  return (data ?? []) as Array<{ account_member_id: string; buyer_account_id: string; standard_version: string; page_spec_version: string; acknowledged_at: string }>;
}
