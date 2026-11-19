import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for co-buyers. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function server() {
  return import("@/lib/co-buyer.server");
}

const text = (value: unknown, label: string, max: number) => {
  const t = String(value ?? "").trim();
  if (!t) throw new Error(`Enter ${label}`);
  return t.slice(0, max);
};

export const getMyCoBuyer = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).myCoBuyer(await adminDb(), { userId: context.userId }));

export const inviteCoBuyerFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { name: string; email: string }) => ({ name: text(input?.name, "their full name", 100), email: text(input?.email, "their email", 254) }))
  .handler(async ({ data, context }) => (await server()).inviteCoBuyer(await adminDb(), { userId: context.userId, ...data }));

export const resendCoBuyerInviteFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).resendCoBuyerInvite(await adminDb(), { userId: context.userId }));

export const cancelCoBuyerInviteFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await (await server()).cancelCoBuyerInvite(await adminDb(), { userId: context.userId });
    return { ok: true };
  });

export const acceptCoBuyerInviteFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { linkId?: string; token?: string }) => {
    const linkId = input?.linkId ? text(input.linkId, "an invitation", 64) : undefined;
    const token = input?.token ? text(input.token, "an invitation", 200) : undefined;
    if (!linkId && !token) throw new Error("Enter an invitation");
    return { linkId, token };
  })
  .handler(async ({ data, context }) => (await server()).acceptCoBuyerInvite(await adminDb(), { userId: context.userId, ...data }));

export const declineCoBuyerInviteFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { linkId: string }) => ({ linkId: text(input?.linkId, "an invitation", 64) }))
  .handler(async ({ data, context }) => {
    await (await server()).declineCoBuyerInvite(await adminDb(), { userId: context.userId, ...data });
    return { ok: true };
  });

export const removeCoBuyerFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await (await server()).removeCoBuyer(await adminDb(), { userId: context.userId });
    return { ok: true };
  });

/** Public: what an invitation link shows before sign-up. Nothing is returned for a link that isn't live. */
export const previewCoBuyerInviteFn = createServerFn({ method: "GET" })
  .inputValidator((input: { token: string }) => ({ token: text(input?.token, "an invitation", 200) }))
  .handler(async ({ data }) => (await server()).previewCoBuyerInvite(await adminDb(), data));
