import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parseAnswers } from "@/lib/eligibility-declaration";

/** Callable surface for the Hybrid Exit seller's Block 4. Full Exit sellers have no eligibility check. */

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

export const getSellerEligibility = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await import("@/lib/seller-eligibility.server")).sellerEligibilityState(await adminDb(), context.userId));

export const submitSellerEligibility = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { answers: Record<string, string>; attestedPersonally: boolean; signedName: string; supersedesId: string | null }) => ({
    answers: parseAnswers(input?.answers),
    attestedPersonally: input?.attestedPersonally === true,
    signedName: String(input?.signedName ?? "").slice(0, 200),
    supersedesId: input?.supersedesId ? String(input.supersedesId).slice(0, 64) : null,
  }))
  .handler(async ({ data, context }) => (await import("@/lib/seller-eligibility.server")).submitSellerDeclaration(await adminDb(), { userId: context.userId, ...data, request: await request() }));
