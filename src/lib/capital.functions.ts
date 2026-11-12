import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for capital accounts: owners read their own; the Manager allocates, enters depreciation and reads all. */

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}
const server = () => import("@/lib/capital.server");

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
const day = (value: unknown, label: string) => {
  const t = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error(`Enter a valid ${label}`);
  return t;
};
const year = (value: unknown) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 2000 || n > 2200) throw new Error("Choose a year");
  return n;
};

export const getOwnerCapitalAccount = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).ownerCapitalAccount(await adminDb(), { userId: context.userId, ...data }));

export const getAdminRollForward = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; year: number }) => ({ propertyId: id(input?.propertyId, "property"), year: year(input?.year) }))
  .handler(async ({ data, context }) => (await server()).adminRollForward(await adminDb(), { userId: context.userId, ...data }));

export const allocateIncomeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; asOf: string }) => ({ propertyId: id(input?.propertyId, "property"), asOf: day(input?.asOf, "date") }))
  .handler(async ({ data, context }) => (await server()).allocateIncome(await adminDb(), { actorId: context.userId, ...data, request: await request() }));

export const enterDepreciationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; year: number; amountCents: number; scheduleRef: string; note?: string | null }) => {
    const cents = Number(input?.amountCents);
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("Enter the depreciation from the CPA's schedule, as a whole number of cents above zero.");
    return { propertyId: id(input?.propertyId, "property"), year: year(input?.year), amountCents: cents, scheduleRef: String(input?.scheduleRef ?? "").slice(0, 200), note: input?.note ? String(input.note).slice(0, 500) : null };
  })
  .handler(async ({ data, context }) => (await server()).enterDepreciation(await adminDb(), { actorId: context.userId, ...data, request: await request() }));

export const syncMonth5EventsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).syncMonth5Events(await adminDb(), { actorId: context.userId, ...data, request: await request() }));
