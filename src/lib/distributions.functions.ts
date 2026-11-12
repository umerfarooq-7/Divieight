import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for distributions: the Manager initiates, previews, authorizes and executes; owners read their own and set their payout method. */

type Db = Parameters<(typeof import("@/lib/distributions.server"))["distributionBoard"]>[0];

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}
const server = () => import("@/lib/distributions.server");

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
const day = (value: unknown) => {
  const t = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error("Enter a valid record date");
  return t;
};

interface DraftInput {
  propertyId: string;
  totalAmount: number | string;
  recordDate: string;
  reason: string;
  method: "pro_rata" | "oa_override";
  percents?: Record<string, number | string> | null;
  oaSection?: string | null;
}
const draftInput = (input: DraftInput) => {
  const method = input?.method === "oa_override" ? "oa_override" : "pro_rata";
  const percents = method === "oa_override" ? Object.fromEntries(Object.entries(input?.percents ?? {}).map(([k, v]) => [String(k).slice(0, 80), Number(v)])) : undefined;
  return {
    propertyId: id(input?.propertyId, "property"),
    totalAmount: Number(input?.totalAmount),
    recordDate: day(input?.recordDate),
    reason: String(input?.reason ?? "").trim().slice(0, 1000),
    method: method as "pro_rata" | "oa_override",
    percents,
    oaSection: String(input?.oaSection ?? "").trim().slice(0, 300) || null,
  };
};

export const getDistributionBoard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId?: string | null }) => ({ propertyId: input?.propertyId ? id(input.propertyId, "property") : null }))
  .handler(async ({ data, context }) => (await server()).distributionBoard(await adminDb(), context.userId, data.propertyId));

export const previewDistributionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(draftInput)
  .handler(async ({ data, context }) => (await server()).previewDistribution(await adminDb(), { userId: context.userId, ...data }));

export const createDistributionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(draftInput)
  .handler(async ({ data, context }) => (await server()).createDistribution(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const authorizeDistributionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { distributionId: string; signedName: string }) => ({ distributionId: id(input?.distributionId, "distribution"), signedName: String(input?.signedName ?? "").trim().slice(0, 200) }))
  .handler(async ({ data, context }) => {
    const db = await adminDb();
    // The Manager's own name, from their account: the typed signature has to match it.
    const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
    const { data: u } = await (supabaseAdmin as any).auth.admin.getUserById(context.userId);
    const name = ((u?.user?.user_metadata?.full_name as string | undefined) ?? "").trim() || null;
    if (!name) throw new Error("Your account has no full name on record. Add it before signing a distribution.");
    return (await server()).authorizeDistribution(db, { userId: context.userId, ...data, managerName: name, request: await request() });
  });

export const executeDistributionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { distributionId: string }) => ({ distributionId: id(input?.distributionId, "distribution") }))
  .handler(async ({ data, context }) => (await server()).executeDistribution(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const settleDistributionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { distributionId: string }) => ({ distributionId: id(input?.distributionId, "distribution") }))
  .handler(async ({ data, context }) => (await server()).settleDistribution(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const retryPaymentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { paymentId: string }) => ({ paymentId: id(input?.paymentId, "payment") }))
  .handler(async ({ data, context }) => (await server()).retryPayment(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const voidPayoutDistributionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { distributionId: string; reason: string }) => ({ distributionId: id(input?.distributionId, "distribution"), reason: String(input?.reason ?? "").trim().slice(0, 1000) }))
  .handler(async ({ data, context }) => (await server()).voidPayoutDistribution(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const repostPayoutDistributionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: DraftInput & { distributionId: string; voidReason: string }) => ({ ...draftInput(input), distributionId: id(input?.distributionId, "distribution"), voidReason: String(input?.voidReason ?? "").trim().slice(0, 1000) }))
  .handler(async ({ data, context }) => (await server()).repostPayoutDistribution(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const setMinimumReserveFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; reserveAmount: number | string }) => ({ propertyId: id(input?.propertyId, "property"), reserveAmount: Number(input?.reserveAmount) }))
  .handler(async ({ data, context }) => {
    await (await server()).setMinimumReserve(await adminDb(), { userId: context.userId, ...data, request: await request() });
    return { ok: true };
  });

export const getOwnerDistributions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).ownerDistributions(await adminDb(), { userId: context.userId, ...data }));

export const savePayoutMethodFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; routing: string; account: string; bankName?: string | null }) => ({
    propertyId: id(input?.propertyId, "property"),
    routing: String(input?.routing ?? "").replace(/\s/g, "").slice(0, 9),
    account: String(input?.account ?? "").replace(/\s/g, "").slice(0, 17),
    bankName: String(input?.bankName ?? "").trim().slice(0, 100) || null,
  }))
  .handler(async ({ data, context }) => (await server()).savePayoutMethod(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const removePayoutMethodFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => {
    await (await server()).removePayoutMethod(await adminDb(), { userId: context.userId, ...data, request: await request() });
    return { ok: true };
  });
