import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isLedgerSource, type LedgerLineInput } from "@/lib/bookkeeping";

/**
 * Callable surface for the ledger. The Manager (admin or founder) writes, through these only. A member of the property,
 * its Heavy Lifting Agent and (later) the CPA read.
 */

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function server() {
  return import("@/lib/bookkeeping.server");
}

async function request() {
  try {
    const { getRequest, getRequestIP } = await import("@tanstack/react-start/server");
    return { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequest().headers.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

const id = (value: unknown, label: string) => {
  const t = String(value ?? "").trim();
  if (!t) throw new Error(`Missing ${label}`);
  return t.slice(0, 64);
};
const date = (value: unknown, label: string) => {
  const t = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error(`Enter a valid ${label}`);
  return t;
};
const optionalDate = (value: unknown, label: string) => (value ? date(value, label) : undefined);

const parseLines = (value: unknown): LedgerLineInput[] => {
  if (!Array.isArray(value)) throw new Error("An entry needs lines.");
  return value.slice(0, 200).map((l) => {
    const o = (l ?? {}) as Record<string, unknown>;
    return {
      accountId: o["accountId"] ? String(o["accountId"]) : undefined,
      code: o["code"] ? String(o["code"]) : undefined,
      memberId: o["memberId"] ? String(o["memberId"]) : null,
      debitCents: o["debitCents"] === undefined ? undefined : Number(o["debitCents"]),
      creditCents: o["creditCents"] === undefined ? undefined : Number(o["creditCents"]),
    };
  });
};

export const postLedgerEntryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; lines: unknown; entryDate?: string; source: string; sourceRef?: string | null; memo?: string | null; isAdjustment?: boolean; adjustmentReason?: string | null }) => {
    if (!isLedgerSource(input?.source)) throw new Error("Say where this entry comes from.");
    return {
      propertyId: id(input?.propertyId, "property"),
      lines: parseLines(input?.lines),
      meta: {
        entryDate: optionalDate(input?.entryDate, "entry date"),
        source: input.source,
        sourceRef: input?.sourceRef ? String(input.sourceRef).slice(0, 200) : null,
        memo: input?.memo ? String(input.memo).slice(0, 1000) : null,
        isAdjustment: input?.isAdjustment === true,
        adjustmentReason: input?.adjustmentReason ? String(input.adjustmentReason).slice(0, 1000) : null,
      },
    };
  })
  .handler(async ({ data, context }) => (await server()).postLedgerEntry(await adminDb(), { actorId: context.userId, ...data, request: await request() }));

export const reverseLedgerEntryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { entryId: string; reason: string; entryDate?: string; isAdjustment?: boolean; adjustmentReason?: string | null }) => ({
    entryId: id(input?.entryId, "entry"),
    reason: String(input?.reason ?? "").slice(0, 1000),
    entryDate: optionalDate(input?.entryDate, "entry date"),
    isAdjustment: input?.isAdjustment === true,
    adjustmentReason: input?.adjustmentReason ? String(input.adjustmentReason).slice(0, 1000) : null,
  }))
  .handler(async ({ data, context }) => (await server()).reverseLedgerEntry(await adminDb(), { actorId: context.userId, ...data, request: await request() }));

export const closeLedgerPeriodFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; year: number; month: number }) => {
    const year = Number(input?.year);
    const month = Number(input?.month);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) throw new Error("Choose a month");
    return { propertyId: id(input?.propertyId, "property"), year, month };
  })
  .handler(async ({ data, context }) => {
    await (await server()).closeLedgerPeriod(await adminDb(), { actorId: context.userId, ...data, request: await request() });
    return { ok: true };
  });

export const reviseChartFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { notes: string; effectiveFrom?: string; changes?: Array<Record<string, unknown>> }) => ({
    notes: String(input?.notes ?? "").slice(0, 1000),
    effectiveFrom: optionalDate(input?.effectiveFrom, "effective date"),
    changes: Array.isArray(input?.changes) ? input.changes.slice(0, 100) : [],
  }))
  .handler(async ({ data, context }) => (await server()).reviseChart(await adminDb(), { actorId: context.userId, ...data }));

export const getLedgerTrialBalance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; asOf?: string }) => ({ propertyId: id(input?.propertyId, "property"), asOf: optionalDate(input?.asOf, "date") }))
  .handler(async ({ data, context }) => (await server()).ledgerTrialBalance(await adminDb(), { userId: context.userId, ...data }));

export const getLedgerAccountActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; accountId: string; from?: string; to?: string }) => ({
    propertyId: id(input?.propertyId, "property"),
    accountId: id(input?.accountId, "account"),
    from: optionalDate(input?.from, "from date"),
    to: optionalDate(input?.to, "to date"),
  }))
  .handler(async ({ data, context }) => (await server()).ledgerAccountActivity(await adminDb(), { userId: context.userId, ...data }));

export const getChartOfAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => (await server()).chartOfAccounts(await adminDb()));

export const openPropertyLedgerFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; initialCashCents?: number }) => ({ propertyId: id(input?.propertyId, "property"), initialCashCents: input?.initialCashCents === undefined ? 0 : Number(input.initialCashCents) }))
  .handler(async ({ data, context }) => (await server()).openPropertyLedger(await adminDb(), { actorId: context.userId, ...data, request: await request() }));

export const backfillOpeningEntriesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).backfillOpeningEntries(await adminDb(), { actorId: context.userId }));

export const getOwnerCapitalReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId?: string } | undefined) => ({ propertyId: input?.propertyId ? id(input.propertyId, "property") : undefined }))
  .handler(async ({ data, context }) => (await server()).ownerCapitalReport(await adminDb(), { userId: context.userId, ...data }));

export const getCapitalAccountLedger = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).capitalAccountLedger(await adminDb(), { userId: context.userId, ...data }));
