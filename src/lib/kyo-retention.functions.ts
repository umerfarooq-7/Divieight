import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for Know Your Owner retention: the Manager, the Compliance Officer and the founder read the status and the queue; only a founder approves an erasure. */

type Db = Parameters<(typeof import("@/lib/kyo-retention.server"))["retentionOverview"]>[0];

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}
const server = () => import("@/lib/kyo-retention.server");

async function request() {
  try {
    const { getRequest, getRequestIP } = await import("@tanstack/react-start/server");
    return { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequest().headers.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

/** A refusal for lack of the role is a 403 on the screen. */
async function forbidOr<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && e.message === "Not authorized") {
      const { setResponseStatus } = await import("@tanstack/react-start/server");
      setResponseStatus(403);
    }
    throw e;
  }
}

const id = (v: unknown, label: string) => {
  const t = String(v ?? "").trim();
  if (!t) throw new Error(`Missing ${label}`);
  return t.slice(0, 64);
};
const text = (v: unknown, max: number) => String(v ?? "").slice(0, max);

export const getRetentionOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => forbidOr(async () => (await server()).retentionOverview(await adminDb(), { userId: context.userId })));

export const getRetentionQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => forbidOr(async () => (await server()).listRetentionQueue(await adminDb(), { userId: context.userId })));

/** Founders only. Approving erases the personal data (never a record under a legal hold or inside its period). */
export const decideRetentionReview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { reviewId: string; decision: string; reason: string }) => {
    if (input?.decision !== "approve_erasure" && input?.decision !== "keep") throw new Error("Unknown decision");
    return { reviewId: id(input.reviewId, "review"), decision: input.decision as "approve_erasure" | "keep", reason: text(input.reason, 1000) };
  })
  .handler(async ({ data, context }) => forbidOr(async () => (await server()).decideReview(await adminDb(), { userId: context.userId, ...data, request: await request() })));

export const setRetentionLegalHold = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { retentionId: string; hold: boolean; reason: string }) => ({ retentionId: id(input?.retentionId, "record"), hold: input?.hold === true, reason: text(input?.reason, 500) }))
  .handler(async ({ data, context }) => forbidOr(async () => (await server()).setLegalHold(await adminDb(), { userId: context.userId, ...data, request: await request() })));

export const recordLlcDissolutionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; date: string; reason: string }) => ({ propertyId: id(input?.propertyId, "property"), date: text(input?.date, 10), reason: text(input?.reason, 500) }))
  .handler(async ({ data, context }) => forbidOr(async () => (await server()).recordLlcDissolution(await adminDb(), { userId: context.userId, ...data, request: await request() })));

// ---- The member ----------------------------------------------------------------------------------------

export const getMyRetention = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string }) => ({ actingMemberId: id(input?.actingMemberId, "member") }))
  .handler(async ({ data, context }) => (await server()).myRetention(await adminDb(), { userId: context.userId, actingMemberId: data.actingMemberId }));

export const requestMyKyoDeletion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; note?: string }) => ({ actingMemberId: id(input?.actingMemberId, "member"), note: text(input?.note, 2000) }))
  .handler(async ({ data, context }) => (await server()).requestKyoDeletion(await adminDb(), { userId: context.userId, ...data, request: await request() }));
