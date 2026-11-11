import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for the KYO record: admin view, and each member's own data and correction requests. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function request() {
  try {
    const { getRequest, getRequestIP } = await import("@tanstack/react-start/server");
    return { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequest().headers.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

async function requireAdmin(context: { supabase: unknown; userId: string }) {
  const { data: isAdmin } = await (context.supabase as any).rpc("has_role", { _user_id: context.userId, _role: "admin" });
  if (!isAdmin) throw new Error("Not authorized");
}

const id = (v: unknown, label: string) => {
  const t = String(v ?? "").trim();
  if (!t) throw new Error(`Missing ${label}`);
  return t.slice(0, 64);
};

const server = () => import("@/lib/kyo.server");

export const getKyoForAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { accountId: string }) => ({ accountId: id(input?.accountId, "account") }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).adminKyo(await adminDb(), { adminId: context.userId, accountId: data.accountId });
  });

export const listKyoCorrectionsForAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    return (await server()).listOpenCorrections(await adminDb());
  });

export const resolveKyoCorrectionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { requestId: string; note: string }) => ({ requestId: id(input?.requestId, "request"), note: String(input?.note ?? "").slice(0, 2000) }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).resolveCorrection(await adminDb(), { adminId: context.userId, ...data });
  });

export const getMyKyo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string }) => ({ actingMemberId: id(input?.actingMemberId, "member") }))
  .handler(async ({ data, context }) => (await server()).myKyo(await adminDb(), { userId: context.userId, actingMemberId: data.actingMemberId }));

export const requestKyoCorrectionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; field: string; requestedChange: string }) => ({
    actingMemberId: id(input?.actingMemberId, "member"),
    field: String(input?.field ?? "").slice(0, 40),
    requestedChange: String(input?.requestedChange ?? "").slice(0, 2000),
  }))
  .handler(async ({ data, context }) => (await server()).requestCorrection(await adminDb(), { userId: context.userId, ...data, request: await request() }));
