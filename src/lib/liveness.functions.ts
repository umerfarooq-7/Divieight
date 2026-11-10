import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for the liveness step. */

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

const text = (v: unknown, label: string, max: number) => {
  const t = String(v ?? "").trim();
  if (!t) throw new Error(`Missing ${label}`);
  return t.slice(0, max);
};

async function requireAdmin(context: { supabase: unknown; userId: string }) {
  const { data: isAdmin } = await (context.supabase as any).rpc("has_role", { _user_id: context.userId, _role: "admin" });
  if (!isAdmin) throw new Error("Not authorized");
}

export const getLivenessState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string }) => ({ actingMemberId: text(input?.actingMemberId, "member", 64) }))
  .handler(async ({ data, context }) => {
    const { livenessState } = await import("@/lib/liveness.server");
    return livenessState(await adminDb(), { userId: context.userId, actingMemberId: data.actingMemberId });
  });

export const submitLivenessSelfie = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; selfiePath: string; selfieFileName: string; contentType?: string | null }) => ({
    actingMemberId: text(input?.actingMemberId, "member", 64),
    selfiePath: text(input?.selfiePath, "selfie", 500),
    selfieFileName: String(input?.selfieFileName ?? "selfie.jpg").slice(0, 200),
    contentType: input?.contentType ? String(input.contentType).slice(0, 100) : null,
  }))
  .handler(async ({ data, context }) => {
    const { runLivenessCheck } = await import("@/lib/liveness.server");
    return runLivenessCheck(await adminDb(), { userId: context.userId, ...data, request: await request() });
  });

export const listLivenessForAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { accountIds: string[] }) => ({ accountIds: (Array.isArray(input?.accountIds) ? input.accountIds : []).map(String).slice(0, 1000) }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const { adminLiveness } = await import("@/lib/liveness.server");
    return adminLiveness(await adminDb(), data.accountIds);
  });

export const getLivenessTestSwitch = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const { readLivenessTestSwitch } = await import("@/lib/liveness.server");
    return { forced: await readLivenessTestSwitch(await adminDb()) };
  });

export const setLivenessTestSwitchFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { forced: string | null }) => {
    const f = input?.forced ?? null;
    if (f !== null && f !== "passed" && f !== "failed" && f !== "inconclusive") throw new Error("Unknown outcome");
    return { forced: f as "passed" | "failed" | "inconclusive" | null };
  })
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const { setLivenessTestSwitch } = await import("@/lib/liveness.server");
    return setLivenessTestSwitch(await adminDb(), { adminUserId: context.userId, forced: data.forced });
  });
