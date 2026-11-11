import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for the Held accounts list. Admins only. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function requireAdmin(context: { supabase: any; userId: string }) {
  const { data } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
  if (!data) throw new Error("Not authorized");
}

export const listHeldAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    return (await import("@/lib/held-reminders.server")).adminHeldAccounts(await adminDb());
  });

export const snoozeHeldAccountFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { memberId: string; note: string }) => ({ memberId: String(input?.memberId ?? ""), note: String(input?.note ?? "").slice(0, 1000) }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await import("@/lib/held-reminders.server")).snoozeHeldAccount(await adminDb(), { adminId: context.userId, ...data });
  });
