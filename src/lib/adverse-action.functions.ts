import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for adverse-action notices. Admin action only: nothing triggers it automatically. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

export const issueAdverseActionNoticeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { memberId: string; actionStatement: string; agencyName: string; agencyAddress: string; agencyPhone: string; agencyWebsite?: string | null; reportObtainedAttested: boolean }) => ({
    memberId: text(input?.memberId, 64),
    actionStatement: text(input?.actionStatement, 1000),
    agency: { name: text(input?.agencyName, 200), address: text(input?.agencyAddress, 500), phone: text(input?.agencyPhone, 60), website: input?.agencyWebsite ? text(input.agencyWebsite, 300) : null },
    reportObtainedAttested: input?.reportObtainedAttested === true,
  }))
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await (context.supabase as any).rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (!isAdmin) throw new Error("Not authorized");
    const { issueAdverseActionNotice } = await import("@/lib/adverse-action.server");
    return issueAdverseActionNotice(await adminDb(), { adminId: context.userId, ...data });
  });

export const getMyAdverseActionNotices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string }) => ({ actingMemberId: text(input?.actingMemberId, 64) }))
  .handler(async ({ data, context }) => {
    const { myNotices } = await import("@/lib/adverse-action.server");
    return myNotices(await adminDb(), { userId: context.userId, actingMemberId: data.actingMemberId });
  });
