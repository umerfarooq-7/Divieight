import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ConversionFilters, ConversionStatus } from "@/lib/conversions.server";

/** Callable surface for the admin's Conversion Events page. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function requireAdmin(context: { supabase: any; userId: string }) {
  const { data } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
  if (!data) throw new Error("Not authorized");
}

const dateOrNull = (value: unknown, label: string) => {
  if (!value) return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`Enter a valid ${label} date`);
  return text;
};

export const listConversions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: Partial<ConversionFilters> | undefined): ConversionFilters => {
    const status = input?.status ?? null;
    if (status && status !== "partial" && status !== "converted") throw new Error("Choose a status");
    return {
      status: status as ConversionStatus | null,
      agentId: input?.agentId ? String(input.agentId) : null,
      propertyId: input?.propertyId ? String(input.propertyId) : null,
      from: dateOrNull(input?.from, "from"),
      to: dateOrNull(input?.to, "to"),
    };
  })
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const { adminConversions } = await import("@/lib/conversions.server");
    return adminConversions(await adminDb(), data);
  });

export const syncConversionsNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const { runConversionSync } = await import("@/lib/conversions.server");
    const db = await adminDb();
    const result = await runConversionSync(db);
    await db.from("audit_log").insert({
      actor_id: context.userId,
      actor_type: "admin",
      action_type: "conversion.synced",
      entity_type: "conversion_events",
      entity_id: null,
      metadata: result,
    });
    return result;
  });
