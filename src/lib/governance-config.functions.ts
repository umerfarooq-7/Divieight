import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for the governance settings. Any admin reads; only the founder role changes. */

type Db = { from: (t: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function requireAdminOr403(context: { supabase: any; userId: string }) {
  const { data } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
  if (data) return;
  const { setResponseStatus } = await import("@tanstack/react-start/server");
  setResponseStatus(403);
  throw new Error("Not authorized");
}

export const getGovernanceSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdminOr403(context);
    const server = await import("@/lib/governance-config.server");
    const db = await adminDb();
    return { settings: await server.governanceSettingsView(db), canEdit: await server.isFounder(db, context.userId) };
  });

export const changeGovernanceSetting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { key: string; value: number; reason: string }) => ({ key: String(input?.key ?? ""), value: Number(input?.value), reason: String(input?.reason ?? "").slice(0, 1000) }))
  .handler(async ({ data, context }) => {
    await requireAdminOr403(context);
    const { updateGovernanceSetting } = await import("@/lib/governance-config.server");
    let request = { ip: null as string | null, userAgent: null as string | null };
    try {
      const { getRequest, getRequestIP } = await import("@tanstack/react-start/server");
      request = { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequest().headers.get("user-agent") };
    } catch {
      /* no request outside a server context */
    }
    return updateGovernanceSetting(await adminDb(), { actorId: context.userId, ...data, request });
  });
