import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for co-owner inquiries: owners raise and read their own; the Manager answers. */

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}
const server = () => import("@/lib/inquiries.server");

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
const text = (value: unknown, max = 2000) => String(value ?? "").slice(0, max);

export const getOwnerLedger = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).ownerLedger(await adminDb(), { userId: context.userId, ...data }));

export const raiseInquiryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; entryId: string; type: string; message: string; suggestedAccountCode?: string | null }) => {
    if (input?.type !== "clarification" && input?.type !== "recategorize") throw new Error("Choose a question or a recategorization.");
    return { propertyId: id(input?.propertyId, "property"), entryId: id(input?.entryId, "transaction"), type: input.type as "clarification" | "recategorize", message: text(input?.message), suggestedAccountCode: input?.suggestedAccountCode ? text(input.suggestedAccountCode, 10) : null };
  })
  .handler(async ({ data, context }) => (await server()).raiseOwnerInquiry(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const getAdminInquiries = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).adminInquiries(await adminDb(), { userId: context.userId, ...data }));

export const answerInquiryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { inquiryId: string; response: string }) => ({ inquiryId: id(input?.inquiryId, "inquiry"), response: text(input?.response) }))
  .handler(async ({ data, context }) => {
    await (await server()).answerInquiry(await adminDb(), { actorId: context.userId, ...data, request: await request() });
    return { ok: true };
  });

export const rejectInquiryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { inquiryId: string; response: string }) => ({ inquiryId: id(input?.inquiryId, "inquiry"), response: text(input?.response) }))
  .handler(async ({ data, context }) => {
    await (await server()).rejectInquiry(await adminDb(), { actorId: context.userId, ...data, request: await request() });
    return { ok: true };
  });

export const resolveInquiryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { inquiryId: string; response: string; correction?: { kind: string; mapping?: Record<string, string>; reason?: string; entryDate?: string } | null }) => {
    const c = input?.correction;
    if (c && !["recategorize", "capitalize", "reverse"].includes(c.kind)) throw new Error("Choose recategorize, capitalize or reverse.");
    return {
      inquiryId: id(input?.inquiryId, "inquiry"),
      response: text(input?.response),
      correction: c ? { kind: c.kind as "recategorize" | "capitalize" | "reverse", mapping: Object.fromEntries(Object.entries(c.mapping ?? {}).slice(0, 20).map(([k, v]) => [id(k, "line"), text(v, 10)])), reason: c.reason ? text(c.reason) : undefined, entryDate: c.entryDate && /^\d{4}-\d{2}-\d{2}$/.test(c.entryDate) ? c.entryDate : undefined } : null,
    };
  })
  .handler(async ({ data, context }) => (await server()).resolveInquiry(await adminDb(), { actorId: context.userId, ...data, request: await request() }));
