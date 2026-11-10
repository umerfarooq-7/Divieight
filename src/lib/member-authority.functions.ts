import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for documented authority. */

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

const id = (v: unknown, label: string) => {
  const t = String(v ?? "").trim();
  if (!t) throw new Error(`Missing ${label}`);
  return t.slice(0, 64);
};

export const getMyAuthority = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string }) => ({ actingMemberId: id(input?.actingMemberId, "member") }))
  .handler(async ({ data, context }) => (await import("@/lib/member-authority.server")).listMyGrants(await adminDb(), { userId: context.userId, actingMemberId: data.actingMemberId }));

export const grantAuthorityFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; granteeMemberId: string; scope: string[]; typedName: string }) => ({
    actingMemberId: id(input?.actingMemberId, "member"),
    granteeMemberId: id(input?.granteeMemberId, "grantee"),
    // Validated against the allowed list on the server: anything else (Block 4, ID, liveness, Block 1, Hold Harmless, W-9…) is refused.
    scope: (Array.isArray(input?.scope) ? input.scope : []).map(String).slice(0, 20),
    typedName: String(input?.typedName ?? "").slice(0, 200),
  }))
  .handler(async ({ data, context }) => (await import("@/lib/member-authority.server")).grantAuthority(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const revokeAuthorityFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; grantId: string }) => ({ actingMemberId: id(input?.actingMemberId, "member"), grantId: id(input?.grantId, "grant") }))
  .handler(async ({ data, context }) => (await import("@/lib/member-authority.server")).revokeAuthority(await adminDb(), { userId: context.userId, ...data, request: await request() }));
