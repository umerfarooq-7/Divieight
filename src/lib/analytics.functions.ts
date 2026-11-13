import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { REPORT_KINDS, type AnalyticsFilters, type ReportKind } from "@/lib/analytics";

/** Callable surface for platform analytics and admin reports. Admins and the founder only: anyone else gets a 403. Read-only; exports are audit logged. */

type Db = { from: (t: string) => any; rpc?: (n: string, a: Record<string, unknown>) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function guard(userId: string) {
  const { requireAnalyticsAccess } = await import("@/lib/analytics.server");
  try {
    await requireAnalyticsAccess(await adminDb(), userId);
  } catch (e) {
    const { setResponseStatus } = await import("@tanstack/react-start/server");
    setResponseStatus(403);
    throw e;
  }
}

async function request() {
  try {
    const { getRequest, getRequestIP } = await import("@tanstack/react-start/server");
    return { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequest().headers.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

const dateOrNull = (value: unknown, label: string) => {
  if (!value) return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`Enter a valid ${label} date`);
  return text;
};
const filters = (input: Partial<AnalyticsFilters> | undefined): AnalyticsFilters => {
  const state = input?.state ? String(input.state).toUpperCase() : null;
  if (state && !/^[A-Z]{2}$/.test(state)) throw new Error("Choose a market");
  return { from: dateOrNull(input?.from, "from"), to: dateOrNull(input?.to, "to"), state };
};
const kind = (v: unknown): ReportKind => {
  if (!REPORT_KINDS.includes(v as ReportKind)) throw new Error("Unknown report");
  return v as ReportKind;
};

export const getAnalyticsBoard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: Partial<AnalyticsFilters> | undefined) => filters(input))
  .handler(async ({ data, context }) => {
    await guard(context.userId);
    return (await import("@/lib/analytics.server")).analyticsBoard(await adminDb(), { userId: context.userId, filters: data });
  });

export const getAdminReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { kind: string; filters?: Partial<AnalyticsFilters>; inquiryDays?: number }) => ({ kind: kind(input?.kind), filters: filters(input?.filters), inquiryDays: input?.inquiryDays ? Math.min(365, Math.max(1, Math.round(Number(input.inquiryDays)))) : undefined }))
  .handler(async ({ data, context }) => {
    await guard(context.userId);
    return (await import("@/lib/analytics.server")).reportData(await adminDb(), { userId: context.userId, kind: data.kind, filters: data.filters, inquiryDays: data.inquiryDays });
  });

export const exportAdminReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { kind: string; filters?: Partial<AnalyticsFilters>; inquiryDays?: number }) => ({ kind: kind(input?.kind), filters: filters(input?.filters), inquiryDays: input?.inquiryDays ? Math.min(365, Math.max(1, Math.round(Number(input.inquiryDays)))) : undefined }))
  .handler(async ({ data, context }) => {
    await guard(context.userId);
    return (await import("@/lib/analytics.server")).exportReport(await adminDb(), { userId: context.userId, kind: data.kind, filters: data.filters, inquiryDays: data.inquiryDays, request: await request() });
  });
