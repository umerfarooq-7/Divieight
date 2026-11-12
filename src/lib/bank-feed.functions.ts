import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for the LLC bank feed. The Manager (admin or founder) only. */

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

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

const propertyId = (value: unknown) => {
  const t = String(value ?? "").trim();
  if (!t) throw new Error("Missing property");
  return t.slice(0, 64);
};

export const getBankFeed = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await import("@/lib/bank-feed.server")).listBankFeed(await adminDb(), { userId: context.userId }));

export const linkLlcOperatingAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: propertyId(input?.propertyId) }))
  .handler(async ({ data, context }) => {
    const { getBankFeedAdapter } = await import("@/lib/bank-feed-adapters");
    return (await import("@/lib/bank-feed.server")).linkOperatingAccount(await adminDb(), getBankFeedAdapter(), { actorId: context.userId, propertyId: data.propertyId, request: await request() });
  });

export const revokeLlcOperatingAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: propertyId(input?.propertyId) }))
  .handler(async ({ data, context }) => {
    await (await import("@/lib/bank-feed.server")).revokeOperatingAccount(await adminDb(), { actorId: context.userId, propertyId: data.propertyId, request: await request() });
    return { ok: true };
  });

export const runBankFeedFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId?: string } | undefined) => ({ propertyId: input?.propertyId ? propertyId(input.propertyId) : undefined }))
  .handler(async ({ data, context }) => {
    const { getBankFeedAdapter } = await import("@/lib/bank-feed-adapters");
    return (await import("@/lib/bank-feed.server")).runBankFeedNow(await adminDb(), (provider) => getBankFeedAdapter(provider), { actorId: context.userId, propertyId: data.propertyId, request: await request() });
  });
