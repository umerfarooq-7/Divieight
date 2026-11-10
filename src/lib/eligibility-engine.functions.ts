import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { DISPOSITION_LABELS, type DispositionOutcome } from "@/lib/eligibility-engine";

/**
 * Callable surface for the eligibility engine. Admins record facts; there is deliberately no
 * function here (or anywhere) that sets or changes a result.
 */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function requireAdmin(context: { supabase: unknown; userId: string }) {
  const { data: isAdmin } = await (context.supabase as any).rpc("has_role", { _user_id: context.userId, _role: "admin" });
  if (!isAdmin) throw new Error("Not authorized");
}

const id = (v: unknown, label: string) => {
  const t = String(v ?? "").trim();
  if (!t) throw new Error(`Missing ${label}`);
  return t.slice(0, 64);
};

const server = () => import("@/lib/eligibility-engine.server");

export const listHeldMembers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    return (await server()).listHeld(await adminDb());
  });

export const recordChargeDisposition = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { memberId: string; outcome: string; offenseKey: string | null; dispositionDate: string }) => {
    if (!(input?.outcome in DISPOSITION_LABELS)) throw new Error("Choose how the charge ended.");
    return { memberId: id(input.memberId, "member"), outcome: input.outcome as DispositionOutcome, offenseKey: input.offenseKey ? String(input.offenseKey).slice(0, 8) : null, dispositionDate: String(input.dispositionDate ?? "").slice(0, 10) };
  })
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).recordDisposition(await adminDb(), { adminId: context.userId, ...data });
  });

export const listPossibleSanctionsMatches = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    return (await server()).listPossibleMatches(await adminDb());
  });

export const resolveSanctionsIdentity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { memberId: string; screeningId: string; samePerson: boolean }) => ({ memberId: id(input?.memberId, "member"), screeningId: id(input?.screeningId, "screening"), samePerson: input?.samePerson === true }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).resolvePossibleMatch(await adminDb(), { adminId: context.userId, ...data });
  });

export const markDeclarationUntrueFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { memberId: string; finding: string }) => ({ memberId: id(input?.memberId, "member"), finding: String(input?.finding ?? "").slice(0, 2000) }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).markDeclarationUntrue(await adminDb(), { adminId: context.userId, ...data });
  });

export const listEligibilityForAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { accountIds: string[] }) => ({ accountIds: (Array.isArray(input?.accountIds) ? input.accountIds : []).map(String).slice(0, 1000) }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).adminEligibility(await adminDb(), data.accountIds);
  });
