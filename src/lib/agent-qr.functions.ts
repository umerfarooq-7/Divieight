import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for agent QR / deep-link attribution. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function server() {
  return import("@/lib/agent-qr.server");
}

/** Public: anyone following a link. Validates the token and stores no personal data. */
export const recordAttributionVisit = createServerFn({ method: "POST" })
  .inputValidator((input: { token: string }) => ({ token: String(input?.token ?? "").slice(0, 64) }))
  .handler(async ({ data }) => {
    try {
      const { getRequest } = await import("@tanstack/react-start/server");
      const userAgent = getRequest().headers.get("user-agent");
      return await (await server()).recordVisit(await adminDb(), { token: data.token, userAgent });
    } catch {
      return { active: false }; // following a link never fails
    }
  });

export const getAgentQrPage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).agentQrPage(await adminDb(), context.userId));

export const createAgentQrToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { label: string }) => {
    const label = String(input?.label ?? "").trim().slice(0, 100);
    if (!label) throw new Error("Give this link a label");
    return { label };
  })
  .handler(async ({ data, context }) => {
    await (await server()).createLabeledToken(await adminDb(), { userId: context.userId, label: data.label });
    return { ok: true };
  });

export const revokeAgentQrToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { tokenId: string }) => {
    if (!input?.tokenId) throw new Error("Missing link");
    return { tokenId: String(input.tokenId) };
  })
  .handler(async ({ data, context }) => {
    await (await server()).revokeToken(await adminDb(), { userId: context.userId, tokenId: data.tokenId });
    return { ok: true };
  });

export const stampBuyerAttribution = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { tokens: string[] }) => ({ tokens: (Array.isArray(input?.tokens) ? input.tokens : []).map(String).slice(0, 5) }))
  .handler(async ({ data, context }) => (await server()).stampBuyer(await adminDb(), { userId: context.userId, tokens: data.tokens }));

export const getMyReferralSuggestion = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).myReferralSuggestion(await adminDb(), context.userId));

export const listBuyerAttributionsForAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await (context.supabase as any).rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (!isAdmin) throw new Error("Not authorized");
    return (await server()).adminAttributions(await adminDb());
  });
