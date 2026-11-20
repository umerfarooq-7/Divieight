import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for co-buyers (limited sub-accounts). */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function server() {
  return import("@/lib/co-buyer-members.server");
}

const text = (value: unknown, label: string, max: number) => {
  const t = String(value ?? "").trim();
  if (!t) throw new Error(`Enter ${label}`);
  return t.slice(0, max);
};

export const getMyCoBuyer = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).myCoBuyer(await adminDb(), { userId: context.userId }));

/** The co-buyer's own portal. */
export const getCoBuyerSelf = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).coBuyerSelf(await adminDb(), { userId: context.userId }));

export const inviteCoBuyerFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { name: string; email: string }) => ({ name: text(input?.name, "their full name", 100), email: text(input?.email, "their email", 254) }))
  .handler(async ({ data, context }) => (await server()).inviteCoBuyer(await adminDb(), { userId: context.userId, ...data }));

export const resendCoBuyerInviteFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).resendCoBuyerInvite(await adminDb(), { userId: context.userId }));

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

/** The signed-in person claims the invitation sent to their address. */
export const claimCoBuyerInviteFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { token: string }) => ({ token: text(input?.token, "an invitation", 200) }))
  .handler(async ({ data, context }) => {
    const email = String((context.claims as { email?: string } | undefined)?.email ?? "");
    return (await server()).claimCoBuyerInvite(await adminDb(), { userId: context.userId, email, token: data.token });
  });

export const attachCoBuyerFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { reservationId: string }) => ({ reservationId: text(input?.reservationId, "a share", 64) }))
  .handler(async ({ data, context }) => (await server()).attachCoBuyerToReservation(await adminDb(), { userId: context.userId, ...data }));

export const detachCoBuyerFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { reservationId: string }) => ({ reservationId: text(input?.reservationId, "a share", 64) }))
  .handler(async ({ data, context }) => {
    await (await server()).detachCoBuyerFromReservation(await adminDb(), { userId: context.userId, ...data });
    return { ok: true };
  });
