import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for the Eligibility Decision Page. */

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

export const acknowledgeEligibilityStandard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string }) => {
    const actingMemberId = String(input?.actingMemberId ?? "").trim();
    if (!actingMemberId) throw new Error("Missing member");
    return { actingMemberId };
  })
  .handler(async ({ data, context }) => {
    const { acknowledgeStandard } = await import("@/lib/eligibility-standard.server");
    return acknowledgeStandard(await adminDb(), { userId: context.userId, actingMemberId: data.actingMemberId, request: await request() });
  });

export const listReadTheStandardForAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { accountIds: string[] }) => ({ accountIds: (Array.isArray(input?.accountIds) ? input.accountIds : []).map(String).slice(0, 1000) }))
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await (context.supabase as any).rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (!isAdmin) throw new Error("Not authorized");
    const { adminReadTheStandard } = await import("@/lib/eligibility-standard.server");
    return adminReadTheStandard(await adminDb(), data.accountIds);
  });
