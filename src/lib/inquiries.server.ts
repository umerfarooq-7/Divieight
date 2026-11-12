/**
 * Co-owner inquiries (server side). The database does the real work (inquiries.sql): who may ask, who sees what, the
 * Manager's answers, the corrections and their links, the Audit Vault. This is the door to it, and the owner's view of the
 * books. An inquiry is a note beside the books: nothing here lets one hold back a statement, a ledger view or any other
 * Ownership Function. If the inquiry tables are missing or fail, the ledger still loads.
 */
import { deliver } from "@/lib/authorization.notify.server";
import { holderFor, holderRecipients } from "@/lib/votes.server";

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

const MISSING = "Database is missing the inquiries table: run inquiries.sql in Supabase.";
function fail(error: { message?: string }): never {
  const m = error.message ?? "";
  if (/does not exist|schema cache|Could not find/i.test(m) && /inquir/i.test(m)) throw new Error(MISSING);
  throw new Error(m || "The inquiry could not be saved.");
}
const meta = (r?: RequestContext) => ({ ip_address: r?.ip ?? null, user_agent: r?.userAgent ?? null });

async function requireManager(db: Db, userId: string) {
  const { data } = await db.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (data !== true) throw new Error("Only the Manager can do that.");
}

type Row = Record<string, any>;

export type InquiryType = "clarification" | "recategorize";
export type InquiryStatus = "open" | "answered" | "resolved" | "rejected";

export interface OwnerInquiry {
  id: string;
  entryId: string;
  type: InquiryType;
  message: string;
  suggestedAccountCode: string | null;
  status: InquiryStatus;
  managerResponse: string | null;
  respondedAt: string | null;
  resolvedAt: string | null;
  resultingEntryId: string | null;
  createdAt: string;
}

export interface OwnerLedgerEntry {
  id: string;
  date: string;
  source: string;
  /** Left out where it could name a person (an entry on a member's capital account). */
  memo: string | null;
  lines: Array<{ code: string; name: string; debitCents: number; creditCents: number }>;
  /** The viewer's own inquiries on this transaction. */
  inquiries: OwnerInquiry[];
}

export interface OwnerLedger {
  allowed: boolean;
  entries: OwnerLedgerEntry[];
  accounts: Array<{ code: string; name: string }>;
  /** False when the inquiry tables aren't set up: the ledger is shown anyway. */
  inquiriesAvailable: boolean;
}

const toInquiry = (r: Row): OwnerInquiry => ({
  id: r.id,
  entryId: r.journal_entry_id,
  type: r.type,
  message: r.message,
  suggestedAccountCode: r.suggested_account_code ?? null,
  status: r.status,
  managerResponse: r.manager_response ?? null,
  respondedAt: r.responded_at ?? null,
  resolvedAt: r.resolved_at ?? null,
  resultingEntryId: r.resulting_entry_id ?? null,
  createdAt: r.created_at,
});

/**
 * The LLC's transactions for a co-owner, with their own inquiries. Property-level transactions (expenses, bank postings, and so
 * on) are shown in full; an entry on a member's capital account is shown only to that member, with no memo. Other owners'
 * inquiries are never returned.
 */
export async function ownerLedger(db: Db, p: { userId: string; propertyId: string }): Promise<OwnerLedger> {
  const holder = await holderFor(db, p.userId, p.propertyId);
  if (!holder) return { allowed: false, entries: [], accounts: [], inquiriesAvailable: false };
  const memberKey = holder.type === "buyer" ? holder.buyerAccountId! : holder.holderKey.replace(/^seller:/, "");

  const { data: entryRows } = await db.from("journal_entries").select("id, entry_date, source, memo, reverses_entry_id, posted_at").eq("property_id", p.propertyId).order("posted_at", { ascending: false }).limit(200);
  const entries = (entryRows ?? []) as Row[];
  const ids = entries.map((e) => e.id as string);
  const { data: lineRows } = ids.length ? await db.from("journal_lines").select("entry_id, account_id, member_id, debit_cents, credit_cents").in("entry_id", ids) : { data: [] };
  const accountIds = [...new Set(((lineRows ?? []) as Row[]).map((l) => l.account_id as string))];
  const { data: acctRows } = accountIds.length ? await db.from("coa_accounts").select("id, code, name, is_member_control").in("id", accountIds) : { data: [] };
  const acctBy = new Map(((acctRows ?? []) as Row[]).map((a) => [a.id as string, a]));

  // The inquiries are a separate, optional read: if it fails, the ledger is still shown.
  let inquiries: OwnerInquiry[] = [];
  let inquiriesAvailable = true;
  try {
    const { data, error } = await db.from("coowner_inquiries").select("*").eq("property_id", p.propertyId).eq("raised_by_member_id", memberKey).order("created_at", { ascending: false });
    if (error) inquiriesAvailable = false;
    else inquiries = ((data ?? []) as Row[]).map(toInquiry);
  } catch {
    inquiriesAvailable = false;
  }

  const { data: versions } = await db.from("coa_versions").select("id, version");
  const latest = ((versions ?? []) as Row[]).sort((a, b) => b.version - a.version)[0];
  const { data: chart } = latest ? await db.from("coa_accounts").select("code, name, is_member_control, active, version_id").eq("version_id", latest.id) : { data: [] };

  const out: OwnerLedgerEntry[] = [];
  for (const e of entries) {
    const ls = ((lineRows ?? []) as Row[]).filter((l) => l.entry_id === e.id);
    const memberLines = ls.filter((l) => l.member_id);
    if (memberLines.some((l) => l.member_id !== memberKey)) continue; // someone else's capital account
    out.push({
      id: e.id,
      date: e.entry_date,
      source: e.source,
      memo: memberLines.length > 0 ? null : (e.memo ?? null),
      lines: ls.map((l) => {
        const a = acctBy.get(l.account_id);
        return { code: (a?.code ?? "") as string, name: (a?.name ?? "") as string, debitCents: Number(l.debit_cents), creditCents: Number(l.credit_cents) };
      }),
      inquiries: inquiries.filter((i) => i.entryId === e.id),
    });
  }
  return {
    allowed: true,
    entries: out,
    accounts: ((chart ?? []) as Row[]).filter((a) => a.active && !a.is_member_control).map((a) => ({ code: a.code as string, name: a.name as string })).sort((a, b) => a.code.localeCompare(b.code)),
    inquiriesAvailable,
  };
}

async function notifySafely(fn: () => Promise<unknown>) {
  // A notification failing never undoes or blocks the inquiry.
  try {
    await fn();
  } catch {
    /* the inquiry is saved; the Manager will still see it in the queue */
  }
}

/** A co-owner asks a question or suggests a recategorization. Only an owner of this property can. */
export async function raiseOwnerInquiry(db: Db, p: { userId: string; propertyId: string; entryId: string; type: InquiryType; message: string; suggestedAccountCode?: string | null; request?: RequestContext }): Promise<{ inquiryId: string }> {
  const holder = await holderFor(db, p.userId, p.propertyId);
  if (!holder) throw new Error("You don't have ownership in that property.");
  const { data, error } = await db.rpc("raise_inquiry", { _property: p.propertyId, _entry: p.entryId, _user: p.userId, _type: p.type, _message: p.message, _suggested_code: p.suggestedAccountCode ?? null, _meta: meta(p.request) });
  if (error) fail(error);
  const inquiryId = data as string;
  await notifySafely(async () => {
    const { data: admins } = await db.from("user_roles").select("user_id").eq("role", "admin");
    for (const a of (admins ?? []) as Array<{ user_id: string }>) {
      await deliver(db as never, { authUserId: a.user_id, email: null }, {
        subject: p.type === "recategorize" ? "A co-owner suggested a recategorization" : "A co-owner asked a question about a transaction",
        message: `A co-owner has ${p.type === "recategorize" ? "suggested a recategorization on" : "a question about"} a transaction in the books. Open the inquiries queue to respond.`,
        link: `/admin/books/${p.propertyId}/inquiries`,
        type: "books_inquiry",
        propertyId: p.propertyId,
        dedupeKey: `inquiry:${inquiryId}:raised`,
      });
    }
  });
  return { inquiryId };
}

// ---------------------------------------------------------------------------------------------------------
// The Manager's queue
// ---------------------------------------------------------------------------------------------------------
export interface AdminInquiry extends OwnerInquiry {
  askedBy: string;
  entry: { date: string; memo: string | null; source: string; lines: Array<{ id: string; code: string; name: string; debitCents: number; creditCents: number; memberId: string | null }> } | null;
}

export async function adminInquiries(db: Db, p: { userId: string; propertyId: string }): Promise<{ property: string; inquiries: AdminInquiry[]; accounts: Array<{ code: string; name: string }> }> {
  await requireManager(db, p.userId);
  const { data: prop } = await db.from("properties").select("id, address, city, state").eq("id", p.propertyId).maybeSingle();
  if (!prop) throw new Error("Property not found");
  const { data, error } = await db.from("coowner_inquiries").select("*").eq("property_id", p.propertyId).order("created_at", { ascending: false });
  if (error) fail(error);
  const rows = (data ?? []) as Row[];
  const entryIds = [...new Set(rows.map((r) => r.journal_entry_id as string))];
  const { data: entryRows } = entryIds.length ? await db.from("journal_entries").select("id, entry_date, memo, source").in("id", entryIds) : { data: [] };
  const { data: lineRows } = entryIds.length ? await db.from("journal_lines").select("id, entry_id, account_id, member_id, debit_cents, credit_cents").in("entry_id", entryIds) : { data: [] };
  const accountIds = [...new Set(((lineRows ?? []) as Row[]).map((l) => l.account_id as string))];
  const { data: acctRows } = accountIds.length ? await db.from("coa_accounts").select("id, code, name").in("id", accountIds) : { data: [] };
  const acctBy = new Map(((acctRows ?? []) as Row[]).map((a) => [a.id as string, a]));
  const memberIds = [...new Set(rows.map((r) => r.raised_by_member_id as string))];
  const { data: buyers } = memberIds.length ? await db.from("buyer_accounts").select("id, email").in("id", memberIds) : { data: [] };
  const emailBy = new Map(((buyers ?? []) as Row[]).map((b) => [b.id as string, b.email as string | null]));
  const { data: versions } = await db.from("coa_versions").select("id, version");
  const latest = ((versions ?? []) as Row[]).sort((a, b) => b.version - a.version)[0];
  const { data: chart } = latest ? await db.from("coa_accounts").select("code, name, is_member_control, active, version_id").eq("version_id", latest.id) : { data: [] };
  return {
    property: [prop.address, prop.city, prop.state].filter(Boolean).join(", "),
    accounts: ((chart ?? []) as Row[]).filter((a) => a.active && !a.is_member_control).map((a) => ({ code: a.code as string, name: a.name as string })).sort((a, b) => a.code.localeCompare(b.code)),
    inquiries: rows.map((r) => {
      const e = ((entryRows ?? []) as Row[]).find((x) => x.id === r.journal_entry_id);
      return {
        ...toInquiry(r),
        askedBy: emailBy.get(r.raised_by_member_id) ?? r.raised_by_member_id,
        entry: e
          ? {
              date: e.entry_date,
              memo: e.memo ?? null,
              source: e.source,
              lines: ((lineRows ?? []) as Row[])
                .filter((l) => l.entry_id === e.id)
                .map((l) => ({ id: l.id as string, code: (acctBy.get(l.account_id)?.code ?? "") as string, name: (acctBy.get(l.account_id)?.name ?? "") as string, debitCents: Number(l.debit_cents), creditCents: Number(l.credit_cents), memberId: (l.member_id ?? null) as string | null })),
            }
          : null,
      };
    }),
  };
}

export async function openInquiryCount(db: Db, propertyId: string): Promise<number> {
  try {
    const { data, error } = await db.from("coowner_inquiries").select("id").eq("property_id", propertyId).in("status", ["open", "answered"]);
    return error ? 0 : ((data ?? []) as Row[]).length;
  } catch {
    return 0;
  }
}

async function notifyAsker(db: Db, inquiryId: string, status: string, summary: string) {
  await notifySafely(async () => {
    const { data: q } = await db.from("coowner_inquiries").select("property_id, raised_by_user_id").eq("id", inquiryId).maybeSingle();
    if (!q) return;
    const recipients = await holderRecipients(db, q.property_id);
    const recipient = recipients.find((r) => r.authUserId === q.raised_by_user_id) ?? { authUserId: q.raised_by_user_id as string, email: null };
    await deliver(db as never, recipient, {
      subject: "The Manager responded to your question about the books",
      message: summary,
      link: `/owner/properties/${q.property_id}/ledger`,
      type: "inquiry_update",
      propertyId: q.property_id,
      dedupeKey: `inquiry:${inquiryId}:${status}:${Date.now()}`,
    });
  });
}

export async function answerInquiry(db: Db, p: { actorId: string; inquiryId: string; response: string; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  const { error } = await db.rpc("answer_inquiry", { _id: p.inquiryId, _actor: p.actorId, _response: p.response, _meta: meta(p.request) });
  if (error) fail(error);
  await notifyAsker(db, p.inquiryId, "answered", "The Manager has answered your question. Open your ledger to read it.");
}

export async function rejectInquiry(db: Db, p: { actorId: string; inquiryId: string; response: string; request?: RequestContext }) {
  await requireManager(db, p.actorId);
  const { error } = await db.rpc("reject_inquiry", { _id: p.inquiryId, _actor: p.actorId, _response: p.response, _meta: meta(p.request) });
  if (error) fail(error);
  await notifyAsker(db, p.inquiryId, "rejected", "The Manager has replied to your suggestion. Open your ledger to read why.");
}

export interface InquiryCorrection {
  kind: "recategorize" | "capitalize" | "reverse";
  mapping?: Record<string, string>;
  reason?: string;
  entryDate?: string;
  isAdjustment?: boolean;
  adjustmentReason?: string | null;
}

/** Resolve, optionally by posting a Prompt 4 correction; the new entry is linked as resulting_entry_id. */
export async function resolveInquiry(db: Db, p: { actorId: string; inquiryId: string; response: string; correction?: InquiryCorrection | null; request?: RequestContext }): Promise<{ resultingEntryId: string | null }> {
  await requireManager(db, p.actorId);
  const c = p.correction;
  const { data, error } = await db.rpc("resolve_inquiry", {
    _id: p.inquiryId,
    _actor: p.actorId,
    _response: p.response,
    _correction: c ? { kind: c.kind, mapping: c.mapping ?? {}, reason: c.reason ?? null, entry_date: c.entryDate ?? null, is_adjustment: c.isAdjustment === true, adjustment_reason: c.adjustmentReason ?? null } : null,
    _meta: meta(p.request),
  });
  if (error) fail(error);
  await notifyAsker(db, p.inquiryId, "resolved", c ? "The Manager has resolved your question with a correction to the books. Open your ledger to see it." : "The Manager has resolved your question. Open your ledger to read the response.");
  return { resultingEntryId: ((data as { resulting_entry_id?: string | null } | null)?.resulting_entry_id ?? null) as string | null };
}
