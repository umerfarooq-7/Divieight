import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for the Standard's versions. Reading the live version is open to anyone signed in; publishing is admin only. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function requireAdmin(context: { supabase: unknown; userId: string }) {
  const { data: isAdmin } = await (context.supabase as any).rpc("has_role", { _user_id: context.userId, _role: "admin" });
  if (!isAdmin) throw new Error("Not authorized");
}

const server = () => import("@/lib/standard-version.server");

/** The version the Decision Page and the declaration show. */
export const getLiveStandardFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => (await server()).getLiveStandard(await adminDb()));

export const listStandardVersionsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const s = await server();
    return { live: await s.getLiveStandard(await adminDb()), versions: await s.listStandardVersions(await adminDb()).catch(() => []) };
  });

export const publishStandardVersionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { version: string; fileUrl: string; acknowledgedWarning: boolean }) => ({
    version: String(input?.version ?? "").slice(0, 20),
    fileUrl: String(input?.fileUrl ?? "").slice(0, 500),
    acknowledgedWarning: input?.acknowledgedWarning === true,
  }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).publishStandardVersion(await adminDb(), { adminId: context.userId, ...data });
  });
