/**
 * Monthly Co-owner Statements (server side): the monthly job, the Manager's review and issue flow, delivery (in-app, PDF, email), and the
 * owner's read-only view. The numbers are built and fixed by the database (monthly-statements.sql). Nothing here looks at an owner's
 * standing, payments, votes or Retention Lock: a statement is never withheld from an owner (Rev 48 floor).
 */
import { adminRecipients, deliver } from "@/lib/authorization.notify.server";
import { holderLabeller, holderRecipient } from "@/lib/expenses.server";
import { renderStatementPdf } from "@/lib/statement-pdf";
import { STATEMENT_HOLIDAYS, isPeriod, periodLabel, statementMoney, statementSchedule, type StatementSnapshot, type StatementStatus } from "@/lib/statements";
import { holderFor } from "@/lib/votes.server";

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any; storage?: any };
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}
const MISSING = "Database is missing statements: run monthly-statements.sql in Supabase.";
const BUCKET = "statements";
const meta = (r?: RequestContext) => ({ ip_address: r?.ip ?? null, user_agent: r?.userAgent ?? null });

async function requireManager(db: Db, userId: string) {
  const { data } = await db.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (data !== true) throw new Error("Only the Manager can do that.");
}
async function isManager(db: Db, userId: string) {
  const { data } = await db.rpc("has_role", { _user_id: userId, _role: "admin" });
  return data === true;
}
async function call<T = Record<string, any>>(db: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const m = String(error.message ?? "");
    if (/does not exist|schema cache|Could not find/i.test(m) && /statement/i.test(m)) throw new Error(MISSING);
    throw new Error(m || "The books refused that.");
  }
  return data as T;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const link = (propertyId: string, id?: string) => (id ? `/owner/properties/${propertyId}/statements/${id}` : `/owner/properties/${propertyId}/statements`);

/** A capital account's holder key: a Buyer Account's id, or 'seller:<id>' for a retained seller. */
async function holderKeyOf(db: Db, memberKey: string): Promise<string> {
  const { data } = await db.from("buyer_accounts").select("id").eq("id", memberKey).maybeSingle();
  return data ? memberKey : `seller:${memberKey}`;
}

// ---------------------------------------------------------------------------------------------------------
// The monthly job
// ---------------------------------------------------------------------------------------------------------
async function propertiesWithBooks(db: Db): Promise<string[]> {
  const { data } = await db.from("cap_table_entries").select("property_id");
  return [...new Set(((data ?? []) as Array<{ property_id: string }>).map((r) => r.property_id))];
}

async function alertManagers(db: Db, subject: string, message: string, dedupeKey: string) {
  for (const admin of await adminRecipients(db as never)) {
    await deliver(db as never, admin, { subject, message, link: "/admin/books", type: "monthly_statement", dedupeKey: `${dedupeKey}:${admin.authUserId}` });
  }
}

/**
 * The daily job. From the first business day of the month it makes (or refreshes) the drafts for the month that just ended, for every LLC and
 * every member; it also looks at the months already issued, and a correction that changed one gets a new version as a draft. Running it again
 * changes nothing. If the deadline (the first business week) has passed and drafts are still waiting, the Manager is told, once per month.
 */
export async function runStatementsSweep(db: Db, p: { now?: Date; holidays?: readonly string[] } = {}) {
  const now = p.now ?? new Date();
  const today = iso(now);
  const schedule = statementSchedule(today, p.holidays ?? STATEMENT_HOLIDAYS);
  const result = { today, period: schedule.period, due: schedule.due, deadline: schedule.deadline, properties: 0, created: 0, refreshed: 0, corrections: 0, alerts: 0 };
  if (!schedule.due) return result;
  for (const propertyId of await propertiesWithBooks(db)) {
    result.properties += 1;
    const g = await call<Record<string, any>>(db, "generate_monthly_statements", { _property: propertyId, _period: schedule.period, _actor: null, _meta: {} });
    result.created += Number(g.created ?? 0);
    result.refreshed += Number(g.refreshed ?? 0);
    result.corrections += Number(g.corrections ?? 0);
    // Past months that were already issued: has a correction changed any of them?
    const { data: issued } = await db.from("monthly_statements").select("period").eq("property_id", propertyId).eq("status", "issued");
    for (const period of [...new Set(((issued ?? []) as Array<{ period: string }>).map((r) => r.period))].filter((x) => x !== schedule.period).sort().slice(-24)) {
      const c = await call<Record<string, any>>(db, "generate_monthly_statements", { _property: propertyId, _period: period, _actor: null, _meta: {} });
      result.corrections += Number(c.corrections ?? 0);
    }
    if (schedule.overdue) {
      const { data: drafts } = await db.from("monthly_statements").select("id").eq("property_id", propertyId).eq("status", "draft");
      if ((drafts ?? []).length > 0) {
        await alertManagers(db, "Monthly statements are waiting to be issued", `The ${periodLabel(schedule.period)} statements are still drafts and the first business week (${schedule.deadline}) has passed. Review the needs-review queue, add your notes and issue them from the Books screens.`, `statements_overdue:${propertyId}:${schedule.period}`);
        result.alerts += 1;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// The Manager's flow
// ---------------------------------------------------------------------------------------------------------
interface Row {
  id: string;
  property_id: string;
  member_key: string;
  period: string;
  version: number;
  status: StatementStatus;
  pdf_url: string | null;
  data_snapshot: StatementSnapshot;
  manager_notes: string | null;
  issued_at: string | null;
}

export async function statementBoard(db: Db, p: { userId: string; propertyId: string; period?: string | null; today?: string }) {
  await requireManager(db, p.userId);
  const today = p.today ?? iso(new Date());
  const schedule = statementSchedule(today);
  const period = p.period && isPeriod(p.period) ? p.period : schedule.period;
  const { data, error } = await db.from("monthly_statements").select("*").eq("property_id", p.propertyId).eq("period", period).order("member_key");
  if (error) throw new Error(MISSING);
  const rows = (data ?? []) as Row[];
  const labelOf = await holderLabeller(db);
  const d1 = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const { data: queue } = await db.from("bank_transactions").select("id").eq("property_id", p.propertyId).eq("status", "needs_review").lte("posted_date", d1);
  const { data: rec } = await db.rpc("statement_reconciliation", { _property: p.propertyId, _period: period });
  const reconciles = new Map(((rec ?? []) as Array<{ statement_id: string; reconciles: boolean }>).map((r) => [r.statement_id, r.reconciles]));
  const statements = [];
  for (const r of rows.sort((a, b) => a.member_key.localeCompare(b.member_key) || b.version - a.version)) {
    statements.push({
      id: r.id,
      memberKey: r.member_key,
      holder: await labelOf(await holderKeyOf(db, r.member_key)),
      version: r.version,
      status: r.status,
      closingCents: Number(r.data_snapshot.capital.closing_cents),
      notes: r.manager_notes,
      issuedAt: r.issued_at,
      reconciles: reconciles.get(r.id) ?? null,
    });
  }
  const drafts = statements.filter((s) => s.status === "draft");
  return {
    period,
    schedule: { period: schedule.period, starts: schedule.starts, deadline: schedule.deadline, overdue: schedule.overdue && period === schedule.period },
    statements,
    drafts: drafts.length,
    needsReview: (queue ?? []).length,
    notes: drafts.find((s) => s.notes)?.notes ?? "",
  };
}

export async function generateStatements(db: Db, p: { userId: string; propertyId: string; period: string; request?: RequestContext }) {
  await requireManager(db, p.userId);
  if (!isPeriod(p.period)) throw new Error("The month is YYYY-MM.");
  const r = await call<Record<string, any>>(db, "generate_monthly_statements", { _property: p.propertyId, _period: p.period, _actor: p.userId, _meta: meta(p.request) });
  if (r.status === "not_open") throw new Error("The books for this property are not open yet.");
  return { created: Number(r.created), refreshed: Number(r.refreshed), corrections: Number(r.corrections), unchanged: Number(r.unchanged) };
}

export async function saveStatementNotes(db: Db, p: { userId: string; propertyId: string; period: string; memberKey?: string | null; notes: string; request?: RequestContext }) {
  await requireManager(db, p.userId);
  if (!isPeriod(p.period)) throw new Error("The month is YYYY-MM.");
  const n = await call<number>(db, "set_statement_notes", { _property: p.propertyId, _period: p.period, _member: p.memberKey ?? null, _notes: p.notes, _actor: p.userId, _meta: meta(p.request) });
  if (Number(n) === 0) throw new Error("There are no drafts for that month to add notes to.");
  return { drafts: Number(n) };
}

/** What an owner's PDF is called. */
export const statementFileName = (s: Pick<StatementSnapshot, "period">, version: number) => `statement-${s.period}-v${version}.pdf`;

async function memberLabel(db: Db, memberKey: string) {
  return (await holderLabeller(db))(await holderKeyOf(db, memberKey));
}

/** The PDF for a statement, made from its fixed snapshot. */
export async function pdfFor(db: Db, row: Row): Promise<Uint8Array> {
  return renderStatementPdf({ snapshot: row.data_snapshot, memberLabel: await memberLabel(db, row.member_key), version: row.version, status: row.status, issuedAt: row.issued_at });
}

/**
 * Issue every draft of a month. Each owner is told in the app and by email (a notice that can't be switched off), and the PDF is filed.
 * A corrected version says so, and the version it replaces stays viewable.
 */
export async function issueStatements(db: Db, p: { userId: string; propertyId: string; period: string; forceReason?: string | null; request?: RequestContext }) {
  await requireManager(db, p.userId);
  if (!isPeriod(p.period)) throw new Error("The month is YYYY-MM.");
  const r = await call<{ issued: number; statements: Array<{ id: string; member_key: string; version: number; superseded_id: string | null }>; review_queue_pending: number }>(db, "issue_monthly_statements", {
    _property: p.propertyId,
    _period: p.period,
    _actor: p.userId,
    _force_reason: p.forceReason?.trim() || null,
    _meta: meta(p.request),
  });
  let notified = 0;
  let filed = 0;
  for (const s of r.statements ?? []) {
    const { data } = await db.from("monthly_statements").select("*").eq("id", s.id).maybeSingle();
    const row = data as Row | null;
    if (!row) continue;
    // File the PDF. If storage isn't there the statement is still issued and the PDF is made on request.
    try {
      const bytes = await pdfFor(db, row);
      const path = `${row.property_id}/${row.period}/${row.member_key}-v${row.version}.pdf`;
      const up = await db.storage?.from(BUCKET).upload(path, new Blob([bytes as BlobPart], { type: "application/pdf" }), { contentType: "application/pdf", upsert: false });
      if (up && !up.error) {
        await db.rpc("set_statement_pdf", { _id: row.id, _path: `${BUCKET}/${path}` });
        filed += 1;
      }
    } catch {
      // made on request instead
    }
    const recipient = await holderRecipient(db, await holderKeyOf(db, row.member_key));
    if (!recipient) continue;
    const corrected = row.version > 1;
    const result = await deliver(db as never, recipient, {
      subject: corrected ? `A corrected statement for ${periodLabel(row.period)}` : `Your statement for ${periodLabel(row.period)}`,
      message: corrected
        ? `Your ${periodLabel(row.period)} statement was corrected (version ${row.version}). Your closing capital balance is ${statementMoney(Number(row.data_snapshot.capital.closing_cents))}. The earlier version stays available for your records.`
        : `Your ${periodLabel(row.period)} statement is ready. Your closing capital balance is ${statementMoney(Number(row.data_snapshot.capital.closing_cents))}. You can read it online or download it as a PDF.`,
      link: link(row.property_id, row.id),
      type: "monthly_statement",
      propertyId: row.property_id,
      dedupeKey: `statement:${row.id}`,
    });
    if (!result.duplicate) notified += 1;
  }
  return { issued: Number(r.issued), notified, filed, reviewQueuePending: Number(r.review_queue_pending) };
}

// ---------------------------------------------------------------------------------------------------------
// The owner's side: read-only, their own capital account only
// ---------------------------------------------------------------------------------------------------------
async function ownMemberKey(db: Db, userId: string, propertyId: string): Promise<string | null> {
  const holder = await holderFor(db as never, userId, propertyId);
  if (!holder) return null;
  return holder.buyerAccountId ?? holder.holderKey.replace(/^seller:/, "");
}

/** Every issued and superseded statement of the owner's own account on a property, newest first. No test of the owner's standing. */
export async function ownerStatements(db: Db, p: { userId: string; propertyId: string }) {
  const memberKey = await ownMemberKey(db, p.userId, p.propertyId);
  if (!memberKey) return { allowed: false as const };
  const { data } = await db.from("monthly_statements").select("*").eq("property_id", p.propertyId).eq("member_key", memberKey).in("status", ["issued", "superseded"]);
  const rows = ((data ?? []) as Row[]).sort((a, b) => (a.period === b.period ? b.version - a.version : a.period < b.period ? 1 : -1));
  return {
    allowed: true as const,
    statements: rows.map((r) => ({ id: r.id, period: r.period, version: r.version, status: r.status, issuedAt: r.issued_at, closingCents: Number(r.data_snapshot.capital.closing_cents) })),
  };
}

/** One statement, only if it is the caller's own account's (or the caller is the Manager). Anyone else gets the same answer as for a statement that doesn't exist. */
async function loadAllowed(db: Db, userId: string, statementId: string): Promise<Row> {
  const denied = new Error("Statement not found.");
  const { data } = await db.from("monthly_statements").select("*").eq("id", statementId).maybeSingle();
  const row = data as Row | null;
  if (!row) throw denied;
  if (await isManager(db, userId)) return row;
  if (row.status === "draft") throw denied;
  const memberKey = await ownMemberKey(db, userId, row.property_id);
  if (!memberKey || memberKey !== row.member_key) throw denied;
  return row;
}

export async function readStatement(db: Db, p: { userId: string; statementId: string }) {
  const row = await loadAllowed(db, p.userId, p.statementId);
  const { data: newer } = await db.from("monthly_statements").select("id, version, status").eq("property_id", row.property_id).eq("member_key", row.member_key).eq("period", row.period).gt("version", row.version);
  return {
    id: row.id,
    propertyId: row.property_id,
    period: row.period,
    version: row.version,
    status: row.status,
    issuedAt: row.issued_at,
    holder: await memberLabel(db, row.member_key),
    snapshot: row.data_snapshot,
    newerVersion: ((newer ?? []) as Array<{ id: string; version: number }>).sort((a, b) => b.version - a.version)[0] ?? null,
  };
}

export async function statementPdf(db: Db, p: { userId: string; statementId: string }) {
  const row = await loadAllowed(db, p.userId, p.statementId);
  const bytes = await pdfFor(db, row);
  return { filename: statementFileName(row.data_snapshot, row.version), base64: Buffer.from(bytes).toString("base64") };
}
