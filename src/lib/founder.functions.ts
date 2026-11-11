import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { FounderFilters } from "@/lib/founder";

/** Callable surface for the Founder Dashboard. Admins only: anyone else gets a 403. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

/** Founders only. An admin who isn't a founder gets a 403 here, like anyone else. */
async function requireAdminOr403(context: { supabase: any; userId: string }) {
  const { isFounder } = await import("@/lib/governance-config.server");
  if (await isFounder((await adminDb()) as never, context.userId)) return;
  const { setResponseStatus } = await import("@tanstack/react-start/server");
  setResponseStatus(403);
  throw new Error("Not authorized");
}

const dateOrNull = (value: unknown, label: string) => {
  if (!value) return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`Enter a valid ${label} date`);
  return text;
};

export const getFounderDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: Partial<FounderFilters> | undefined): FounderFilters => {
    const state = input?.state ? String(input.state).toUpperCase() : null;
    if (state && !/^[A-Z]{2}$/.test(state)) throw new Error("Choose a market");
    return { from: dateOrNull(input?.from, "from"), to: dateOrNull(input?.to, "to"), state };
  })
  .handler(async ({ data, context }) => {
    await requireAdminOr403(context);
    const { founderDashboard } = await import("@/lib/founder.server");
    return founderDashboard(await adminDb(), data);
  });

export const refreshFounderDashboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdminOr403(context);
    const { refreshFounder } = await import("@/lib/founder.server");
    const db = await adminDb();
    const result = await refreshFounder(db);
    await db.from("audit_log").insert({
      actor_id: context.userId,
      actor_type: "admin",
      action_type: "founder_dashboard.refreshed",
      entity_type: "founder_dashboard",
      entity_id: null,
      metadata: result,
    });
    return result;
  });
