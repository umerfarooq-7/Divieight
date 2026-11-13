import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for monthly statements: the Manager reviews, adds notes and issues; owners read their own and download the PDF. */

type Db = Parameters<(typeof import("@/lib/statements.server"))["statementBoard"]>[0];

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}
const server = () => import("@/lib/statements.server");

async function request() {
  try {
    const { getRequest, getRequestIP } = await import("@tanstack/react-start/server");
    return { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequest().headers.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

const id = (value: unknown, label: string) => {
  const t = String(value ?? "").trim();
  if (!t) throw new Error(`Missing ${label}`);
  return t.slice(0, 64);
};
const period = (value: unknown) => {
  const t = String(value ?? "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(t)) throw new Error("The month is YYYY-MM.");
  return t;
};

export const getStatementBoard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; period?: string | null }) => ({ propertyId: id(input?.propertyId, "property"), period: input?.period ? period(input.period) : null }))
  .handler(async ({ data, context }) => (await server()).statementBoard(await adminDb(), { userId: context.userId, ...data }));

export const generateStatementsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; period: string }) => ({ propertyId: id(input?.propertyId, "property"), period: period(input?.period) }))
  .handler(async ({ data, context }) => (await server()).generateStatements(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const saveStatementNotesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; period: string; memberKey?: string | null; notes: string }) => ({
    propertyId: id(input?.propertyId, "property"),
    period: period(input?.period),
    memberKey: input?.memberKey ? id(input.memberKey, "member") : null,
    notes: String(input?.notes ?? "").slice(0, 4000),
  }))
  .handler(async ({ data, context }) => (await server()).saveStatementNotes(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const issueStatementsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; period: string; forceReason?: string | null }) => ({
    propertyId: id(input?.propertyId, "property"),
    period: period(input?.period),
    forceReason: String(input?.forceReason ?? "").trim().slice(0, 500) || null,
  }))
  .handler(async ({ data, context }) => (await server()).issueStatements(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const getOwnerStatements = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).ownerStatements(await adminDb(), { userId: context.userId, ...data }));

export const getStatement = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { statementId: string }) => ({ statementId: id(input?.statementId, "statement") }))
  .handler(async ({ data, context }) => (await server()).readStatement(await adminDb(), { userId: context.userId, ...data }));

export const getStatementPdf = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { statementId: string }) => ({ statementId: id(input?.statementId, "statement") }))
  .handler(async ({ data, context }) => (await server()).statementPdf(await adminDb(), { userId: context.userId, ...data }));
