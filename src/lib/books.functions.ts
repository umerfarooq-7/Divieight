import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Callable surface for the Manager's books screens. The Manager (admin or founder) writes, always through the database
 * functions, which only ever add entries. The Heavy Lifting Agent has one read-only view.
 */

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any; storage?: any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}
const server = () => import("@/lib/books.server");

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
const text = (value: unknown, max = 1000) => String(value ?? "").slice(0, max);
const cents = (value: unknown) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("The amount is a whole number of cents above zero.");
  return n;
};
const adjustment = (input: { entryDate?: string; isAdjustment?: boolean; adjustmentReason?: string | null }) => ({
  entryDate: optionalDate(input?.entryDate, "date"),
  isAdjustment: input?.isAdjustment === true,
  adjustmentReason: input?.adjustmentReason ? text(input.adjustmentReason) : null,
});

export const getBooksOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).booksOverview(await adminDb(), { userId: context.userId, ...data }));

export const getHlaBooksView = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).hlaBooksView(await adminDb(), { userId: context.userId, ...data }));

export const postBankTransactionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { transactionId: string; splits: Array<{ code: string; cents: number }> }) => ({
    transactionId: id(input?.transactionId, "transaction"),
    splits: (Array.isArray(input?.splits) ? input.splits : []).slice(0, 20).map((s) => ({ code: text(s?.code, 10), cents: Number(s?.cents) })),
  }))
  .handler(async ({ data, context }) => (await server()).postBankTransaction(await adminDb(), { actorId: context.userId, ...data, request: await request() }));

export const ignoreBankTransactionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { transactionId: string; reason: string }) => ({ transactionId: id(input?.transactionId, "transaction"), reason: text(input?.reason) }))
  .handler(async ({ data, context }) => {
    await (await server()).ignoreBankTransaction(await adminDb(), { actorId: context.userId, ...data, request: await request() });
    return { ok: true };
  });

export const postManualEntryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; date: string; amountCents: number; direction: "in" | "out"; accountCode: string; memo: string; receiptPath?: string | null; receiptName?: string | null; receiptType?: string | null; isAdjustment?: boolean; adjustmentReason?: string | null }) => ({
    propertyId: id(input?.propertyId, "property"),
    date: date(input?.date, "date"),
    amountCents: cents(input?.amountCents),
    direction: input?.direction === "in" ? ("in" as const) : ("out" as const),
    accountCode: text(input?.accountCode, 10),
    memo: text(input?.memo),
    attachment: input?.receiptPath ? { path: text(input.receiptPath, 300), fileName: text(input.receiptName ?? "receipt", 200), contentType: input.receiptType ? text(input.receiptType, 100) : null } : null,
    isAdjustment: input?.isAdjustment === true,
    adjustmentReason: input?.adjustmentReason ? text(input.adjustmentReason) : null,
  }))
  .handler(async ({ data, context }) => (await server()).postManualEntry(await adminDb(), { actorId: context.userId, ...data, request: await request() }));

export const recategorizeEntryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { entryId: string; mapping: Record<string, string>; reason: string; entryDate?: string; isAdjustment?: boolean; adjustmentReason?: string | null }) => ({
    entryId: id(input?.entryId, "entry"),
    mapping: Object.fromEntries(Object.entries(input?.mapping ?? {}).slice(0, 20).map(([k, v]) => [id(k, "line"), text(v, 10)])),
    reason: text(input?.reason),
    ...adjustment(input),
  }))
  .handler(async ({ data, context }) => (await server()).recategorizeEntry(await adminDb(), { actorId: context.userId, ...data, request: await request() }));

export const capitalizeEntryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { entryId: string; reason: string; entryDate?: string; isAdjustment?: boolean; adjustmentReason?: string | null }) => ({ entryId: id(input?.entryId, "entry"), reason: text(input?.reason), ...adjustment(input) }))
  .handler(async ({ data, context }) => (await server()).capitalizeEntry(await adminDb(), { actorId: context.userId, ...data, request: await request() }));

export const createRecurringRuleFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; description: string; amountCents: number; accountCode: string; frequency: string; firstRun: string }) => {
    if (!["weekly", "monthly", "quarterly", "annually"].includes(input?.frequency)) throw new Error("Choose how often it repeats.");
    return { propertyId: id(input?.propertyId, "property"), description: text(input?.description, 200), amountCents: cents(input?.amountCents), accountCode: text(input?.accountCode, 10), frequency: input.frequency as "weekly" | "monthly" | "quarterly" | "annually", firstRun: date(input?.firstRun, "first date") };
  })
  .handler(async ({ data, context }) => (await server()).createRecurringRule(await adminDb(), { actorId: context.userId, ...data, request: await request() }));

export const setRecurringRuleActiveFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { ruleId: string; active: boolean }) => ({ ruleId: id(input?.ruleId, "rule"), active: input?.active === true }))
  .handler(async ({ data, context }) => {
    await (await server()).setRecurringRuleActive(await adminDb(), { actorId: context.userId, ...data, request: await request() });
    return { ok: true };
  });

export const runRecurringNowFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).applyDueRecurring(await adminDb(), { actorId: context.userId, propertyId: data.propertyId }));

export const saveCategorizationRuleFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string | null; matchType: string; pattern: string; accountCode: string; priority?: number }) => {
    if (!["merchant", "keyword", "amount_range"].includes(input?.matchType)) throw new Error("Choose how to match.");
    return { propertyId: input?.propertyId ? id(input.propertyId, "property") : null, matchType: input.matchType as "merchant" | "keyword" | "amount_range", pattern: text(input?.pattern, 200), accountCode: text(input?.accountCode, 10), priority: Number.isFinite(Number(input?.priority)) ? Math.trunc(Number(input.priority)) : 100 };
  })
  .handler(async ({ data, context }) => (await server()).saveCategorizationRule(await adminDb(), { actorId: context.userId, ...data, request: await request() }));

export const setCategorizationRuleActiveFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { ruleId: string; active: boolean }) => ({ ruleId: id(input?.ruleId, "rule"), active: input?.active === true }))
  .handler(async ({ data, context }) => {
    await (await server()).setCategorizationRuleActive(await adminDb(), { actorId: context.userId, ...data, request: await request() });
    return { ok: true };
  });

export const applyRulesToNeedsReviewFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).applyRulesToNeedsReview(await adminDb(), { actorId: context.userId, ...data, request: await request() }));

export const reopenPeriodFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; year: number; month: number; reason: string }) => {
    const year = Number(input?.year);
    const month = Number(input?.month);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) throw new Error("Choose a month");
    return { propertyId: id(input?.propertyId, "property"), year, month, reason: text(input?.reason) };
  })
  .handler(async ({ data, context }) => {
    await (await server()).reopenPeriod(await adminDb(), { actorId: context.userId, ...data, request: await request() });
    return { ok: true };
  });

export const getReceiptLinkFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; attachmentId: string }) => ({ propertyId: id(input?.propertyId, "property"), attachmentId: id(input?.attachmentId, "receipt") }))
  .handler(async ({ data, context }) => ({ url: await (await server()).receiptLink(await adminDb(), { userId: context.userId, ...data }) }));
