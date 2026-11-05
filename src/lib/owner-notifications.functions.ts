import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isOwnerNotificationType, type OwnerNotificationType } from "@/lib/owner-notifications";

/** Callable surface for owner notification settings and distributions. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function server() {
  return import("@/lib/owner-notifications.server");
}

async function requireAdmin(context: { supabase: any; userId: string }) {
  const { data } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
  if (!data) throw new Error("Not authorized");
}

export const getOwnerNotificationPreferences = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).ownerPreferences(await adminDb(), context.userId));

export const setOwnerNotificationPreference = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { type: OwnerNotificationType; emailEnabled: boolean }) => {
    if (!isOwnerNotificationType(String(input?.type))) throw new Error("Choose a notification type");
    return { type: input.type, emailEnabled: input.emailEnabled === true };
  })
  .handler(async ({ data, context }) => {
    await (await server()).setOwnerPreference(await adminDb(), { userId: context.userId, ...data });
    return { ok: true };
  });

export const getNotificationPropertyLabels = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyIds: string[] }) => ({ propertyIds: (Array.isArray(input?.propertyIds) ? input.propertyIds : []).map(String).slice(0, 200) }))
  .handler(async ({ data, context }) => (await server()).notificationPropertyLabels(await adminDb(), context.userId, data.propertyIds));

export const listDistributionsForAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    return (await server()).adminDistributions(await adminDb());
  });

export const postDistributionEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; totalAmount: number | string; recordDate: string; note?: string | null }) => {
    if (!input?.propertyId) throw new Error("Choose a property");
    const recordDate = String(input?.recordDate ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) throw new Error("Enter a valid record date");
    const note = String(input?.note ?? "").trim().slice(0, 1000);
    return { propertyId: String(input.propertyId), totalAmount: Number(input?.totalAmount), recordDate, note: note || null };
  })
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).postDistribution(await adminDb(), { adminId: context.userId, ...data });
  });
