import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for the versioned Terms: public reading, the Manager's publishing and delivery record, and each person's own status. */

type Db = Parameters<(typeof import("@/lib/tc.server"))["listVersions"]>[0];

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}
const server = () => import("@/lib/tc.server");

async function request() {
  try {
    const { getRequest, getRequestIP } = await import("@tanstack/react-start/server");
    return { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequest().headers.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

const text = (v: unknown, max: number) => String(v ?? "").slice(0, max);

// ---- Public: no sign-in --------------------------------------------------------------------------------

export const getPublicTerms = createServerFn({ method: "POST" })
  .inputValidator((input?: { version?: string | null }) => ({ version: input?.version ? text(input.version, 20) : null }))
  .handler(async ({ data }) => (await server()).publicTerms(await adminDb(), { version: data.version }));

export const getTermsComparison = createServerFn({ method: "POST" })
  .inputValidator((input: { from: string; to: string }) => ({ from: text(input?.from, 20), to: text(input?.to, 20) }))
  .handler(async ({ data }) => {
    const { from, to } = await (await server()).versionPair(await adminDb(), data.from, data.to);
    return {
      from: { version: from.version, effectiveDate: from.effective_date, body: from.body },
      to: { version: to.version, effectiveDate: to.effective_date, body: to.body, isMaterial: to.is_material, summary: to.summary_of_changes },
    };
  });

// ---- The signed-in person ------------------------------------------------------------------------------

/** Called once per visit by a signed-in person: continued use after the effective date is recorded as acceptance of the version in force. */
export const recordTermsContinuedUse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).recordImplicitAcceptance(await adminDb(), { userId: context.userId, request: await request() }));

export const getMyTermsStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).myTermsStatus(await adminDb(), { userId: context.userId }));

// ---- The Manager ---------------------------------------------------------------------------------------

export const getTermsAdminBoard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const s = await server();
    const db = await adminDb();
    await s.requireAdmin(db, context.userId);
    const versions = await s.listVersions(db);
    const reports: Record<string, Awaited<ReturnType<typeof s.deliveryReport>>> = {};
    for (const v of versions.filter((x) => x.is_material)) reports[v.id] = await s.deliveryReport(db, { adminId: context.userId, versionId: v.id });
    return { versions, reports };
  });

export const publishTerms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { version: string; effectiveDate: string; body: string; isMaterial: boolean; summary?: string }) => ({
    version: text(input?.version, 20),
    effectiveDate: text(input?.effectiveDate, 10),
    body: text(input?.body, 200_000),
    isMaterial: input?.isMaterial === true,
    summary: text(input?.summary, 4000),
  }))
  .handler(async ({ data, context }) => {
    const r = await (await server()).publishTcVersion(await adminDb(), { adminId: context.userId, input: data });
    return { version: r.version.version, notices: r.notices };
  });

/** Reaches only the people not yet notified. */
export const resendTermsNotices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { versionId: string }) => ({ versionId: text(input?.versionId, 64) }))
  .handler(async ({ data, context }) => {
    const s = await server();
    const db = await adminDb();
    await s.requireAdmin(db, context.userId);
    return s.sendTcNotices(db, { versionId: data.versionId, adminId: context.userId });
  });
