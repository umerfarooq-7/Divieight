import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { rejectAuthorityAttempt } from "@/lib/member-authority";
import { parseAnswers } from "@/lib/eligibility-declaration";

/** Callable surface for Block 4 — Eligibility Declaration and Authorization. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function request() {
  try {
    const { getRequest, getRequestIP } = await import("@tanstack/react-start/server");
    return { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequest().headers.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

const memberId = (v: unknown) => {
  const t = String(v ?? "").trim();
  if (!t) throw new Error("Missing member");
  return t.slice(0, 64);
};

export const getDeclarationState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string }) => ({ actingMemberId: memberId(input?.actingMemberId) }))
  .handler(async ({ data, context }) => {
    const { declarationState } = await import("@/lib/eligibility-declaration.server");
    return declarationState(await adminDb(), { userId: context.userId, actingMemberId: data.actingMemberId });
  });

export const submitEligibilityDeclaration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; answers: Record<string, string>; attestedPersonally: boolean; signedName: string; supersedesId: string | null; kind?: string }) => (rejectAuthorityAttempt(input, "block4"), {
    actingMemberId: memberId(input?.actingMemberId),
    answers: parseAnswers(input?.answers),
    attestedPersonally: input?.attestedPersonally === true,
    signedName: String(input?.signedName ?? "").slice(0, 200),
    supersedesId: input?.supersedesId ? String(input.supersedesId).slice(0, 64) : null,
    kind: input?.kind === "change_report" ? ("change_report" as const) : undefined,
  }))
  .handler(async ({ data, context }) => {
    const { submitDeclaration } = await import("@/lib/eligibility-declaration.server");
    return submitDeclaration(await adminDb(), { userId: context.userId, ...data, request: await request() });
  });

export const listDeclarationsForAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { accountIds: string[] }) => ({ accountIds: (Array.isArray(input?.accountIds) ? input.accountIds : []).map(String).slice(0, 1000) }))
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await (context.supabase as any).rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (!isAdmin) throw new Error("Not authorized");
    const { adminDeclarations } = await import("@/lib/eligibility-declaration.server");
    return adminDeclarations(await adminDb(), data.accountIds);
  });
