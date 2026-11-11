/**
 * Member steps and the account roll-up. Every member-level onboarding step is tracked per
 * Account Member; the account's status is derived from them, never stored on its own.
 *
 *  - held: any member's result is held (only the Held label; never refused or unpaid).
 *  - ready: every active member has completed every required step and is eligible.
 *  - pending: anything else. A not_eligible member leaves the account pending and blocks the
 *    Golden Ticket; the primary may continue without that member (before the ticket).
 *
 * Block 2 (LPOA) is tracked per member but is not a Golden Ticket condition: it gates
 * Entity Genesis Stage 2 instead.
 */
import { DECISION_PAGE_SPEC_VERSION, STANDARD_VERSION as BUNDLED_STANDARD_VERSION } from "@/constants/eligibilityCopy";
import { BLOCK1_VERSION, BLOCK2_VERSION } from "@/constants/authorizationsCopy";
import { identityComplete } from "@/lib/account-members";
import { currentResultOf, type EligibilityResult } from "@/lib/eligibility-engine";
import { latestLiveness } from "@/lib/liveness";

type Db = { from: (t: string) => any };

export interface MemberSteps {
  memberId: string;
  name: string;
  role: string;
  idScan: boolean;
  liveness: boolean;
  /** E1: read the Participant Eligibility Standard (current versions). */
  standardRead: boolean;
  /** E2: a complete declaration. */
  declaration: boolean;
  block1: boolean;
  /** Tracked, not a Golden Ticket condition (gates Entity Genesis Stage 2). */
  block2: boolean;
  holdHarmless: boolean;
  w9: boolean;
  pra: boolean;
  /** E3: the engine's current result (null = no result yet). */
  result: EligibilityResult | null;
}

export type RequiredStep = "idScan" | "liveness" | "standardRead" | "declaration" | "block1" | "holdHarmless" | "w9" | "pra";

export const REQUIRED_STEPS: Array<{ key: RequiredStep; label: string }> = [
  { key: "idScan", label: "ID scan" },
  { key: "liveness", label: "Liveness check" },
  { key: "standardRead", label: "Read the Eligibility Standard" },
  { key: "declaration", label: "Eligibility declaration" },
  { key: "block1", label: "Account linking consent (Block 1)" },
  { key: "pra", label: "Priority Reservation Agreement" },
  { key: "holdHarmless", label: "Hold Harmless" },
  { key: "w9", label: "W-9" },
];

export type AccountStatus = "ready" | "held" | "pending";

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = { ready: "Eligible", held: "Held", pending: "Pending" };

export const missingSteps = (m: MemberSteps) => REQUIRED_STEPS.filter((s) => !m[s.key]);

export function accountRollup(members: MemberSteps[]): { status: AccountStatus; blocked: boolean } {
  if (members.some((m) => m.result === "held")) return { status: "held", blocked: true };
  const blocked = members.some((m) => m.result === "not_eligible");
  const ready = members.length > 0 && members.every((m) => m.result === "eligible" && missingSteps(m).length === 0);
  return { status: ready ? "ready" : "pending", blocked: blocked || !ready };
}

/** Loads every active member's steps. Works with the browser client (own account, via RLS) or the server's. */
export async function loadMemberSteps(db: Db, accountId: string): Promise<MemberSteps[]> {
  const rows = async (table: string, cols: string, extra?: (q: any) => any) => {
    let q = db.from(table).select(cols).eq("buyer_account_id", accountId);
    if (extra) q = extra(q);
    const { data, error } = await q;
    return error ? [] : ((data ?? []) as any[]);
  };
  const members = await rows("account_members", "id, full_name, role, address, date_of_birth, id_document_url, created_at", (q) => q.eq("status", "active"));
  const [live, acks, decls, results, b1, b2, docs, w9] = await Promise.all([
    rows("member_liveness_checks", "account_member_id, status, created_at"),
    rows("eligibility_page_acknowledgements", "account_member_id, standard_version, page_spec_version"),
    rows("eligibility_declarations", "id, account_member_id, status, standard_version"),
    rows("eligibility_results", "account_member_id, declaration_id, determined_at, result"),
    rows("member_plaid_consents", "account_member_id, text_version"),
    rows("member_block2_authorizations", "account_member_id, text_version"),
    rows("signed_documents", "account_member_id, document_type"),
    rows("member_w9", "account_member_id"),
  ]);
  // The live Standard (the bundled version stands in until the table exists).
  const liveRow = await db.from("standard_versions").select("version").eq("is_live", true).maybeSingle();
  const liveVersion: string = (liveRow?.data as { version?: string } | null)?.version ?? BUNDLED_STANDARD_VERSION;
  const primaryId = members.find((m) => m.role === "primary")?.id ?? null;
  // Signatures from before members were named on them belong to the account holder.
  const signedBy = (type: string, id: string) => docs.some((d) => d.document_type === type && (d.account_member_id ?? primaryId) === id);
  return members
    .sort((a, b) => (a.role === "primary" ? -1 : b.role === "primary" ? 1 : String(a.created_at).localeCompare(String(b.created_at))))
    .map((m) => {
      const decl = decls.find((d) => d.account_member_id === m.id && d.status === "complete") ?? null;
      return {
        memberId: m.id,
        name: m.full_name?.trim() || (m.role === "primary" ? "The account holder" : "The second member"),
        role: m.role,
        idScan: identityComplete(m) && Boolean(m.id_document_url),
        liveness: latestLiveness(live, m.id)?.status === "passed",
        // Read against the version they are measured under: their declaration's, or the live one before they declare.
        // A newer version going live doesn't send an existing participant back to read it again.
        standardRead: acks.some((a) => a.account_member_id === m.id && a.standard_version === (decl?.standard_version ?? liveVersion) && a.page_spec_version === DECISION_PAGE_SPEC_VERSION),
        declaration: Boolean(decl),
        block1: b1.some((r) => r.account_member_id === m.id && r.text_version === BLOCK1_VERSION),
        block2: b2.some((r) => r.account_member_id === m.id && r.text_version === BLOCK2_VERSION),
        holdHarmless: signedBy("HOLD_HARMLESS", m.id),
        w9: w9.some((r) => r.account_member_id === m.id),
        pra: signedBy("PRA", m.id),
        result: (currentResultOf(results, m.id, decl?.id ?? null)?.result as EligibilityResult | undefined) ?? null,
      };
    });
}
