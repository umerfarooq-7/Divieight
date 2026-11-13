import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for the Designated CPA: the Manager designates and rescinds; the CPA reads one LLC, read-only. */

type Db = Parameters<(typeof import("@/lib/cpa.server"))["designationBoard"]>[0];

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}
const server = () => import("@/lib/cpa.server");

async function request() {
  try {
    const { getRequest, getRequestIP } = await import("@tanstack/react-start/server");
    return { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequest().headers.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}
async function origin() {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    return new URL(getRequest().url).origin;
  } catch {
    return "https://divieight.vercel.app";
  }
}

const id = (value: unknown, label: string) => {
  const t = String(value ?? "").trim();
  if (!t) throw new Error(`Missing ${label}`);
  return t.slice(0, 64);
};
const year = (value: unknown) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 2000 || n > 2200) throw new Error("Enter a valid year");
  return n;
};
const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

// The Manager
export const getCpaBoard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).designationBoard(await adminDb(), { userId: context.userId, ...data }));

export const designateCpaFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; name: string; firm: string; email: string; licenseNo?: string | null }) => ({
    propertyId: id(input?.propertyId, "property"),
    name: text(input?.name, 200),
    firm: text(input?.firm, 200),
    email: text(input?.email, 255),
    licenseNo: text(input?.licenseNo, 100) || null,
  }))
  .handler(async ({ data, context }) => (await server()).designateCpa(await adminDb(), { userId: context.userId, ...data, origin: await origin(), request: await request() }));

export const rescindCpaFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { designationId: string; reason: string }) => ({ designationId: id(input?.designationId, "designation"), reason: text(input?.reason, 1000) }))
  .handler(async ({ data, context }) => (await server()).rescindCpa(await adminDb(), { userId: context.userId, ...data, request: await request() }));

// A member: who the CPA is
export const getOwnerCpa = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).ownerCpa(await adminDb(), { userId: context.userId, ...data }));

// The CPA
export const getCpaPortal = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).cpaPortal(await adminDb(), { userId: context.userId }));

export const getCpaLedger = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; year: number }) => ({ propertyId: id(input?.propertyId, "property"), year: year(input?.year) }))
  .handler(async ({ data, context }) => (await server()).cpaLedger(await adminDb(), { userId: context.userId, ...data }));

export const getCpaCapitalAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; year: number }) => ({ propertyId: id(input?.propertyId, "property"), year: year(input?.year) }))
  .handler(async ({ data, context }) => (await server()).cpaCapitalAccounts(await adminDb(), { userId: context.userId, ...data }));

export const getCpaStatements = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).cpaStatements(await adminDb(), { userId: context.userId, ...data }));

export const getCpaStatement = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { statementId: string }) => ({ statementId: id(input?.statementId, "statement") }))
  .handler(async ({ data, context }) => (await server()).cpaReadStatement(await adminDb(), { userId: context.userId, ...data }));

export const getCpaStatementPdf = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { statementId: string }) => ({ statementId: id(input?.statementId, "statement") }))
  .handler(async ({ data, context }) => (await server()).cpaStatementPdf(await adminDb(), { userId: context.userId, ...data }));

export const getCpaWorksheet = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).cpaWorksheet(await adminDb(), { userId: context.userId, ...data }));

export const getCpaPackets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).cpaPackets(await adminDb(), { userId: context.userId, ...data }));

export const getCpaRoster = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).cpaRoster(await adminDb(), { userId: context.userId, ...data }));

export const revealCpaTinFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; w9Id: string; note?: string | null }) => ({ propertyId: id(input?.propertyId, "property"), w9Id: id(input?.w9Id, "W-9"), note: text(input?.note, 300) || null }))
  .handler(async ({ data, context }) => (await server()).cpaRevealTin(await adminDb(), { userId: context.userId, ...data }));
