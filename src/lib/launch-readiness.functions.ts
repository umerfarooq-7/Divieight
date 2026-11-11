import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for launch readiness. The list is founder only (a 403 for anyone else); the warnings are for any admin. */

type Db = { from: (t: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function requireFounderOr403(userId: string) {
  const { isFounder } = await import("@/lib/governance-config.server");
  if (await isFounder(await adminDb(), userId)) return;
  const { setResponseStatus } = await import("@tanstack/react-start/server");
  setResponseStatus(403);
  throw new Error("Not authorized");
}

export const getLaunchReadiness = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireFounderOr403(context.userId);
    return { items: await (await import("@/lib/launch-readiness.server")).listLaunchItems(await adminDb()) };
  });

export const saveLaunchItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { key: string; status: string; owner: string; notes: string }) => ({
    key: String(input?.key ?? ""),
    status: String(input?.status ?? ""),
    owner: String(input?.owner ?? "").slice(0, 200),
    notes: String(input?.notes ?? "").slice(0, 4000),
  }))
  .handler(async ({ data, context }) => {
    await requireFounderOr403(context.userId);
    let request = { ip: null as string | null, userAgent: null as string | null };
    try {
      const { getRequest, getRequestIP } = await import("@tanstack/react-start/server");
      request = { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequest().headers.get("user-agent") };
    } catch {
      /* no request outside a server context */
    }
    return { items: await (await import("@/lib/launch-readiness.server")).updateLaunchItem(await adminDb(), { actorId: context.userId, ...data, request }) };
  });

/** Any admin: what is wrong with this deployment (shown as a banner in the admin area). */
export const getAdminLaunchWarnings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await (context.supabase as any).rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (!data) throw new Error("Not authorized");
    return { warnings: (await import("@/lib/launch-readiness.server")).computeLaunchWarnings() };
  });
