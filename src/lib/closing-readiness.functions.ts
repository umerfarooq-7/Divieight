import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabase } from "@/integrations/supabase/client";
import type { Readiness } from "@/lib/closing-readiness.server";

/** Closing Readiness dashboard — admin-only, read-only. */
export const listClosingReadiness = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ properties: Readiness[] }> => {
    const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: context.claims?.sub as string, _role: "admin" });
    if (!isAdmin) throw new Error("Not authorized");
    const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
    const { readinessOverview } = await import("@/lib/closing-readiness.server");
    return { properties: await readinessOverview(supabaseAdmin as never) };
  });
